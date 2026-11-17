"""하드웨어 자동 프로파일러 및 로컬 LLM 실행 티어 선택기 (Hardware Auto-Profiler & Tier Selector).

DeepSeek Harness는 설치된 PC의 사양에 따라 로컬에서 실행 가능한 LLM의 상한이 달라진다.
이 모듈은 **표준 라이브러리만으로**(psutil은 선택적 가속일 뿐 필수 아님) CPU 코어 / 물리 RAM /
NVIDIA GPU VRAM을 측정하고, 그 결과를 4단계 로컬 실행 티어로 결정론적으로 사상한다::

    Tier 0  rule_based_only   로컬 LLM 없음    -> AST 슬라이싱 + 정규식/규칙 + 클라우드 API
    Tier 1  lightweight_local 1.5B~3B SLM      -> 로컬 심볼 트리아지 / 분류 / 초고속 생성
    Tier 2  standard_local    7B~8B Coder LLM  -> 직접 실행 / 코드 생성 / 1차 로컬 조사
    Tier 3  advanced_local    14B~32B Coder LLM -> 로컬 전 구간 실행 파이프라인

판정 규칙(상위 티어부터 평가, 낮은 조건이 하나라도 걸리면 하위 티어)::

    Tier 3: RAM >= 32GB  AND VRAM >= 12GB
    Tier 2: RAM >= 16GB  OR  VRAM >= 6GB
    Tier 1: RAM 8~16GB   OR  VRAM 2~4GB
    Tier 0: 그 외 (RAM < 8GB 또는 GPU 없는 저사양) — 로컬 VRAM/RAM 오버헤드 0

RAM 조회는 ``psutil`` -> Windows ``GlobalMemoryStatusEx`` -> POSIX ``os.sysconf`` 순으로
폴백한다. **측정 실패는 0.0이 아니라 "unknown"으로 기록한다**(``Measurement``).

티어 판정은 ``OR`` 조건이다::

    Tier 3: RAM >= 32GB  AND VRAM >= 12GB
    Tier 2: RAM >= 16GB  OR  VRAM >= 6GB
    Tier 1: RAM >= 8GB   OR  VRAM >= 2GB

이 ``OR``는 **의도된 동작이며 옳다**. RAM을 측정하지 못한 기기라도 VRAM 6GB 게이트를
만족하면 Tier 2가 될 수 있다 — GPU 하나로 로컬 모델을 돌리는 구성이 실제로 존재하기
때문이다. 다만 그것은 "RAM이 0GB로 측정되었다"가 아니라 "RAM은 unknown이고 VRAM으로만
판정했다"는 뜻이어야 한다. 이전 버전의 docstring은 "모든 조회가 실패하면 Tier 0으로
수렴한다"고 적었지만, 코드의 ``OR`` 판정 때문에 VRAM이 충분하면 Tier 0이 아니다.
**문서가 틀렸고 코드가 옳다.** 측정 실패를 저사양으로 표시하지 않기 위해 실패는
``Measurement(status=UNKNOWN)``으로 남기고, 선택 계층(``vram_budget``)은 그 예산을 쓰는
경로를 비활성한다.

GPU는 ``nvidia-smi``가 PATH에 있고 정상 응답할 때만 NVIDIA GPU로 인정하고, 부재/실패 시
CPU 전용으로 간주한다(별도 드라이버 바인딩/외부 패키지 불필요).

설계문서 §1.2의 프로브 중 이 모듈이 추가로 제공하는 것: **여유 VRAM**(M-02),
**디스플레이가 dGPU에 물려 있는지**(M-10), **드라이버 공유 모델**(M-11),
**대상 드라이브의 디스크 여유**(M-12), **추론 런타임 존재·빌드**(M-14),
**가중치 존재**(M-15). 기존 함수(``detect_hardware`` 등)의 계약은 그대로 두고
:func:`probe_hardware_profile`이 그 위에 확장 필드를 얹는다.
"""
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, replace
from enum import Enum
from functools import lru_cache
from typing import Any, Dict, Optional, Sequence, Tuple

_BYTES_PER_GB = float(1 << 30)
_NVIDIA_SMI_TIMEOUT_SECONDS = 3.0
_BUILD_PATTERN = re.compile(r"\bb(\d{3,6})\b")
_CUDA_VERSION_PATTERN = re.compile(r"cuda[ _-]?(\d{1,2})")

__all__ = [
    "HardwareSpec",
    "detect_hardware",
    "clear_hardware_cache",
    "LocalExecutionTier",
    "LocalExecutionTierInfo",
    "determine_local_tier",
    "parse_tier",
    "LOCAL_TIER_MODEL_IDS",
    "LOCAL_TIER_QUANTIZATION",
    "LOCAL_TIER_RECOMMENDATIONS",
    "MeasurementStatus",
    "Measurement",
    "GpuMemoryProbe",
    "HardwareProfile",
    "probe_gpu_memory",
    "probe_disk_free_gib",
    "probe_runtime",
    "probe_weights",
    "probe_hardware_profile",
]


# ---------------------------------------------------------------------------
# 1) 하드웨어 측정 계층
# ---------------------------------------------------------------------------
@dataclass
class HardwareSpec:
    """측정된 하드웨어 사양.

    ``ram_gb`` / ``vram_gb``는 모두 GB(=GiB, 2^30 bytes) 기준이다.
    """
    cpu_cores: int
    ram_gb: float
    has_gpu: bool
    vram_gb: float
    gpu_name: str

    @property
    def is_cpu_only(self) -> bool:
        """사용 가능한 GPU 메모리가 없으면 True."""
        return not self.has_gpu or self.vram_gb <= 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "cpu_cores": int(self.cpu_cores),
            "ram_gb": round(float(self.ram_gb), 2),
            "has_gpu": bool(self.has_gpu),
            "vram_gb": round(float(self.vram_gb), 2),
            "gpu_name": self.gpu_name,
        }

    def __str__(self) -> str:
        gpu = f"{self.gpu_name} ({self.vram_gb:.1f}GB VRAM)" if self.has_gpu else "CPU-only"
        return f"CPU {self.cpu_cores}c / RAM {self.ram_gb:.1f}GB / {gpu}"


def _cpu_cores() -> int:
    try:
        return max(1, int(os.cpu_count() or 1))
    except (TypeError, ValueError):
        return 1


def _ram_gb_from_psutil() -> Optional[float]:
    """psutil이 설치된 경우의 빠른 경로(선택 사항)."""
    try:
        import psutil  # type: ignore
    except Exception:  # 미설치/임베디드 환경
        return None
    try:
        return float(psutil.virtual_memory().total) / _BYTES_PER_GB
    except Exception:
        return None


def _ram_gb_from_windows() -> Optional[float]:
    """Windows ctypes ``GlobalMemoryStatusEx`` 폴백(표준 라이브러리만 사용)."""
    if os.name != "nt":
        return None
    try:
        import ctypes

        class _MemoryStatusEx(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = _MemoryStatusEx()
        status.dwLength = ctypes.sizeof(_MemoryStatusEx)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return None
        return float(status.ullTotalPhys) / _BYTES_PER_GB
    except Exception:
        return None


def _ram_gb_from_posix() -> Optional[float]:
    """POSIX ``os.sysconf`` 폴백(컨테이너/리눅스/macOS)."""
    try:
        pages = int(os.sysconf("SC_PHYS_PAGES"))
        page_size = int(os.sysconf("SC_PAGE_SIZE"))
    except (AttributeError, ValueError, OSError, TypeError):
        return None
    if pages <= 0 or page_size <= 0:
        return None
    return float(pages * page_size) / _BYTES_PER_GB


def _detect_ram_gb() -> float:
    """물리 RAM(GB). 모든 폴백이 실패하면 0.0(측정 불가)을 돌려준다.

    0.0은 "측정했더니 0이었다"가 아니라 "측정하지 못했다"이다. 티어 판정은 ``OR``
    조건이므로 이 값이 곧 Tier 0을 뜻하지는 않는다 — VRAM 게이트를 만족하면 상위
    티어가 될 수 있고, 그것이 옳다. 측정 실패를 저사양으로 표시하지 않기 위해
    :func:`probe_hardware_profile`은 이 값을 ``Measurement(UNKNOWN)``으로 기록하고,
    예산을 계산하는 ``vram_budget``은 RAM 예산을 쓰는 경로를 비활성한다.
    """
    for probe in (_ram_gb_from_psutil, _ram_gb_from_windows, _ram_gb_from_posix):
        value = probe()
        if value and value > 0:
            return round(float(value), 2)
    return 0.0


def _detect_nvidia_gpu() -> Tuple[bool, float, str]:
    """nvidia-smi 기반 NVIDIA GPU 탐지. ``(has_gpu, vram_gb, name)`` 반환."""
    executable = shutil.which("nvidia-smi")
    if not executable:
        return (False, 0.0, "")

    run_kwargs: Dict[str, Any] = {}
    if os.name == "nt":
        run_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            [
                executable,
                "--query-gpu=name,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=_NVIDIA_SMI_TIMEOUT_SECONDS,
            check=False,
            **run_kwargs,
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        # 드라이버 미설치, PATH 손상, 타임아웃 등 -> CPU 전용으로 처리
        return (False, 0.0, "")

    if completed.returncode != 0:
        return (False, 0.0, "")

    best: Tuple[bool, float, str] = (False, 0.0, "")
    for line in (completed.stdout or "").splitlines():
        parts = [piece.strip() for piece in line.split(",")]
        if len(parts) < 2:
            continue
        try:
            vram_gb = float(parts[1]) / 1024.0  # nvidia-smi nounits = MiB
        except ValueError:
            continue
        if vram_gb > best[1]:
            best = (True, round(vram_gb, 2), parts[0])
    return best


@lru_cache(maxsize=1)
def _detect_hardware_cached() -> HardwareSpec:
    has_gpu, vram_gb, gpu_name = _detect_nvidia_gpu()
    return HardwareSpec(
        cpu_cores=_cpu_cores(),
        ram_gb=_detect_ram_gb(),
        has_gpu=has_gpu,
        vram_gb=float(vram_gb),
        gpu_name=gpu_name,
    )


def detect_hardware() -> HardwareSpec:
    """현재 머신의 하드웨어 사양을 자동 감지한다(크로스 플랫폼, 표준 라이브러리 전용).

    nvidia-smi 프로세스 호출 비용을 피하기 위해 측정 결과를 캐시하고 호출자에게는
    안전하게 복사본을 넘긴다.
    """
    return replace(_detect_hardware_cached())


def clear_hardware_cache() -> None:
    """하드웨어 측정 캐시를 비운다(테스트/핫플러그 시나리오용)."""
    _detect_hardware_cached.cache_clear()


# ---------------------------------------------------------------------------
# 1b) 확장 프로브 (설계문서 M-02, M-10, M-11, M-12, M-14, M-15)
# ---------------------------------------------------------------------------
class MeasurementStatus(str, Enum):
    """측정값의 3상태. ``UNKNOWN``은 0.0이 아니다."""
    MEASURED = "measured"
    UNKNOWN = "unknown"
    NOT_APPLICABLE = "not_applicable"


@dataclass(frozen=True)
class Measurement:
    """측정값 + 상태 + 사유. 값이 없으면 ``value``는 ``None``이다."""
    status: MeasurementStatus
    value: Optional[float] = None
    reason: str = ""

    @property
    def known(self) -> bool:
        return self.status is MeasurementStatus.MEASURED and self.value is not None

    @classmethod
    def measured(cls, value: float) -> "Measurement":
        return cls(MeasurementStatus.MEASURED, float(value), "")

    @classmethod
    def unknown(cls, reason: str) -> "Measurement":
        return cls(MeasurementStatus.UNKNOWN, None, reason)

    @classmethod
    def not_applicable(cls, reason: str) -> "Measurement":
        return cls(MeasurementStatus.NOT_APPLICABLE, None, reason)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status.value,
            "value": self.value,
            "reason": self.reason,
        }


@dataclass
class GpuMemoryProbe:
    """nvidia-smi 1회 호출로 얻는 VRAM 예산 관련 측정값."""
    gpu_name: str
    total_mib: Measurement
    free_mib: Measurement
    used_mib: Measurement
    display_active: Measurement
    driver_model: Measurement

    def to_dict(self) -> Dict[str, Any]:
        return {
            "gpu_name": self.gpu_name,
            "total_mib": self.total_mib.to_dict(),
            "free_mib": self.free_mib.to_dict(),
            "used_mib": self.used_mib.to_dict(),
            "display_active": self.display_active.to_dict(),
            "driver_model": self.driver_model.to_dict(),
        }


_NVIDIA_MEMORY_FIELDS = "name,memory.total,memory.free,memory.used,display_active,driver_model.current"


def _run_nvidia_smi(fields: str) -> Optional[str]:
    executable = shutil.which("nvidia-smi")
    if not executable:
        return None
    run_kwargs: Dict[str, Any] = {}
    if os.name == "nt":
        run_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            [executable, f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=_NVIDIA_SMI_TIMEOUT_SECONDS,
            check=False,
            **run_kwargs,
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout or ""


def probe_gpu_memory() -> GpuMemoryProbe:
    """M-01/M-02/M-03/M-10/M-11: VRAM 총량·여유·사용량·디스플레이·드라이버 모델.

    한 번의 ``nvidia-smi`` 호출로 읽는다. 실패한 필드는 각각 ``unknown``이며,
    0으로 대체하지 않는다.
    """
    output = _run_nvidia_smi(_NVIDIA_MEMORY_FIELDS)
    if output is None:
        reason = "nvidia-smi is not available or did not answer"
        unknown = Measurement.unknown(reason)
        return GpuMemoryProbe("", unknown, unknown, unknown, unknown, unknown)

    best: Optional[GpuMemoryProbe] = None
    best_total = -1.0
    for line in output.splitlines():
        parts = [piece.strip() for piece in line.split(",")]
        if len(parts) < 6:
            continue

        def _number(piece: str) -> Measurement:
            try:
                return Measurement.measured(float(piece))
            except ValueError:
                return Measurement.unknown(f"nvidia-smi returned {piece!r}")

        total = _number(parts[1])
        if not total.known:
            continue
        if total.value is not None and total.value > best_total:
            display_text = parts[4].strip().lower()
            if display_text in ("enabled", "yes", "true"):
                display = Measurement.measured(1.0)
            elif display_text in ("disabled", "no", "false"):
                display = Measurement.measured(0.0)
            else:
                display = Measurement.unknown(f"display_active={parts[4]!r}")
            driver_model = (
                Measurement.measured(0.0) if parts[5] else Measurement.unknown("driver_model empty")
            )
            best_total = total.value
            best = GpuMemoryProbe(
                gpu_name=parts[0],
                total_mib=total,
                free_mib=_number(parts[2]),
                used_mib=_number(parts[3]),
                display_active=display,
                driver_model=driver_model,
            )
    if best is None:
        unknown = Measurement.unknown("nvidia-smi reported no usable GPU row")
        return GpuMemoryProbe("", unknown, unknown, unknown, unknown, unknown)
    return best


def probe_disk_free_gib(path: Optional[str] = None) -> Measurement:
    """M-12: 대상 드라이브의 여유 공간(GiB). 측정 실패는 ``unknown``."""
    target = path or os.getcwd()
    try:
        usage = shutil.disk_usage(target)
    except (OSError, ValueError) as exc:
        return Measurement.unknown(f"disk_usage failed for {target!r}: {exc}")
    return Measurement.measured(float(usage.free) / _BYTES_PER_GB)


def _runtime_candidates() -> Tuple[str, ...]:
    names = ("llama-server", "llama-cli", "llama-server.exe", "llama-cli.exe")
    return names


def probe_runtime(root: Optional[str] = None) -> Dict[str, Any]:
    """M-14: 추론 런타임 존재·빌드·종류·백엔드.

    ``llama-server``/``llama-cli``를 PATH와 ``root``에서 찾고 ``--version``을 한 번
    읽는다. 네트워크 호출은 하지 않는다.

    반환 dict의 ``kind``는 ``stock``(업스트림) 또는 ``prism_fork``(PrismML 포크)이고,
    ``backend``는 파일 이름/버전 문자열의 ``vulkan``/``cuda13``/``cuda12`` 표기에서
    읽는다. 표기가 없으면 ``None``이며, 선택기는 그 경우 보수적으로 거부한다.
    """
    search_dirs = []
    if root:
        search_dirs.append(root)
    for name in _runtime_candidates():
        found = shutil.which(name)
        if found:
            search_dirs.append(os.path.dirname(found))
    for directory in search_dirs:
        if not directory or not os.path.isdir(directory):
            continue
        for name in _runtime_candidates():
            candidate = os.path.join(directory, name)
            if os.path.isfile(candidate):
                version_text = _runtime_version_text(candidate)
                return {
                    "present": True,
                    "path": candidate,
                    "build": _runtime_build(version_text),
                    "kind": _runtime_kind(candidate, version_text),
                    "backend": _runtime_backend(candidate, version_text),
                }
    return {"present": False, "path": None, "build": None, "kind": None, "backend": None}


def _runtime_version_text(executable: str) -> str:
    run_kwargs: Dict[str, Any] = {}
    if os.name == "nt":
        run_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            [executable, "--version"],
            capture_output=True,
            text=True,
            timeout=_NVIDIA_SMI_TIMEOUT_SECONDS,
            check=False,
            **run_kwargs,
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        return ""
    return f"{completed.stdout or ''}\n{completed.stderr or ''}"


def _runtime_build(version_text: str) -> Optional[int]:
    match = _BUILD_PATTERN.search(version_text or "")
    return int(match.group(1)) if match else None


def _runtime_kind(executable: str, version_text: str) -> str:
    haystack = f"{os.path.basename(executable)} {version_text}".lower()
    return "prism_fork" if "prism" in haystack else "stock"


def _runtime_backend(executable: str, version_text: str) -> Optional[str]:
    """백엔드 표기. ``cuda13``은 포크가 크래시하는 경로라 별도 값으로 둔다."""
    haystack = f"{os.path.basename(executable)} {version_text}".lower()
    if "vulkan" in haystack:
        return "vulkan"
    if "cuda" in haystack:
        for major in _CUDA_VERSION_PATTERN.findall(haystack):
            return f"cuda{major}"
        return "cuda"
    if "avx" in haystack or "blas" in haystack:
        return "cpu"
    return None


def probe_weights(model_dir: Optional[str]) -> Measurement:
    """M-15(존재만): 모델 디렉터리에 GGUF 파일이 있는가. 해시 검증은 하지 않는다."""
    if not model_dir:
        return Measurement.unknown("no model directory is configured")
    try:
        if not os.path.isdir(model_dir):
            return Measurement.measured(0.0)
        for entry in os.scandir(model_dir):
            if entry.is_file() and entry.name.lower().endswith(".gguf"):
                return Measurement.measured(float(entry.stat().st_size))
    except OSError as exc:
        return Measurement.unknown(f"cannot read model directory {model_dir!r}: {exc}")
    return Measurement.measured(0.0)


def probe_hardware_profile(model_dir: Optional[str] = None, disk_path: Optional[str] = None) -> "HardwareProfile":
    """모든 프로브를 한 번에 실행해 :class:`HardwareProfile`로 묶는다."""
    spec = detect_hardware()
    memory = probe_gpu_memory()
    vram_total = (
        memory.total_mib.value / 1024.0
        if memory.total_mib.known and memory.total_mib.value is not None
        else None
    )
    vram_free = (
        memory.free_mib.value / 1024.0
        if memory.free_mib.known and memory.free_mib.value is not None
        else None
    )
    used = (
        memory.used_mib.value / 1024.0
        if memory.used_mib.known and memory.used_mib.value is not None
        else None
    )
    display = None if not memory.display_active.known else bool(memory.display_active.value)
    driver_model = None if not memory.driver_model.known else "wddm" if os.name == "nt" else "tcc"
    runtime = probe_runtime()
    weights = probe_weights(model_dir)
    disk = probe_disk_free_gib(disk_path)
    return HardwareProfile(
        vendor="nvidia" if spec.has_gpu else "unknown",
        gpu_name=spec.gpu_name or memory.gpu_name,
        vram_total_gib=vram_total,
        vram_free_gib=vram_free,
        os_reserved_gib=used,
        display_attached=display,
        driver_model=driver_model,
        ram_total_gib=spec.ram_gb if spec.ram_gb > 0 else None,
        cpu_logical=spec.cpu_cores,
        cpu_physical=None,
        disk_free_gib=disk.value if disk.known else None,
        runtime_present=bool(runtime["present"]),
        runtime_build=runtime["build"],
        runtime_kind=runtime["kind"],
        runtime_backend=runtime["backend"],
        runtime_path=runtime["path"],
        weights_present=(weights.value > 0) if weights.known and weights.value is not None else None,
        vram_total=Measurement.measured(vram_total) if vram_total is not None else Measurement.unknown(
            memory.total_mib.reason
        ),
        vram_free=Measurement.measured(vram_free) if vram_free is not None else Measurement.unknown(
            memory.free_mib.reason
        ),
        ram_total=(
            Measurement.measured(spec.ram_gb) if spec.ram_gb > 0
            else Measurement.unknown("system RAM could not be measured")
        ),
        disk_free=disk,
        weights=weights,
    )


@dataclass
class HardwareProfile:
    """설계문서 §6.2의 주입 가능한 프로필.

    ``*_gib`` 필드는 ``None``이면 "측정하지 못함"이고 0이 아니다.
    """
    vendor: str
    gpu_name: str = ""
    vram_total_gib: Optional[float] = None
    vram_free_gib: Optional[float] = None
    os_reserved_gib: Optional[float] = None
    display_attached: Optional[bool] = None
    driver_model: Optional[str] = None
    ram_total_gib: Optional[float] = None
    ram_available_gib: Optional[float] = None
    cpu_logical: int = 1
    cpu_physical: Optional[int] = None
    disk_free_gib: Optional[float] = None
    runtime_present: bool = False
    runtime_build: Optional[int] = None
    runtime_path: Optional[str] = None
    weights_present: Optional[bool] = None
    vram_total: Optional[Measurement] = None
    vram_free: Optional[Measurement] = None
    ram_total: Optional[Measurement] = None

    @property
    def is_discrete_gpu(self) -> bool:
        return bool(self.gpu_name) and self.vram_total_gib is not None and self.vram_total_gib > 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "vendor": self.vendor,
            "gpu_name": self.gpu_name,
            "vram_total_gib": self.vram_total_gib,
            "vram_free_gib": self.vram_free_gib,
            "os_reserved_gib": self.os_reserved_gib,
            "display_attached": self.display_attached,
            "driver_model": self.driver_model,
            "ram_total_gib": self.ram_total_gib,
            "ram_available_gib": self.ram_available_gib,
            "cpu_logical": int(self.cpu_logical),
            "cpu_physical": self.cpu_physical,
            "disk_free_gib": self.disk_free_gib,
            "runtime_present": self.runtime_present,
            "runtime_build": self.runtime_build,
            "runtime_path": self.runtime_path,
            "weights_present": self.weights_present,
            "vram_total": self.vram_total.to_dict() if self.vram_total else None,
            "vram_free": self.vram_free.to_dict() if self.vram_free else None,
            "ram_total": self.ram_total.to_dict() if self.ram_total else None,
        }


# ---------------------------------------------------------------------------
# 2) 로컬 실행 티어
# ---------------------------------------------------------------------------
class LocalExecutionTier(str, Enum):
    """로컬 LLM 실행 역량 4단계(문자열 값은 설정/로그에 그대로 기록된다)."""
    RULE_BASED_ONLY = "rule_based_only"
    LIGHTWEIGHT_LOCAL = "lightweight_local"
    STANDARD_LOCAL = "standard_local"
    ADVANCED_LOCAL = "advanced_local"

    def __str__(self) -> str:  # pragma: no cover - 표시 형식
        return self.value

    @property
    def level(self) -> int:
        """0~3 정수 순위(상위 티어 비교용)."""
        return _TIER_LEVEL[self]

    @classmethod
    def parse(cls, value: Any) -> "LocalExecutionTier":
        """문자열/정수/별칭을 티어로 정규화한다."""
        return parse_tier(value)

    def __lt__(self, other: Any) -> bool:
        coerced = _compare_operand(other)
        if coerced is None:
            return NotImplemented
        return self.level < coerced.level

    def __le__(self, other: Any) -> bool:
        coerced = _compare_operand(other)
        if coerced is None:
            return NotImplemented
        return self.level <= coerced.level

    def __gt__(self, other: Any) -> bool:
        coerced = _compare_operand(other)
        if coerced is None:
            return NotImplemented
        return self.level > coerced.level

    def __ge__(self, other: Any) -> bool:
        coerced = _compare_operand(other)
        if coerced is None:
            return NotImplemented
        return self.level >= coerced.level


_TIER_SEQUENCE: Tuple[LocalExecutionTier, ...] = (
    LocalExecutionTier.RULE_BASED_ONLY,
    LocalExecutionTier.LIGHTWEIGHT_LOCAL,
    LocalExecutionTier.STANDARD_LOCAL,
    LocalExecutionTier.ADVANCED_LOCAL,
)
_TIER_LEVEL: Dict[LocalExecutionTier, int] = {tier: level for level, tier in enumerate(_TIER_SEQUENCE)}

#: 사용자 입력 허용 별칭 (설정 파일/CLI 인자에서 흔히 쓰는 표기)
_TIER_ALIASES: Dict[str, LocalExecutionTier] = {
    "none": LocalExecutionTier.RULE_BASED_ONLY,
    "no_local": LocalExecutionTier.RULE_BASED_ONLY,
    "rule_based": LocalExecutionTier.RULE_BASED_ONLY,
    "rules": LocalExecutionTier.RULE_BASED_ONLY,
    "cpu": LocalExecutionTier.RULE_BASED_ONLY,
    "lightweight": LocalExecutionTier.LIGHTWEIGHT_LOCAL,
    "slm": LocalExecutionTier.LIGHTWEIGHT_LOCAL,
    "small": LocalExecutionTier.LIGHTWEIGHT_LOCAL,
    "standard": LocalExecutionTier.STANDARD_LOCAL,
    "medium": LocalExecutionTier.STANDARD_LOCAL,
    "advanced": LocalExecutionTier.ADVANCED_LOCAL,
    "large": LocalExecutionTier.ADVANCED_LOCAL,
}

#: 각 티어가 우선 사용하는 로컬 프리셋 ID (registry 카탈로그와 동일한 키)
LOCAL_TIER_MODEL_IDS: Dict[LocalExecutionTier, Optional[str]] = {
    LocalExecutionTier.RULE_BASED_ONLY: None,
    LocalExecutionTier.LIGHTWEIGHT_LOCAL: "local/qwen2.5-coder-1.5b-gguf",
    LocalExecutionTier.STANDARD_LOCAL: "local/qwen2.5-coder-7b-gguf",
    LocalExecutionTier.ADVANCED_LOCAL: "local/bonsai-2-27b-pq2",
}

#: 티어별 권장 양자화(4비트 K-quant 혼합: 품질 손실 최소 + VRAM/램 절감)
#: Tier 3는 삼진(Ternary) PQ2_0: 27B 밀집 모델을 2.13 bpw(VRAM 6.7GB)로 적재한다.
LOCAL_TIER_QUANTIZATION: Dict[LocalExecutionTier, str] = {
    LocalExecutionTier.RULE_BASED_ONLY: "none (로컬 LLM 미사용)",
    LocalExecutionTier.LIGHTWEIGHT_LOCAL: "Q4_K_M",
    LocalExecutionTier.STANDARD_LOCAL: "Q4_K_M",
    LocalExecutionTier.ADVANCED_LOCAL: "PQ2_0 (Ternary 2.13 bpw, VRAM 6.7GB)",
}

#: 티어별 추천 요약(모델/컨텍스트/처리량 한 줄 요약)
LOCAL_TIER_RECOMMENDATIONS: Dict[LocalExecutionTier, str] = {
    LocalExecutionTier.RULE_BASED_ONLY: "로컬 LLM 없이 규칙 기반 처리 (LLM 호출은 클라우드 flash)",
    LocalExecutionTier.LIGHTWEIGHT_LOCAL: "Qwen2.5-Coder-1.5B~3B (Q4_K_M, 32K context, 120+ tok/s)",
    LocalExecutionTier.STANDARD_LOCAL: "Qwen2.5-Coder-7B (Q4_K_M, 65K context, ~60 tok/s)",
    LocalExecutionTier.ADVANCED_LOCAL: (
        "Bonsai-2-27B (Ternary, 262K context, 85 tok/s) — Tier 3 플래그십"
    ),
}


def parse_tier(value: Any) -> LocalExecutionTier:
    """문자열(``tier2``, ``standard_local``, ``7b`` 등)/정수(0~3)/별칭을 티어로 변환."""
    if isinstance(value, LocalExecutionTier):
        return value
    if isinstance(value, bool):
        raise TypeError(f"불리언은 로컬 실행 티어가 아닙니다: {value!r}")
    if isinstance(value, int):
        if 0 <= value < len(_TIER_SEQUENCE):
            return _TIER_SEQUENCE[value]
        raise ValueError(f"로컬 실행 티어 범위를 벗어났습니다(0~3): {value!r}")

    text = str(value).strip().lower().replace("-", "_").replace(" ", "_")
    for tier in _TIER_SEQUENCE:
        if text == tier.value:
            return tier
    if text.startswith("tier"):
        text = text[4:]
    if text in _TIER_ALIASES:
        return _TIER_ALIASES[text]
    if text.isdigit():
        return parse_tier(int(text))
    raise ValueError(f"알 수 없는 로컬 실행 티어입니다: {value!r}")


def _compare_operand(other: Any) -> Optional[LocalExecutionTier]:
    try:
        return parse_tier(other)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class LocalExecutionTierInfo:
    """티어 판정 결과 + 실행 권장안(모델군/양자화/하이브리드 라우팅)."""
    tier: LocalExecutionTier
    recommended_models: Tuple[str, ...]
    quantization: str
    hybrid_routing_strategy: str
    registry_model_id: Optional[str] = None
    hardware: Optional[HardwareSpec] = None
    capability_tier: Optional[LocalExecutionTier] = None
    override_applied: bool = False

    @property
    def tier_value(self) -> str:
        return self.tier.value

    @property
    def tier_level(self) -> int:
        return self.tier.level

    @property
    def uses_local_llm(self) -> bool:
        """로컬 LLM을 실제로 구동할 수 있는 티어인지 여부."""
        return self.tier is not LocalExecutionTier.RULE_BASED_ONLY and self.registry_model_id is not None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "tier": self.tier.value,
            "tier_level": self.tier.level,
            "recommended_models": list(self.recommended_models),
            "quantization": self.quantization,
            "hybrid_routing_strategy": self.hybrid_routing_strategy,
            "registry_model_id": self.registry_model_id,
            "uses_local_llm": self.uses_local_llm,
            "capability_tier": self.capability_tier.value if self.capability_tier else None,
            "override_applied": self.override_applied,
            "hardware": self.hardware.to_dict() if self.hardware else None,
        }

    def __str__(self) -> str:
        return f"{self.tier.value} ({self.quantization})"


#: 티어별 권장 모델군 및 하이브리드 라우팅 전략 (한국어 설명 포함)
_TIER_PROFILES: Dict[LocalExecutionTier, Dict[str, Any]] = {
    LocalExecutionTier.RULE_BASED_ONLY: {
        "models": (),
        "strategy": (
            "로컬 LLM 미사용. AST 슬라이싱 + 정규식/규칙 기반으로 즉시 처리하고, "
            "LLM 추론이 필요한 순간에만 클라우드 DeepSeek Flash를 호출한다(로컬 VRAM/RAM 오버헤드 0)."
        ),
    },
    LocalExecutionTier.LIGHTWEIGHT_LOCAL: {
        "models": (
            "Qwen2.5-Coder-1.5B-Instruct",
            "Qwen2.5-Coder-3B-Instruct",
            "DeepSeek-R1-Distill-Qwen-1.5B",
        ),
        "strategy": (
            "Fast-Path, AST 심볼 트리아지, 경량 분류, 단문 코드 생성은 1.5B~3B SLM을 로컬(GGUF/llama.cpp/"
            "Ollama)에서 $0 지연 실행하고, 복잡한 구현/조사는 2-Track 클라우드 파이프라인으로 승격한다."
        ),
    },
    LocalExecutionTier.STANDARD_LOCAL: {
        "models": (
            "Qwen2.5-Coder-7B-Instruct",
            "Llama-3.1-8B-Instruct",
        ),
        "strategy": (
            "Fast-Path, 직접 코드 생성, 1차 로컬 조사(survey)를 7B~8B 4bit 모델로 로컬 처리하고, "
            "고난도 설계/보안 검증/대형 컨텍스트만 클라우드 상위 모델로 하이브리드 위임한다."
        ),
    },
    LocalExecutionTier.ADVANCED_LOCAL: {
        "models": (
            "Qwen2.5-Coder-14B-Instruct",
            "Qwen2.5-Coder-32B-Instruct",
        ),
        "strategy": (
            "계획 -> 구현 -> 1차 검증까지 로컬 14B~32B 모델로 완결하는 로컬 실행 파이프라인을 기본으로 하고, "
            "초고난도/초대형 컨텍스트/보안 감사만 클라우드로 위임한다."
        ),
    },
}


def _classify_hardware(spec: HardwareSpec) -> LocalExecutionTier:
    """측정 사양을 티어로 사상한다(상위 티어 조건부터 결정론적으로 평가)."""
    ram = float(spec.ram_gb or 0.0)
    vram = float(spec.vram_gb or 0.0) if spec.has_gpu else 0.0

    if ram >= 32.0 and vram >= 12.0:
        return LocalExecutionTier.ADVANCED_LOCAL
    if ram >= 16.0 or vram >= 6.0:
        return LocalExecutionTier.STANDARD_LOCAL
    if ram >= 8.0 or vram >= 2.0:
        return LocalExecutionTier.LIGHTWEIGHT_LOCAL
    return LocalExecutionTier.RULE_BASED_ONLY


def determine_local_tier(
    spec: HardwareSpec,
    override_tier: Optional[str] = None,
) -> LocalExecutionTierInfo:
    """하드웨어 사양(및 선택적 사용자 override)으로부터 실행 티어 권장안을 만든다.

    ``override_tier``는 사용자가 명시한 강제 티어(예: 원격 Ollama 서버를 쓰는 경우)이며,
    하드웨어 판정값과 무관하게 그대로 적용된다. 대신 ``capability_tier``에 하드웨어가
    실제로 감당 가능한 티어를 함께 기록해 호출자가 진단에 사용할 수 있게 한다.
    """
    capability = _classify_hardware(spec)
    override_applied = override_tier is not None
    tier = parse_tier(override_tier) if override_applied else capability
    profile = _TIER_PROFILES[tier]
    return LocalExecutionTierInfo(
        tier=tier,
        recommended_models=tuple(profile["models"]),
        quantization=LOCAL_TIER_QUANTIZATION[tier],
        hybrid_routing_strategy=str(profile["strategy"]),
        registry_model_id=LOCAL_TIER_MODEL_IDS.get(tier),
        hardware=spec,
        capability_tier=capability,
        override_applied=override_applied,
    )

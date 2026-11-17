"""하드웨어 예산 산술 + 결정론적 로컬 모델 선택기 (pure functions, no I/O).

이 모듈은 측정하지 않는다. 측정은 ``hardware_profiler``가 하고, 여기서는
``MachineProfile``(측정값)과 ``ModelRequirement``(카탈로그 요구량)만 받아
``SelectionDecision`` 또는 ``Unavailable``을 결정론적으로 돌려준다. 같은 입력은
항상 같은 출력을 내며, 카탈로그를 model_id로 정렬해 순회하므로 입력 순서가
결과를 바꾸지 않는다. 난수·시계·네트워크·파일 접근은 없다.

세 가지 규칙이 모든 판정을 지배한다.

1. **WDDM 스필은 예산이 아니라 거부 사유다.** 사용 가능 VRAM은 항상
   ``min(total - os_reserved, free) - safety``이며 시스템 RAM을 예산에 더하지
   않는다. 들어가지 않는 구성은 ``Unavailable``이다. "아마 들어갈 것"으로
   적재하지 않는다.
2. **양자화는 런타임 요구를 함께 갖는다.** Bonsai 2의 Q2_0는 stock llama.cpp
   b11556 이상이 필요하고, PQ2_0/PTQ1_0은 PrismML 포크(ggml type 142/143)가
   필요하다. 포크의 자체 매트릭스는 PQ2_0가 Vulkan에서 실패해 2 tok/s 미만의
   CPU로 조용히 폴백한다고 적고, CUDA 13.x 빌드는 KNOWN_ISSUES에 따라 일부
   시스템에서 크래시한다. 따라서 선택기는 "지금 있는 런타임이 적재할 수 없는
   조합"을 고르지 않는다.
3. **상주 쌍의 런타임 버퍼는 하나로 계산한다.** 이 PC에서 관측된 앵커
   (7B+1.5B = 6.4 GiB, 7B+3B = 7.2–7.4 GiB)를 재현하는 유일한 계산이
   ``max(buffer_fore, buffer_bg)`` 하나를 더하는 것이다. 버퍼를 두 번 더하면 두
   앵커가 모두 0.45 GiB씩 초과한다. Bonsai 2 계열의 1.21 GiB 버퍼는 그 계열
   프로세스의 값이므로, 쌍의 버퍼는 두 값 중 큰 쪽이다.

검증된 Bonsai 2 가중치 크기(Hugging Face 파일 목록의 정확한 byte 수)와 아키텍처에서
계산한 KV/token은 카탈로그 데이터이며, 이 모듈이 만들어 내는 값이 아니다.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Dict, Optional, Sequence, Tuple, Union

MIB = 1 << 20
GIB = 1 << 30

# ---------------------------------------------------------------------------
# 릴리스 파라미터 (설계문서 §2.6) — 측정값이 아니다
# ---------------------------------------------------------------------------
P_VRAM_SAFETY_OFF_DGPU_BYTES = GIB // 2          # 0.5 GiB
P_VRAM_SAFETY_ON_DGPU_BYTES = GIB                # 1.0 GiB
#: 일반 GGUF(stock llama.cpp) 프로세스의 런타임 버퍼. 7B Q4_K_M + 1.5B 조합의
#: 실측 점유 6.4 GiB를 재현하는 값이다.
P_RUNTIME_OVERHEAD_BYTES = (GIB * 45) // 100     # 0.45 GiB
#: Bonsai 2 계열(Prism 런타임)의 프로세스 버퍼. 벤더 계산
#: 2.381 GiB(9B Q2_0) + 1.00 GiB(KV 32K) + 1.21 GiB = 4.59 GiB 에서 온 값이다.
BONSAI_RUNTIME_BUFFER_BYTES = (GIB * 121) // 100  # 1.21 GiB
P_CO_RESIDENT_MARGIN_BYTES = GIB // 2            # 0.5 GiB
P_RAM_RESERVE_BYTES = 6 * GIB                    # 6.0 GiB
P_DISK_RESERVE_BYTES = 5 * GIB                   # 5.0 GiB
P_CTX_FLOOR = 4096
#: 포그라운드 하한. 16K 미만 컨텍스트는 저장소 규모 코딩에 못 쓰므로, 8 GB에서
#: 27B PTQ1_0이 확보하는 약 8.5K는 "포그라운드로 부를 수 없는" 값이다.
P_CTX_FG_MIN = 16384
P_CTX_CEIL_FG = 65536
#: 백그라운드 상한 = 벤더가 계산한 9B 32K 조합과 같은 값.
P_CTX_CEIL_BG = 32768
P_CTX_CEIL_CPU = 8192
P_KV_TYPE = "f16"
P_BG_SWAP_ALLOWED = True

#: M-03 폴백: 유휴 예약분을 측정하지 못했을 때의 실측값 232 MiB.
DEFAULT_OS_RESERVED_BYTES = 232 * MIB

#: 백그라운드 트랙 전용 역할(``registry.BACKGROUND_TASK_ROLES``와 동일 집합).
BACKGROUND_ROLE_NAMES = frozenset({"background_worker", "memory_distiller", "compactor"})
#: Only the auxiliary plane assigns these roles; no coder role exists for them.
AUX_ROLE_NAMES = frozenset({"session_titler", "query_rewriter"})
EMBEDDING_ROLE_NAMES = frozenset({"embedding"})
#: Every role that may never be a foreground coder, for any declaration path.
LOCAL_JOB_ROLE_NAMES = BACKGROUND_ROLE_NAMES | AUX_ROLE_NAMES | EMBEDDING_ROLE_NAMES

SIZE_CLASS_ORDER: Dict[str, int] = {"small": 0, "medium": 1, "large": 2}

STATUS_READY_LOCAL = "ready_local"
STATUS_READY_LOCAL_SLOW = "ready_local_slow"
STATUS_LOCAL_NO_FIT = "local_no_fit"
STATUS_LOCAL_FIT_PARTIAL = "local_fit_partial"
STATUS_LOCAL_MEASUREMENT_UNKNOWN = "local_measurement_unknown"
STATUS_LOCAL_UNPROVISIONED = "local_unprovisioned"
STATUS_CATALOG_EMPTY = "catalog_empty"

REASON_CATALOG_EMPTY = "catalog_empty"
REASON_CATALOG_INCOMPLETE = "catalog_incomplete"
REASON_CATALOG_PENDING = "catalog_pending_confirmation"
REASON_WEIGHTS_MISSING = "weights_missing"
REASON_WEIGHTS_UNCONFIRMED = "weights_unconfirmed"
REASON_RUNTIME_ABSENT = "runtime_absent"
REASON_RUNTIME_KIND = "runtime_kind_unsupported"
REASON_RUNTIME_TOO_OLD = "runtime_too_old"
REASON_RUNTIME_VERSION_UNKNOWN = "runtime_version_unknown"
REASON_RUNTIME_BACKEND = "runtime_backend_unsupported"
REASON_RUNTIME_BACKEND_UNKNOWN = "runtime_backend_unknown"
REASON_VRAM_UNKNOWN = "vram_unknown"
REASON_RAM_UNKNOWN = "ram_unknown"
REASON_BUDGET_EXHAUSTED = "budget_exhausted"
REASON_FOREGROUND_ROLE_MISSING = "foreground_role_missing"
REASON_FOREGROUND_NOT_IN_CATALOG = "foreground_not_in_catalog"
REASON_WEIGHTS_OVER_BUDGET = "weights_over_budget"
REASON_CONTEXT_FLOOR = "context_below_floor"
REASON_NO_FIT = "no_fit"
REASON_BACKGROUND_OFF = "background_off"

#: 양자화가 요구하는 런타임 종류. ``stock``은 llama.cpp 업스트림,
#: ``prism_fork``는 ggml type 142/143을 이해하는 PrismML 빌드다.
RUNTIME_NONE = "none"
RUNTIME_STOCK = "stock"
RUNTIME_PRISM_FORK = "prism_fork"
RUNTIME_KINDS = (RUNTIME_NONE, RUNTIME_STOCK, RUNTIME_PRISM_FORK)

#: stock llama.cpp가 Q2_0(Prism merge)를 이해하기 시작한 빌드 번호.
STOCK_MIN_BUILD_Q2_0 = 11556

#: 포크 경로에서 쓰지 않는 백엔드. Vulkan은 PQ2_0가 실패하고(2 tok/s 미만 CPU
#: 폴백), CUDA 13.x는 KNOWN_ISSUES에 따라 일부 시스템에서 크래시한다. 이 머신의
#: 드라이버가 CUDA UMD 13.4를 노출해도 안전한 경로는 CUDA 12.4 빌드 하나뿐이다.
PRISM_FORK_BLOCKED_BACKENDS: Tuple[str, ...] = ("vulkan", "cuda13")

RESIDENCY_CO_RESIDENT = "co_resident"
RESIDENCY_SWAP = "swap"
RESIDENCY_BACKGROUND_OFF = "background_off"
RESIDENCY_STANDALONE = "standalone"

__all__ = [
    "Accelerator",
    "MachineProfile",
    "ModelRequirement",
    "ResidentRequest",
    "CoResidency",
    "SelectionDecision",
    "Unavailable",
    "resident_cost",
    "co_resident_ok",
    "select",
    "kv_bytes",
    "runtime_block_reason",
    "MIB",
    "GIB",
    "BACKGROUND_ROLE_NAMES",
    "AUX_ROLE_NAMES",
    "EMBEDDING_ROLE_NAMES",
    "LOCAL_JOB_ROLE_NAMES",
    "RESIDENCY_STANDALONE",
    "P_CTX_FLOOR",
    "P_CTX_FG_MIN",
    "P_CTX_CEIL_FG",
    "P_CTX_CEIL_BG",
    "P_CTX_CEIL_CPU",
    "P_RUNTIME_OVERHEAD_BYTES",
    "BONSAI_RUNTIME_BUFFER_BYTES",
    "P_CO_RESIDENT_MARGIN_BYTES",
    "P_VRAM_SAFETY_ON_DGPU_BYTES",
    "P_VRAM_SAFETY_OFF_DGPU_BYTES",
    "DEFAULT_OS_RESERVED_BYTES",
    "P_RAM_RESERVE_BYTES",
    "RUNTIME_STOCK",
    "RUNTIME_PRISM_FORK",
    "STOCK_MIN_BUILD_Q2_0",
    "PRISM_FORK_BLOCKED_BACKENDS",
    "RESIDENCY_CO_RESIDENT",
    "RESIDENCY_SWAP",
    "RESIDENCY_BACKGROUND_OFF",
]


class Accelerator(str, Enum):
    """가속기 종류. iGPU와 없음은 모두 RAM 예산으로만 판정한다."""

    DISCRETE_GPU = "discrete_gpu"
    INTEGRATED_GPU = "integrated_gpu"
    NONE = "none"


def kv_bytes(kv_bytes_per_token: int, context_tokens: int) -> int:
    """컨텍스트 길이에 대한 KV 캐시 크기(bytes)."""
    return int(kv_bytes_per_token) * int(context_tokens)


def resident_cost(
    weights_bytes: int,
    kv_per_token: int,
    context_tokens: int,
    overhead_bytes: int = P_RUNTIME_OVERHEAD_BYTES,
) -> int:
    """모델 하나를 ``context_tokens``로 올릴 때의 점유 bytes.

    ``weights + kv + runtime overhead``. 음수 입력은 호출자의 프로그래밍 오류이며,
    요구량을 조용히 줄이지 않도록 예외를 던진다.
    """
    weights = int(weights_bytes)
    per_token = int(kv_per_token)
    ctx = int(context_tokens)
    overhead = int(overhead_bytes)
    if weights < 0 or per_token < 0 or ctx < 0 or overhead < 0:
        raise ValueError("resident cost inputs must be non-negative")
    return weights + per_token * ctx + overhead


@dataclass(frozen=True)
class ResidentRequest:
    """상주 판정에 넣을 모델 하나 + 컨텍스트."""

    model_id: str
    weights_bytes: int
    kv_per_token: int
    context_tokens: int

    @classmethod
    def from_requirement(cls, entry: "ModelRequirement", context_tokens: int) -> "ResidentRequest":
        if entry.weights_bytes is None or entry.kv_bytes_per_token is None:
            raise ValueError(f"{entry.model_id} has no verified requirement fields")
        return cls(entry.model_id, entry.weights_bytes, entry.kv_bytes_per_token, context_tokens)

    @property
    def cost_bytes(self) -> int:
        return resident_cost(self.weights_bytes, self.kv_per_token, self.context_tokens, 0)


@dataclass(frozen=True)
class CoResidency:
    """상주 산술과 그 판정.

    ``status``는 ``co_resident``(잔여 >= 마진), ``marginal``(0 <= 잔여 < 마진),
    ``over_budget``(잔여 < 0) 중 하나다. 참인 것은 ``co_resident``뿐이며,
    ``marginal``은 "적재는 되지만 이 릴리스가 요구하는 마진을 남기지 못함"이므로
    답은 swap이다(스필로 적재하지 않는다).
    """

    ok: bool
    status: str
    budget_bytes: int
    used_bytes: int
    margin_bytes: int
    remaining_bytes: int
    overhead_bytes: int
    models: Tuple[str, ...]

    @property
    def over_budget(self) -> bool:
        return self.remaining_bytes < 0

    def __bool__(self) -> bool:
        return self.ok

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "budget_gib": _gib(self.budget_bytes),
            "used_gib": _gib(self.used_bytes),
            "margin_gib": _gib(self.margin_bytes),
            "remaining_gib": _gib(self.remaining_bytes),
            "overhead_gib": _gib(self.overhead_bytes),
            "models": list(self.models),
        }


def co_resident_ok(
    budget_bytes: int,
    models: Sequence[ResidentRequest],
    margin_bytes: int = P_CO_RESIDENT_MARGIN_BYTES,
    overhead_bytes: int = P_RUNTIME_OVERHEAD_BYTES,
) -> CoResidency:
    """두 개 이상의 모델이 함께 상주할 수 있는가.

    정확한 산술::

        used      = sum(weights_i + kv_per_token_i * ctx_i) + overhead
        remaining = budget - used
        ok        = remaining >= margin

    ``overhead``는 상주 집합에 한 번 더한다(프로세스 하나가 두 슬롯을 들고 있는
    구성이며, 이 PC의 실측 앵커가 그 계산과 일치한다). 모델이 하나뿐이면 상주
    질문이 아니므로 ``ValueError``.
    """
    requests = tuple(models)
    if len(requests) < 2:
        raise ValueError("co-residency needs at least two models")
    budget = int(budget_bytes)
    margin = int(margin_bytes)
    overhead = int(overhead_bytes)
    if budget < 0 or margin < 0 or overhead < 0:
        raise ValueError("co-residency inputs must be non-negative")
    used = sum(item.cost_bytes for item in requests) + overhead
    remaining = budget - used
    if remaining < 0:
        status = "over_budget"
    elif remaining < margin:
        status = "marginal"
    else:
        status = "co_resident"
    return CoResidency(
        ok=status == "co_resident",
        status=status,
        budget_bytes=budget,
        used_bytes=used,
        margin_bytes=margin,
        remaining_bytes=remaining,
        overhead_bytes=overhead,
        models=tuple(item.model_id for item in requests),
    )


@dataclass(frozen=True)
class ModelRequirement:
    """카탈로그 항목 하나의 적재 요구량.

    ``weights_bytes``/``kv_bytes_per_token``이 ``None``이면 실제 파일로 검증되지
    않은 값이라는 뜻이며, 추정하지 않고 ``catalog_incomplete``로 제외한다.
    """

    model_id: str
    weights_bytes: Optional[int]
    kv_bytes_per_token: Optional[int]
    min_context: int
    context_window: int
    size_class: str = "small"
    roles: Tuple[str, ...] = ()
    bg_approved: bool = False
    aux_approved: bool = False
    license: Optional[str] = None
    quant_label: Optional[str] = None
    runtime_kind: str = RUNTIME_STOCK
    runtime_min_build: Optional[int] = None
    runtime_buffer_bytes: int = P_RUNTIME_OVERHEAD_BYTES
    pending_confirmation: bool = False
    weights_basis: str = "distributor_listing"
    benchmark_note: Optional[str] = None

    def missing_fields(self) -> Tuple[str, ...]:
        """적재 판정에 필요한데 없거나 쓸 수 없는 필드."""
        missing = []
        if self.weights_bytes is None or self.weights_bytes <= 0:
            missing.append("weights_bytes")
        if self.kv_bytes_per_token is None or self.kv_bytes_per_token <= 0:
            missing.append("kv_bytes_per_token")
        if self.min_context <= 0 or self.context_window <= 0:
            missing.append("context")
        if not self.license:
            missing.append("license")
        return tuple(missing)

    @property
    def is_complete(self) -> bool:
        return not self.missing_fields()

    def supports_role(self, role: str) -> bool:
        return role in self.roles

    @property
    def declares_background_role(self) -> bool:
        return bool(set(self.roles) & BACKGROUND_ROLE_NAMES)

    @property
    def foreground_eligible(self) -> bool:
        """A coder must declare a role outside background, aux and embedding jobs."""
        return bool(set(self.roles) - LOCAL_JOB_ROLE_NAMES)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "model_id": self.model_id,
            "weights_bytes": self.weights_bytes,
            "weights_gib": _gib(self.weights_bytes),
            "kv_bytes_per_token": self.kv_bytes_per_token,
            "min_context": self.min_context,
            "context_window": self.context_window,
            "size_class": self.size_class,
            "roles": list(self.roles),
            "bg_approved": self.bg_approved,
            "aux_approved": self.aux_approved,
            "license": self.license,
            "quant_label": self.quant_label,
            "runtime_kind": self.runtime_kind,
            "runtime_min_build": self.runtime_min_build,
            "runtime_buffer_bytes": self.runtime_buffer_bytes,
            "pending_confirmation": self.pending_confirmation,
            "weights_basis": self.weights_basis,
            "benchmark_note": self.benchmark_note,
        }


def runtime_block_reason(entry: "ModelRequirement", machine: "MachineProfile") -> Optional[str]:
    """이 양자화를 이 런타임이 적재할 수 없으면 사유 코드를, 가능하면 ``None``.

    런타임 종류/빌드가 확인되지 않으면 낙관적으로 통과시키지 않는다.

    * ``prism_fork`` 양자화(PQ2_0/PTQ1_0)는 포크 빌드에서만 적재되고, Vulkan과
      CUDA 13.x 백엔드는 벤더 매트릭스/KNOWN_ISSUES에 따라 거부한다.
    * ``stock`` 양자화(Q2_0)는 stock b11556 이상 또는 포크에서 적재된다.
    """
    kind = entry.runtime_kind
    if kind == RUNTIME_PRISM_FORK:
        if machine.runtime_kind != RUNTIME_PRISM_FORK:
            return REASON_RUNTIME_KIND
        if machine.runtime_backend is None:
            return REASON_RUNTIME_BACKEND_UNKNOWN
        if machine.runtime_backend in PRISM_FORK_BLOCKED_BACKENDS:
            return REASON_RUNTIME_BACKEND
    elif kind == RUNTIME_STOCK:
        if machine.runtime_kind not in (RUNTIME_STOCK, RUNTIME_PRISM_FORK):
            return REASON_RUNTIME_KIND
    else:
        return REASON_RUNTIME_KIND

    if entry.runtime_min_build is not None:
        if machine.runtime_build is None:
            return REASON_RUNTIME_VERSION_UNKNOWN
        if machine.runtime_build < entry.runtime_min_build:
            return REASON_RUNTIME_TOO_OLD
    return None


@dataclass(frozen=True)
class MachineProfile:
    """측정된 예산. ``None``은 "0"이 아니라 "측정하지 못함"이다."""

    accelerator: Accelerator
    vram_total_bytes: Optional[int] = None
    vram_free_bytes: Optional[int] = None
    os_reserved_bytes: Optional[int] = None
    display_attached: Optional[bool] = None
    ram_total_bytes: Optional[int] = None
    ram_available_bytes: Optional[int] = None
    cpu_physical_cores: int = 1
    gpu_name: str = ""
    driver_model: Optional[str] = None
    disk_free_bytes: Optional[int] = None
    runtime_present: bool = False
    runtime_kind: Optional[str] = RUNTIME_NONE
    runtime_build: Optional[int] = None
    runtime_backend: Optional[str] = None
    weights_present: Optional[bool] = None

    @property
    def os_reserved(self) -> Tuple[int, bool]:
        """``(bytes, assumed)`` — M-03 실패 시 실측 232 MiB로 대체한다."""
        if self.os_reserved_bytes is None:
            return (DEFAULT_OS_RESERVED_BYTES, True)
        return (max(0, int(self.os_reserved_bytes)), False)

    @property
    def display_on_gpu(self) -> bool:
        """디스플레이 연결을 모르면 연결된 것으로 간주한다(보수적, M-10)."""
        return True if self.display_attached is None else bool(self.display_attached)

    @property
    def safety_bytes(self) -> int:
        return P_VRAM_SAFETY_ON_DGPU_BYTES if self.display_on_gpu else P_VRAM_SAFETY_OFF_DGPU_BYTES

    def vram_usable_bytes(self) -> Optional[int]:
        """안전 여유를 빼기 전의 여유. 측정 불가면 ``None``."""
        if self.vram_total_bytes is None:
            return None
        reserved, _ = self.os_reserved
        headroom = int(self.vram_total_bytes) - reserved
        if self.vram_free_bytes is not None:
            headroom = min(headroom, max(0, int(self.vram_free_bytes)))
        return max(0, headroom)

    def vram_budget_bytes(self) -> Optional[int]:
        usable = self.vram_usable_bytes()
        if usable is None:
            return None
        return max(0, usable - self.safety_bytes)

    def ram_budget_bytes(self) -> Optional[int]:
        if self.ram_total_bytes is None:
            return None
        return max(0, int(self.ram_total_bytes) - P_RAM_RESERVE_BYTES)

    @property
    def load_path(self) -> str:
        """``vram``은 dGPU일 때만. iGPU/없음은 ``ram``."""
        return "vram" if self.accelerator is Accelerator.DISCRETE_GPU else "ram"

    @property
    def threads(self) -> int:
        return max(1, int(self.cpu_physical_cores) - 2)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "accelerator": self.accelerator.value,
            "gpu_name": self.gpu_name,
            "vram_total_gib": _gib(self.vram_total_bytes),
            "vram_free_gib": _gib(self.vram_free_bytes),
            "os_reserved_gib": _gib(self.os_reserved_bytes),
            "os_reserved_assumed": self.os_reserved[1],
            "display_attached": self.display_attached,
            "vram_budget_gib": _gib(self.vram_budget_bytes()),
            "ram_total_gib": _gib(self.ram_total_bytes),
            "ram_budget_gib": _gib(self.ram_budget_bytes()),
            "disk_free_gib": _gib(self.disk_free_bytes),
            "load_path": self.load_path,
            "driver_model": self.driver_model,
            "runtime_present": self.runtime_present,
            "runtime_kind": self.runtime_kind,
            "runtime_build": self.runtime_build,
            "runtime_backend": self.runtime_backend,
            "weights_present": self.weights_present,
        }


@dataclass(frozen=True)
class SelectionDecision:
    """예산 안에 들어가는 구성."""

    status: str
    fore_model_id: str
    bg_model_id: Optional[str]
    ctx_tokens: int
    bg_ctx_tokens: Optional[int]
    quant_label: Optional[str]
    gpu_layers: Union[int, str]
    kv_type: str
    threads: int
    residency: str
    reasons: Tuple[str, ...]
    load_path: str
    budget_bytes: int
    fore_cost_bytes: int
    bg_cost_bytes: int
    co_residency: Optional[CoResidency] = None
    notes: Tuple[str, ...] = ()

    @property
    def available(self) -> bool:
        return True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "fore_model_id": self.fore_model_id,
            "bg_model_id": self.bg_model_id,
            "ctx_tokens": self.ctx_tokens,
            "bg_ctx_tokens": self.bg_ctx_tokens,
            "quant_label": self.quant_label,
            "gpu_layers": self.gpu_layers,
            "kv_type": self.kv_type,
            "threads": self.threads,
            "residency": self.residency,
            "reasons": list(self.reasons),
            "load_path": self.load_path,
            "budget_gib": _gib(self.budget_bytes),
            "fore_cost_gib": _gib(self.fore_cost_bytes),
            "bg_cost_gib": _gib(self.bg_cost_bytes),
            "co_residency": self.co_residency.to_dict() if self.co_residency else None,
            "notes": list(self.notes),
        }


@dataclass(frozen=True)
class Unavailable:
    """만족하는 구성이 없다. 사유는 항상 채워진다."""

    status: str
    reason: str
    detail: str
    reasons: Tuple[str, ...] = ()
    rejected: Tuple[Tuple[str, str], ...] = ()
    rejected_details: Tuple[Tuple[str, str], ...] = ()
    budget_bytes: Optional[int] = None

    @property
    def available(self) -> bool:
        return False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "reason": self.reason,
            "detail": self.detail,
            "reasons": list(self.reasons or (self.detail,)),
            "rejected": [{"model_id": mid, "reason": code} for mid, code in self.rejected],
            "rejected_details": [
                {"model_id": mid, "detail": text} for mid, text in self.rejected_details
            ],
            "budget_gib": _gib(self.budget_bytes),
        }


@dataclass
class _Candidate:
    """내부용: 실제 컨텍스트에서 예산에 들어간 항목."""

    entry: ModelRequirement
    ctx_tokens: int
    cost_bytes: int


def _gib(value: Optional[int]) -> Optional[float]:
    return None if value is None else round(int(value) / GIB, 3)


def _gib_text(value: Optional[int]) -> str:
    return "unknown" if value is None else f"{value / GIB:.2f} GiB"


def _size_rank(entry: ModelRequirement) -> int:
    return SIZE_CLASS_ORDER.get(str(entry.size_class).strip().lower(), 0)


def _fit(
    entry: ModelRequirement,
    budget_bytes: int,
    ceiling_tokens: int,
    floor_tokens: int,
) -> Tuple[Optional[Tuple[int, int]], str, str]:
    """``((ctx, cost), "", "")`` 또는 ``(None, reason_code, detail)``.

    detail은 사유를 사람이 검산할 수 있는 산술 문자열이다.
    """
    weights = int(entry.weights_bytes or 0)
    per_token = int(entry.kv_bytes_per_token or 0)
    buffer_bytes = int(entry.runtime_buffer_bytes)
    base = weights + buffer_bytes
    if base > budget_bytes:
        return (
            None,
            REASON_WEIGHTS_OVER_BUDGET,
            f"weights {_gib_text(weights)} + runtime buffer {_gib_text(buffer_bytes)} = "
            f"{_gib_text(base)} > budget {_gib_text(budget_bytes)}",
        )
    ctx_fit = (budget_bytes - base) // per_token if per_token > 0 else 0
    floor = max(int(floor_tokens), int(entry.min_context))
    if ctx_fit < floor:
        return (
            None,
            REASON_CONTEXT_FLOOR,
            f"weights {_gib_text(weights)} + buffer {_gib_text(buffer_bytes)} leaves "
            f"{_gib_text(max(0, budget_bytes - base))} for KV = {ctx_fit} tokens, "
            f"below the {floor}-token floor (budget {_gib_text(budget_bytes)})",
        )
    ctx = min(ctx_fit, int(entry.context_window), int(ceiling_tokens))
    if ctx < floor:
        return (
            None,
            REASON_CONTEXT_FLOOR,
            f"catalogue ceiling {int(entry.context_window)} tokens is below the "
            f"{floor}-token floor",
        )
    cost = resident_cost(weights, per_token, ctx, buffer_bytes)
    if cost > budget_bytes:
        return (
            None,
            REASON_WEIGHTS_OVER_BUDGET,
            f"resident cost {_gib_text(cost)} > budget {_gib_text(budget_bytes)}",
        )
    return (ctx, cost), "", ""


def _foreground_key(candidate: _Candidate) -> Tuple[int, int, str]:
    # size_class는 카탈로그의 선언 등급이며 성능 순위가 아니다.
    return (-_size_rank(candidate.entry), -candidate.ctx_tokens, candidate.entry.model_id)


def _resident_buffer(fore: ModelRequirement, other: ModelRequirement) -> int:
    """상주 쌍의 런타임 버퍼. 큰 쪽 하나를 쓴다(실측 앵커를 재현하는 계산)."""
    return max(int(fore.runtime_buffer_bytes), int(other.runtime_buffer_bytes))


def _co_residency_at(
    fore: _Candidate,
    other: _Candidate,
    budget_bytes: int,
    fore_ctx_tokens: int,
) -> CoResidency:
    return co_resident_ok(
        budget_bytes,
        (
            ResidentRequest.from_requirement(fore.entry, fore_ctx_tokens),
            ResidentRequest.from_requirement(other.entry, other.ctx_tokens),
        ),
        overhead_bytes=_resident_buffer(fore.entry, other.entry),
    )


def _largest_joint_ctx(fore: _Candidate, other: _Candidate, budget_bytes: int) -> int:
    """상주 마진을 남기면서 포그라운드가 쓸 수 있는 최대 컨텍스트."""
    bg_part = int(other.entry.weights_bytes or 0) + kv_bytes(
        int(other.entry.kv_bytes_per_token or 0), other.ctx_tokens
    )
    room = (
        budget_bytes
        - P_CO_RESIDENT_MARGIN_BYTES
        - bg_part
        - int(fore.entry.weights_bytes or 0)
        - _resident_buffer(fore.entry, other.entry)
    )
    floor = max(P_CTX_FG_MIN, fore.entry.min_context)
    if room < 0:
        return floor
    ctx = room // int(fore.entry.kv_bytes_per_token or 1)
    return max(floor, min(fore.ctx_tokens, ctx))


def _job_pool(
    entries: Sequence[ModelRequirement],
    machine: "MachineProfile",
    budget_bytes: int,
    ceiling_tokens: int,
    floor_tokens: int,
    path: str,
    foreground: Optional[_Candidate],
    exclude_model_id: Optional[str],
    accept: "Callable[[ModelRequirement], bool]",
) -> Tuple[
    List[Tuple[_Candidate, Optional[CoResidency], int]],
    Dict[str, str],
    Dict[str, str],
    List[str],
]:
    """공용 후보 풀: 승인 필터 → 완결성 → 런타임 → 적재 산술 → 상주/교체.

    백그라운드와 aux/임베딩은 같은 게이트를 쓴다(별도 구현 없음). 다른 것은
    ``accept``(승인 목록/역할 필터), 컨텍스트 상한/하한, 제외할 포그라운드뿐이다.
    """
    pool: List[Tuple[_Candidate, Optional[CoResidency], int]] = []
    rejected: Dict[str, str] = {}
    reject_details: Dict[str, str] = {}
    partial: List[str] = []
    for entry in entries:
        if exclude_model_id is not None and entry.model_id == exclude_model_id:
            continue
        if not accept(entry):
            continue
        if entry.pending_confirmation:
            rejected[entry.model_id] = REASON_CATALOG_PENDING
            reject_details[entry.model_id] = "requirement values are not verified yet"
            continue
        missing = entry.missing_fields()
        if missing:
            rejected[entry.model_id] = f"{REASON_CATALOG_INCOMPLETE}:{','.join(missing)}"
            reject_details[entry.model_id] = f"missing {', '.join(missing)}"
            continue
        blocked = runtime_block_reason(entry, machine)
        if blocked is not None:
            rejected[entry.model_id] = blocked
            reject_details[entry.model_id] = (
                f"needs runtime {entry.runtime_kind}"
                + (f" build >= {entry.runtime_min_build}" if entry.runtime_min_build else "")
                + f"; installed {machine.runtime_kind} build {machine.runtime_build} "
                f"backend {machine.runtime_backend}"
            )
            continue
        fit, why, detail = _fit(entry, budget_bytes, ceiling_tokens, floor_tokens)
        if fit is None:
            rejected[entry.model_id] = why
            reject_details[entry.model_id] = detail
            if why == REASON_CONTEXT_FLOOR:
                partial.append(entry.model_id)
            continue
        candidate = _Candidate(entry, fit[0], fit[1])
        if path == "vram" and machine.vram_free_bytes is not None and foreground is not None:
            joint = _largest_joint_ctx(foreground, candidate, budget_bytes)
            pool.append(
                (candidate, _co_residency_at(foreground, candidate, budget_bytes, joint), joint)
            )
        else:
            # 공유 메모리에는 "상주"가 없다(§3.2). 여유 VRAM이 미상이면 상주를 주장하지
            # 않는다 — 단독 적재만 허용하고 교체로 내린다.
            pool.append((candidate, None, foreground.ctx_tokens if foreground is not None else 0))
    return pool, rejected, reject_details, partial


def select(
    machine: MachineProfile,
    catalogue: Sequence[ModelRequirement],
    *,
    foreground_model_id: Optional[str] = None,
    background_role: Optional[str] = None,
    aux_role: Optional[str] = None,
) -> Union[SelectionDecision, Unavailable]:
    """기계 프로필 + 카탈로그 → 결정.

    평가 순서: 런타임 준비도, 예산, 항목별 하드 제약, 포그라운드, 백그라운드, 상주.
    카탈로그는 model_id로 정렬해 순회하므로 입력 순서가 결과를 바꾸지 않는다.

    포그라운드는 명시적 ID를 지정해도 백그라운드/aux/embedding 전용 항목을 고르지
    않는다. 코더 역할도 선언한 기존 겸용 모델은 계속 포그라운드로 쓸 수 있다.

    ``aux_role`` evaluates an approved aux/embedding candidate list through these same
    readiness and fit checks, without requiring a foreground coder. Its selected ID and
    context occupy ``bg_model_id``/``bg_ctx_tokens``; no foreground load is claimed.
    A supplied foreground ID is excluded and requires swap, never unverified co-residency.

    백그라운드는 ``bg_approved`` + 백그라운드 역할 선언 + (size_class 내림차순,
    model_id 오름차순)으로 고른다. 상주 가능 여부를 먼저 보지 않는 이유는 2026-11-04
    결정("12 GB는 더 큰 백그라운드 모델을 허용한다") 때문이며, 상주 불가는
    ``residency='swap'``으로 명시되고 두 모델을 동시에 올리지 않는다.
    """
    entries = tuple(sorted(catalogue, key=lambda item: item.model_id))
    if not entries:
        return Unavailable(
            status=STATUS_CATALOG_EMPTY,
            reason=REASON_CATALOG_EMPTY,
            detail="the catalogue has no entries, so no model can be selected",
        )

    if not machine.runtime_present:
        return Unavailable(
            status=STATUS_LOCAL_UNPROVISIONED,
            reason=REASON_RUNTIME_ABSENT,
            detail=(
                "no local inference runtime is installed, so nothing can be loaded; "
                "the hardware budget is still valid once a runtime exists"
            ),
        )
    if machine.weights_present is not True:
        # 3상태(M-15): ``True``만 실행 가능하다. ``False``는 부재, ``None``은 미확인이며
        # 미확인을 낙관적으로 통과시키면 없는 가중치를 적재하려 든다(§1.3, E-LOC-02).
        if machine.weights_present is False:
            return Unavailable(
                status=STATUS_LOCAL_UNPROVISIONED,
                reason=REASON_WEIGHTS_MISSING,
                detail="the runtime is present but no model weights were found on disk",
            )
        return Unavailable(
            status=STATUS_LOCAL_UNPROVISIONED,
            reason=REASON_WEIGHTS_UNCONFIRMED,
            detail=(
                "the runtime is present but model weights were never confirmed; "
                "an unmeasured weight file is not treated as present"
            ),
        )
    if machine.runtime_kind not in (RUNTIME_STOCK, RUNTIME_PRISM_FORK):
        return Unavailable(
            status=STATUS_LOCAL_UNPROVISIONED,
            reason=REASON_RUNTIME_KIND,
            detail=(
                "the installed runtime kind is unknown; refusing every quantisation "
                "rather than loading one it may not support"
            ),
        )

    path = machine.load_path
    if path == "vram":
        budget = machine.vram_budget_bytes()
        unknown_reason = REASON_VRAM_UNKNOWN
        unknown_detail = "VRAM total could not be measured; the GPU path stays disabled"
        ceiling = P_CTX_CEIL_FG
        floor = P_CTX_FG_MIN
    else:
        budget = machine.ram_budget_bytes()
        unknown_reason = REASON_RAM_UNKNOWN
        unknown_detail = "system RAM could not be measured; the RAM path stays disabled"
        ceiling = P_CTX_CEIL_CPU
        floor = P_CTX_FLOOR

    if budget is None:
        return Unavailable(
            status=STATUS_LOCAL_MEASUREMENT_UNKNOWN,
            reason=unknown_reason,
            detail=unknown_detail,
        )
    if budget <= 0:
        return Unavailable(
            status=STATUS_LOCAL_NO_FIT,
            reason=REASON_BUDGET_EXHAUSTED,
            detail=(
                f"the {path} budget is {_gib_text(budget)} after the release reserve; "
                "no model can be loaded"
            ),
            budget_bytes=budget,
        )

    known_ids = {entry.model_id for entry in entries}
    if foreground_model_id is not None and foreground_model_id not in known_ids:
        return Unavailable(
            status=STATUS_LOCAL_NO_FIT,
            reason=REASON_FOREGROUND_NOT_IN_CATALOG,
            detail=(
                f"{foreground_model_id} is not in the catalogue; requested sizes are "
                "never estimated and no substitute is chosen"
            ),
            budget_bytes=budget,
        )
    if aux_role is not None:
        aux_ceiling = P_CTX_CEIL_BG if path == "vram" else P_CTX_CEIL_CPU
        fore_candidate: Optional[_Candidate] = None
        if foreground_model_id is not None:
            fore_req = next((item for item in entries if item.model_id == foreground_model_id), None)
            if (
                fore_req is not None
                and not fore_req.pending_confirmation
                and not fore_req.missing_fields()
                and fore_req.foreground_eligible
                and runtime_block_reason(fore_req, machine) is None
            ):
                fore_fit, _, _ = _fit(fore_req, budget, ceiling, floor)
                if fore_fit is not None:
                    fore_candidate = _Candidate(fore_req, fore_fit[0], fore_fit[1])

        aux_pool, rejected, reject_details, partial = _job_pool(
            entries,
            machine,
            budget,
            aux_ceiling,
            P_CTX_FLOOR,
            path,
            fore_candidate,
            foreground_model_id,
            lambda item: item.aux_approved and item.supports_role(aux_role),
        )

        if not aux_pool:
            status = STATUS_LOCAL_FIT_PARTIAL if partial else STATUS_LOCAL_NO_FIT
            reason = REASON_CONTEXT_FLOOR if partial else REASON_NO_FIT
            if not partial and rejected and len(set(rejected.values())) == 1:
                reason = next(iter(rejected.values())).split(":", 1)[0]
            detail = (
                f"no approved aux/embedding model for role {aux_role!r} fits the "
                f"{path} budget of {_gib_text(budget)}"
                + (
                    f"; the weights fit but {P_CTX_FLOOR} tokens of context do not"
                    if partial
                    else ""
                )
            )
            return Unavailable(
                status=status,
                reason=reason,
                detail=detail,
                budget_bytes=budget,
                rejected=tuple(sorted(rejected.items())),
                rejected_details=tuple(sorted(reject_details.items())),
            )

        aux_pool.sort(
            key=lambda item: (
                0 if (item[1] is not None and item[1].ok) else 1,
                _size_rank(item[0].entry),
                item[0].entry.model_id,
            )
        )
        chosen, co, joint_ctx = aux_pool[0]
        reasons = [
            f"budget: {_gib_text(budget)} {path}"
            + (f"; free VRAM {_gib_text(machine.vram_free_bytes)}" if path == "vram" else ""),
        ]
        fore_ctx = 0
        fore_cost = 0
        if fore_candidate is not None:
            fore_ctx = joint_ctx if (co is not None and co.ok) else fore_candidate.ctx_tokens
            fore_cost = resident_cost(
                int(fore_candidate.entry.weights_bytes or 0),
                int(fore_candidate.entry.kv_bytes_per_token or 0),
                fore_ctx,
                fore_candidate.entry.runtime_buffer_bytes,
            )
            if path == "vram" and co is not None and co.ok:
                residency = RESIDENCY_CO_RESIDENT
                reasons.append(
                    f"aux: {chosen.entry.model_id} at {chosen.ctx_tokens} tokens stays resident "
                    f"(remaining {_gib_text(co.remaining_bytes)} >= margin "
                    f"{_gib_text(co.margin_bytes)})"
                )
            elif P_BG_SWAP_ALLOWED:
                residency = RESIDENCY_SWAP
                detail = f"status={co.status}" if co is not None else "no co-residency evaluation"
                reasons.append(
                    f"aux: {chosen.entry.model_id} at {chosen.ctx_tokens} tokens needs a swap "
                    f"({detail}; the two models are not loaded together)"
                )
            else:
                return Unavailable(
                    status=STATUS_LOCAL_NO_FIT,
                    reason=REASON_BACKGROUND_OFF,
                    detail="swap is disabled by this release",
                    budget_bytes=budget,
                )
        elif foreground_model_id is not None:
            if not P_BG_SWAP_ALLOWED:
                return Unavailable(
                    status=STATUS_LOCAL_NO_FIT,
                    reason=REASON_BACKGROUND_OFF,
                    detail="swap is disabled by this release",
                    budget_bytes=budget,
                )
            residency = RESIDENCY_SWAP
            reasons.append(
                f"aux: {chosen.entry.model_id} at {chosen.ctx_tokens} tokens needs a swap "
                f"(foreground {foreground_model_id} has no verified co-residency profile)"
            )
        else:
            residency = RESIDENCY_STANDALONE
            reasons.append(
                f"aux: {chosen.entry.model_id} at {chosen.ctx_tokens} tokens on the {path} path"
            )

        aux_cost = resident_cost(
            int(chosen.entry.weights_bytes or 0),
            int(chosen.entry.kv_bytes_per_token or 0),
            chosen.ctx_tokens,
            chosen.entry.runtime_buffer_bytes,
        )
        notes: Tuple[str, ...] = ()
        if chosen.entry.benchmark_note:
            notes += (f"aux benchmark: {chosen.entry.benchmark_note}",)
        if co is not None and co.ok:
            notes += (
                f"co-resident set: {_gib_text(co.used_bytes)} of {_gib_text(co.budget_bytes)}, "
                f"remaining {_gib_text(co.remaining_bytes)}",
            )
        status = STATUS_READY_LOCAL_SLOW if path == "ram" else STATUS_READY_LOCAL
        return SelectionDecision(
            status=status,
            fore_model_id=foreground_model_id or "",
            bg_model_id=chosen.entry.model_id,
            ctx_tokens=fore_ctx,
            bg_ctx_tokens=chosen.ctx_tokens,
            quant_label=chosen.entry.quant_label,
            gpu_layers="all" if path == "vram" else 0,
            kv_type=P_KV_TYPE,
            threads=machine.threads,
            residency=residency,
            reasons=tuple(reasons),
            load_path=path,
            budget_bytes=budget,
            fore_cost_bytes=fore_cost,
            bg_cost_bytes=aux_cost,
            co_residency=co,
            notes=notes,
        )

    rejected: Dict[str, str] = {}
    reject_details: Dict[str, str] = {}
    candidates = []
    partial = []
    for entry in entries:
        if foreground_model_id is not None and entry.model_id != foreground_model_id:
            continue
        if entry.pending_confirmation:
            rejected[entry.model_id] = REASON_CATALOG_PENDING
            reject_details[entry.model_id] = "requirement values are not verified yet"
            continue
        missing = entry.missing_fields()
        if missing:
            rejected[entry.model_id] = f"{REASON_CATALOG_INCOMPLETE}:{','.join(missing)}"
            reject_details[entry.model_id] = f"missing {', '.join(missing)}"
            continue
        # 자동 선택은 백그라운드/aux/embedding 전용 항목을 포그라운드로 올리지 않는다.
        # 이름으로 명시한 요청도 같다: aux/embedding 모델은 포그라운드 코더가 아니다.
        if not entry.foreground_eligible:
            rejected[entry.model_id] = REASON_FOREGROUND_ROLE_MISSING
            reject_details[entry.model_id] = "declares only background/aux/embedding roles"
            continue
        blocked = runtime_block_reason(entry, machine)
        if blocked is not None:
            rejected[entry.model_id] = blocked
            reject_details[entry.model_id] = (
                f"needs runtime {entry.runtime_kind}"
                + (f" build >= {entry.runtime_min_build}" if entry.runtime_min_build else "")
                + f"; installed {machine.runtime_kind} build {machine.runtime_build} "
                f"backend {machine.runtime_backend}"
            )
            continue
        fit, why, detail = _fit(entry, budget, ceiling, floor)
        if fit is None:
            rejected[entry.model_id] = why
            reject_details[entry.model_id] = detail
            if why == REASON_CONTEXT_FLOOR:
                partial.append(entry.model_id)
            continue
        candidates.append(_Candidate(entry, fit[0], fit[1]))

    if not candidates:
        status = STATUS_LOCAL_FIT_PARTIAL if partial else STATUS_LOCAL_NO_FIT
        reason = REASON_CONTEXT_FLOOR if partial else REASON_NO_FIT
        detail = (
            f"no catalogue model fits the {path} budget of {_gib_text(budget)}"
            + (f"; the weights fit but {floor} tokens of context do not" if partial else "")
        )
        if foreground_model_id is not None and foreground_model_id in rejected:
            reason = rejected[foreground_model_id].split(":", 1)[0]
            detail = (
                f"{foreground_model_id} cannot be loaded on {_gib_text(budget)} {path}: "
                f"{reject_details.get(foreground_model_id) or rejected[foreground_model_id]}"
            )
        return Unavailable(
            status=status,
            reason=reason,
            detail=detail,
            budget_bytes=budget,
            rejected=tuple(sorted(rejected.items())),
            rejected_details=tuple(sorted(reject_details.items())),
        )

    fore = min(candidates, key=_foreground_key)
    reasons = [
        f"budget: {_gib_text(budget)} {path}"
        + (f"; free VRAM {_gib_text(machine.vram_free_bytes)}" if path == "vram" else ""),
        f"foreground: {fore.entry.model_id} at {fore.ctx_tokens} tokens on the {path} path",
    ]

    bg_pool, bg_rejected, bg_details, _ = _job_pool(
        entries,
        machine,
        budget,
        P_CTX_CEIL_BG if path == "vram" else P_CTX_CEIL_CPU,
        P_CTX_FLOOR,
        path,
        fore,
        fore.entry.model_id,
        lambda item: (
            item.bg_approved
            and item.declares_background_role
            and (background_role is None or item.supports_role(background_role))
        ),
    )
    for model_id, code in bg_rejected.items():
        rejected.setdefault(model_id, code)
        reject_details.setdefault(model_id, bg_details.get(model_id, ""))

    bg: Optional[_Candidate] = None
    co: Optional[CoResidency] = None
    residency = RESIDENCY_BACKGROUND_OFF
    fore_ctx = fore.ctx_tokens
    if bg_pool:
        # §2.3 5단계: 상주 가능한 후보를 먼저, 그 안에서 size_class 내림차순,
        # model_id 오름차순. 상주 가능 후보가 없으면 swap 허용 시 같은 순서의 첫 항목.
        bg_pool.sort(
            key=lambda item: (
                0 if (item[1] is not None and item[1].ok) else 1,
                -_size_rank(item[0].entry),
                item[0].entry.model_id,
            )
        )
        bg, co, joint_ctx = bg_pool[0]
        if path == "vram":
            if co is not None and co.ok:
                fore_ctx = joint_ctx
                residency = RESIDENCY_CO_RESIDENT
                reasons.append(
                    f"background: {bg.entry.model_id} at {bg.ctx_tokens} tokens stays resident "
                    f"(remaining {_gib_text(co.remaining_bytes)} >= margin "
                    f"{_gib_text(co.margin_bytes)})"
                )
                if fore_ctx < fore.ctx_tokens:
                    reasons.append(
                        f"foreground context capped from {fore.ctx_tokens} to {fore_ctx} tokens "
                        "to keep the background model resident"
                    )
            elif P_BG_SWAP_ALLOWED:
                residency = RESIDENCY_SWAP
                detail = f"status={co.status}" if co is not None else "no co-residency evaluation"
                reasons.append(
                    f"background: {bg.entry.model_id} at {bg.ctx_tokens} tokens needs a swap "
                    f"({detail}; the two models are not loaded together)"
                )
            else:
                bg = None
                residency = RESIDENCY_BACKGROUND_OFF
                reasons.append("background_off: swap is disabled by this release")
        elif P_BG_SWAP_ALLOWED:
            residency = RESIDENCY_SWAP
            reasons.append(
                f"background: {bg.entry.model_id} at {bg.ctx_tokens} tokens shares the RAM path "
                "through a swap; co-residency never applies off a discrete GPU"
            )
        else:
            bg = None
            residency = RESIDENCY_BACKGROUND_OFF
            reasons.append("background_off: swap is disabled by this release")
    else:
        reasons.append("background_off: no approved background model fits this budget")

    fore_cost = resident_cost(
        int(fore.entry.weights_bytes or 0),
        int(fore.entry.kv_bytes_per_token or 0),
        fore_ctx,
        fore.entry.runtime_buffer_bytes,
    )
    bg_cost = 0
    if bg is not None:
        bg_cost = resident_cost(
            int(bg.entry.weights_bytes or 0),
            int(bg.entry.kv_bytes_per_token or 0),
            bg.ctx_tokens,
            bg.entry.runtime_buffer_bytes,
        )

    notes: Tuple[str, ...] = ()
    if fore.entry.benchmark_note:
        notes += (f"foreground benchmark: {fore.entry.benchmark_note}",)
    if bg is not None and bg.entry.benchmark_note:
        notes += (f"background benchmark: {bg.entry.benchmark_note}",)
    if co is not None and co.ok:
        notes += (
            f"co-resident set: {_gib_text(co.used_bytes)} of {_gib_text(co.budget_bytes)}, "
            f"remaining {_gib_text(co.remaining_bytes)}",
        )

    status = STATUS_READY_LOCAL_SLOW if path == "ram" else STATUS_READY_LOCAL
    return SelectionDecision(
        status=status,
        fore_model_id=fore.entry.model_id,
        bg_model_id=bg.entry.model_id if bg is not None else None,
        ctx_tokens=fore_ctx,
        bg_ctx_tokens=bg.ctx_tokens if bg is not None else None,
        quant_label=fore.entry.quant_label,
        gpu_layers="all" if path == "vram" else 0,
        kv_type=P_KV_TYPE,
        threads=machine.threads,
        residency=residency,
        reasons=tuple(reasons),
        load_path=path,
        budget_bytes=budget,
        fore_cost_bytes=fore_cost,
        bg_cost_bytes=bg_cost,
        co_residency=co,
        notes=notes,
    )

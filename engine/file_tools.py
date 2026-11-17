"""파일 경로 격리 · 해시 검증 · 원자적 쓰기 · 검증 실행 도구.

이 모듈은 모델이 제안한 파일 편집을 실제 파일시스템에 적용하는 단일 통로다.

- ``resolve_within``: 워크스페이스 루트 밖으로 나가는 경로(절대경로, ``..``,
  심볼릭 링크/정션 탈출)와 민감한 이름(``.git/``, ``.env``, ``*.pem``, ``id_rsa*``,
  ``*credential*``, ``*secret*``)을 거부한다.
- ``apply_edits``: 모든 편집의 ``expected_pre_hash``(sha256)를 **쓰기 전에** 검증하고,
  전부 통과한 경우에만 임시 파일 + ``os.replace``로 원자적 교체한다. 하나라도
  불일치하면 아무것도 쓰지 않고 ``HashMismatchError``를 올린다.
- ``run_verification``: 검증은 셸 문자열이 아니라 argv 목록으로만 실행하며
  (``shell=False``), 환경변수에서 API 키/토큰류를 제거한 사본을 주입한다.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union

__all__ = [
    "FileToolError",
    "PathContainmentError",
    "SensitivePathRejected",
    "InvalidEditError",
    "HashMismatchError",
    "VerificationRecord",
    "resolve_within",
    "hash_bytes",
    "hash_file",
    "write_atomic",
    "apply_edits",
    "scrub_env",
    "run_verification",
]

#: 값에 이 조각이 포함된 환경변수는 검증 프로세스에 전달하지 않는다.
_SECRET_ENV_MARKERS = (
    "api_key",
    "apikey",
    "api-key",
    "token",
    "secret",
    "password",
    "passwd",
    "credential",
    "private_key",
)

#: 파일명/디렉터리 이름 기준 민감 패턴 (대소문자 무시)
_SENSITIVE_DIRS = frozenset({".git", ".ssh", ".aws"})
_SENSITIVE_SUFFIXES = (".pem",)
_SENSITIVE_PREFIXES = ("id_rsa", "id_dsa", "id_ecdsa", "id_ed25519")
_SENSITIVE_INFIXES = ("credential", "secret")


class FileToolError(Exception):
    """file_tools 계층의 모든 거부/실패의 공통 상위 예외."""


class PathContainmentError(FileToolError):
    """워크스페이스 루트를 벗어나는 경로가 요청되었을 때."""


class SensitivePathRejected(PathContainmentError):
    """민감한 이름(키/자격증명/저장소 메타데이터)이 포함된 경로일 때."""


class InvalidEditError(FileToolError):
    """편집 연산 스키마가 잘못되었을 때."""


class HashMismatchError(FileToolError):
    """``expected_pre_hash``가 현재 파일 바이트의 sha256과 다를 때."""


# --------------------------------------------------------------------------- #
# 경로 격리
# --------------------------------------------------------------------------- #
def _reject_sensitive(part: str, original: str) -> None:
    lowered = part.lower()
    if lowered in _SENSITIVE_DIRS or lowered == ".env" or lowered.startswith(".env."):
        raise SensitivePathRejected(f"sensitive path component {part!r} is rejected: {original}")
    if lowered.endswith(_SENSITIVE_SUFFIXES) or lowered.startswith(_SENSITIVE_PREFIXES):
        raise SensitivePathRejected(f"sensitive file name {part!r} is rejected: {original}")
    if any(marker in lowered for marker in _SENSITIVE_INFIXES):
        raise SensitivePathRejected(f"sensitive file name {part!r} is rejected: {original}")


def resolve_within(root: Union[str, Path], rel: Union[str, Path]) -> Path:
    """``root`` 안쪽의 실제 경로를 반환하거나 ``PathContainmentError``를 올린다.

    거부 순서: 빈 경로 → 절대경로/드라이브 문자 → ``~`` → ``..`` → 민감 이름 →
    심볼릭 링크 해석 후 루트 이탈(``resolve()`` + ``relative_to``).
    """
    if rel is None:
        raise PathContainmentError("a workspace-relative path is required")
    text = str(rel)
    if not text.strip():
        raise PathContainmentError("empty path is rejected")

    windows_path = PureWindowsPath(text)
    if windows_path.drive or windows_path.is_absolute() or text.startswith(("/", "\\", "~")):
        raise PathContainmentError(f"absolute paths are rejected: {text}")

    normalized = text.replace("\\", "/")
    parts = tuple(part for part in normalized.split("/") if part not in ("", "."))
    if not parts:
        raise PathContainmentError(f"path resolves to the workspace root itself: {text}")
    if any(part == ".." for part in parts):
        raise PathContainmentError(f"parent traversal is rejected: {text}")
    for part in parts:
        if ':' in part or part.endswith((' ', '.')) or part.startswith('-'):
            raise PathContainmentError(f"ambiguous or option-like path component: {text}")
        _reject_sensitive(part, text)

    root_path = Path(root).resolve()
    target = root_path.joinpath(*parts).resolve()
    if not target.is_relative_to(root_path):
        raise PathContainmentError(f"path escapes the workspace root after resolution: {text}")
    for part in target.relative_to(root_path).parts:
        _reject_sensitive(part, text)
    return target


# --------------------------------------------------------------------------- #
# 해시 / 원자적 쓰기
# --------------------------------------------------------------------------- #
def hash_bytes(payload: bytes) -> str:
    """바이트의 sha256 16진 문자열."""
    return hashlib.sha256(payload).hexdigest()


def hash_file(path: Union[str, Path]) -> Optional[str]:
    """파일 바이트의 sha256. 파일이 없으면 ``None``(0으로 위장하지 않는다)."""
    target = Path(path)
    if not target.exists():
        return None
    if not target.is_file():
        raise HashMismatchError(f"expected a regular file: {target.name}")
    return hash_bytes(target.read_bytes())


def write_atomic(path: Union[str, Path], payload: bytes) -> None:
    """같은 디렉터리의 임시 파일에 쓴 뒤 ``os.replace``로 교체한다."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    handle_fd, temp_name = tempfile.mkstemp(prefix=".tmp-edit-", dir=str(target.parent))
    try:
        with os.fdopen(handle_fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, target)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------- #
# 편집 적용
# --------------------------------------------------------------------------- #
def apply_edits(root: Union[str, Path], ops: Iterable[Mapping[str, Any]]) -> List[str]:
    """편집 연산 목록을 검증한 뒤 원자적으로 적용하고 적용된 상대경로들을 반환한다.

    각 연산은 ``{"path": str, "expected_pre_hash": str, "new_content": str}`` 형태다.
    ``expected_pre_hash``가 빈 문자열이면 "새 파일"을 뜻하며, 그 경우 대상이 이미
    존재하면 실패한다. 검증 단계에서 하나라도 실패하면 파일은 전혀 수정되지 않는다.
    """
    planned: List[Tuple[str, Path, bytes]] = []
    seen: set[str] = set()

    for index, op in enumerate(list(ops)):
        if not isinstance(op, Mapping):
            raise InvalidEditError(f"edits[{index}] must be an object")
        if set(op) != {"path", "expected_pre_hash", "new_content"}:
            raise InvalidEditError(f"edits[{index}] must have path, expected_pre_hash, new_content only")
        path_value = op.get("path")
        content = op.get("new_content")
        pre_hash = op.get("expected_pre_hash")
        if not isinstance(path_value, str) or not path_value.strip():
            raise InvalidEditError(f"edits[{index}].path must be a non-empty string")
        if not isinstance(content, str):
            raise InvalidEditError(f"edits[{index}].new_content must be a string")
        if not isinstance(pre_hash, str):
            raise InvalidEditError(f"edits[{index}].expected_pre_hash must be a string")
        target = resolve_within(root, path_value)
        key = os.path.normcase(str(target))
        if key in seen:
            raise InvalidEditError(f"duplicate edit for {path_value!r} in one response")
        seen.add(key)
        current_hash = hash_file(target)
        expected = pre_hash.strip().lower()
        if expected == "":
            if current_hash is not None:
                raise HashMismatchError(
                    f"{path_value}: expected a new file but it already exists (sha256={current_hash})"
                )
        elif current_hash is None:
            raise HashMismatchError(f"{path_value}: file does not exist but expected_pre_hash was supplied")
        elif current_hash != expected:
            raise HashMismatchError(
                f"{path_value}: expected_pre_hash mismatch (expected {expected}, current {current_hash})"
            )

        planned.append((Path(path_value).as_posix(), target, content.encode("utf-8")))

    applied: List[str] = []
    for rel_path, target, payload in planned:
        write_atomic(target, payload)
        applied.append(rel_path)
    return applied


# --------------------------------------------------------------------------- #
# 검증 실행 (argv 전용)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class VerificationRecord:
    """검증 프로세스의 실제 실행 기록."""
    argv: Tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str
    duration_ms: float

    @property
    def ok(self) -> bool:
        return self.returncode == 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "argv": list(self.argv),
            "returncode": self.returncode,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "duration_ms": round(self.duration_ms, 3),
            "ok": self.ok,
        }


def scrub_env(env: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
    """API 키/토큰류를 제거한 환경변수 사본을 만든다."""
    source = dict(os.environ if env is None else env)
    cleaned: Dict[str, str] = {}
    for key, value in source.items():
        lowered = key.lower()
        if any(marker in lowered for marker in _SECRET_ENV_MARKERS):
            continue
        cleaned[key] = value
    return cleaned


def run_verification(
    argv: Sequence[str],
    cwd: Union[str, Path] = ".",
    timeout: float = 120.0,
    env: Optional[Mapping[str, str]] = None,
) -> VerificationRecord:
    """argv 목록을 셸 없이 실행하고 실제 종료코드/출력 기록을 돌려준다."""
    if isinstance(argv, (str, bytes)):
        raise InvalidEditError("verification must be an argv list, not a shell string")
    command = [str(part) for part in argv]
    if not command:
        raise InvalidEditError("verification argv must not be empty")

    started = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            shell=False,
            cwd=str(cwd),
            timeout=timeout,
            capture_output=True,
            env=scrub_env(env),
        )
    except subprocess.TimeoutExpired as exc:
        return VerificationRecord(
            argv=tuple(command),
            returncode=-1,
            stdout=_as_text(exc.stdout),
            stderr=f"verification timed out after {timeout}s",
            duration_ms=(time.monotonic() - started) * 1000.0,
        )
    except OSError as exc:
        return VerificationRecord(
            argv=tuple(command),
            returncode=-1,
            stdout="",
            stderr=f"verification could not start: {exc}",
            duration_ms=(time.monotonic() - started) * 1000.0,
        )
    return VerificationRecord(
        argv=tuple(command),
        returncode=int(completed.returncode),
        stdout=_as_text(completed.stdout),
        stderr=_as_text(completed.stderr),
        duration_ms=(time.monotonic() - started) * 1000.0,
    )


def _as_text(payload: Union[bytes, str, None]) -> str:
    if payload is None:
        return ""
    if isinstance(payload, bytes):
        return payload.decode("utf-8", errors="replace")
    return str(payload)

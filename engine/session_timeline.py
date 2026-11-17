"""세션 활동 타임라인 — 구조화 이벤트만으로 추가/수정/삭제를 판정하고 한국어로 요약한다.

핵심 원칙: **사실은 오직 구조화된 세션 이벤트에서만 온다.** 로컬 aux 모델은 이미 확정된
문장을 한국어로 다듬는 일만 한다. 모델 문장이 타임라인에 없는 대상·건수·변경을 언급하면
그 출력은 거부되고 구조적 문장이 대신 반환되며, 거부 사유는 결과의 ``rejection``에 남는다
(조용한 대체 없음).

받아들이는 최소 이벤트 계약 (:data:`EVENT_CONTRACT`, 값은 허용 키의 우선순위)
--------------------------------------------------------------------------------
* 이벤트 id — ``event_id``, ``id``, ``eventId``, ``tool_call_id``, ``toolCallId``.
  없으면 ``event-<입력순번>``을 합성하고 ``degraded``에 기록한다.
* 타임스탬프 — ``timestamp``, ``ts``, ``time``, ``at``, ``created_at``, ``createdAt``.
  ISO-8601 문자열/``datetime``/epoch 초를 받는다. 없거나 해석 불가면 정렬 맨 뒤로 보내고
  ``degraded``에 기록한다. 타임존 없는 값은 UTC로 가정하며 그 사실도 기록한다.
* 종류 — ``kind``, ``type``, ``event_type``, ``eventType``. ``tool_call``, ``tool_result``,
  ``message``, ``approval``을 문서 계약으로 받고, 브리지 프레임 이름
  (``tool_execution_start``/``tool_execution_end``, ``message_*``, ``extension_ui_request``)은
  :data:`KIND_ALIASES`로 접어서 받는다. 그 밖의 값은 소문자 그대로 보존한다.
* 도구 — ``tool``, ``tool_name``, ``toolName``, ``name``.
* 대상 — ``target``, ``path``, ``file_path``, ``filePath``, ``file``, ``identifier``,
  ``target_id``, ``targetId``. 없으면 ``대상 미상``으로 표기하고 ``degraded``에 기록한다.
* 결과 상태 — ``isError``, ``is_error``, ``status``, ``result_status``. 불리언/숫자/문자열을
  해석해 실패·거부면 변경으로 세지 않는다.
* 생성 여부 — ``created``, ``created_new``, ``createdNew``, ``is_new``, ``isNew``,
  ``new_file``, ``newFile`` (참/거짓). **없으면 분류 불가**다.
* 기존 존재 여부 — ``existed_before``, ``existedBefore``, ``existed``.
* 삭제 여부 — ``deleted``, ``removed``, ``is_deleted``, ``isDeleted``.
* 연산 — ``op``, ``operation``, ``action``, ``change_type``, ``changeType``.
* 파일별 결과 — ``perFileResults``, ``per_file_results``, ``files``. 항목마다 path/op/diff 와
  ``created``/``existed_before``/``deleted``/``status``(``isError``)를 읽는다. 항목의 근거는
  같은 이벤트의 최상위 근거보다 먼저 적용되고 도구 이름 추론보다 우선하며, 근거 경로는
  ``result.details.perFileResults[0].op`` 처럼 컨테이너 경로 전체로 기록된다(감사 가능).

위 키들은 최상위뿐 아니라 ``details``, ``result``, ``result.details``, ``args``, ``meta``,
``data``, ``payload``, ``payload.details``에서도 찾는다(브리지가 중첩해 보내기 때문).
그 밖의 필드는 무시한다(관대함). 브리지에 없는 필드(예: 생성 여부)를 요구하지 않으며,
없으면 추측하지 않고 분류 불가로 남긴다.

브리지 수명주기 프레임
----------------------
``tool_execution_start`` 와 ``tool_execution_end`` 가 같은 도구 호출 id로 오면 두 프레임을
한 항목으로 합치고 종료 프레임의 내용으로 판정한다(``app/public/protocol.js`` 가
toolCallId 로 상관하는 방식과 같다). 시작 프레임은 별도 줄을 만들지 않는다. 종료 프레임이
없는 호출은 미완료이므로 ``분류 불가`` 에 사유를 실어 보낸다.

분류 규칙(먼저 일치하는 것, 근거 필드를 함께 기록)
--------------------------------------------------
0. 파일별 항목의 근거(``created``/``existed_before``/``deleted``/``status``)를 이벤트
   최상위 근거보다 먼저 읽고, 도구 이름 추론보다도 우선한다. 근거 경로는
   ``result.details.perFileResults[0].op`` 처럼 컨테이너 경로 전체로 남긴다.
1. 같은 범위의 ``status``/``isError``가 실패·거부 → ``분류 불가`` (변경이 보고되지 않았다).
   HTTP 2xx 는 성공이고, ``running``/``pending``/``in_progress`` 처럼 아직 끝나지 않은 상태도
   ``분류 불가`` 다(완료된 변경으로 보고하지 않는다).
2. 삭제:  ``deleted`` 참 | ``tool``이 삭제 도구 | ``op``이 delete/remove 계열.
3. 추가:  ``created`` 참 | ``existed_before`` 거짓 | ``op``이 create 계열 |
   ``tool``이 생성 도구.
4. 수정:  ``existed_before`` 참 | ``created`` 거짓 | ``op``이 edit/modify 계열 |
   ``tool``이 편집 전용 도구(``edit``, ``str_replace`` …).
5. 애매한 쓰기 동사(``write``/``overwrite``/``rewrite`` …)는 **존재 근거가 있을 때만**
   수정이고, 근거가 없으면 ``분류 불가``. ``op``의 ``add``/``added``/``new`` 는 줄 추가
   어휘일 뿐이므로 파일 생성 근거로 쓰지 않는다.
6. 생성 가능 도구(``apply_patch``, ``patch``, ``str_replace_editor`` …)는 성공했다고 해서
   "기존 파일 편집"이라 말하지 않는다. 파일별 근거나 ``command`` 근거로만 판정하고,
   근거가 없으면 ``분류 불가``.
7. 그 밖의 쓰기(예: ``write_file`` 덮어쓰기)는 **생성 여부가 보고되지 않았으므로**
   ``분류 불가``. "세션 앞부분에 그 경로가 없었으니 새 파일"이라는 추론은 하지 않는다 —
   파일은 세션 이전에 존재했을 수 있다.

모델은 ``AuxTaskRunner``/``select_aux_model`` 경로로만 부른다(:class:`TimelinePhraser`는
상속한 ``_invoke``를 재사용한다). 전용 요약 역할이 레지스트리에 없으면 기존
``compactor`` 역할로 실행하고 그 사실을 결과에 남긴다. 포그라운드 선택기는 쓰지 않으며,
비-로컬 provider 선택은 거부된다.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from .aux_tasks import (
    AuxCloudProviderRefused,
    AuxTaskError,
    AuxTaskRunner,
    AuxTaskUnavailable,
    cap_text,
    normalize_text,
)

__all__ = [
    "ADD",
    "MODIFY",
    "DELETE",
    "UNCLASSIFIED",
    "CATEGORIES",
    "EVENT_CONTRACT",
    "KIND_ALIASES",
    "SESSION_TIMELINE_JOB",
    "COMPACTOR_JOB",
    "COMPACTOR_ROLE",
    "PENDING_ROLE_NOTE",
    "Classification",
    "TimelineEntry",
    "SessionTimeline",
    "PhraseRequest",
    "PhraseOutcome",
    "PhrasedTimeline",
    "TimelinePhraser",
    "WRITE_TOOLS",
    "classify",
    "classify_event",
    "build_timeline",
    "render_timeline",
]

#: 분류 범주(고정 순서). UI는 이 순서로 그린다.
ADD = "추가"
MODIFY = "수정"
DELETE = "삭제"
UNCLASSIFIED = "분류 불가"
CATEGORIES: Tuple[str, ...] = (ADD, MODIFY, DELETE, UNCLASSIFIED)

#: 이 모듈이 레지스트리에 요청하는 aux 작업 이름(전용 요약 역할이 생기면 이 이름이 쓰인다).
SESSION_TIMELINE_JOB = "session_timeline"
#: 전용 역할이 없을 때 쓰는 기존 작업 이름과 그 역할(``registry.AUX_TASK_ROLES``의 값).
COMPACTOR_JOB = "compaction"
COMPACTOR_ROLE = "compactor"
#: 전용 요약 역할이 아직 없다는 사실을 결과에 남기는 문구.
PENDING_ROLE_NOTE = (
    "레지스트리에 전용 요약(summarizer) 역할이 없어 기존 compactor 역할로 문장을 다듬었습니다."
    " 전용 summarizer 역할은 아직 대기 중입니다."
)

#: 이벤트 필드 -> 허용 키(우선순위). 최소 계약이며 모두 선택적이다.
EVENT_CONTRACT: Dict[str, Tuple[str, ...]] = {
    "event_id": ("event_id", "id", "eventId", "tool_call_id", "toolCallId"),
    "timestamp": ("timestamp", "ts", "time", "at", "created_at", "createdAt"),
    "kind": ("kind", "type", "event_type", "eventType"),
    "tool": ("tool", "tool_name", "toolName", "name"),
    "target": ("target", "path", "file_path", "filePath", "file", "identifier",
               "target_id", "targetId"),
    "status": ("isError", "is_error", "status", "result_status"),
    "created": ("created", "created_new", "createdNew", "is_new", "isNew",
                "new_file", "newFile"),
    "existed_before": ("existed_before", "existedBefore", "existed"),
    "deleted": ("deleted", "removed", "is_deleted", "isDeleted"),
    "op": ("op", "operation", "action", "change_type", "changeType"),
    "per_file_results": ("perFileResults", "per_file_results", "files"),
}

#: 브리지 프레임 이름 -> 문서 계약 종류.
KIND_ALIASES: Dict[str, str] = {
    "tool_execution_start": "tool_call",
    "toolcall_start": "tool_call",
    "tool_execution_update": "tool_result",
    "tool_execution_end": "tool_result",
    "toolcall_end": "tool_result",
    "message_start": "message",
    "message_update": "message",
    "message_end": "message",
    "extension_ui_request": "approval",
    "approval_request": "approval",
}

_DELETE_TOOLS = frozenset({
    "delete", "delete_file", "delete_path", "remove", "remove_file", "rm", "rmdir",
    "unlink", "trash",
})
_CREATE_TOOLS = frozenset({
    "create", "create_file", "create_directory", "create_dir", "new_file",
    "write_new_file", "add_file", "mkdir",
})
#: 성공한 호출이 곧 "기존 대상 편집"인 도구(생성 불가 계약).
_EDIT_TOOLS = frozenset({
    "edit", "edit_file", "str_replace", "replace_in_file", "insert_lines", "multiedit",
    "multi_edit",
})
#: 생성도 할 수 있는 도구 -> 성공했다고 "기존 파일 편집"이라 말하지 않는다.
#: 파일별 근거나 ``command`` 근거로만 판정하고, 근거가 없으면 분류 불가다.
_CREATE_CAPABLE_TOOLS = frozenset({
    "apply_patch", "patch", "str_replace_editor", "apply_edits",
})
#: 덮어쓸 수는 있지만 생성 여부를 스스로 말하지 않는 도구 -> 근거 없으면 분류 불가.
_OVERWRITE_TOOLS = frozenset({
    "write", "write_file", "save", "save_file", "overwrite_file", "put_file",
})
WRITE_TOOLS = frozenset(
    _DELETE_TOOLS | _CREATE_TOOLS | _EDIT_TOOLS | _CREATE_CAPABLE_TOOLS | _OVERWRITE_TOOLS
)

_DELETE_OPS = frozenset({"delete", "deleted", "remove", "removed", "unlink", "unlinked", "rm"})
#: 파일 생성 근거가 되는 연산 어휘.
_CREATE_OPS = frozenset({"create", "created", "create_file", "write_new", "new_file"})
#: 줄 추가 어휘 -> 파일 생성 근거가 아니다(기존 파일의 줄 추가일 수 있다).
_WEAK_CREATE_OPS = frozenset({"add", "added", "new", "insert_added"})
#: 애매한 쓰기 동사 -> 존재 근거가 있을 때만 수정이다.
_WRITE_OPS = frozenset({"write", "wrote", "overwrite", "overwrote", "rewrite", "rewrote",
                        "save", "saved", "patch", "patched"})
_EDIT_OPS = frozenset({"edit", "edited", "modify", "modified", "update", "updated", "replace",
                       "replaced", "str_replace", "insert", "inserted", "append", "appended"})

_FAILURE_WORDS = frozenset({
    "error", "failed", "failure", "denied", "rejected", "refused", "cancelled", "canceled",
    "aborted", "timeout", "blocked",
})
#: 아직 끝나지 않은 실행 상태 -> 변경으로 확정하지 않고 분류 불가로 보낸다.
_PENDING_WORDS = frozenset({
    "running", "pending", "in_progress", "inprogress", "in_flight", "started", "start",
    "queued", "waiting", "streaming",
})
#: 브리지 수명주기 프레임 이름(원본 kind 기준).
_FRAME_START = frozenset({"tool_execution_start", "toolcall_start"})
_FRAME_UPDATE = frozenset({"tool_execution_update"})
_FRAME_END = frozenset({"tool_execution_end", "toolcall_end"})
_LIFECYCLE_FRAMES = _FRAME_START | _FRAME_UPDATE | _FRAME_END

#: 중첩 컨테이너 키(브리지가 details/result 아래에 근거를 싣는다). 탐색 순서는
#: 최상위 -> 너비 우선이며, 근거 경로는 이 컨테이너 경로를 그대로 남긴다.
_NESTED_KEYS: Tuple[str, ...] = ("details", "result", "args", "meta", "data", "payload")

_MISSING = object()

_BULLET = re.compile(r"^\s*(?:[-*•·]|\d+\s*[.)])\s*")
#: 인식하는 파일 확장자. 정규식에서는 긴 것부터 시도해 ``conf``/``csv`` 가 ``c`` 로
#: 잘리지 않게 한다.
_EXTENSIONS: Tuple[str, ...] = (
    "dockerfile", "makefile", "properties", "markdown", "graphql", "parquet", "ipynb",
    "config", "gradle", "svelte", "swift", "proto", "jsonl", "scss", "sass", "less",
    "toml", "yaml", "yml", "conf", "lock", "local", "env", "xml", "csv", "tsv", "vue",
    "html", "htm", "json", "pyi", "tsx", "jsx", "mjs", "cjs", "bash", "zsh", "ps1",
    "bat", "cmd", "py", "ts", "js", "md", "txt", "ini", "cfg", "css", "sql", "go",
    "rs", "kt", "kts", "java", "scala", "cc", "cpp", "cxx", "hpp", "cs", "rb", "php",
    "mm", "log", "mod", "sum", "bak", "tmp", "dat", "bin", "dll", "exe", "jar", "war",
    "whl", "gz", "zip", "tar", "png", "jpg", "jpeg", "svg", "pdf", "docx", "xlsx",
    "pptx", "c", "h", "m", "sh",
)
#: 확장자가 없는 관용적 파일 이름.
_BARE_NAMES: Tuple[str, ...] = (
    "Makefile", "Dockerfile", "README", "LICENSE", "CHANGELOG", "NOTICE", "AUTHORS",
    "CODEOWNERS", "MANIFEST", "Gemfile", "Rakefile", "Procfile", "Jenkinsfile",
    "Vagrantfile", "CONTRIBUTING",
)
_EXT_ALTERNATION = "|".join(sorted(_EXTENSIONS, key=len, reverse=True))
_BARE_ALTERNATION = "|".join(sorted(_BARE_NAMES, key=len, reverse=True))
_PATH_TOKEN = re.compile(
    r"[A-Za-z0-9_.\-~\\/]*[\\/][A-Za-z0-9_.\-~\\/]+"
    r"|\.[A-Za-z0-9_\-]+/[A-Za-z0-9_.\-/]+"
    r"|[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)*\.(?:" + _EXT_ALTERNATION + r")(?![A-Za-z0-9_])"
    r"|\.[A-Za-z][A-Za-z0-9_.\-]+(?![A-Za-z0-9_])"
    r"|(?<![A-Za-z0-9_.\-])(?:" + _BARE_ALTERNATION + r")(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
_COUNT_TOKEN = re.compile(r"(\d+)\s*(?:건|개|항목)")
#: 범주를 주장하는 서술 어휘(완료형 위주). 명사형("변경 사항", "추가로")까지 잡으면
#: 충실한 문장을 잘못 거부하므로 서술 형태만 인정한다.
_CATEGORY_CLAIMS: Tuple[Tuple[str, Tuple[re.Pattern, ...]], ...] = (
    (ADD, (
        re.compile(r"추가(?:했|하|되|됨|한|된)"),
        re.compile(r"생성(?:했|하|되|됨|한|된)"),
        re.compile(r"만들(?:었|어|어진|어짐)"),
        re.compile(r"신규\s*(?:파일|생성|추가)"),
        re.compile(r"새\s*파일"),
    )),
    (MODIFY, (
        re.compile(r"수정(?:했|하|되|됨|한|된)"),
        re.compile(r"고쳤|고치|고쳐"),
        re.compile(r"변경(?:했|하|되|됨|한|된)"),
        re.compile(r"편집(?:했|하|되|됨|한|된)"),
        re.compile(r"바꿨|바꾸|바꿔"),
        re.compile(r"업데이트(?:했|하|되|됨)"),
        re.compile(r"갱신(?:했|하|되|됨)"),
        re.compile(r"덮어썼|덮어씀|덮어쓰"),
    )),
    (DELETE, (
        re.compile(r"삭제(?:했|하|되|됨|한|된)"),
        re.compile(r"지웠|지우|지워"),
        re.compile(r"제거(?:했|하|되|됨|한|된)"),
        re.compile(r"없앴|없애"),
    )),
)
#: 주장 바로 뒤 부정 수식어 -> 그 어휘의 주장을 부정하는 문장으로 읽는다("삭제된 파일은 없습니다").
#: 절을 넘는 부정어(예: "만들었으며 삭제된 파일은 없습니다"의 "없습니다")와 혼동되지 않도록
#: 조사/보조사(은/는/이/가/도) 및 수식 구문으로 한정한다.
_NEGATION = re.compile(
    r"^(?:\s*[^,.!?\n]{0,8}?(?:은|는|이|가|도)\s*)?(?:없|아니|않|안\s|미\s)"
)

_PHRASE_SYSTEM_PROMPT = (
    "너는 이미 확정된 세션 변경 목록을 한국어 문장으로 다듬는 역할만 한다. "
    "목록에 없는 파일·경로·도구·건수·변경을 절대 추가하지 않는다. "
    "제시된 줄 수와 순서를 바꾸지 않고, 한 줄에 한 문장만 출력한다."
)


# --------------------------------------------------------------------------- #
# 값 조회 helpers (Mapping 과 속성 객체 모두 허용)
# --------------------------------------------------------------------------- #
def _one(source: Any, key: str) -> Tuple[Any, bool]:
    if source is None:
        return _MISSING, False
    if isinstance(source, Mapping):
        if key in source:
            return source[key], True
        return _MISSING, False
    value = getattr(source, key, _MISSING)
    return (value, True) if value is not _MISSING else (_MISSING, False)


def _flat(source: Any, names: Sequence[str]) -> Tuple[Any, Optional[str]]:
    """최상위에서만 찾는다(id/kind 처럼 중첩 의미가 없는 필드용)."""
    for name in names:
        value, found = _one(source, name)
        if found and value is not None:
            return value, name
    return _MISSING, None


def _scopes(source: Any) -> Iterable[Tuple[str, Any]]:
    """``(점 표기 경로, 컨테이너)``를 최상위부터 너비 우선으로 돌려준다."""
    seen = set()
    queue: List[Tuple[str, Any]] = [("", source)]
    while queue:
        prefix, container = queue.pop(0)
        if container is None or id(container) in seen:
            continue
        seen.add(id(container))
        yield prefix, container
        for key in _NESTED_KEYS:
            child, found = _one(container, key)
            if found and child is not None:
                queue.append((f"{prefix}.{key}" if prefix else key, child))


def _scoped(source: Any, names: Sequence[str]) -> Tuple[Any, Optional[str]]:
    """최상위와 중첩 컨테이너에서 찾고, 일치한 점 표기 경로를 함께 돌려준다."""
    for prefix, container in _scopes(source):
        for name in names:
            value, found = _one(container, name)
            if found and value is not None:
                return value, f"{prefix}.{name}" if prefix else name
    return _MISSING, None


def _looks_like_event(raw: Any) -> bool:
    if isinstance(raw, Mapping):
        return True
    if raw is None:
        return False
    return any(hasattr(raw, key) for names in EVENT_CONTRACT.values() for key in names)


def _as_bool(value: Any) -> Optional[bool]:
    """참/거짓 표기를 해석한다. 숫자 coercion 은 하지 않는다(0/1 카운트와 혼동 방지)."""
    if isinstance(value, bool):
        return value
    if not isinstance(value, str):
        return None
    text = normalize_text(value).lower()
    if text in {"true", "yes", "y", "new", "created", "create", "added", "add"}:
        return True
    if text in {"false", "no", "n", "existing", "modified", "edit"}:
        return False
    return None


def _normalize_op(value: Any) -> Optional[str]:
    if value is None or value is _MISSING:
        return None
    text = normalize_text(value).lower().replace("-", "_").replace(" ", "_")
    return text or None


def _is_failure(value: Any) -> bool:
    """실패·거부인가. HTTP 2xx 는 성공, 종료 코드 0 은 성공으로 읽는다."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if value >= 100:  # HTTP 스타일 상태 코드
            return not 200 <= value < 300
        return value != 0  # 종료 코드 스타일
    return normalize_text(value).lower() in _FAILURE_WORDS


def _is_pending(value: Any) -> bool:
    """아직 끝나지 않은 실행 상태인가(완료된 변경으로 보고하면 안 된다)."""
    if isinstance(value, (bool, int, float)):
        return False
    return normalize_text(value).lower().replace("-", "_").replace(" ", "_") in _PENDING_WORDS


def _status_issue(value: Any) -> Optional[str]:
    """상태 값 -> ``None`` | ``"failed"`` | ``"in_progress"``."""
    if value is None:
        return None
    if _is_pending(value):
        return "in_progress"
    if _is_failure(value):
        return "failed"
    return None


def _parse_timestamp(value: Any) -> Tuple[Optional[datetime], Optional[str]]:
    """``(datetime, 문제 설명)``. 해석 불가는 ``(None, 사유)``."""
    if value is None or value is _MISSING:
        return None, None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, bool):
        return None, f"해석할 수 없는 타임스탬프 {value!r}"
    elif isinstance(value, (int, float)):
        try:
            parsed = datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None, f"해석할 수 없는 타임스탬프 {value!r}"
    elif isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None, f"해석할 수 없는 타임스탬프 {value!r}"
    else:
        return None, f"해석할 수 없는 타임스탬프 {value!r}"
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc), (
            "타임존 없는 타임스탬프를 UTC로 가정해 정렬했습니다"
        )
    return parsed, None


def _fmt(value: Any) -> str:
    if value is _MISSING or value is None:
        return ""
    return cap_text(normalize_text(value), 80)


# --------------------------------------------------------------------------- #
# 결과 모델
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Classification:
    """한 변경 후보의 판정 + 감사 가능한 근거.

    ``evidence``는 판정을 만든 필드의 점 표기 경로(예: ``result.details.created``)이고
    ``evidence_value``는 그 필드에서 읽은 값이다. ``evidence="creation_status"``/
    ``value="absent"``는 "쓰기는 보고되었지만 생성 여부가 보고되지 않았다"는 뜻이다.
    """

    category: str
    evidence: str
    evidence_value: str
    description: str


@dataclass(frozen=True)
class TimelineEntry:
    """타임라인 한 줄. 모든 필드는 이벤트에서 온 값이거나 그 값의 한국어 서술이다."""

    category: str
    description: str
    target: str
    timestamp: Optional[str]
    tool: str
    event_id: str
    evidence: str
    evidence_value: str
    kind: str = ""
    confirmed: bool = True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "category": self.category,
            "description": self.description,
            "target": self.target,
            "timestamp": self.timestamp,
            "tool": self.tool,
            "event_id": self.event_id,
            "kind": self.kind,
            "confirmed": self.confirmed,
            "evidence": {"field": self.evidence, "value": self.evidence_value},
        }


@dataclass(frozen=True)
class SessionTimeline:
    """정렬된 변경 항목 + 범주별 집계 + 세션 구간 + 강등 기록(``degraded``)."""

    entries: Tuple[TimelineEntry, ...] = ()
    degraded: Tuple[Dict[str, Any], ...] = ()
    event_count: int = 0
    start: Optional[str] = None
    end: Optional[str] = None

    @property
    def counts(self) -> Dict[str, int]:
        totals = {name: 0 for name in CATEGORIES}
        for entry in self.entries:
            totals[entry.category] += 1
        return totals

    @property
    def unclassified(self) -> Tuple[TimelineEntry, ...]:
        return tuple(entry for entry in self.entries if entry.category == UNCLASSIFIED)

    def to_dict(self) -> Dict[str, Any]:
        counts = self.counts
        return {
            "session": {
                "start": self.start,
                "end": self.end,
                "event_count": self.event_count,
                "entry_count": len(self.entries),
                "counts": dict(counts),
            },
            "counts": dict(counts),
            "categories": [
                {
                    "category": name,
                    "count": counts[name],
                    "entries": [e.to_dict() for e in self.entries if e.category == name],
                }
                for name in CATEGORIES
            ],
            "entries": [entry.to_dict() for entry in self.entries],
            "unclassified": [entry.to_dict() for entry in self.unclassified],
            "degraded": [dict(issue) for issue in self.degraded],
        }


# --------------------------------------------------------------------------- #
# 이벤트 정규화
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class _Target:
    """변경 후보 하나(이벤트 최상위 대상 또는 파일별 결과 항목)와 그 항목 고유의 근거.

    파일별 항목이면 ``created``/``existed``/``deleted``/``status_value`` 는 **그 항목에서**
    읽은 값이고 ``*_evidence`` 는 ``result.details.perFileResults[0].created`` 처럼 컨테이너
    경로 전체다(감사 가능). ``from_item`` 은 항목 고유 근거가 있는지 여부로, 이때 근거는
    도구 이름 추론보다 우선한다.
    """

    value: str
    op: Optional[str]
    op_evidence: Optional[str]
    created: Optional[bool] = None
    created_evidence: Optional[str] = None
    existed: Optional[bool] = None
    existed_evidence: Optional[str] = None
    deleted: Optional[bool] = None
    deleted_evidence: Optional[str] = None
    status_value: Any = None
    status_issue: Optional[str] = None
    status_evidence: Optional[str] = None
    from_item: bool = False


@dataclass(frozen=True)
class _Event:
    event_id: str
    timestamp: Optional[datetime]
    iso: Optional[str]
    epoch: float
    kind: str
    raw_kind: str
    tool: str
    tool_norm: str
    status_value: Any
    status_issue: Optional[str]
    status_evidence: Optional[str]
    created: Optional[bool]
    created_evidence: Optional[str]
    existed: Optional[bool]
    existed_evidence: Optional[str]
    deleted: Optional[bool]
    deleted_evidence: Optional[str]
    targets: Tuple[_Target, ...]
    has_diff: bool


def _flag(
    raw: Any, name: str, event_id: str, issues: List[Dict[str, Any]]
) -> Tuple[Optional[bool], Optional[str]]:
    value, field = _scoped(raw, EVENT_CONTRACT[name])
    if value is _MISSING or value is None:
        return None, None
    parsed = _as_bool(value)
    if parsed is None:
        issues.append({
            "event": event_id,
            "problem": "unreadable_flag",
            "detail": f"{field}={value!r} 값을 참/거짓으로 해석하지 못했습니다",
        })
        return None, None
    return parsed, field


def _item_flag(
    item: Any, prefix: str, name: str, event_id: str, issues: List[Dict[str, Any]]
) -> Tuple[Optional[bool], Optional[str]]:
    """파일별 항목 하나에서 플래그를 읽고 ``접두.필드`` 전체 경로를 남긴다."""
    value, field = _flat(item, EVENT_CONTRACT[name])
    if value is _MISSING or value is None:
        return None, None
    path = f"{prefix}.{field}"
    parsed = _as_bool(value)
    if parsed is None:
        issues.append({
            "event": event_id,
            "problem": "unreadable_flag",
            "detail": f"{path}={value!r} 값을 참/거짓으로 해석하지 못했습니다",
        })
        return None, None
    return parsed, path


def _item_status(
    item: Any, prefix: str, event_id: str, issues: List[Dict[str, Any]]
) -> Tuple[Any, Optional[str], Optional[str]]:
    """파일별 항목 하나의 상태 -> ``(값, 문제, 경로)``. 문제는 failed/in_progress."""
    value, field = _flat(item, EVENT_CONTRACT["status"])
    if value is _MISSING or value is None:
        return None, None, None
    path = f"{prefix}.{field}"
    issue = _status_issue(value)
    if issue is None and not isinstance(value, (bool, int, float)):
        issues.append({
            "event": event_id,
            "problem": "unreadable_status",
            "detail": f"{path}={value!r} 상태를 해석하지 못해 성공으로도 실패로도 보지 않았습니다",
        })
    return value, issue, path


def _normalize_event(raw: Any, seq: int) -> Tuple[Optional[_Event], List[Dict[str, Any]]]:
    issues: List[Dict[str, Any]] = []
    if not _looks_like_event(raw):
        issues.append({
            "event": f"event-{seq}",
            "problem": "invalid_event",
            "detail": f"이벤트가 아닌 값({type(raw).__name__})은 건너뛰었습니다",
        })
        return None, issues

    id_value, _ = _flat(raw, EVENT_CONTRACT["event_id"])
    if id_value is _MISSING or not normalize_text(id_value):
        event_id = f"event-{seq}"
        issues.append({
            "event": event_id,
            "problem": "missing_event_id",
            "detail": "이벤트 id가 없어 입력 순번 기반 식별자를 합성했습니다",
        })
    else:
        event_id = normalize_text(id_value)

    timestamp_value, _ = _scoped(raw, EVENT_CONTRACT["timestamp"])
    timestamp, timestamp_problem = _parse_timestamp(timestamp_value)
    if timestamp is None:
        issues.append({
            "event": event_id,
            "problem": "missing_timestamp",
            "detail": timestamp_problem or "타임스탬프가 없어 정렬 맨 뒤에 배치했습니다",
        })
    elif timestamp_problem:
        issues.append({"event": event_id, "problem": "naive_timestamp",
                       "detail": timestamp_problem})

    kind_value, _ = _flat(raw, EVENT_CONTRACT["kind"])
    raw_kind = "" if kind_value is _MISSING else normalize_text(kind_value).lower()
    kind = KIND_ALIASES.get(raw_kind, raw_kind)

    tool_value, _ = _scoped(raw, EVENT_CONTRACT["tool"])
    tool = "" if tool_value is _MISSING else normalize_text(tool_value)
    tool_norm = tool.strip().lower().replace("-", "_").replace(" ", "_")

    status_value, status_field = _scoped(raw, EVENT_CONTRACT["status"])
    status_issue = None if status_value is _MISSING else _status_issue(status_value)

    created, created_evidence = _flag(raw, "created", event_id, issues)
    existed, existed_evidence = _flag(raw, "existed_before", event_id, issues)
    deleted, deleted_evidence = _flag(raw, "deleted", event_id, issues)

    diff_value, _ = _scoped(raw, ("diff",))
    has_diff = isinstance(diff_value, str) and bool(diff_value.strip())

    target_value, _ = _scoped(raw, EVENT_CONTRACT["target"])
    event_target = "" if target_value is _MISSING else normalize_text(target_value)
    op_value, op_field = _scoped(raw, EVENT_CONTRACT["op"])
    event_op = _normalize_op(op_value)
    if event_op is None and tool_norm in _CREATE_CAPABLE_TOOLS:
        # ``str_replace_editor`` 처럼 ``command="create"`` 로 생성/편집을 가르는 도구만
        # ``command`` 를 연산 근거로 읽는다(다른 도구의 셸 명령과 섞이지 않게).
        command_value, command_field = _scoped(raw, ("command",))
        event_op = _normalize_op(command_value)
        if event_op is not None:
            op_field = command_field

    targets: List[_Target] = []
    files_value, files_field = _scoped(raw, EVENT_CONTRACT["per_file_results"])
    if isinstance(files_value, (list, tuple)):
        for index, item in enumerate(files_value):
            if item is None or not _looks_like_event(item):
                continue
            prefix = f"{files_field}[{index}]"
            path_value, path_field = _flat(item, EVENT_CONTRACT["target"])
            path_val = (
                "" if path_value is _MISSING else normalize_text(path_value)
            ) or event_target
            item_op_value, item_op_field = _flat(item, EVENT_CONTRACT["op"])
            item_created, item_created_ev = _item_flag(item, prefix, "created", event_id, issues)
            item_existed, item_existed_ev = _item_flag(item, prefix, "existed_before",
                                                       event_id, issues)
            item_deleted, item_deleted_ev = _item_flag(item, prefix, "deleted", event_id, issues)
            item_status, item_status_issue, item_status_ev = _item_status(
                item, prefix, event_id, issues
            )
            item_from_item = any(
                flag is not None for flag in
                (item_created, item_existed, item_deleted, item_status_issue)
            )
            # 항목 고유 근거가 우선한다. 없을 때만 이벤트 최상위 값으로 채운다.
            file_created = item_created if item_created is not None else created
            file_existed = item_existed if item_existed is not None else existed
            file_deleted = item_deleted if item_deleted is not None else deleted
            file_status = item_status if item_status is not None else (
                None if status_value is _MISSING else status_value
            )
            file_status_issue = item_status_issue if item_status_issue is not None else status_issue
            if item_op_field:
                file_op = _normalize_op(item_op_value)
                evidence = item_op_field if file_op else None
                evidence = f"{prefix}.{evidence}" if evidence else None
            else:
                file_op = event_op
                evidence = op_field if event_op else None
            targets.append(_Target(
                value=path_val,
                op=file_op,
                op_evidence=evidence,
                created=file_created,
                created_evidence=(
                    item_created_ev if item_created is not None else created_evidence
                ),
                existed=file_existed,
                existed_evidence=(
                    item_existed_ev if item_existed is not None else existed_evidence
                ),
                deleted=file_deleted,
                deleted_evidence=(
                    item_deleted_ev if item_deleted is not None else deleted_evidence
                ),
                status_value=file_status,
                status_issue=file_status_issue,
                status_evidence=(
                    item_status_ev if item_status is not None else status_field
                ),
                from_item=item_from_item,
            ))
            item_diff, _ = _flat(item, ("diff",))
            if isinstance(item_diff, str) and item_diff.strip():
                has_diff = True
            if path_value is _MISSING:
                issues.append({
                    "event": event_id,
                    "problem": "missing_target",
                    "detail": f"{prefix} 항목에 경로가 없어 '대상 미상'으로 표기했습니다",
                })
    if not targets:
        targets.append(_Target(
            value=event_target,
            op=event_op,
            op_evidence=op_field if event_op else None,
            created=created,
            created_evidence=created_evidence,
            existed=existed,
            existed_evidence=existed_evidence,
            deleted=deleted,
            deleted_evidence=deleted_evidence,
            status_value=None if status_value is _MISSING else status_value,
            status_issue=status_issue,
            status_evidence=status_field,
        ))

    if not tool and kind in ("tool_call", "tool_result"):
        issues.append({
            "event": event_id,
            "problem": "missing_tool",
            "detail": "도구 이름이 없어 어떤 도구로 바뀌었는지 문장에 표기할 수 없습니다",
        })
    write_like = (
        tool_norm in WRITE_TOOLS
        or created is not None
        or existed is not None
        or deleted is not None
        or has_diff
    )
    if write_like and any(not target.value for target in targets):
        issues.append({
            "event": event_id,
            "problem": "missing_target",
            "detail": "대상 경로/식별자가 없어 '대상 미상'으로 표기했습니다",
        })

    event = _Event(
        event_id=event_id,
        timestamp=timestamp,
        iso=None if timestamp is None else timestamp.isoformat(),
        epoch=math.inf if timestamp is None else timestamp.timestamp(),
        kind=kind,
        raw_kind=raw_kind,
        tool=tool,
        tool_norm=tool_norm,
        status_value=None if status_value is _MISSING else status_value,
        status_issue=status_issue,
        status_evidence=status_field,
        created=created,
        created_evidence=created_evidence,
        existed=existed,
        existed_evidence=existed_evidence,
        deleted=deleted,
        deleted_evidence=deleted_evidence,
        targets=tuple(targets),
        has_diff=has_diff,
    )
    return event, issues


# --------------------------------------------------------------------------- #
# 분류 (결정론, 근거 필드 기록)
# --------------------------------------------------------------------------- #
def _describe(category: str, tool: str, target: str, variant: str = "") -> str:
    name = target or "대상 미상"
    tool_name = tool or "도구 미상"
    if category == ADD:
        return f"{name} 추가 — {tool_name} 도구가 새 대상을 만들었다고 보고함"
    if category == MODIFY:
        return f"{name} 수정 — {tool_name} 도구가 기존 대상을 편집했다고 보고함"
    if category == DELETE:
        return f"{name} 삭제 — {tool_name} 도구가 대상을 삭제했다고 보고함"
    if variant == "in_progress":
        return (
            f"{name} 변경 미확정 — {tool_name} 실행이 아직 끝나지 않아 완료된 변경으로 "
            "보고하지 않음"
        )
    if variant == "failed":
        return (
            f"{name} 변경 없음 — {tool_name} 실행이 실패 또는 거부되어 변경이 보고되지 않음"
        )
    return f"{name} 분류 불가 — {tool_name} 실행의 생성/존재 여부가 보고되지 않음"


def _classify(event: _Event, target: _Target) -> Classification:
    """근거 순서: 항목 고유 상태/플래그 -> 이벤트 플래그 -> 연산 어휘 -> 도구 이름.

    파일별 항목에 고유 근거가 있으면 그 근거가 도구 이름 추론보다 우선한다. 애매한 쓰기
    동사와 생성 가능 도구는 존재/생성 근거가 있을 때만 확정되고, 없으면 분류 불가다.
    """
    tool_name = event.tool or "도구 미상"
    target_name = target.value
    op = target.op
    op_evidence = target.op_evidence or "op"

    status_issue = target.status_issue or event.status_issue
    if status_issue == "failed":
        return Classification(
            UNCLASSIFIED,
            target.status_evidence or event.status_evidence or "status",
            _fmt(target.status_value if target.status_value is not None
                 else event.status_value),
            _describe(UNCLASSIFIED, tool_name, target_name, "failed"),
        )
    if status_issue == "in_progress":
        return Classification(
            UNCLASSIFIED,
            target.status_evidence or event.status_evidence or "status",
            _fmt(target.status_value if target.status_value is not None
                 else event.status_value),
            _describe(UNCLASSIFIED, tool_name, target_name, "in_progress"),
        )
    # 항목 고유 근거가 있으면 도구 이름 추론보다 먼저 적용한다.
    if target.from_item:
        item_result = _classify_by_evidence(event, target, tool_name, target_name)
        if item_result is not None:
            return item_result
    if event.tool_norm in _DELETE_TOOLS:
        return Classification(DELETE, "tool", event.tool,
                              _describe(DELETE, tool_name, target_name))
    if event.deleted is True:
        return Classification(DELETE, event.deleted_evidence or "deleted", "true",
                              _describe(DELETE, tool_name, target_name))
    if op in _DELETE_OPS:
        return Classification(DELETE, op_evidence, op,
                              _describe(DELETE, tool_name, target_name))
    by_evidence = _classify_by_evidence(event, target, tool_name, target_name)
    if by_evidence is not None:
        return by_evidence
    # 애매한 쓰기 동사와 줄 추가 어휘는 그 자체로는 범주를 확정하지 않는다
    # (기존 파일 덮어쓰기·줄 추가일 수 있으므로 존재 근거가 있어야 한다).
    if op in _WRITE_OPS or op in _WEAK_CREATE_OPS:
        if event.tool_norm in _EDIT_TOOLS:
            return Classification(MODIFY, "tool", event.tool,
                                  _describe(MODIFY, tool_name, target_name))
        return Classification(UNCLASSIFIED, "creation_status", "absent",
                              _describe(UNCLASSIFIED, tool_name, target_name))
    if op in _CREATE_OPS:
        return Classification(ADD, op_evidence, op, _describe(ADD, tool_name, target_name))
    if event.tool_norm in _CREATE_TOOLS:
        return Classification(ADD, "tool", event.tool, _describe(ADD, tool_name, target_name))
    if op in _EDIT_OPS:
        return Classification(MODIFY, op_evidence, op,
                              _describe(MODIFY, tool_name, target_name))
    if event.tool_norm in _EDIT_TOOLS:
        return Classification(MODIFY, "tool", event.tool,
                              _describe(MODIFY, tool_name, target_name))
    # 남은 연산 어휘(애매한 쓰기 동사, 줄 추가 어휘, 생성 가능 도구의 patch …)는
    # 존재/생성 근거가 없으므로 수정으로 확정하지 않는다.
    return Classification(UNCLASSIFIED, "creation_status", "absent",
                          _describe(UNCLASSIFIED, tool_name, target_name))


def _classify_by_evidence(
    event: _Event, target: _Target, tool_name: str, target_name: str
) -> Optional[Classification]:
    """존재/생성/삭제 근거만으로 판정한다. 근거가 없으면 ``None``."""
    if target.deleted is True:
        return Classification(DELETE, target.deleted_evidence or "deleted", "true",
                              _describe(DELETE, tool_name, target_name))
    if target.created is True:
        return Classification(ADD, target.created_evidence or "created", "true",
                              _describe(ADD, tool_name, target_name))
    if target.existed is False:
        return Classification(ADD, target.existed_evidence or "existed_before", "false",
                              _describe(ADD, tool_name, target_name))
    if target.existed is True:
        return Classification(MODIFY, target.existed_evidence or "existed_before", "true",
                              _describe(MODIFY, tool_name, target_name))
    if target.created is False:
        return Classification(MODIFY, target.created_evidence or "created", "false",
                              _describe(MODIFY, tool_name, target_name))
    return None


def _classify_event_with_target(event: Any) -> Tuple[Classification, str]:
    """이벤트 하나를 판정하고 ``(Classification, target_name)`` 을 돌려준다."""
    normalized, _ = _normalize_event(event, 0)
    if normalized is None:
        return Classification(UNCLASSIFIED, "event", "invalid",
                              "이벤트로 읽을 수 없는 입력 — 분류 불가"), ""
    target = normalized.targets[0]
    return _classify(normalized, target), target.value


def classify_event(event: Any) -> Classification:
    """이벤트 하나를 판정하고 근거 필드를 함께 돌려준다(추측 없음)."""
    classification, _ = _classify_event_with_target(event)
    return classification


def classify(event: Any) -> str:
    """``추가 | 수정 | 삭제 | 분류 불가``. 근거가 필요하면 :func:`classify_event`."""
    return classify_event(event).category


def _is_candidate(event: _Event) -> bool:
    """변경 후보인가(읽기·메시지·승인은 타임라인에 들어가지 않는다)."""
    if event.tool_norm in WRITE_TOOLS:
        return True
    if event.created is not None or event.existed is not None or event.deleted is not None:
        return True
    if any(target.op for target in event.targets):
        return True
    return event.has_diff


def build_timeline(events: Iterable[Any]) -> SessionTimeline:
    """순수 함수: 이벤트만으로 타임라인을 만든다(모델/IO 없음).

    수명주기 프레임(``tool_execution_start``/``end``)은 같은 도구 호출 id마다 한 항목으로
    합치고 종료 프레임으로 판정한다(``protocol.js`` 방식). 종료 프레임이 없는 호출은
    미완료이므로 ``분류 불가`` 로 보낸다.
    """
    issues: List[Dict[str, Any]] = []
    earliest: Optional[datetime] = None
    latest: Optional[datetime] = None
    event_count = 0

    # 1단계: 정규화 및 수명주기 프레임 상관(tool_call_id 기준 집약).
    # order: 최초 등장 순서 보존, frames: 도구 호출 id별 정규화된 이벤트 목록.
    groups: Dict[str, List[_Event]] = {}
    order: List[str] = []
    independent_events: List[_Event] = []

    for seq, raw in enumerate(list(events or ())):
        event_count += 1
        event, event_issues = _normalize_event(raw, seq)
        issues.extend(event_issues)
        if event is None:
            continue
        if event.timestamp is not None:
            if earliest is None or event.timestamp < earliest:
                earliest = event.timestamp
            if latest is None or event.timestamp > latest:
                latest = event.timestamp
        # 수명주기 프레임은 tool_call_id(=event_id)로 묶는다.
        if event.raw_kind in _LIFECYCLE_FRAMES:
            key = event.event_id
            if key not in groups:
                groups[key] = []
                order.append(key)
            groups[key].append(event)
        else:
            independent_events.append(event)

    correlated_events: List[_Event] = list(independent_events)
    for key in order:
        frames = groups[key]
        terminal = [f for f in frames if f.raw_kind in _FRAME_END]
        starts = [f for f in frames if f.raw_kind in _FRAME_START]
        if terminal:
            # 종료 프레임을 대표로 쓰되, 시작 프레임에만 있던 도구/대상/타임스탬프를 보충한다.
            end_frame = terminal[-1]
            start_frame = starts[0] if starts else None
            effective_tool = end_frame.tool or (start_frame.tool if start_frame else "")
            effective_norm = end_frame.tool_norm or (
                start_frame.tool_norm if start_frame else ""
            )
            effective_ts = end_frame.timestamp or (
                start_frame.timestamp if start_frame else None
            )
            effective_targets = end_frame.targets
            if (not effective_targets or (len(effective_targets) == 1 and not effective_targets[0].value)) and start_frame:
                if start_frame.targets and any(t.value for t in start_frame.targets):
                    effective_targets = start_frame.targets
            correlated_events.append(replace(
                end_frame,
                tool=effective_tool,
                tool_norm=effective_norm,
                timestamp=effective_ts,
                iso=None if effective_ts is None else effective_ts.isoformat(),
                epoch=math.inf if effective_ts is None else effective_ts.timestamp(),
                targets=effective_targets,
            ))
        elif starts:
            # 시작 프레임만 온 호출: 종료 프레임이 없으므로 아직 실행 중(in_progress)이다.
            start_frame = starts[0]
            correlated_events.append(replace(
                start_frame,
                status_value="in_progress",
                status_issue="in_progress",
                status_evidence="lifecycle",
            ))
        else:
            # 업데이트만 온 경우: 최신 프레임을 in_progress 로 남긴다.
            last_frame = frames[-1]
            correlated_events.append(replace(
                last_frame,
                status_value="in_progress",
                status_issue="in_progress",
                status_evidence="lifecycle",
            ))

    rows: List[Tuple[float, str, int, int, TimelineEntry]] = []
    for seq, event in enumerate(correlated_events):
        if not _is_candidate(event):
            continue
        for file_index, target in enumerate(event.targets):
            classification = _classify(event, target)
            description = classification.description
            if event.raw_kind in _FRAME_START or event.kind == "tool_call":
                if event.status_issue != "in_progress":
                    description += " (호출만 보고됨)"
            entry = TimelineEntry(
                category=classification.category,
                description=description,
                target=target.value,
                timestamp=event.iso,
                tool=event.tool,
                event_id=event.event_id,
                evidence=classification.evidence,
                evidence_value=classification.evidence_value,
                kind=event.kind,
                confirmed=(
                    event.raw_kind not in _FRAME_START
                    and event.kind != "tool_call"
                    and event.status_issue != "in_progress"
                ),
            )
            rows.append((event.epoch, event.event_id, seq, file_index, entry))
    rows.sort(key=lambda row: (row[0], row[1], row[2], row[3]))
    return SessionTimeline(
        entries=tuple(row[4] for row in rows),
        degraded=tuple(issues),
        event_count=event_count,
        start=None if earliest is None else earliest.isoformat(),
        end=None if latest is None else latest.isoformat(),
    )


# --------------------------------------------------------------------------- #
# 문장화 (구조적 / 로컬 모델)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PhraseRequest:
    """러너가 받는 입력: 확정된 문장 + 검증 기준(대상/건수)."""

    sentences: Tuple[str, ...]
    entries: Tuple[TimelineEntry, ...]
    targets: Tuple[str, ...]
    counts: Mapping[str, int]
    total: int


@dataclass(frozen=True)
class PhraseOutcome:
    """러너가 돌려주는 출력 + provenance(aux 러너의 값을 그대로 옮긴다)."""

    lines: Tuple[str, ...]
    raw: str
    model_id: str
    cost_usd: Optional[float]
    provider: str
    role: str
    role_note: Optional[str] = None


@dataclass(frozen=True)
class PhrasedTimeline:
    """렌더 결과: 문장 + 출처. ``to_dict()``가 UI용 고정 구조를 만든다."""

    timeline: SessionTimeline
    sentences: Tuple[str, ...]
    summary: str
    source: str
    model_id: str
    cost_usd: Optional[float]
    provider: str
    role: str
    role_note: Optional[str] = None
    rejection: Optional[Dict[str, Any]] = None
    notes: Tuple[str, ...] = ()

    @property
    def is_model_phrased(self) -> bool:
        return self.source == "model"

    def to_dict(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {
            "provenance": {
                "source": self.source,
                "model_id": self.model_id,
                "cost_usd": self.cost_usd,
                "provider": self.provider,
                "role": self.role,
                "role_note": self.role_note,
                "rejection": None if self.rejection is None else dict(self.rejection),
                "notes": list(self.notes),
            },
            "summary": self.summary,
            "sentences": list(self.sentences),
        }
        data.update(self.timeline.to_dict())
        return data


def _summary_line(timeline: SessionTimeline) -> str:
    counts = timeline.counts
    parts = ", ".join(f"{name} {counts[name]}건" for name in CATEGORIES)
    line = f"세션 변경 {len(timeline.entries)}건 — {parts}"
    if timeline.start and timeline.end:
        line += f" (세션 구간 {timeline.start} ~ {timeline.end})"
    return line + "."


def _phrase_payload(request: PhraseRequest) -> str:
    lines = []
    for index, (entry, sentence) in enumerate(zip(request.entries, request.sentences), 1):
        lines.append(
            f"{index}. [{entry.category}] {entry.target or '대상 미상'} | "
            f"{entry.tool or '도구 미상'} | {sentence}"
        )
    allowed_targets = ", ".join(request.targets) or "(없음)"
    allowed_counts = ", ".join(
        f"{name} {request.counts.get(name, 0)}건" for name in CATEGORIES
    )
    return (
        "아래 변경 문장을 자연스러운 한국어 한 문장으로 다듬으세요.\n"
        "규칙: 줄 수와 순서를 바꾸지 않습니다. 새 파일/경로/도구/건수/변경을 추가하지 않습니다. "
        "목록에 없는 대상은 쓰지 않습니다. 번호와 대괄호 머리표를 붙이지 말고 문장만 출력합니다.\n"
        f"허용된 대상: {allowed_targets}\n"
        f"허용된 건수: 총 {request.total}건 ({allowed_counts})\n\n"
        + "\n".join(lines)
    )


def _unknown_task_reason(reason: str) -> bool:
    text = normalize_text(reason).lower()
    return "unknown aux task" in text or "not declared" in text


def _clean_lines(text: Any) -> Tuple[str, ...]:
    cleaned: List[str] = []
    for line in str(text or "").splitlines():
        value = normalize_text(_BULLET.sub("", line))
        if value:
            cleaned.append(value)
    return tuple(cleaned)


class TimelinePhraser(AuxTaskRunner):
    """``AuxTaskRunner``에 "확정 문장 다듬기" 한 작업만 더한 실행기.

    선택·로컬 전용 강제·1회 재시도·provenance·비용 회계는 상속한 ``_invoke``가 그대로
    맡는다(별도 선택기를 만들지 않고 ``aux_tasks``를 수정하지도 않는다). 레지스트리가
    ``session_timeline`` 작업을 모르면 기존 ``compactor`` 역할로 한 번 더 시도하고,
    그 사실을 ``role_note``에 남긴다.
    """

    def phrase(self, request: PhraseRequest) -> PhraseOutcome:
        messages = [
            {"role": "system", "content": _PHRASE_SYSTEM_PROMPT},
            {"role": "user", "content": _phrase_payload(request)},
        ]
        note: Optional[str] = None
        role = SESSION_TIMELINE_JOB
        try:
            text, provenance = self._invoke(SESSION_TIMELINE_JOB, messages)
        except AuxTaskUnavailable as exc:
            if not _unknown_task_reason(exc.reason):
                raise
            text, provenance = self._invoke(COMPACTOR_JOB, messages)
            note, role = PENDING_ROLE_NOTE, COMPACTOR_ROLE
        return PhraseOutcome(
            lines=_clean_lines(text),
            raw=str(text),
            model_id=provenance.model_id,
            cost_usd=provenance.cost_usd,
            provider=provenance.provider,
            role=role,
            role_note=note,
        )


def _normalize_target(value: Any) -> str:
    """대상 경로 비교용 정규화: 구분자 통일, 강조 표기 제거, ``./`` 접두 제거."""
    text = normalize_text(value).replace("\\", "/").strip().strip("`'\"()[]{}<>,.;:")
    while text.startswith("./"):
        text = text[2:]
    return text.casefold()


def _line_targets(line: str, allowed: Mapping[str, Any]) -> Tuple[str, ...]:
    """문장에 등장한 **타임라인에 있는** 대상(정확 일치만 인정한다).

    접미 일치를 인정하지 않으므로 ``backup/a.py`` 같은 발명된 디렉터리는 통과하지 못한다.
    """
    found: List[str] = []
    for match in _PATH_TOKEN.finditer(line):
        candidate = _normalize_target(match.group(0))
        if candidate and candidate in allowed and candidate not in found:
            found.append(candidate)
    return tuple(found)


def _claimed_categories(line: str) -> Tuple[set, set]:
    """문장이 주장하는 범주 ``(긍정, 부정)``.

    부정은 주장 어휘 뒤 12자 안의 부정어로 판별한다("삭제된 파일은 없습니다" -> 삭제 부정).
    """
    positive: set = set()
    negative: set = set()
    for category, patterns in _CATEGORY_CLAIMS:
        for pattern in patterns:
            for match in pattern.finditer(line):
                window = line[match.end(): match.end() + 12]
                if _NEGATION.search(window):
                    negative.add(category)
                else:
                    positive.add(category)
    return positive, negative


def _validate_phrasing(lines: Sequence[str], timeline: SessionTimeline) -> List[Dict[str, Any]]:
    """모델 문장이 타임라인 밖의 대상/건수/변경을 말하는지 검사한다(전부 아니면 전무)."""
    entries = timeline.entries
    violations: List[Dict[str, Any]] = []
    if len(lines) != len(entries):
        violations.append({
            "kind": "line_count",
            "value": f"{len(lines)} != {len(entries)}",
            "detail": "다듬은 문장 수가 변경 항목 수와 다릅니다",
        })
    allowed_targets = {_normalize_target(e.target): e.target for e in entries if e.target}
    counts = timeline.counts
    allowed_counts = {len(entries)} | set(counts.values())
    seen = set()

    def add(kind: str, value: str, detail: str) -> None:
        key = (kind, value)
        if key in seen:
            return
        seen.add(key)
        violations.append({"kind": kind, "value": value, "detail": detail})

    claimed_without_entries: set = set()
    for index, line in enumerate(lines, 1):
        for match in _PATH_TOKEN.finditer(line):
            token = match.group(0)
            if _normalize_target(token) in allowed_targets:
                continue
            add("unknown_target", token, "타임라인 이벤트에 없는 대상입니다")
        positive, negative = _claimed_categories(line)
        for category in positive:
            if counts.get(category, 0) == 0:
                claimed_without_entries.add(category)
        if len(lines) != len(entries):
            continue
        entry = entries[index - 1]
        # 1) 이 줄이 부르는 대상을 같은 줄의 주장과 묶는다(줄-항목 순서는 프롬프트 계약).
        named = _line_targets(line, allowed_targets)
        entry_target = _normalize_target(entry.target)
        for target in named:
            if entry_target and target != entry_target:
                add("target_pairing", allowed_targets[target],
                    f"{index}번째 문장이 {entry.target} 항목 자리에서 다른 대상을 말했습니다")
        # 2) 이 줄의 범주 주장이 그 항목의 범주와 어긋나면 거부한다.
        if positive and entry.category not in positive:
            add("category_mismatch", sorted(positive)[0],
                f"{index}번째 문장이 {entry.category} 항목을 "
                f"{', '.join(sorted(positive))}(으)로 말했습니다")
        if entry.category in negative and entry.category not in positive:
            add("category_negated", entry.category,
                f"{index}번째 문장이 {entry.category} 항목을 부정했습니다")
    for category in sorted(claimed_without_entries):
        add("category_without_entries", category,
            "항목이 없는 범주를 변경으로 말했습니다")
    for match in _COUNT_TOKEN.finditer("\n".join(lines)):
        number = int(match.group(1))
        if number in allowed_counts:
            continue
        add("unknown_count", match.group(0), "타임라인 집계에 없는 건수입니다")
    return violations


def render_timeline(timeline: SessionTimeline, runner: Any = None) -> PhrasedTimeline:
    """문장화. 러너가 없거나 모델을 쓸 수 없으면 구조적 문장을 쓴다(항상 성공)."""
    structural = tuple(entry.description for entry in timeline.entries)
    summary = _summary_line(timeline)

    def structural_result(
        rejection: Optional[Dict[str, Any]] = None, notes: Tuple[str, ...] = ()
    ) -> PhrasedTimeline:
        return PhrasedTimeline(
            timeline=timeline,
            sentences=structural,
            summary=summary,
            source="structural",
            model_id="",
            cost_usd=0.0,
            provider="none",
            role="",
            role_note=None,
            rejection=rejection,
            notes=notes,
        )

    if not structural:
        return structural_result(notes=("변경 항목이 없어 모델을 호출하지 않았습니다.",))
    if runner is None:
        return structural_result(notes=("모델 실행기가 없어 구조적 문장을 사용했습니다.",))

    request = PhraseRequest(
        sentences=structural,
        entries=timeline.entries,
        targets=tuple(dict.fromkeys(e.target for e in timeline.entries if e.target)),
        counts=timeline.counts,
        total=len(timeline.entries),
    )
    try:
        outcome = runner.phrase(request)
    except AuxCloudProviderRefused as exc:
        return structural_result(
            rejection={"reason": "cloud_provider_refused", "detail": str(exc), "violations": []},
            notes=(f"비-로컬 provider({exc.provider}) 선택을 거부하고 구조적 문장을 유지했습니다.",),
        )
    except AuxTaskUnavailable as exc:
        return structural_result(
            rejection={"reason": "aux_model_unavailable", "detail": exc.reason, "violations": []},
            notes=(f"로컬 aux 모델을 쓸 수 없어 구조적 문장을 유지했습니다: {exc.reason}",),
        )
    except AuxTaskError as exc:
        return structural_result(
            rejection={"reason": "aux_task_error", "detail": str(exc), "violations": []},
            notes=(f"aux 실행이 실패해 구조적 문장을 유지했습니다: {exc}",),
        )

    if outcome.provider != "local":
        # 구조적 문장을 돌려주되 실제 provider/비용은 보존한다(무료로 보고하지 않는다).
        return replace(
            structural_result(
                rejection={"reason": "non_local_provider",
                           "detail": f"provider={outcome.provider!r}", "violations": []},
                notes=("aux 결과가 로컬 실행으로 증명되지 않아 모델 문장을 쓰지 않았습니다.",),
            ),
            model_id=outcome.model_id,
            cost_usd=outcome.cost_usd,
            provider=outcome.provider,
            role=outcome.role,
            role_note=outcome.role_note,
        )
    if not outcome.lines:
        return structural_result(
            rejection={"reason": "empty_model_output",
                       "detail": "모델이 빈 응답을 반환했습니다", "violations": []},
            notes=("모델 응답이 비어 구조적 문장을 사용했습니다.",),
        )
    violations = _validate_phrasing(outcome.lines, timeline)
    if violations:
        return structural_result(
            rejection={
                "reason": "model_output_rejected",
                "detail": "모델 문장이 타임라인에 없는 대상/건수/변경을 언급했습니다",
                "violations": violations,
                "raw": cap_text(normalize_text(outcome.raw), 2000),
            },
            notes=("모델 문장을 거부하고 구조적 문장을 반환했습니다(사유는 rejection에 기록).",),
        )
    return PhrasedTimeline(
        timeline=timeline,
        sentences=tuple(outcome.lines),
        summary=summary,
        source="model",
        model_id=outcome.model_id,
        cost_usd=outcome.cost_usd,
        provider=outcome.provider,
        role=outcome.role,
        role_note=outcome.role_note,
        rejection=None,
        notes=(),
    )

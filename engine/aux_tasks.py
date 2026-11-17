"""Local auxiliary-task runner: session titling, memory distillation, compaction, rewrite.

세션 제목·메모리 증류·컨텍스트 압축·질의 재작성처럼 작은 로컬 모델로 충분한 부가 작업을
API 비용 0으로 실행한다. 이 모듈이 스스로 강제하는 규칙:

1. **로컬 전용.** 모든 작업은
   ``registry.select_aux_model(task, tier=..., machine=..., foreground_model_id=...)``
   로 모델을 고르고 ``route="local_only"``로만 호출한다. 선택이 비-로컬 provider를
   가리키면 :class:`AuxCloudProviderRefused`로 거부한다(클라우드 폴백 없음, 비용 없음).
2. **모든 결과에 provenance.** ``provider`` ("local" | "external" | "unknown" | "none"),
   ``model_id``, Optional ``cost_usd``, ``source`` ("model" | "fallback"). 결정론적 폴백은
   절대 모델 출력으로 표기하지 않는다. ``cost_usd=None``은 "무료"가 아니라 **알 수 없음**
   이며 ``provider="unknown"``으로 표시한다 — 단가 미등록(``LmClient._price``가 ``None``),
   음수/NaN 비용, 선택 모델과 다른 ``usage.model_id`` 보고가 모두 여기에 해당한다.
3. **결정론과 상한.** 제목/질의 출력은 공백 정규화 후 길이 상한을 지킨다. 압축은
   ``token_budget``을 넘지 않고 무엇을 버렸는지 보고한다. 재시도는 일시적 전송 오류에
   한해 정확히 1회다(무한 재시도 없음).
4. **비용 회계.** :meth:`AuxTaskRunner.stats`는 작업별 model/fallback/structural 호출 수와,
   로컬 실행에서 구조적으로 ``0.0``인 누적 ``cost_usd``를 노출한다. 주입된 클라이언트가
   양수 비용을 보고하면 **재시도로 버려진 시도의 비용까지** 합산해 ``external_cost_usd``로
   기록하고 결과를 ``provider="external"``(not-local)로 표시한다 — 유료 호출을 숨길 수
   없다. ``paid_calls``는 **유료 시도 수**다(청구 이벤트 수가 아니다). 보고가 모호하면
   (비용 미상·비숫자·음수/NaN·모델 불일치) ``unknown_cost``로 세고 결과를
   ``provider="unknown"``/``cost_usd=None``으로 남긴다 — 무료로 위장하지 않는다.

작업별 폴백 정책 (:data:`FALLBACK_POLICIES`, ``AuxTaskRunner.fallback_policy(job)``):
===============  =========  ============================================================
작업              정책        aux 모델이 준비되지 않았을 때
===============  =========  ============================================================
``title``        fallback   첫 사용자 메시지에서 만든 정규화·길이제한 제목(``Untitled
                            session``로의 안전한 기본값)
``distillation`` raise      :class:`AuxTaskUnavailable` (선택 사유 보존). 모델 없이 만든
                            후보는 메모리 저장소를 오염시키므로 만들지 않는다.
``compaction``   fallback   예산에 들어가는 최신 턴만 남기는 구조적 압축 + 버린 내용 보고
``query_rewrite`` fallback   호출자 질의 자체의 정규화·길이제한 형태
===============  =========  ============================================================

폴백 정책은 **모델 부재(unavailable)** 에만 적용된다. 선택이 ready인데 호출이 실패하면
(재시도 소진/비일시 오류) :class:`AuxTransportError`가 그대로 올라간다 — 준비된 모델의
실패를 결정론 폴백으로 위장하면 "왜 모델이 안 쓰였는지"가 사라지기 때문이다. 계약 위반
(비-로컬 provider)은 정책과 무관하게 :class:`AuxCloudProviderRefused`다. 레지스트리가
``select_aux_model``을 노출하지 않거나 시그니처가 어긋나면 :class:`AuxRegistryContractError`
로 **크게 실패한다**(백그라운드/포그라운드 선택기로 역할·게이트를 조용히 바꾸지 않는다).
선택기 자체가 예외를 던지면 :class:`AuxSelectionError`다(폴백으로 삼키지 않고 ``error`` 집계).

압축이 모델 호출을 필요로 하지 않는 경우(대화가 이미 예산 안, 요약 예산을 예약할 수 없는
작은 예산)는 ``stats()['jobs']['compaction']['structural']``로 세고, "모델이 필요했지만 쓸
수 없었다"(예: 모델 부재, 빈 요약 응답)는 ``fallback``으로 센다. 요약을 넣지 않은 결과는
언제나 ``summary_applied=False``이고 그 이유가 ``provenance.reason``에 남는다.

압축을 포함한 모든 작업은 압축/재작성 시 토큰을 ``decision_planner.estimate_tokens``
(≈3자/토큰)로 추정한다. 실제 모델 토크나이저가 아니므로 예산은 보수적 근사치다.
"""
from __future__ import annotations

import hashlib
import inspect
import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .decision_planner import estimate_tokens
from .lm_client import LmClientError, ProviderUnavailable

__all__ = [
    "AUX_TASKS",
    "FALLBACK_POLICIES",
    "LOCAL_ROUTE",
    "CHARS_PER_TOKEN",
    "SUMMARY_LABEL",
    "AuxTaskError",
    "AuxTaskUnavailable",
    "AuxTransportError",
    "AuxCloudProviderRefused",
    "AuxModelOutputError",
    "AuxRegistryContractError",
    "AuxSelectionError",
    "Provenance",
    "SessionTitle",
    "MemoryCandidate",
    "DistillationResult",
    "CompactionResult",
    "QueryRewrite",
    "AuxTaskRunner",
    "normalize_text",
    "cap_text",
]

#: 이 실행기가 아는 보조 작업 이름(= ``select_aux_model``에 그대로 넘기는 task).
AUX_TASKS = ("title", "distillation", "compaction", "query_rewrite")

#: 작업별 폴백 정책. ``fallback``은 결정론적 대체 결과, ``raise``는 AuxTaskUnavailable.
FALLBACK_POLICIES: Dict[str, str] = {
    "title": "fallback",
    "distillation": "raise",
    "compaction": "fallback",
    "query_rewrite": "fallback",
}

#: 로컬 엔드포인트만 쓰는 전송 경로(클라우드 라우팅 거부).
LOCAL_ROUTE = "local_only"
#: ``estimate_tokens``와 같은 근사(3자/토큰).
CHARS_PER_TOKEN = 3
#: 예약된 요약 몫 안에서 항상 쓸 수 있는 최소 라벨. 이 라벨조차 예약 몫에 들어가지 않으면
#: 요약은 불가능하므로 모델을 호출하지 않는다.
SUMMARY_LABEL = "[summary] "

_WS = re.compile(r"\s+")
_FENCE = re.compile(r"```[a-zA-Z0-9_+.\-]*\s*\n?(.*?)\n?```", re.DOTALL)
_TITLE_PREFIX = re.compile(r"^title\s*[:：]\s*", re.IGNORECASE)
_EDGE_CHARS = "`'\"*_# \t"
_TRAILING_PUNCT = " \t.,;:!?…'\""


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #
class AuxTaskError(RuntimeError):
    """보조 작업 실패의 공통 상위 타입."""


class AuxTaskUnavailable(AuxTaskError):
    """이 작업에 쓸 수 있는 로컬 aux 모델이 없다.

    ``reason``은 선택기(``AuxModelSelection.reason``)의 사유를 그대로 보존한다.
    """

    def __init__(self, task: str, reason: str, detail: Optional[str] = None):
        self.task = task
        self.reason = str(reason or "aux model unavailable")
        self.detail = None if detail is None else str(detail)
        super().__init__(f"aux task {task!r} unavailable: {self.reason}")


class AuxTransportError(AuxTaskError):
    """클라이언트 계층 실패. ``transient``는 일시적 전송 오류였음을 뜻한다.

    일시적 오류(:class:`~engine.lm_client.ProviderUnavailable`)만 1회 재시도하며,
    재시도가 소진되면 여기서 멈춘다(루프 없음). :class:`AuxTaskUnavailable`과 달리
    **폴백으로 삼켜지지 않는다** — 모델은 준비되었는데 호출이 실패한 경우를 조용한
    결정론 폴백으로 위장하지 않기 위해서다.
    """

    def __init__(
        self,
        task: str,
        reason: str,
        detail: Optional[str] = None,
        attempts: int = 1,
        transient: bool = False,
    ):
        self.task = task
        self.reason = str(reason or "aux transport failure")
        self.detail = None if detail is None else str(detail)
        self.attempts = int(attempts)
        self.transient = bool(transient)
        super().__init__(f"aux task {task!r} transport failure: {self.reason}")


class AuxCloudProviderRefused(AuxTaskError):
    """선택 결과가 비-로컬 provider를 가리켰다(계약 위반 → 항상 예외).

    폴백 정책이 ``fallback``인 작업에서도 조용히 대체하지 않는다. 유료/클라우드 호출이
    폴백으로 위장되는 일을 막기 위함이다.
    """

    def __init__(self, task: str, model_id: str, provider: str):
        self.task = task
        self.model_id = model_id
        self.provider = provider
        super().__init__(
            f"aux task {task!r} refused non-local provider {provider!r} "
            f"for model {model_id!r}: aux tasks have no cloud fallback"
        )


class AuxModelOutputError(AuxTaskError):
    """모델 응답을 해석할 수 없다(전송 오류가 아니므로 재시도하지 않는다)."""

    def __init__(self, task: str, reason: str):
        self.task = task
        self.reason = str(reason)
        super().__init__(f"aux task {task!r} produced unusable output: {self.reason}")


class AuxRegistryContractError(AuxTaskError):
    """레지스트리가 합의된 aux 선택 계약을 제공하지 않는다.

    ``select_aux_model`` 부재나 시그니처 불일치를 **조용히 백그라운드/포그라운드 선택으로
    대체하지 않는다**: 그런 대체는 작업 이름을 다른 역할로 바꾸고 게이트(8 GB → 32 GB)를
    상향해 전혀 다른 모델을 고른다. 계약 위반은 호출자가 고칠 수 있도록 크게 실패한다.
    """

    def __init__(self, task: str, reason: str):
        self.task = task
        self.reason = str(reason)
        super().__init__(
            f"aux task {task!r} cannot be served: registry does not implement "
            f"select_aux_model as agreed ({self.reason})"
        )


class AuxSelectionError(AuxTaskError):
    """선택기가 예외를 던졌다(계약은 맞지만 호출이 실패).

    ``AuxTaskUnavailable``과 구분한다: 이 경우는 "모델이 없다"가 아니라 "선택이 깨졌다"이므로
    조용한 결정론 폴백으로 삼키지 않고, 작업별 ``error`` 카운트에 남긴다.
    """

    def __init__(self, task: str, reason: str):
        self.task = task
        self.reason = str(reason)
        super().__init__(f"aux task {task!r} selection failed: {self.reason}")


# --------------------------------------------------------------------------- #
# Provenance and results
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Provenance:
    """결과 한 건의 출처.

    - ``source``: ``"model"``(모델 산출) 또는 ``"fallback"``(결정론 대체).
    - ``provider``: ``"local"``(로컬 실행이 증명됨) | ``"external"``(주입 클라이언트가
      비용을 보고함) | ``"unknown"``(비용/모델 보고가 모호해 로컬이라 주장할 수 없음) |
      ``"none"``(모델 미사용).
    - ``cost_usd``: ``0.0``은 로컬 실행의 구조적 값이고, ``None``은 **알 수 없음**이다
      (무료가 아니다).
    """

    task: str
    source: str  # "model" | "fallback"
    provider: str  # "local" | "external" | "unknown" | "none"
    model_id: str
    cost_usd: Optional[float]
    attempts: int = 0
    reason: Optional[str] = None
    detail: Optional[str] = None

    @property
    def is_local(self) -> bool:
        """로컬 실행으로 증명된 결과인가(외부 보고 비용/불명 비용이면 False)."""
        return self.provider == "local" and self.cost_usd == 0.0

    @property
    def cost_known(self) -> bool:
        return self.cost_usd is not None

    @property
    def is_model_output(self) -> bool:
        return self.source == "model"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task": self.task,
            "source": self.source,
            "provider": self.provider,
            "model_id": self.model_id,
            "cost_usd": self.cost_usd,
            "cost_known": self.cost_known,
            "attempts": self.attempts,
            "is_local": self.is_local,
            "reason": self.reason,
            "detail": self.detail,
        }


class _WithProvenance:
    """결과 공통 접근자(provenance를 평평한 속성으로도 노출)."""

    provenance: Provenance

    @property
    def source(self) -> str:
        return self.provenance.source

    @property
    def provider(self) -> str:
        return self.provenance.provider

    @property
    def model_id(self) -> str:
        return self.provenance.model_id

    @property
    def cost_usd(self) -> Optional[float]:
        return self.provenance.cost_usd

    @property
    def cost_known(self) -> bool:
        return self.provenance.cost_known

    @property
    def is_local(self) -> bool:
        return self.provenance.is_local


@dataclass(frozen=True)
class SessionTitle(_WithProvenance):
    """세션 제목 + 출처."""

    text: str
    provenance: Provenance

    def to_dict(self) -> Dict[str, Any]:
        return {"title": self.text, "provenance": self.provenance.to_dict()}


@dataclass(frozen=True)
class MemoryCandidate(_WithProvenance):
    """메모리 후보 하나. ``canonical_key``로 호출자가 중복 제거한다."""

    text: str
    category: str
    provenance: Provenance

    @property
    def canonical_key(self) -> str:
        """정규화 텍스트의 해시(대소문자/공백 차이는 같은 후보로 본다)."""
        return hashlib.sha256(normalize_text(self.text).casefold().encode("utf-8")).hexdigest()[:16]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "text": self.text,
            "category": self.category,
            "canonical_key": self.canonical_key,
            "provenance": self.provenance.to_dict(),
        }


@dataclass(frozen=True)
class DistillationResult:
    """증류 결과: 후보 목록 + (빈 목록일 때도) 출처.

    후보가 0건일 때 "모델이 정말 기억할 것이 없다고 답했다"와 "모델을 쓸 수 없었다"가
    구분되지 않으면 호출자는 빈 목록을 성공으로 오해한다. ``status``가
    ``"model"``(모델 응답, 0건 가능) / ``"empty"``(대화가 비어 호출 없음) /
    ``"unavailable"``(모델 부재)을 구분하고, 각각 ``provenance``를 동봉한다.
    """

    status: str
    candidates: Tuple[MemoryCandidate, ...]
    provenance: Provenance

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "candidates": [candidate.to_dict() for candidate in self.candidates],
            "provenance": self.provenance.to_dict(),
        }


@dataclass(frozen=True)
class CompactionResult(_WithProvenance):
    """압축 결과: 예산 안에 남긴 메시지 + 버린 내용 보고.

    ``dropped_count``/``dropped_indexes``는 통째로 버린 메시지 수이고,
    ``truncated_token_count``는 살린 메시지에서 잘려 나간 꼬리의 토큰 수다.
    ``dropped_token_count``는 둘의 합 — 즉 "입력에서 사라진 모든 내용"이다.
    """

    messages: Tuple[Dict[str, str], ...]
    token_budget: int
    token_count: int
    dropped_count: int
    dropped_token_count: int
    dropped_indexes: Tuple[int, ...]
    dropped_digest: str
    provenance: Provenance
    summary_applied: bool = False
    truncated: bool = False
    truncated_message_index: Optional[int] = None
    truncated_token_count: int = 0
    kept_indexes: Tuple[int, ...] = ()
    filtered_dropped_indexes: Tuple[int, ...] = ()
    filtered_truncated_message_index: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "messages": [dict(message) for message in self.messages],
            "token_budget": self.token_budget,
            "token_count": self.token_count,
            "dropped_count": self.dropped_count,
            "dropped_token_count": self.dropped_token_count,
            "dropped_indexes": list(self.dropped_indexes),
            "kept_indexes": list(self.kept_indexes),
            "filtered_dropped_indexes": list(self.filtered_dropped_indexes),
            "dropped_digest": self.dropped_digest,
            "summary_applied": self.summary_applied,
            "truncated": self.truncated,
            "truncated_message_index": self.truncated_message_index,
            "filtered_truncated_message_index": self.filtered_truncated_message_index,
            "truncated_token_count": self.truncated_token_count,
            "provenance": self.provenance.to_dict(),
        }


class QueryRewrite(str):
    """재작성된 질의. ``str``이면서 provenance를 함께 나른다."""

    provenance: Provenance

    def __new__(cls, text: str, provenance: Provenance) -> "QueryRewrite":
        instance = super().__new__(cls, text)
        instance.provenance = provenance
        return instance

    @property
    def text(self) -> str:
        return str(self)

    @property
    def source(self) -> str:
        return self.provenance.source

    @property
    def provider(self) -> str:
        return self.provenance.provider

    @property
    def model_id(self) -> str:
        return self.provenance.model_id

    @property
    def cost_usd(self) -> Optional[float]:
        return self.provenance.cost_usd

    @property
    def cost_known(self) -> bool:
        return self.provenance.cost_known

    @property
    def is_local(self) -> bool:
        return self.provenance.is_local

    def to_dict(self) -> Dict[str, Any]:
        return {"query": str(self), "provenance": self.provenance.to_dict()}


# --------------------------------------------------------------------------- #
# Text helpers
# --------------------------------------------------------------------------- #
def normalize_text(text: Any) -> str:
    """모든 공백 런을 단일 공백으로 접고 앞뒤를 제거한다."""
    return _WS.sub(" ", str(text or "").strip())


def cap_text(text: str, limit: int) -> str:
    """``len(result) <= limit``을 보장하는 길이 상한(경계면 단어 단위 절단 + ``…``)."""
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    if limit == 1:
        return text[:1]
    head = text[: limit - 1]
    cut = head.rfind(" ")
    if cut >= limit // 2:
        head = head[:cut]
    return head.rstrip() + "…"


def _truncate_to_tokens(text: str, max_tokens: int) -> str:
    """``estimate_tokens(result) <= max_tokens``을 보장한다."""
    if max_tokens <= 0:
        return ""
    allowed = max_tokens * CHARS_PER_TOKEN
    if len(text) <= allowed:
        return text
    head = text[: allowed - 1]
    cut = head.rfind(" ")
    if cut > 0:
        head = head[:cut]
    return head.rstrip() + "…"


def _first_content_line(text: str) -> str:
    """코드펜스/빈 줄을 걷어낸 첫 내용 줄."""
    raw = str(text or "").strip()
    fence = _FENCE.fullmatch(raw)
    if fence:
        raw = fence.group(1).strip()
    for line in raw.splitlines():
        if line.strip():
            return line
    return ""


def _clean_line(text: str) -> str:
    """모델이 붙인 마크다운/따옴표/선행 라벨을 제거한 한 줄."""
    line = normalize_text(_first_content_line(text))
    line = _TITLE_PREFIX.sub("", line)
    line = line.strip(_EDGE_CHARS)
    line = normalize_text(line).rstrip(_TRAILING_PUNCT)
    return normalize_text(line)


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, Sequence) and not isinstance(content, (str, bytes)):
        parts: List[str] = []
        for part in content:
            if isinstance(part, Mapping):
                piece = part.get("text")
                if piece is not None:
                    parts.append(str(piece))
            elif isinstance(part, str):
                parts.append(part)
        return "".join(parts)
    return "" if content is None else str(content)


def _normalize_messages(payload: Any) -> List[Dict[str, str]]:
    """대화 입력을 ``[{"role", "content"}]``로 정규화한다.

    허용 입력: 문자열(단일 사용자 메시지), 메시지 시퀀스(``role``/``content`` 또는
    ``speaker``/``text`` 키), ``{"messages"|"conversation"|"transcript": ...}`` 매핑.
    """
    if payload is None:
        return []
    if isinstance(payload, str):
        return [{"role": "user", "content": payload}] if payload.strip() else []
    if isinstance(payload, Mapping):
        inner = payload.get("messages")
        if inner is None:
            inner = payload.get("conversation")
        if inner is None:
            inner = payload.get("transcript")
        return _normalize_messages(inner)
    if not isinstance(payload, Sequence) or isinstance(payload, (bytes, bytearray)):
        return []
    messages: List[Dict[str, str]] = []
    for item in payload:
        if isinstance(item, str):
            if item.strip():
                messages.append({"role": "user", "content": item})
            continue
        if isinstance(item, Mapping):
            role = normalize_text(item.get("role") or item.get("speaker") or "user").lower() or "user"
            messages.append({"role": role, "content": _content_text(item.get("content", item.get("text")))})
    return messages


def _load_json_value(text: str) -> Any:
    """응답 본문에서 첫 JSON 값(배열/객체)을 뽑는다. 없으면 ``ValueError``."""
    raw = str(text or "").strip()
    fence = _FENCE.fullmatch(raw)
    if fence:
        raw = fence.group(1).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    for opener, closer in (("[", "]"), ("{", "}")):
        start = raw.find(opener)
        end = raw.rfind(closer)
        if 0 <= start < end:
            try:
                return json.loads(raw[start:end + 1])
            except json.JSONDecodeError:
                continue
    raise ValueError("no JSON array or object found in the reply")


# --------------------------------------------------------------------------- #
# Selection contract
# --------------------------------------------------------------------------- #
#: ``select_aux_model``이 받아야 하는 키워드 인자(합의된 계약).
_SELECTION_KWARGS = ("tier", "machine", "foreground_model_id")

#: 작업별 stats 버킷 키. ``structural``은 "모델 없이도 올바른 결과가 나오는 경우"(예: 대화가
#: 이미 예산 안), ``fallback``은 "모델이 필요했지만 쓸 수 없었다"를 뜻한다.
_JOB_STAT_KEYS = (
    "model",
    "fallback",
    "structural",
    "unavailable",
    "error",
    "paid_call",
    "unknown_cost",
    "transport_retries",
)


def _parse_reported_cost(raw: Any) -> Tuple[Optional[float], Optional[str]]:
    """공급자 보고 비용을 ``(cost, invalid_reason)``으로 해석한다.

    숫자가 아닌 값(``"0.5"`` 문자열, ``True``/``False`` 불리언), 음수, NaN, 무한대는
    **숫자로 강제 변환하지 않고** 미상으로 돌려준다: 문자열/불리언을 ``float()``로 바꾸면
    청구되지 않은 값을 지출로 세거나 반대로 지출을 0으로 위장하게 된다.
    """
    if raw is None:
        return None, "usage reported no cost (pricing unknown)"
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None, f"non-numeric cost value {raw!r}"
    cost = float(raw)
    if not math.isfinite(cost) or cost < 0.0:
        return None, f"invalid cost value {raw!r}"
    return cost, None


def _accepted_kwargs(selector: Any) -> set:
    """선택기가 받아들이는 키워드 이름 집합(``**kwargs``면 전체 허용)."""
    try:
        parameters = inspect.signature(selector).parameters
    except (TypeError, ValueError):  # 내장/C 확장 호출 가능 객체
        return set(_SELECTION_KWARGS)
    for parameter in parameters.values():
        if parameter.kind is inspect.Parameter.VAR_KEYWORD:
            return set(_SELECTION_KWARGS)
    return {
        name
        for name, parameter in parameters.items()
        if parameter.kind
        in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
    }


def _empty_bucket() -> Dict[str, Any]:
    bucket: Dict[str, Any] = {key: 0 for key in _JOB_STAT_KEYS}
    bucket["cost_usd"] = 0.0
    bucket["external_cost_usd"] = 0.0
    return bucket


@dataclass(frozen=True)
class _Selection:
    """``_select_newest``의 결과: 남긴 메시지와 **모든** 손실의 회계.

    인덱스는 두 종류를 모두 담는다: ``*_indexes``/``truncated_index``는 **호출자가 넘긴
    원본 transcript의 위치**이고, ``filtered_*``는 내용 없는 메시지를 걸러낸 작업 목록의
    위치다(둘은 빈 메시지가 있으면 달라진다). ``dropped_token_count``는 통째로 버린
    메시지와 잘린 꼬리를 합친 "입력에서 사라진 토큰"이다.
    """

    kept: List[Dict[str, str]]
    kept_indexes: Tuple[int, ...]
    used: int
    dropped_indexes: Tuple[int, ...]
    filtered_dropped_indexes: Tuple[int, ...]
    dropped_tokens: int
    truncated_index: Optional[int]
    filtered_truncated_index: Optional[int]
    truncated_tokens: int
    truncated_text: str

    @property
    def lost_anything(self) -> bool:
        return bool(self.dropped_indexes) or self.truncated_index is not None

    @property
    def dropped_token_count(self) -> int:
        return self.dropped_tokens + self.truncated_tokens


@dataclass(frozen=True)
class _Observation:
    """한 시도에서 읽은 ``usage`` 스냅샷.

    ``usage`` 참조를 **강하게 유지**하므로 그 객체의 주소는 재사용될 수 없다: 주소가 같은
    새 객체는 존재할 수 없고, 따라서 동일성 비교로 "같은 살아있는 보고의 재판독"만 걸러낼
    수 있다(주소 재사용으로 실제 지출이 누락되지 않는다).
    """

    usage: Any
    snapshot: Tuple[Any, ...]


@dataclass
class _AttemptLedger:
    """호출 시도들의 누적 회계. 재시도로 실패한 시도의 지출도 합산한다."""

    attempts: int = 0
    paid_cost: float = 0.0
    paid_attempts: int = 0
    cost_unknown: bool = False
    unknown_attempts: int = 0
    unknown_reason: str = ""
    model_mismatch: str = ""
    observations: List["_Observation"] = field(default_factory=list)
    settled: bool = False
    unknown_counted: bool = False


# --------------------------------------------------------------------------- #
# Runner
# --------------------------------------------------------------------------- #
class AuxTaskRunner:
    """작은 로컬 모델로 세션 부가 작업을 실행한다(클라우드 폴백·비용 없음).

    ``lm_client``는 ``lm_client.chat_stream(messages, model=..., route=...)``를 제공하는
    객체면 된다(실제 :class:`engine.lm_client.LmClient` 또는 테스트 대역). ``registry``는
    합의된 ``select_aux_model(task, tier=None, machine=None, foreground_model_id=None)``을
    제공해야 한다. 없거나 시그니처가 다르면 :class:`AuxRegistryContractError`로 실패한다 —
    백그라운드/포그라운드 선택기로 대신 고르면 작업이 다른 역할로 재해석되고 게이트가
    달라져 전혀 다른 모델이 선택되기 때문이다.
    """

    def __init__(
        self,
        lm_client: Any,
        registry: Any,
        tier: Any = None,
        machine: Any = None,
        foreground_model_id: Optional[str] = None,
        title_max_chars: int = 60,
        max_query_chars: int = 240,
        max_candidate_chars: int = 240,
        max_candidates: int = 8,
        max_category_chars: int = 40,
        max_summary_tokens: int = 200,
        min_summary_tokens: int = 8,
        prompt_char_budget: int = 6000,
        max_message_chars: int = 800,
        max_transport_retries: int = 1,
    ):
        self.lm_client = lm_client
        self.registry = registry
        self.tier = tier
        self.machine = machine
        self.foreground_model_id = foreground_model_id
        self.title_max_chars = max(1, int(title_max_chars))
        self.max_query_chars = max(1, int(max_query_chars))
        self.max_candidate_chars = max(1, int(max_candidate_chars))
        self.max_candidates = max(1, int(max_candidates))
        self.max_category_chars = max(1, int(max_category_chars))
        self.max_summary_tokens = max(0, int(max_summary_tokens))
        self.min_summary_tokens = max(1, int(min_summary_tokens))
        self.prompt_char_budget = max(200, int(prompt_char_budget))
        self.max_message_chars = max(40, int(max_message_chars))
        # 일시적 전송 오류에 대한 재시도는 최대 1회로 고정한다(무한 재시도 금지).
        self.max_transport_retries = min(1, max(0, int(max_transport_retries)))
        self.policies = dict(FALLBACK_POLICIES)
        self.last_selection: Any = None
        self.last_provenance: Optional[Provenance] = None
        self._stats: Dict[str, Dict[str, Any]] = {job: _empty_bucket() for job in AUX_TASKS}
        self._selection_api: Dict[str, int] = {}
        self._external_cost_total = 0.0
        self._paid_calls = 0

    # ------------------------------------------------------------------ #
    # Compaction budget arithmetic
    # ------------------------------------------------------------------ #
    def _summary_minimum(self) -> int:
        """요약이 성립하는 최소 예약 토큰(라벨 + ``min_summary_tokens``)."""
        return max(
            self.min_summary_tokens,
            estimate_tokens(SUMMARY_LABEL) + self.min_summary_tokens,
        )

    def _summary_reservation(self, budget: int) -> int:
        """이번 예산에서 요약에 떼어 둘 토큰. 0이면 요약을 시도하지 않는다."""
        reserved = min(self.max_summary_tokens, budget // 4)
        if reserved < self._summary_minimum():
            return 0
        return reserved

    @staticmethod
    def _summary_content(dropped_count: int, summary_line: str, reserved: int) -> Optional[str]:
        """예약 몫 안에 들어가는 요약 메시지 본문. 불가능하면 ``None``(요약하지 않는다)."""
        if reserved <= 0:
            return None
        label = f"[summary of {dropped_count} dropped message(s)] "
        body_tokens = reserved - estimate_tokens(label)
        if body_tokens < 1:
            label = SUMMARY_LABEL
            body_tokens = reserved - estimate_tokens(label)
        if body_tokens < 1 or not summary_line:
            return None
        content = label + _truncate_to_tokens(summary_line, body_tokens)
        return content if estimate_tokens(content) <= reserved else None

    def _structural_compaction(
        self,
        job: str,
        messages: Sequence[Dict[str, str]],
        selection: "_Selection",
        budget: int,
        reason: str,
        model_was_needed: bool = False,
        model_provenance: Optional[Provenance] = None,
    ) -> CompactionResult:
        """모델/요약 없이 만든 압축 결과.

        ``model_was_needed=True``는 "요약이 필요했지만 쓸 수 없었다"(예: 모델 부재, 빈 요약)를
        뜻하며 ``fallback``으로 세고, False는 "모델이 애초에 필요 없었다"(이미 예산 안,
        요약 몫을 예약할 수 없는 작은 예산)로 ``structural``로 센다. 어느 쪽이든
        ``source="fallback"``이고 모델 출력으로 표기하지 않는다. 모델 호출이 **실제로
        지출을 냈다면**(``model_provenance``가 non-local) 그 제공자/비용을 결과에 물려준다.
        """
        if model_was_needed:
            provenance = self._fallback_from(job, model_provenance, reason)
        else:
            provenance = self._structural_provenance(job, reason)
        return CompactionResult(
            messages=tuple(selection.kept),
            token_budget=budget,
            token_count=selection.used,
            dropped_count=len(selection.dropped_indexes),
            dropped_token_count=selection.dropped_token_count,
            dropped_indexes=selection.dropped_indexes,
            kept_indexes=selection.kept_indexes,
            filtered_dropped_indexes=selection.filtered_dropped_indexes,
            dropped_digest=self._digest(messages, selection),
            provenance=provenance,
            summary_applied=False,
            truncated=selection.truncated_index is not None,
            truncated_message_index=selection.truncated_index,
            filtered_truncated_message_index=selection.filtered_truncated_index,
            truncated_token_count=selection.truncated_tokens,
        )

    # ------------------------------------------------------------------ #
    # Public jobs
    # ------------------------------------------------------------------ #
    def title_session(self, conversation: Any) -> SessionTitle:
        """세션 제목. 폴백 정책: **fallback**(첫 사용자 메시지 기반)."""
        job = "title"
        messages = _normalize_messages(conversation)
        fallback_text = self._fallback_title(messages)
        if not messages:
            return SessionTitle(fallback_text, self._structural_provenance(job, "empty conversation"))
        try:
            text, provenance = self._invoke(job, self._title_prompt(messages))
        except AuxTaskUnavailable as exc:
            return SessionTitle(fallback_text, self._unavailable_fallback(job, exc.reason))
        except AuxTaskError:
            self._count(job, "error")
            raise
        title = cap_text(_clean_line(text), self.title_max_chars)
        if not title:
            # 모델 출력을 쓸 수 없어도 그 호출의 지출은 결과에 남는다(무료로 위장 금지).
            return SessionTitle(
                fallback_text, self._fallback_from(job, provenance, "model returned an empty title")
            )
        return SessionTitle(title, provenance)

    def distill_memory(self, session: Any) -> List[MemoryCandidate]:
        """메모리 후보 목록. 폴백 정책: **raise**(``AuxTaskUnavailable``, 사유 보존).

        빈 목록의 의미가 필요하면 :meth:`distill_memory_detailed`를 쓴다(모델이 "기억할 것
        없음"이라고 답한 경우와 대화가 비어 호출하지 않은 경우가 구분된다).
        """
        return list(self.distill_memory_detailed(session).candidates)

    def distill_memory_detailed(self, session: Any) -> DistillationResult:
        """증류 결과 + 출처. 폴백 정책: **raise**(모델 부재 시 후보를 만들어내지 않는다)."""
        job = "distillation"
        messages = _normalize_messages(session)
        if not messages:
            return DistillationResult("empty", (), self._structural_provenance(job, "empty session"))
        try:
            text, provenance = self._invoke(job, self._distill_prompt(messages))
            candidates = self._parse_candidates(job, text, provenance)
        except AuxTaskUnavailable:
            self._count(job, "unavailable")
            raise
        except AuxTaskError:
            self._count(job, "error")
            raise
        return DistillationResult("model", tuple(candidates), provenance)

    def compact_context(self, transcript: Any, token_budget: int) -> CompactionResult:
        """토큰 예산에 맞춘 압축. 폴백 정책: **fallback**(최신 턴 보존 구조적 압축).

        불변식: 반환된 ``token_count``는 **어떤 예산에서도** ``token_budget`` 이하이고,
        실제로 담긴 모든 메시지의 추정 토큰 합과 같다. 요약은 예약 몫이
        ``min_summary_tokens``와 라벨 최소치를 모두 감당할 때만 시도하며, 그럴 수 없으면
        모델을 부르지 않고 요약 메시지도 넣지 않는다(``summary_applied=False``).
        """
        job = "compaction"
        budget = int(token_budget)
        if budget <= 0:
            raise ValueError("token_budget must be a positive integer")
        # 내용이 없는 메시지는 정보가 없으므로 압축 대상에서 제외하되, 인덱스는 **호출자가
        # 넘긴 원본 위치**로 보고한다(걸러낸 목록 위치는 filtered_*에 남긴다).
        original = _normalize_messages(transcript)
        positions = [index for index, m in enumerate(original) if m["content"].strip()]
        messages = [original[index] for index in positions]
        if not messages:
            return CompactionResult(
                messages=(),
                token_budget=budget,
                token_count=0,
                dropped_count=0,
                dropped_token_count=0,
                dropped_indexes=(),
                dropped_digest="nothing dropped",
                provenance=self._structural_provenance(job, "empty transcript"),
            )
        # 이미 예산 안이면 모델 호출도 요약도 필요 없다.
        full = self._select_newest(messages, budget, positions)
        if not full.lost_anything:
            return self._structural_compaction(
                job,
                messages,
                full,
                budget,
                "transcript fits the budget; nothing to summarize",
            )
        # 요약 몫을 먼저 떼어 두면 선택과 요약이 서로를 기다리는 순환이 생기지 않는다.
        reserved = self._summary_reservation(budget)
        if reserved == 0:
            # 요약 몫을 예약할 수 없는 예산: 모델 호출도, 요약 메시지도 없다.
            return self._structural_compaction(
                job,
                messages,
                full,
                budget,
                f"no summary budget fits inside budget {budget} "
                f"(needs >= {self._summary_minimum()} est. tokens); structural pass only",
            )
        selection = self._select_newest(messages, budget - reserved, positions)
        if not selection.lost_anything:  # pragma: no cover - 예약 몫 > 0이면 여기 오지 않는다
            selection = full

        summary_line = ""
        provenance: Optional[Provenance] = None
        failure: Optional[str] = None
        try:
            dropped_messages: List[Dict[str, str]] = [
                messages[index] for index in selection.filtered_dropped_indexes
            ]
            if selection.truncated_text:
                dropped_messages.append(
                    {"role": "system", "content": "[truncated tail] " + selection.truncated_text}
                )
            text, provenance = self._invoke(
                job, self._compact_prompt(dropped_messages, reserved)
            )
            summary_line = _clean_line(text)
            if not summary_line:
                failure = "model returned an empty compaction summary"
        except AuxTaskUnavailable as exc:
            self._count(job, "unavailable")
            failure = exc.reason
        except AuxTaskError:
            self._count(job, "error")
            raise

        if failure is not None:
            return self._structural_compaction(
                job,
                messages,
                full,
                budget,
                failure,
                model_was_needed=True,
                model_provenance=provenance,
            )

        summary_content = self._summary_content(
            len(selection.dropped_indexes), summary_line, reserved
        )
        if summary_content is None or provenance is None:
            # 예약 산술이 어긋났다면 요약을 넣지 않는다(예산 초과로 이어지지 않게).
            return self._structural_compaction(
                job,
                messages,
                full,
                budget,
                "summary did not fit the reserved budget",
                model_was_needed=provenance is not None,
                model_provenance=provenance,
            )
        messages_out = ({"role": "system", "content": summary_content}, *selection.kept)
        token_count = selection.used + estimate_tokens(summary_content)
        return CompactionResult(
            messages=messages_out,
            token_budget=budget,
            token_count=token_count,
            dropped_count=len(selection.dropped_indexes),
            dropped_token_count=selection.dropped_token_count,
            dropped_indexes=selection.dropped_indexes,
            kept_indexes=selection.kept_indexes,
            filtered_dropped_indexes=selection.filtered_dropped_indexes,
            dropped_digest=self._digest(messages, selection),
            provenance=provenance,
            summary_applied=True,
            truncated=selection.truncated_index is not None,
            truncated_message_index=selection.truncated_index,
            filtered_truncated_message_index=selection.filtered_truncated_index,
            truncated_token_count=selection.truncated_tokens,
        )

    def rewrite_query(self, query: str, history: Any = None) -> QueryRewrite:
        """질의 재작성. 폴백 정책: **fallback**(원 질의의 정규화·길이제한 형태)."""
        job = "query_rewrite"
        raw = normalize_text(query)
        fallback_text = cap_text(raw, self.max_query_chars)
        if not raw:
            return QueryRewrite("", self._structural_provenance(job, "empty query"))
        try:
            text, provenance = self._invoke(job, self._rewrite_prompt(raw, history))
        except AuxTaskUnavailable as exc:
            return QueryRewrite(fallback_text, self._unavailable_fallback(job, exc.reason))
        except AuxTaskError:
            self._count(job, "error")
            raise
        rewritten = cap_text(_clean_line(text), self.max_query_chars)
        if not rewritten:
            # 빈 응답이어도 지출이 있었다면 결과가 그 지출을 보고한다(무료 주장 금지).
            return QueryRewrite(
                fallback_text,
                self._fallback_from(job, provenance, "model returned an empty query"),
            )
        return QueryRewrite(rewritten, provenance)

    def fallback_policy(self, job: str) -> str:
        """작업별 폴백 정책(``"fallback"`` 또는 ``"raise"``)."""
        return self.policies[job]

    def stats(self) -> Dict[str, Any]:
        """작업별 카운트와 비용 누계.

        각 버킷은 ``model``(모델 출력) / ``fallback``(모델이 필요했지만 불가) /
        ``structural``(모델 없이도 올바른 결과) / ``unavailable`` / ``error`` /
        ``paid_call`` / ``unknown_cost`` / ``transport_retries`` 를 센다.
        """
        jobs = {job: dict(bucket) for job, bucket in sorted(self._stats.items())}
        totals = _empty_bucket()
        for bucket in jobs.values():
            for key in totals:
                totals[key] += bucket[key]
        totals["cost_usd"] = round(totals["cost_usd"], 12)
        totals["external_cost_usd"] = round(totals["external_cost_usd"], 12)
        return {
            "local_only": True,
            # 로컬 실행만 있었다면 구조적으로 0.0이다(외부 보고 비용은 아래에 분리).
            "cost_usd": round(totals["cost_usd"], 12),
            "external_cost_usd": round(self._external_cost_total, 12),
            "paid_calls": self._paid_calls,
            "unknown_cost_calls": totals["unknown_cost"],
            "jobs": jobs,
            "totals": totals,
            "selection_api": dict(self._selection_api),
        }

    # ------------------------------------------------------------------ #
    # Selection
    # ------------------------------------------------------------------ #
    def _select(self, job: str) -> Any:
        """합의된 ``select_aux_model`` 계약으로만 모델을 고른다(대체 선택기 없음)."""
        selector = getattr(self.registry, "select_aux_model", None)
        if not callable(selector):
            raise AuxRegistryContractError(
                job,
                f"registry {type(self.registry).__name__} has no select_aux_model; "
                "aux tasks refuse to re-role themselves through another selector",
            )
        missing = [name for name in _SELECTION_KWARGS if name not in _accepted_kwargs(selector)]
        if missing:
            raise AuxRegistryContractError(
                job,
                f"select_aux_model does not accept {missing}; agreed contract is "
                "select_aux_model(task, tier=None, machine=None, foreground_model_id=None)",
            )
        try:
            selection = selector(
                job,
                tier=self.tier,
                machine=self.machine,
                foreground_model_id=self.foreground_model_id,
            )
        except TypeError as exc:
            # 시그니처 드리프트는 "모델 없음"이 아니라 계약 위반이다: 그대로 드러낸다.
            raise AuxRegistryContractError(job, f"select_aux_model call failed: {exc}") from None
        except AuxTaskError:
            raise
        except Exception as exc:  # noqa: BLE001 - 선택기 내부 오류는 사용 불가가 아니라 결함이다
            raise AuxSelectionError(job, f"{type(exc).__name__}: {exc}") from None
        self._selection_api["select_aux_model"] = self._selection_api.get("select_aux_model", 0) + 1
        self.last_selection = selection
        return selection

    @staticmethod
    def _selection_ready(selection: Any) -> bool:
        ready = getattr(selection, "is_ready", False)
        return bool(ready)

    # ------------------------------------------------------------------ #
    # Invocation
    # ------------------------------------------------------------------ #
    def _invoke(self, job: str, messages: List[Dict[str, str]]) -> Tuple[str, Provenance]:
        """aux 모델 1회 호출(일시적 전송 오류만 1회 재시도)과 provenance.

        재시도로 **버려진 시도의 사용량/비용도 매 시도마다 읽어** 원장(``_AttemptLedger``)에
        누적한다: 1차 시도가 비용을 보고하고 실패해도 그 지출은 ``paid_calls``/
        ``external_cost_usd``에 남는다.
        """
        selection = self._select(job)
        if not self._selection_ready(selection):
            reason = str(getattr(selection, "reason", "") or "aux model unavailable")
            detail = getattr(selection, "detail", None)
            raise AuxTaskUnavailable(job, reason, None if detail is None else str(detail))

        require_entry = getattr(selection, "require_entry", None)
        if callable(require_entry):
            try:
                entry = require_entry()
            except Exception as exc:  # noqa: BLE001 - 계약 위반은 사용 불가로 보고
                raise AuxTaskUnavailable(job, f"selection is not usable: {exc}") from None
        else:
            entry = getattr(selection, "entry", None)

        provider = normalize_text(getattr(entry, "provider", "")).lower()
        model_id = normalize_text(getattr(selection, "model_id", "") or getattr(entry, "model_id", ""))
        if provider != "local":
            raise AuxCloudProviderRefused(job, model_id, provider or "<undeclared>")
        if not model_id:
            raise AuxTaskUnavailable(job, "selection is ready but names no model id")

        ledger = _AttemptLedger()
        last_attempt = self.max_transport_retries + 1
        for attempt in range(1, last_attempt + 1):
            ledger.attempts = attempt
            try:
                stream = self.lm_client.chat_stream(messages, model=model_id, route=LOCAL_ROUTE)
                text = "".join(str(piece) for piece in (stream or ()))
            except ProviderUnavailable as exc:
                self._record_attempt(ledger, model_id)
                if attempt < last_attempt:
                    self._count(job, "transport_retries")
                    continue
                self._settle_attempts(job, ledger)
                raise AuxTransportError(
                    job,
                    f"transient transport failure after {attempt} attempt(s): {exc}",
                    detail=model_id,
                    attempts=attempt,
                    transient=True,
                ) from None
            except LmClientError as exc:
                # 인증/요청 형식/용량 오류는 재시도해도 같다(재시도 금지).
                self._record_attempt(ledger, model_id)
                self._settle_attempts(job, ledger)
                raise AuxTransportError(
                    job,
                    f"{type(exc).__name__}: {exc}",
                    detail=model_id,
                    attempts=attempt,
                ) from None
            except Exception as exc:  # noqa: BLE001 - 클라이언트 계약 밖 예외도 삼키지 않고 보고
                self._record_attempt(ledger, model_id)
                self._settle_attempts(job, ledger)
                raise AuxTransportError(
                    job,
                    f"client raised {type(exc).__name__}: {exc}",
                    detail=model_id,
                    attempts=attempt,
                ) from None
            self._record_attempt(ledger, model_id)
            self._count(job, "model")
            return text, self._provenance_model(job, model_id, ledger)
        raise AuxTaskUnavailable(job, "aux call exhausted without a result")  # pragma: no cover

    # ------------------------------------------------------------------ #
    # Provenance / stats helpers
    # ------------------------------------------------------------------ #
    def _record_attempt(self, ledger: "_AttemptLedger", model_id: str) -> None:
        """이번 시도가 남긴 ``lm_client.usage``를 **스냅샷**으로 원장에 반영한다.

        중복 방지는 주소(``id``)가 아니라 "살아있는 같은 보고를 같은 값으로 다시 읽었는가"로
        판단한다: 원장이 ``usage`` 참조를 계속 붙들고 있으므로 그 주소는 재사용될 수 없고
        (새 객체는 다른 주소를 받는다), 같은 객체가 값만 바꾼 경우(장수 ``usage`` 객체를
        mutate하는 클라이언트)에는 스냅샷이 달라져 새 지출로 기록된다. 반대로 아무 변화 없는
        재판독은 중복 청구되지 않는다.
        """
        usage = getattr(self.lm_client, "usage", None)
        if usage is None:
            ledger.cost_unknown = True
            ledger.unknown_attempts += 1
            ledger.unknown_reason = ledger.unknown_reason or "client reported no usage"
            return
        reported_model = normalize_text(getattr(usage, "model_id", ""))
        cost, invalid_reason = _parse_reported_cost(getattr(usage, "cost_usd", None))
        snapshot = (reported_model, cost, invalid_reason)
        for observation in ledger.observations:
            if observation.usage is usage and observation.snapshot == snapshot:
                return  # 동일한 살아있는 보고의 재판독(새 호출 없음) — 중복 청구 금지
        ledger.observations.append(_Observation(usage, snapshot))

        if reported_model and reported_model != model_id:
            ledger.model_mismatch = reported_model
        if invalid_reason is not None:
            ledger.cost_unknown = True
            ledger.unknown_attempts += 1
            ledger.unknown_reason = ledger.unknown_reason or invalid_reason
            return
        if cost and cost > 0.0:
            ledger.paid_cost += cost
            ledger.paid_attempts += 1

    def _settle_attempts(self, job: str, ledger: "_AttemptLedger") -> None:
        """실패로 끝난 시도들의 지출을 회계에 남긴다(지출·불명 지출 모두 숨기지 않는다)."""
        if ledger.settled:
            return
        ledger.settled = True
        if ledger.paid_attempts > 0:
            self._book_paid(job, ledger.paid_cost, ledger.paid_attempts)
        self._count_unknown_once(job, ledger)

    def _count_unknown_once(self, job: str, ledger: "_AttemptLedger") -> None:
        """값을 매길 수 없는 시도가 한 번이라도 있었으면 호출 1건으로 센다."""
        if ledger.unknown_counted or ledger.unknown_attempts == 0:
            return
        ledger.unknown_counted = True
        self._count(job, "unknown_cost")

    def _book_paid(self, job: str, cost: float, paid_attempts: int) -> None:
        """유료 **시도 수**를 기록한다(``paid_calls`` == 유료 시도 수, 청구 이벤트 수 아님)."""
        if paid_attempts <= 0:
            return
        bucket = self._stats.setdefault(job, _empty_bucket())
        bucket["paid_call"] += paid_attempts
        bucket["external_cost_usd"] = round(bucket["external_cost_usd"] + cost, 12)
        self._external_cost_total = round(self._external_cost_total + cost, 12)
        self._paid_calls += paid_attempts

    def _provenance_model(
        self, job: str, model_id: str, ledger: "_AttemptLedger"
    ) -> Provenance:
        if ledger.paid_attempts > 0:
            # 주입된 클라이언트가 유료 호출을 보고했다: 기록하되 로컬로 표기하지 않는다.
            if not ledger.settled:
                ledger.settled = True
                self._book_paid(job, ledger.paid_cost, ledger.paid_attempts)
            # 값을 매길 수 없는 시도가 섞여 있었다면 그것도 집계에 남긴다.
            self._count_unknown_once(job, ledger)
            reason = "injected client reported a paid call; this result is not local"
            if ledger.model_mismatch:
                reason += f"; usage.model_id={ledger.model_mismatch!r} != selected {model_id!r}"
            if ledger.cost_unknown:
                reason += "; at least one attempt reported an unpriceable cost"
            provenance = Provenance(
                task=job,
                source="model",
                provider="external",
                model_id=ledger.model_mismatch or model_id,
                cost_usd=ledger.paid_cost,
                attempts=ledger.attempts,
                reason=reason,
            )
        elif ledger.cost_unknown or ledger.model_mismatch:
            self._count_unknown_once(job, ledger)
            reasons = []
            if ledger.unknown_reason:
                reasons.append(ledger.unknown_reason)
            if ledger.model_mismatch:
                reasons.append(
                    f"usage.model_id={ledger.model_mismatch!r} != selected {model_id!r}"
                )
            provenance = Provenance(
                task=job,
                source="model",
                provider="unknown",
                model_id=ledger.model_mismatch or model_id,
                cost_usd=None,
                attempts=ledger.attempts,
                reason="cost/provenance unknown; cannot claim a free local run: "
                + "; ".join(reasons),
            )
        else:
            provenance = Provenance(
                task=job,
                source="model",
                provider="local",
                model_id=model_id,
                cost_usd=0.0,
                attempts=ledger.attempts,
            )
        self.last_provenance = provenance
        return provenance

    def _fallback_from(
        self, job: str, model_provenance: Optional[Provenance], reason: str
    ) -> Provenance:
        """모델 출력을 쓸 수 없어 만든 폴백. **그 시도의 실제 지출을 숨기지 않는다.**

        무료 로컬 시도였다면 ``provider="none"``/``cost_usd=0.0``이고, 유료 또는 값을
        매길 수 없는 시도였다면 모델 provenance의 ``provider``/``cost_usd``/``model_id``를
        그대로 물려받는다(이미 원장에 기록된 지출을 다시 청구하지는 않는다).
        """
        if model_provenance is None or model_provenance.is_local:
            return self._fallback_provenance(job, reason)
        combined = reason
        if model_provenance.reason:
            combined = f"{reason}; {model_provenance.reason}"
        provenance = Provenance(
            task=job,
            source="fallback",
            provider=model_provenance.provider,
            model_id=model_provenance.model_id,
            cost_usd=model_provenance.cost_usd,
            attempts=model_provenance.attempts,
            reason=combined,
            detail=model_provenance.detail,
        )
        self._count(job, "fallback")
        self.last_provenance = provenance
        return provenance

    def _fallback_provenance(self, job: str, reason: str) -> Provenance:
        """모델이 **필요했지만** 쓸 수 없어 만든 결정론 결과(fallback 카운트)."""
        provenance = Provenance(
            task=job,
            source="fallback",
            provider="none",
            model_id="",
            cost_usd=0.0,
            attempts=0,
            reason=str(reason or "aux model unavailable"),
        )
        self._count(job, "fallback")
        self.last_provenance = provenance
        return provenance

    def _structural_provenance(self, job: str, reason: str) -> Provenance:
        """모델 호출이 애초에 필요 없는 결정론 결과(structural 카운트)."""
        provenance = Provenance(
            task=job,
            source="fallback",
            provider="none",
            model_id="",
            cost_usd=0.0,
            attempts=0,
            reason=str(reason or "no model needed"),
        )
        self._count(job, "structural")
        self.last_provenance = provenance
        return provenance

    def _unavailable_fallback(self, job: str, reason: str) -> Provenance:
        """모델 부재로 만든 폴백(``unavailable`` + ``fallback`` 둘 다 기록)."""
        self._count(job, "unavailable")
        return self._fallback_provenance(job, reason)

    def _count(self, job: str, key: str) -> None:
        bucket = self._stats.setdefault(job, _empty_bucket())
        bucket[key] += 1

    # ------------------------------------------------------------------ #
    # Prompts
    # ------------------------------------------------------------------ #
    def _render(self, messages: Sequence[Mapping[str, str]]) -> List[Dict[str, str]]:
        """프롬프트용 대화 렌더(최신 메시지 우선, 전체 문자 예산 상한)."""
        rendered: List[Dict[str, str]] = []
        remaining = self.prompt_char_budget
        for message in reversed(list(messages)):
            if remaining <= 0:
                break
            content = normalize_text(message.get("content"))
            cap = min(self.max_message_chars, remaining)
            if len(content) > cap:
                content = content[:cap].rstrip() + "…"
            remaining -= len(content)
            rendered.append({"role": str(message.get("role") or "user"), "content": content})
        rendered.reverse()
        return rendered

    def _title_prompt(self, messages: Sequence[Mapping[str, str]]) -> List[Dict[str, str]]:
        return [
            {
                "role": "system",
                "content": (
                    "You name chat sessions. Reply with exactly one line of plain text, at most "
                    f"{self.title_max_chars} characters, in the language of the conversation. "
                    "No quotes, no markdown, no trailing period, no explanation."
                ),
            },
            {
                "role": "user",
                "content": json.dumps({"conversation": self._render(messages)}, ensure_ascii=False),
            },
        ]

    def _distill_prompt(self, messages: Sequence[Mapping[str, str]]) -> List[Dict[str, str]]:
        return [
            {
                "role": "system",
                "content": (
                    "You extract durable memory from a chat session. Reply with ONLY a strict "
                    'JSON array of objects like [{"text": "...", "category": "preference"}]. '
                    f"At most {self.max_candidates} items, each under "
                    f"{self.max_candidate_chars} characters. Keep only durable facts, "
                    "preferences and decisions; never invent content and never repeat an item. "
                    "Reply with [] when nothing is worth remembering."
                ),
            },
            {
                "role": "user",
                "content": json.dumps({"session": self._render(messages)}, ensure_ascii=False),
            },
        ]

    def _compact_prompt(
        self,
        dropped: Sequence[Mapping[str, str]],
        reserved_tokens: int,
    ) -> List[Dict[str, str]]:
        return [
            {
                "role": "system",
                "content": (
                    "You summarize the earlier part of a conversation that is about to be "
                    "dropped so the assistant does not lose it. Reply with plain prose only, at "
                    f"most {reserved_tokens} tokens, keep decisions, file paths, identifiers and "
                    "open questions. Never invent facts and never describe the summary itself."
                ),
            },
            {
                "role": "user",
                "content": json.dumps({"dropped_turns": self._render(dropped)}, ensure_ascii=False),
            },
        ]

    def _rewrite_prompt(self, raw: str, history: Any) -> List[Dict[str, str]]:
        payload: Dict[str, Any] = {"query": raw}
        history_messages = _normalize_messages(history)
        if history_messages:
            payload["history"] = self._render(history_messages)
        return [
            {
                "role": "system",
                "content": (
                    "Rewrite the user's search query into one self-contained line that keeps the "
                    f"original intent and fills in obvious referents from the history. At most "
                    f"{self.max_query_chars} characters. Reply with the rewritten query only: no "
                    "quotes, no numbering, no explanation."
                ),
            },
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ]

    # ------------------------------------------------------------------ #
    # Fallbacks / parsing / structural compaction
    # ------------------------------------------------------------------ #
    def _fallback_title(self, messages: Sequence[Mapping[str, str]]) -> str:
        source = next(
            (m for m in messages if m["role"] == "user" and str(m["content"]).strip()),
            None,
        )
        if source is None:
            source = next((m for m in messages if str(m["content"]).strip()), None)
        if source is None:
            return cap_text("Untitled session", self.title_max_chars)
        return cap_text(normalize_text(source["content"]), self.title_max_chars) or cap_text(
            "Untitled session", self.title_max_chars
        )

    def _parse_candidates(self, job: str, text: str, provenance: Provenance) -> List[MemoryCandidate]:
        """모델 응답 → 후보 목록.

        "해석 가능한 빈 배열"(`[]`)은 **모델이 기억할 것이 없다고 답한 정상 결과**다.
        반면 항목은 있는데 쓸 수 있는 텍스트가 하나도 없는 응답은 빈 결과와 구분되지 않으면
        성공으로 오해되므로 :class:`AuxModelOutputError`로 드러낸다.
        """
        try:
            payload = _load_json_value(text)
        except ValueError as exc:
            raise AuxModelOutputError(job, str(exc)) from None
        if isinstance(payload, Mapping):
            payload = payload.get("candidates", payload.get("items"))
            if payload is None:
                raise AuxModelOutputError(job, "reply object has no candidates/items array")
        if not isinstance(payload, Sequence) or isinstance(payload, (str, bytes)):
            raise AuxModelOutputError(job, "reply is not a JSON array of candidates")
        candidates: List[MemoryCandidate] = []
        seen = set()
        skipped = 0
        for item in payload:
            if isinstance(item, str):
                body, category = item, "note"
            elif isinstance(item, Mapping):
                body = item.get("text")
                category = item.get("category") or "note"
            else:
                skipped += 1
                continue
            body = cap_text(normalize_text(body), self.max_candidate_chars)
            category = cap_text(normalize_text(category) or "note", self.max_category_chars) or "note"
            if not body:
                skipped += 1
                continue
            key = hashlib.sha256(body.casefold().encode("utf-8")).hexdigest()
            if key in seen:
                continue
            seen.add(key)
            candidates.append(MemoryCandidate(body, category, provenance))
            if len(candidates) >= self.max_candidates:
                break
        if not candidates and len(payload) > 0:
            raise AuxModelOutputError(
                job,
                f"reply had {len(payload)} item(s) but none carried usable text "
                f"(skipped {skipped}); refusing to report it as an empty result",
            )
        return candidates

    def _select_newest(
        self,
        messages: Sequence[Dict[str, str]],
        budget: int,
        index_map: Optional[Sequence[int]] = None,
    ) -> "_Selection":
        """예산에 들어가는 최신 연속 구간을 고르고 **모든 손실**을 회계한다.

        - 통째로 버린 메시지: ``dropped_indexes`` / ``dropped_tokens``
        - 살린 메시지에서 잘려 나간 꼬리: ``truncated_index`` / ``truncated_tokens``
          (잘린 꼬리 원문은 ``truncated_text``에 남겨 요약 입력으로 쓸 수 있게 한다)

        ``index_map``은 작업 목록 위치 → 호출자가 넘긴 원본 transcript 위치다(내용 없는
        메시지를 걸러낸 경우 둘이 다르다). 주어지면 ``*_indexes``/``truncated_index``는
        **원본 위치**로 보고하고, 걸러낸 목록 위치는 ``filtered_*``에 남긴다.
        ``used``는 담긴 메시지들의 추정 토큰 합이며 절대 ``budget``을 넘지 않는다.
        """
        kept: List[Dict[str, str]] = []
        used = 0
        start = len(messages)
        for index in range(len(messages) - 1, -1, -1):
            cost = estimate_tokens(messages[index]["content"])
            if used + cost > budget:
                break
            kept.append({"role": messages[index]["role"], "content": messages[index]["content"]})
            used += cost
            start = index
        kept.reverse()
        filtered_truncated: Optional[int] = None
        truncated_tokens = 0
        truncated_text = ""
        if not kept and messages:
            newest_index = len(messages) - 1
            newest = messages[newest_index]
            content = _truncate_to_tokens(newest["content"], budget)
            if content:
                original_tokens = estimate_tokens(newest["content"])
                kept = [{"role": newest["role"], "content": content}]
                used = estimate_tokens(content)
                start = newest_index
                if used < original_tokens or len(content) < len(newest["content"]):
                    filtered_truncated = newest_index
                    truncated_tokens = max(0, original_tokens - used)
                    truncated_text = newest["content"][len(content):].strip()
        filtered_dropped = tuple(range(0, start))
        dropped_tokens = sum(
            estimate_tokens(messages[index]["content"]) for index in filtered_dropped
        )
        positions = list(index_map) if index_map is not None else list(range(len(messages)))
        return _Selection(
            kept=kept,
            kept_indexes=tuple(positions[index] for index in range(start, len(messages))),
            used=used,
            dropped_indexes=tuple(positions[index] for index in filtered_dropped),
            filtered_dropped_indexes=filtered_dropped,
            dropped_tokens=dropped_tokens,
            truncated_index=None if filtered_truncated is None else positions[filtered_truncated],
            filtered_truncated_index=filtered_truncated,
            truncated_tokens=truncated_tokens,
            truncated_text=truncated_text,
        )

    @staticmethod
    def _digest(messages: Sequence[Dict[str, str]], selection: "_Selection") -> str:
        """버린 내용 요약. 인덱스는 호출자의 원본 transcript 위치이며, 잘린 꼬리도 함께 보고한다."""
        parts: List[str] = []
        if selection.dropped_indexes:
            first_kept = selection.dropped_indexes[-1] + 1
            parts.append(
                f"{len(selection.dropped_indexes)} earlier message(s) dropped "
                f"({selection.dropped_tokens} est. tokens); kept the {len(selection.kept)} "
                f"most recent message(s) from turn {first_kept} onward"
            )
        if selection.truncated_index is not None:
            parts.append(
                f"message {selection.truncated_index} truncated: "
                f"{selection.truncated_tokens} est. tokens cut from its tail"
            )
        if not parts:
            return "nothing dropped"
        return "; ".join(parts) + f"; {selection.dropped_token_count} est. tokens lost in total"

"""DeepSeek Harness 2-Track 결정론적 실행 플래너 (2-Track Deterministic Execution Planner).

DeepSeek Harness는 OpenCodex 모델 게이트웨이를 내부에 직접 내장한 단일 배포
데스크톱/CLI 애플리케이션이다. 이 모듈은 이기종 모델을 실시간으로 분류/재배치하는
'작업 지능(task-intelligence) 서브에이전트 자동 배치'를 수행하지 않는다. 대신 앱 릴리스에
동봉된 큐레이션 프리셋(``registry.CURATED_APP_RELEASE_VERSION``)만 사용해 다음 2개 트랙으로
결정론적으로 분기한다::

    Track 1  direct_execute   : 단순/명확한 프롬프트 -> 계획 오버헤드 $0, 즉시 실행
                                (``light_worker`` 또는 단일 ``worker`` + 큐레이션 기본 모델
                                ``deepseek/deepseek-v4.1-flash-1017``)
    Track 2  survey_and_plan  : 복잡/불명확한 프롬프트 -> 1단계 조사(``researcher``) ->
                                2단계 계획(``planner``) -> 구현(``worker`` 노드) -> 검증(``reviewer``)

기존 메서드 시그니처와 역할 이름은 그대로 유지해 이전 호출자와 테스트가 계속 동작한다.
"""
import ast
import math
import re
import sys
import uuid
from enum import Enum
from pathlib import Path
from dataclasses import dataclass, field, fields
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union

from .hardware_profiler import (
    HardwareSpec,
    LocalExecutionTier,
    LocalExecutionTierInfo,
    detect_hardware,
    determine_local_tier,
    parse_tier,
)
from .registry import (
    BACKGROUND_MODEL_ID,
    BACKGROUND_ROLES,
    DEFAULT_INPUT_TOKENS,
    DEFAULT_OUTPUT_TOKENS,
    OPTIMIZATION_MODES,
    VALID_ROLES,
    BackgroundModelUnavailableError,
    ModelIntelligenceRegistry,
    ModelIntelligenceEntry,
    PricingInfo,
)
from .vram_budget import (
    MachineProfile,
    Unavailable,
    select as select_local_fit,
)


class ModelRoutingBlocked(RuntimeError):
    """요청한 경로·역할에서 실행 가능한 모델이 없을 때 발생한다.

    대체 모델을 발명하지 않는다. 결정론적 게이트(카탈로그 + 역할 + 프라이버시 +
    적재 산술)를 통과한 후보가 없으면 호출자는 실행을 시작하지 않는다.
    """


class DecisionPlanError(ValueError):
    """턴 계획 입력 계약 위반(타입·열거·경계).

    ``KeyError``/``AttributeError``/``TypeError`` 같은 우발적 크래시 대신 호출자가
    잡을 수 있는 한 종류의 예외로 모은다. 값이 열거 밖이지만 **타입이 맞는** 경우
    (예: 지원하지 않는 사고 등급)는 예외가 아니라 ``ValidatedTurnPlan``의
    clamp/rejection이며, 그 판정은 ``clamps``/``violations``에 남는다.
    """

# 서브태스크 분해 시 사용하는 구분자(한/영 혼용 프롬프트 대응)
_SUBTASK_SPLIT = re.compile(
    r"(?:\n+|[;；]|,\s*|(?<=[가-힣A-Za-z])\s*(?:그리고|및|또한)\s*|\band\b|\bthen\b)",
    re.IGNORECASE,
)
_FILE_PATTERN = re.compile(
    r"[\w./\\-]+\.(?:py|pyi|ts|tsx|js|jsx|md|json|ya?ml|sql|html|css|toml|txt)\b"
)
_ROLE_KEYWORDS: Sequence[tuple[str, Sequence[str]]] = (
    ("security_reviewer", ("보안", "취약", "시큐어", "security", "cve", "auth")),
    ("frontend_worker", ("프론트", "ui", "ux", "react", "css", "화면", "컴포넌트", "frontend")),
    ("backend_worker", ("백엔드", "api", "서버", "db", "데이터베이스", "sql", "backend", "동시성", "비동기")),
    ("researcher", ("조사", "리서치", "논문", "벤치마크", "research", "비교")),
)
MAX_PARALLEL_WORKERS = 4

#: 턴 계획이 받아들일 수 있는 컨텍스트 예산의 절대 상한(카탈로그 최대 창 1,048,576의 4배).
#: 이보다 큰 값은 측정 불가가 아니라 잘못된 입력이므로 클램프하지 않고 거부한다.
MAX_CONTEXT_BUDGET_TOKENS = 4_194_304

#: ``model_id="auto"`` 가 해석되는 기본 온디바이스 모델(카탈로그 실재 항목).
DEFAULT_LOCAL_MODEL_ID = "local/qwen2.5-coder-7b-gguf"

#: **게이트웨이가 모델을 정한다**는 명시적 센티널(빈 문자열의 함의가 아니다).
#: ``TurnPlan.model_id`` 가 이 값이면 호출자는 모델을 지정하지 않았고, 검증기는
#: (경로 ∩ 동의) 게이트를 통과하는 카탈로그 항목 하나로 해석해야 한다. 해석 결과가
#: 없으면 자동 선택은 거부된다(클라우드로 암묵 승격하지 않는다).
AUTO_MODEL_ID = "auto"

#: **게이트웨이가 사고 등급을 정한다**는 명시적 센티널. 검증기는 이 값을 플래너의
#: 결정론적 추천 등급으로 해석한 뒤 실제 서빙 모델이 지원하는 등급과 교집합한다.
AUTO_REASONING_GRADE = "auto"

#: 플래너가 모델을 **모른다**고 선언하는 문서화된 지연(deferred) 상태.
#: ``AUTO_MODEL_ID`` 는 "검증 시점에 카탈로그에서 결정론적으로 해석 가능"이고,
#: 이 값은 "플래너가 특정 모델을 발명하지 않고 게이트웨이에 위임"이다. 검증기는
#: (경로 ∩ 동의) 안에 실행 가능한 후보가 하나도 없으면 이 상태를 거부한다 —
#: 게이트웨이가 만족할 수 없는 경로에서 지연을 허용하면 그건 은폐된 실패다.
DEFERRED_MODEL_ID = "gateway_deferred"

#: ``ValidatedTurnPlan.effective_model_selection``/``effective_grade_selection`` 열거값.
CALLER_SELECTION = "caller"
GATEWAY_SELECTION = "gateway_auto"

#: 자동 선택이 스스로 올릴 수 있는 최고 등급. ``xhigh`` 는 호출자의 명시적 선택 전용이다.
MAX_AUTO_REASONING_GRADE = "high"

#: SSH/원격 로컬 서버처럼 **오프디바이스**에서 실행되는 프로바이더 이름.
#: ``route=local_only`` 는 이들 모델을 절대 배정하지 않는다.
OFF_DEVICE_PROVIDERS = frozenset({"remote_server", "remote", "ssh"})

#: 포그라운드 계획에서 절대 배정하지 않는 백그라운드 전담 역할.
BACKGROUND_ROLE_NAMES = frozenset(BACKGROUND_ROLES)

#: 소형 로컬 보조(aux) 평면 전담 역할 — 포그라운드 계획의 모델/서브에이전트 역할이 아니다.
AUX_ROLE_NAMES = frozenset({"session_titler", "query_rewriter", "embedding"})

#: 포그라운드 계획에서 배정할 수 없는 모든 역할(백그라운드 + aux). 이 역할만 선언한
#: 카탈로그 항목은 어떤 포그라운드 역할도 수행할 수 없다.
NON_FOREGROUND_ROLE_NAMES = BACKGROUND_ROLE_NAMES | AUX_ROLE_NAMES

#: 승인 없이는 즉시 실행 집합에 들어갈 수 없는 L3(비가역·외부·반출) 도구.
L3_APPROVAL_TOOLS = frozenset({"bash", "eval", "github", "manage_skill", "web_search"})
#: 승인이 필요한 도구 이름 접두사(MCP 서버 도구, 외부 브리지 도구).
L3_APPROVAL_PREFIXES = ("mcp__", "external__")

#: ``TurnPlan.origin`` 이 가질 수 있는 값(설계 §2.2).
VALID_PLAN_ORIGINS = ("model", "defaults", "timeout", "malformed", "pin_conflict", "policy")
#: ``TurnPlan.context_history`` 열거값.
VALID_CONTEXT_HISTORY = ("none", "last_turn", "summary")
#: ``TurnPlan.expected_cost_class`` 열거값(게이트가 아니라 표시 필드).
VALID_COST_CLASSES = ("local_zero", "metered", "unknown")
#: 사고 등급의 전순서. 위로 올리지 않고 아래로만 자른다.
REASONING_GRADE_ORDER = ("off", "low", "medium", "high", "xhigh")

# 백그라운드 인지 작업 지시 템플릿 및 출력 토큰 상한
_BACKGROUND_TASK_INSTRUCTIONS: Dict[str, str] = {
    "compaction": "세션 대화/히스토리를 지능형 압축(핵심 결정·미해결 과제·인터페이스 계약 보존): ",
    "title": "세션/브랜치 제목 생성(20자 이내, 핵심 의도 중심): ",
    "commit_message": "변경 사항 기반 커밋 메시지 생성(제목 50자 + 본문 3줄 이내): ",
    "memory_indexing": "FTS5 인덱싱용 키워드/요약 노트 생성: ",
    "rerank": "검색 후보 재순위 및 관련도 판정: ",
    "distillation": "장기 메모리 지식 증류(중복 제거·사실/규칙 추출): ",
    "triage": "백그라운드 작업 큐 트리아지(우선순위/차단 여부 판정): ",
    "loop_guard": "에이전트 루프 가드 진단(반복 패턴·정체 원인 식별): ",
    "diagnostics": "백그라운드 실행 진단 및 실패 원인 요약: ",
}
_BACKGROUND_TASK_OUTPUT_TOKENS: Dict[str, int] = {
    "compaction": 1200,
    "title": 64,
    "commit_message": 160,
    "memory_indexing": 500,
    "rerank": 300,
    "distillation": 900,
    "triage": 300,
    "loop_guard": 400,
    "diagnostics": 600,
}


def estimate_tokens(text: str) -> int:
    """한/영 혼용 코드 프롬프트 기준 보수적 토큰 추정 (약 3자/토큰)."""
    return max(1, math.ceil(len(text) / 3.0))


def _require_text(value: Any, name: str = "prompt") -> str:
    """텍스트 입력 계약. ``None``/숫자/불리언은 AttributeError 가 아니라 명시적 예외다."""
    if not isinstance(value, str):
        raise DecisionPlanError(f"{name} must be a string, got {type(value).__name__}")
    return value


def _is_strict_int(value: Any) -> bool:
    """``True``/``False`` 와 실수를 제외한 정수 판정(불리언은 int 의 서브클래스다)."""
    return isinstance(value, int) and not isinstance(value, bool)


def _lookup_entry(
    registry: ModelIntelligenceRegistry,
    model_id: Any,
) -> Optional[ModelIntelligenceEntry]:
    """카탈로그 조회를 예외 없는 optional 로 만든다(``registry.get_model`` 은 KeyError)."""
    if not isinstance(model_id, str) or not model_id:
        return None
    getter = getattr(registry, "get_model", None)
    if not callable(getter):
        return None
    try:
        return getter(model_id)
    except (KeyError, TypeError):
        return None


def _entry_privacy_complete(entry: ModelIntelligenceEntry) -> bool:
    """카탈로그 프라이버시 플래그(ZDR + 학습 옵트아웃)가 모두 참인지."""
    privacy = getattr(entry, "privacy", None)
    return bool(getattr(privacy, "zero_data_retention", False)) and bool(
        getattr(privacy, "training_opt_out", False)
    )


def _route_allows(
    entry: ModelIntelligenceEntry,
    route: ExecutionRoute,
    cloud_consent: bool,
) -> bool:
    """모델 하나가 (경로 ∩ 동의) 교집합을 통과하는지 판정한다."""
    return not _route_gate(entry, route, cloud_consent)


def _route_gate(
    entry: ModelIntelligenceEntry,
    route: ExecutionRoute,
    cloud_consent: bool,
) -> str:
    """경로 ∩ 동의 게이트. 빈 문자열이면 통과, 아니면 사유 코드.

    - 온디바이스(``provider == "local"``)는 어떤 경로에서도 오프디바이스 전송이 없다.
    - 오프디바이스(클라우드/SSH/원격 로컬 서버)는 **명시적 동의**와 ``local_only`` 가 아닌
      경로가 모두 필요하다. ``privacy_consent=False`` 는 ``route=ANY_CLOUD``/``ZDR_CLOUD``
      를 넘겨받아도 어떤 오프디바이스 모델도 고르지 못한다.
    - ``zdr_cloud`` 는 동의가 있어도 카탈로그 프라이버시 플래그(ZDR + 학습 옵트아웃)를
      다시 확인한다(원격 로컬 서버 포함).
    - ``any_cloud`` 는 호출자가 명시적으로 넓힌 경로이므로 동의만 요구한다.
    """
    provider = str(getattr(entry, "provider", "") or "")
    model_id = getattr(entry, "model_id", "")
    if provider == "local":
        return ""
    if route == ExecutionRoute.LOCAL_ONLY:
        return f"local_only_forbids_off_device:{model_id}:provider={provider}"
    if not cloud_consent:
        return f"cloud_consent_missing:{model_id}"
    if route == ExecutionRoute.ZDR_CLOUD and not _entry_privacy_complete(entry):
        # ``any_cloud`` 는 가장 넓은 경로라 ZDR 플래그를 요구하지 않지만, ZDR 경로는
        # 카탈로그에 선언된 ZDR + 학습 옵트아웃을 다시 확인한다(동의가 있어도).
        suffix = ":off_device_provider" if provider in OFF_DEVICE_PROVIDERS else ""
        return f"zdr_catalog_privacy_violation:{model_id}{suffix}"
    return ""


def _role_eligible(entry: ModelIntelligenceEntry, role: str) -> bool:
    """포그라운드 역할 적격성: 역할 선언 + 배경 전담 역할/항목 배제.

    ``compactor``/``memory_distiller``/``background_worker`` 와 aux 평면 역할
    (``session_titler``/``query_rewriter``/``embedding``)은 포그라운드 계획에서
    절대 배정하지 않는다(백그라운드/aux 트랙 전용). Bonsai 처럼 배경 역할만 선언한 항목도
    포그라운드 후보가 아니며, aux 전용 소형 모델도 포그라운드 코더가 아니다.
    """
    if role in NON_FOREGROUND_ROLE_NAMES:
        return False
    roles = set(getattr(entry, "roles", ()) or ())
    if role not in roles:
        return False
    return bool(roles - BACKGROUND_ROLE_NAMES)


def _requires_approval(tool: str) -> bool:
    """L3(비가역·외부·반출) 도구 여부. 승인 전에는 실행 집합에 넣지 않는다."""
    return tool in L3_APPROVAL_TOOLS or any(tool.startswith(p) for p in L3_APPROVAL_PREFIXES)


def _pricing_unknown(entry: ModelIntelligenceEntry) -> bool:
    """유료 모델의 단가를 알 수 없는지. 로컬(온디바이스)은 항상 $0 로 계산 가능하다."""
    if getattr(entry, "provider", "") == "local":
        return False
    pricing = getattr(entry, "pricing", None)
    if pricing is None:
        return True
    return not any(
        float(getattr(pricing, attribute, 0.0) or 0.0) > 0.0
        for attribute in ("input_per_million", "output_per_million", "cache_read_per_million")
    )


def _attempt_cost(
    entry: ModelIntelligenceEntry,
    input_tokens: int,
    output_tokens: int,
) -> Optional[float]:
    """모델 1회 시도 비용(유료 단가 기준).

    단가를 계산할 수 없으면 ``0.0``(무료)이 아니라 ``None``(측정 불가)이다. 호출자는
    ``None`` 을 예산 내 실행으로 승격하지 않고 거부한다.
    """
    pricing = getattr(entry, "pricing", None)
    if pricing is None:
        return None
    try:
        return float(pricing.attempt_cost_usd(max(int(input_tokens), 0), max(int(output_tokens), 0)))
    except (AttributeError, TypeError, ValueError):
        return None


def _local_fit_reason(
    registry: Any,
    entry: Optional[ModelIntelligenceEntry],
    machine: Optional[MachineProfile],
) -> str:
    """온디바이스 모델의 런타임/가중치/적재 준비도. 빈 문자열이면 준비됨.

    ``machine`` 이 없으면(호스트 프로브 없음) 적재 산술을 하지 않는다. 기계 프로필이
    있는데 레지스트리가 로컬 카탈로그를 제공하지 않으면 "측정 불가"로 막는다 — 확인하지
    못한 준비도를 실행 가능으로 승격하지 않는다. 어떤 경우에도 ``AttributeError`` 같은
    우발적 크래시 대신 사유 문자열을 돌려준다.
    """
    if machine is None or entry is None or getattr(entry, "provider", "") != "local":
        return ""
    catalogue = getattr(registry, "local_catalogue", None)
    if not callable(catalogue):
        return "local_catalogue_unavailable: registry cannot enumerate local models"
    try:
        decision = select_local_fit(machine, catalogue(), foreground_model_id=entry.model_id)
    except (AttributeError, TypeError, ValueError, KeyError) as exc:
        return f"local_fit_unmeasurable:{type(exc).__name__}:{exc}"
    if isinstance(decision, Unavailable):
        return f"{decision.reason}: {decision.detail}"
    return ""


def _require_budget(value: Any, name: str = "cost_budget_usd") -> Optional[float]:
    """비용 예산 계약: ``None``(미상) 또는 유한한 음이 아닌 수."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DecisionPlanError(f"{name} must be a number, got {type(value).__name__}")
    amount = float(value)
    if not math.isfinite(amount) or amount < 0:
        raise DecisionPlanError(f"{name} must be finite and non-negative, got {value!r}")
    return amount



def _require_bool(value: Any, name: str) -> bool:
    """불리언 계약. ``1``/``"yes"`` 같은 참 같은 값은 설정 오류로 취급한다."""
    if not isinstance(value, bool):
        raise DecisionPlanError(f"{name} must be a bool, got {type(value).__name__}")
    return value


def _require_mode(mode: Any) -> str:
    """최적화 모드 열거 검증(``auto`` 포함)."""
    if not isinstance(mode, str) or (mode not in OPTIMIZATION_MODES and mode != "auto"):
        raise DecisionPlanError(
            f"unknown optimization mode: {mode!r}; expected one of {(*OPTIMIZATION_MODES, 'auto')}"
        )
    return mode


def _coerce_route(
    route: Optional[Union[str, ExecutionRoute]],
    privacy_consent: Any = False,
) -> ExecutionRoute:
    """경로 문자열/열거를 정규화한다. 알 수 없는 값은 ValueError 가 아니라 계획 오류다."""
    if route is None:
        return ExecutionRoute.from_privacy_consent(_require_bool(privacy_consent, "privacy_consent"))
    if isinstance(route, ExecutionRoute):
        return route
    if isinstance(route, bool) or not isinstance(route, str):
        raise DecisionPlanError(
            f"route must be an ExecutionRoute or string, got {type(route).__name__}"
        )
    try:
        return ExecutionRoute(route)
    except ValueError as exc:
        raise DecisionPlanError(f"unknown execution route: {route!r}") from exc


def _connection_route(route: ExecutionRoute, privacy_consent: bool) -> ExecutionRoute:
    """경로 ∩ 동의. 동의가 없으면 어떤 클라우드 경로도 남지 않는다(LOCAL_ONLY)."""
    if not privacy_consent:
        return ExecutionRoute.LOCAL_ONLY
    return route


@dataclass(frozen=True)
class _ModelGateContext:
    """노드 배정 게이트 입력 묶음(경로 ∩ 동의 · 티어 · 기계 프로필).

    ``route`` 는 게이트가 실제로 쓰는 경로(경로 ∩ 동의)이고, ``requested_route`` 는
    호출자가 요청한 경로(보고용)다. 둘이 다르면 동의가 경로를 좁힌 것이다.
    """
    route: ExecutionRoute
    cloud_consent: bool
    tier_info: Optional[LocalExecutionTierInfo] = None
    machine: Optional[MachineProfile] = None
    requested_route: Optional[ExecutionRoute] = None


@dataclass
class SymbolSlice:
    """AST에서 추출한 함수/클래스 단위 코드 조각."""
    name: str
    kind: str
    qualification: str
    signature: str
    lineno: int
    end_lineno: int
    source: str


class ExecutionRoute(str, Enum):
    LOCAL_ONLY = "local_only"
    ZDR_CLOUD = "zdr_cloud"
    ANY_CLOUD = "any_cloud"

    @classmethod
    def from_privacy_consent(cls, consent: bool) -> "ExecutionRoute":
        """Deprecated boolean compatibility: False means local only, True means ZDR cloud.

        동의와 경로는 **서로 독립**이다. 동의가 없으면 어떤 클라우드 경로도 나오지
        않는다(`LOCAL_ONLY`). 동의가 있다고 해서 `ANY_CLOUD`를 자동으로 고르지도
        않는다(가장 좁은 클라우드 경로인 `ZDR_CLOUD`가 기본값이다). 역방향 파생,
        즉 ``route == ANY_CLOUD`` → ``privacy_consent = True``는 금지다.
        """
        return cls.ZDR_CLOUD if consent else cls.LOCAL_ONLY


@dataclass
class DAGNode:
    node_id: str
    role: str
    model_id: str
    reasoning_effort: str
    dependencies: List[str]
    target_files: List[str]
    instruction: str
    verification_command: List[str] = field(default_factory=list)
    estimated_input_tokens: int = 0
    estimated_output_tokens: int = 0
    cache_hit_ratio: float = 0.0
    estimated_cost_usd: float = 0.0
    route: ExecutionRoute = ExecutionRoute.ZDR_CLOUD
    #: ``False``면 이 노드는 실행 가능한 배정이 아니다(카탈로그/역할/프라이버시/적재 게이트
    #: 중 하나가 막았다). 이때 ``model_id`` 는 모델 배정이 아니라 **온디바이스 진단 라벨**이며
    #: (가능하면 빈 문자열), 게이트가 실제로 검토한 이름은 ``candidate_model_id`` 에 남는다.
    #: 실행 계약은 언제나 이 플래그다.
    executable: bool = True
    #: 실행 불가 사유(``executable=False``일 때 비어 있지 않다).
    block_reason: str = ""
    #: 차단 시 게이트가 검토한 후보 이름(진단용, 배정 아님). 실행 가능 노드에서는 빈 문자열.
    candidate_model_id: str = ""

    def __post_init__(self) -> None:
        self.route = ExecutionRoute(self.route)


@dataclass
class ExecutionDAGPlan:
    plan_id: str
    task_complexity: int
    fast_path: bool
    estimated_budget_usd: float
    nodes: List[DAGNode] = field(default_factory=list)
    privacy_consent: bool = False
    mode: str = "balanced"
    route: Optional[ExecutionRoute] = None
    #: 호출자의 클라우드 동의 플래그. ``None``이면 종전처럼 ``route == any_cloud``에서 파생한다.
    cloud_consent: Optional[bool] = None
    #: 실행 가능한 경로가 하나도 없으면 ``True``(노드는 진단용으로만 남는다).
    blocked: bool = False
    block_reasons: List[str] = field(default_factory=list)
    block_detail: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.route = (ExecutionRoute(self.route) if self.route is not None
                      else ExecutionRoute.from_privacy_consent(self.privacy_consent))
        self.privacy_consent = (bool(self.cloud_consent) if self.cloud_consent is not None
                                else self.route == ExecutionRoute.ANY_CLOUD)
        for node in self.nodes:
            node.route = self.route


class IntelligencePlanner:
    """
    DeepSeek Harness 2-Track 결정론적 실행 플래너 (2-Track Deterministic Execution Planner)
    - Track 1 direct_execute: 단순/명확한 작업은 계획 오버헤드 없이 즉시 실행
      (``light_worker`` 또는 단일 ``worker``, 큐레이션 기본 모델 ``deepseek/deepseek-v4.1-flash-1017``)
    - Track 2 survey_and_plan: 복잡/불명확한 작업은 조사(researcher) -> 계획(planner) ->
      구현(worker) -> 검증(reviewer) 순의 결정론적 DAG로 합성
    - AST Symbol Slicer: 전체 파일 대신 함수/클래스 시그니처+본문만 추출해 컨텍스트 비용 절감

    모델 배치는 레지스트리에 동봉된 큐레이션 프리셋 안에서만 결정되며(정기 앱 릴리스로 갱신),
    런타임 이기종 모델 자동 재배치는 수행하지 않는다.
    """
    # 간단하고 명확한 작업 판정 키워드/정규식 (즉시 작업/구현 경로)
    CLEAR_DIRECT_PATTERNS = [
        r"오타\s*수정", r"주석\s*추가", r"포맷팅", r"린트", r"format", r"typo", r"단순\s*조회",
        r"버그\s*수정", r"fix", r"수정해", r"추가해", r"변경해", r"함수\s*작성", r"테스트\s*추가"
    ]
    # 복잡하거나 불명확한 작업 판정 키워드 (1차 조사 후 계획 수립 경로)
    EXPLORATORY_UNCLEAR_PATTERNS = [
        r"조사", r"분석", r"설계", r"아키텍처", r"리팩터링", r"검토", r"어떻게",
        r"타당성", r"비교", r"추천", r"전략", r"방안", r"최적화", r"파악", r"확인해\s*봐",
        r"explore", r"investigate", r"survey", r"benchmark", r"architecture", r"refactor"
    ]

    def __init__(self, registry: ModelIntelligenceRegistry):
        self.registry = registry

    def classify_execution_track(self, prompt: str) -> str:
        """
        [2-Track 결정론적 트랙 분류]
        사용자의 프롬프트를 2가지 트랙으로 결정론적으로 분류:
        1. 'direct_execute': 간단하거나 목표 대상/지시가 명확한 작업 -> $0 계획 오버헤드로 즉시 실행
        2. 'survey_and_plan': 복잡하거나 요구사항이 불명확/탐색적인 작업 -> 1차 조사(Researcher) -> 계획(Planner) 후 구현
        """
        text = _require_text(prompt).strip()
        lower = text.lower()
        target_files = self.detect_target_files(text)

        # 조사/탐색/분석/설계 키워드가 있거나, 불명확한 질의 형태인 경우 -> survey_and_plan
        is_exploratory = any(re.search(pat, text, re.IGNORECASE) for pat in self.EXPLORATORY_UNCLEAR_PATTERNS)
        has_question = any(q in text for q in ["?", "어떻게", "무엇", "방법", "원인", "이유"])

        if is_exploratory or has_question:
            # 명확한 단일 파일의 단순 수정이 아닌 이상 조사 및 계획 수립 트랙으로 유도
            if not (len(target_files) == 1 and any(re.search(pat, text, re.IGNORECASE) for pat in self.CLEAR_DIRECT_PATTERNS[:7])):
                return "survey_and_plan"

        # 대상 파일이 명시되어 있고 단순/명확한 작업 지시어인 경우 -> direct_execute
        if any(re.search(pat, text, re.IGNORECASE) for pat in self.CLEAR_DIRECT_PATTERNS):
            return "direct_execute"

        # 프롬프트 길이가 짧고 (< 60자) 서브태스크가 없으면 기본 즉시 실행
        if len(text) < 60 and len(self.decompose(text)) <= 1:
            return "direct_execute"

        return "survey_and_plan"

    def is_simple_task(self, prompt: str) -> bool:
        """초경량 Fast-Path 판정 (1노드 즉시 처리)"""
        _require_text(prompt)
        track = self.classify_execution_track(prompt)
        if track == "direct_execute" and (
            (len(prompt.strip()) < 50 and any(re.search(pat, prompt, re.IGNORECASE) for pat in self.CLEAR_DIRECT_PATTERNS[:7]))
            or (len(self.detect_target_files(prompt)) == 1 and len(prompt.strip()) < 80)
        ):
            return True
        return False

    def estimate_complexity(self, prompt: str) -> int:
        _require_text(prompt)
        if self.is_simple_task(prompt):
            return 2
        score = 4
        high_keywords = [
            "아키텍처", "리팩터링", "멀티에이전트", "보안", "동시성", "병렬",
            "최적화", "설계", "구현", "테스트",
        ]
        for kw in high_keywords:
            if kw in prompt:
                score += 1
        file_targets = len(set(_FILE_PATTERN.findall(prompt)))
        if file_targets > 1:
            score += 1
        subtasks = self.decompose(prompt)
        if len(subtasks) > 1:
            score += 1
        return min(10, max(1, score))

    # ------------------------------------------------------------------ #
    # AST symbol extraction / code slicing
    # ------------------------------------------------------------------ #
    def extract_symbols(
        self,
        source: str,
        symbols: Optional[Iterable[str]] = None,
    ) -> List[SymbolSlice]:
        """파이썬 소스에서 함수/클래스(중첩 포함) 시그니처와 본문을 추출한다.

        ``symbols``가 주어지면 이름(단일 이름 또는 ``Class.method``)이 일치하는
        심볼만 반환한다. 문법 오류는 ``SyntaxError``로 그대로 전파된다.
        """
        tree = ast.parse(source)
        lines = source.splitlines()
        wanted = set(symbols or ())
        found: List[SymbolSlice] = []

        def signature(node: ast.AST) -> str:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
                args = ast.unparse(node.args)
                returns = f" -> {ast.unparse(node.returns)}" if node.returns else ""
                return f"{prefix} {node.name}({args}){returns}"
            bases = [ast.unparse(b) for b in node.bases]
            for keyword in node.keywords:
                bases.append(f"{keyword.arg}={ast.unparse(keyword.value)}")
            suffix = f"({', '.join(bases)})" if bases else ""
            return f"class {node.name}{suffix}"

        def visit(node: ast.AST, parents: Sequence[str]) -> None:
            name = getattr(node, "name", None)
            is_callable = isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            is_class = isinstance(node, ast.ClassDef)
            if name is not None and (is_callable or is_class):
                qualification = ".".join([*parents, name])
                if not wanted or name in wanted or qualification in wanted:
                    start = node.lineno
                    end = getattr(node, "end_lineno", start) or start
                    body = "\n".join(lines[start - 1:end])
                    found.append(
                        SymbolSlice(
                            name=name,
                            kind="class" if is_class else ("async_function" if isinstance(node, ast.AsyncFunctionDef) else "function"),
                            qualification=qualification,
                            signature=signature(node),
                            lineno=start,
                            end_lineno=end,
                            source=body,
                        )
                    )
                for child in ast.iter_child_nodes(node):
                    visit(child, [*parents, name])
                return
            for child in ast.iter_child_nodes(node):
                visit(child, parents)

        visit(tree, [])
        found.sort(key=lambda s: (s.lineno, s.qualification))
        return found

    def slice_code(
        self,
        source: str,
        symbols: Optional[Iterable[str]] = None,
        header: str = "",
    ) -> str:
        """파일 전체 대신 지정 심볼(미지정 시 전체 심볼)만 이어 붙인 슬라이스를 만든다."""
        parts: List[str] = []
        if header:
            parts.append(f"# {header}")
        for symbol in self.extract_symbols(source, symbols):
            parts.append(f"# L{symbol.lineno}-{symbol.end_lineno} {symbol.signature}\n{symbol.source}")
        return "\n\n".join(parts)

    def extract_code_slices(
        self,
        path: str,
        source: str,
        symbols: Optional[Iterable[str]] = None,
    ) -> List[Dict[str, Any]]:
        """경로/시그니처/본문을 함께 담은 직렬화 가능한 코드 슬라이스 목록."""
        return [
            {
                "path": path,
                "name": s.name,
                "kind": s.kind,
                "qualification": s.qualification,
                "signature": s.signature,
                "lineno": s.lineno,
                "end_lineno": s.end_lineno,
                "code": s.source,
            }
            for s in self.extract_symbols(source, symbols)
        ]

    # ------------------------------------------------------------------ #
    # 2-Track DAG synthesis
    # ------------------------------------------------------------------ #
    def decompose(self, prompt: str) -> List[str]:
        """프롬프트를 독립 실행 가능한 서브태스크 문장 목록으로 분해한다."""
        chunks: List[str] = []
        for raw in _SUBTASK_SPLIT.split(_require_text(prompt)):
            text = raw.strip(" .。·-")
            if len(text) < 4:
                continue
            if any(text == seen for seen in chunks):
                continue
            chunks.append(text)
        return chunks

    def detect_target_files(self, prompt: str) -> List[str]:
        seen: List[str] = []
        for match in _FILE_PATTERN.findall(_require_text(prompt)):
            cleaned = match.replace("\\", "/")
            if cleaned and cleaned not in seen:
                seen.append(cleaned)
        return seen

    def _role_for(self, subtask: str) -> str:
        lowered = subtask.lower()
        for role, keywords in _ROLE_KEYWORDS:
            if any(kw.lower() in lowered for kw in keywords):
                return role
        return "worker"

    def _node_cost(
        self,
        model_id: str,
        input_tokens: int,
        output_tokens: int,
        cache_hit_ratio: float,
    ) -> float:
        """노드 1회 시도 비용. 카탈로그에 없는 모델은 0.0 이 아니라 "계산 불가"이므로
        호출자가 판단하도록 0.0 대신 None 을 쓰지 않고, 미상은 0.0 으로 두되 노드는
        ``executable=False`` 로 막힌다(비용 0 표시가 실행 가능을 함의하지 않는다)."""
        entry = _lookup_entry(self.registry, model_id)
        if entry is None or getattr(entry, "pricing", None) is None:
            return 0.0
        try:
            return round(entry.pricing.attempt_cost_usd(input_tokens, output_tokens, cache_hit_ratio), 8)
        except (TypeError, ValueError):
            return 0.0

    # ------------------------------------------------------------------ #
    # 실행 가능성 게이트 (카탈로그 + 역할 + 경로∩동의 + 적재)
    # ------------------------------------------------------------------ #
    def _gate_local(
        self,
        entry: ModelIntelligenceEntry,
        tier_info: Optional[LocalExecutionTierInfo],
        machine: Optional[MachineProfile],
    ) -> str:
        """온디바이스 모델의 하드웨어/런타임/가중치 준비도. 빈 문자열이면 실행 가능.

        하드웨어 준비도가 권위다: ``rule_based_only`` 티어는 로컬 LLM 을 구동할 수 없으므로
        그 티어의 로컬 모델 배정은 카탈로그에 이름이 있어도 실행할 수 없다.
        """
        if tier_info is not None and not tier_info.uses_local_llm:
            return f"local_capability_missing:tier={tier_info.tier.value}"
        if machine is not None:
            fit_reason = _local_fit_reason(self.registry, entry, machine)
            if fit_reason:
                return f"local_fit:{fit_reason}"
        return ""

    def _gate(
        self,
        entry: Optional[ModelIntelligenceEntry],
        role: str,
        context: "_ModelGateContext",
    ) -> str:
        """노드 하나의 실행 가능성. 빈 문자열이면 실행 가능, 아니면 사유 코드."""
        if entry is None:
            return "model_not_in_catalog"
        if role not in VALID_ROLES:
            return f"invalid_role:{role}"
        if role in BACKGROUND_ROLE_NAMES:
            if not bool(getattr(entry, "bg_approved", False)):
                return f"not_background_approved:{entry.model_id}"
            if role not in set(getattr(entry, "roles", ()) or ()):
                return f"background_role_not_declared:{entry.model_id}:{role}"
            if entry.provider != "local":
                return f"background_model_must_be_local:{entry.model_id}"
            return self._gate_local(entry, context.tier_info, context.machine)
        if not _role_eligible(entry, role):
            return f"role_not_supported:{entry.model_id}:{role}"
        route_reason = _route_gate(entry, context.route, context.cloud_consent)
        if route_reason:
            return route_reason
        if entry.provider == "local":
            return self._gate_local(entry, context.tier_info, context.machine)
        return ""

    def _resolve_model(
        self,
        role: str,
        preferred_model_id: Optional[str],
        mode: str,
        context: "_ModelGateContext",
        input_tokens: int,
        output_tokens: int,
        cache_hit_ratio: float,
    ) -> Tuple[str, str, str]:
        """``(model_id, block_reason, candidate_model_id)``.

        사유가 비어 있으면 ``model_id`` 가 실행 가능한 배정이고 ``candidate_model_id`` 는
        같은 값이다. 사유가 있으면 노드는 **실행 대상이 아니며**(``executable=False``),
        ``model_id`` 에는 하류 소비자가 클라우드 배정으로 오독하지 않도록 **온디바이스
        카탈로그 라벨**만 남기고, 게이트가 실제로 검토한 이름은 ``candidate_model_id`` 에
        진단용으로 남긴다. 레지스트리의 ``BackgroundModelSelection`` 이 불가 시
        ``model_id=""`` + ``candidate_model_id`` 를 쓰는 것과 같은 규약이며, 실행 계약은
        언제나 ``DAGNode.executable``/``ExecutionDAGPlan.blocked`` 다.

        백그라운드 역할은 여기서 포그라운드 ``select_model`` 로 새지 않는다.
        """
        reasons: List[str] = []
        candidate_label = ""
        if preferred_model_id:
            candidate = _lookup_entry(self.registry, preferred_model_id)
            if candidate is None:
                reasons.append(f"preferred_model_not_in_catalog:{preferred_model_id}")
            else:
                candidate_label = candidate.model_id
                reason = self._gate(candidate, role, context)
                if not reason:
                    return candidate.model_id, "", candidate.model_id
                reasons.append(f"preferred:{reason}")

        if role in BACKGROUND_ROLE_NAMES:
            # 백그라운드 역할은 select_background_model() 만 배정한다.
            reasons.append(f"background_role_requires_background_plan:{role}")
            return self._diagnostic_label(), ";".join(reasons), candidate_label

        if context.tier_info is not None and not context.tier_info.uses_local_llm \
                and context.route == ExecutionRoute.LOCAL_ONLY:
            # 하드웨어 준비도가 권위다: 이 티어에는 로컬 LLM 이 없고 남은 경로도 LOCAL_ONLY 뿐이다.
            # 포그라운드 선택기를 돌려 이름만 대는 대신 빠진 능력을 사유로 남기고 끝낸다
            # (클라우드 경로가 열려 있으면 이 분기를 타지 않으므로 클라우드 기본값도 아니다).
            reasons.append(f"local_capability_missing:tier={context.tier_info.tier.value}")
            return self._diagnostic_label(), ";".join(reasons), candidate_label

        try:
            selected = self.registry.select_model(
                role,
                mode=mode if mode in OPTIMIZATION_MODES else "balanced",
                privacy_consent=context.cloud_consent,
                input_tokens=max(int(input_tokens), 1),
                output_tokens=max(int(output_tokens), 1),
                cache_hit_ratio=cache_hit_ratio,
                route=context.route.value,
            )
        except (BackgroundModelUnavailableError, RuntimeError, ValueError, KeyError) as exc:
            reasons.append(f"no_compliant_route:{role}:{exc}")
            return self._diagnostic_label(), ";".join(reasons), candidate_label

        candidate_label = candidate_label or selected.model_id
        reason = self._gate(selected, role, context)
        if reason:
            reasons.append(f"selected:{reason}")
            return (selected.model_id if selected.provider == "local" else self._diagnostic_label()), \
                ";".join(reasons), candidate_label
        return selected.model_id, "", selected.model_id

    def _diagnostic_label(self) -> str:
        """차단 노드에 남길 **온디바이스** 카탈로그 이름(진단 라벨, 배정 아님)."""
        for entry in sorted(self.registry.catalog, key=lambda item: item.model_id):
            if getattr(entry, "provider", "") == "local" and _role_eligible(entry, "light_worker"):
                return entry.model_id
        return ""

    def _make_node(
        self,
        node_id: str,
        role: str,
        instruction: str,
        target_files: List[str],
        dependencies: Optional[List[str]] = None,
        reasoning_effort: str = "medium",
        input_tokens: int = 0,
        output_tokens: int = 600,
        cache_hit_ratio: float = 0.0,
        verification_command: Optional[List[str]] = None,
        mode: str = "balanced",
        context: Optional["_ModelGateContext"] = None,
        preferred_model_id: Optional[str] = None,
    ) -> DAGNode:
        gate: "_ModelGateContext" = context or _ModelGateContext(
            route=ExecutionRoute.LOCAL_ONLY, cloud_consent=False
        )
        chosen_model_id, block_reason, candidate_label = self._resolve_model(
            role=role,
            preferred_model_id=preferred_model_id,
            mode=mode,
            context=gate,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_hit_ratio=cache_hit_ratio,
        )

        return DAGNode(
            node_id=node_id,
            role=role,
            model_id=chosen_model_id,
            reasoning_effort=reasoning_effort,
            dependencies=list(dependencies or []),
            target_files=list(target_files),
            instruction=instruction,
            verification_command=verification_command or self._verification_for(target_files),
            estimated_input_tokens=input_tokens,
            estimated_output_tokens=output_tokens,
            cache_hit_ratio=cache_hit_ratio,
            estimated_cost_usd=self._node_cost(chosen_model_id, input_tokens, output_tokens, cache_hit_ratio),
            executable=not block_reason,
            block_reason=block_reason,
            candidate_model_id=candidate_label if block_reason else "",
        )

    def _verification_for(self, target_files: Sequence[str], prompt: str = "") -> List[str]:
        """Fixed commands keyed by suffix; prompt text never supplies executable arguments."""
        files = list(target_files)
        suffixes = {Path(path).suffix.lower() for path in files}
        python_files = [path for path in files if Path(path).suffix.lower() in (".py", ".pyi")]
        if python_files:
            return [sys.executable, "-m", "py_compile", *python_files]
        if suffixes == {".json"}:
            return [sys.executable, "-c",
                    "import json,pathlib,sys; [json.loads(pathlib.Path(p).read_text(encoding='utf-8')) for p in sys.argv[1:]]",
                    *files]
        if len(files) == 1 and suffixes <= {".js", ".mjs", ".cjs"}:
            return ["node", "--check", *files]
        if suffixes <= {".md", ".txt"}:
            return [sys.executable, "-c",
                    "import pathlib,sys; [pathlib.Path(p).read_text(encoding='utf-8') for p in sys.argv[1:]]",
                    *files]
        return [sys.executable, "-m", "pytest", "-q"]

    def auto_infer_mode(
        self,
        prompt: str,
        complexity: int,
        hardware_tier: Optional[Union[str, LocalExecutionTier]] = None,
    ) -> str:
        """
        [Zero-Config Auto-Optimization]
        사용자가 수동으로 모드나 예산을 고를 필요 없이, 작업 특성과 복잡도를 자동 감지하여
        최적의 실행 모드를 내부에서 결정론적으로 선택함.
        - hardware_tier가 지정된 경우 사양 컨텍스트 반영
        - 초단순/경량 작업: cost (초저가 flash 모델 우선, 캐시 극대화)
        - 복잡도 8 이상/보안/아키텍처: quality (플래그십 승격 및 고도 검증)
        - 긴급/성능/배포/실시간 키워드: speed (병렬화 및 최소 지연)
        - 기본 일반 코딩: balanced (ECPS 최적 가성비)
        """
        lower = prompt.lower()
        if complexity <= 2 or any(k in lower for k in ["오타", "typo", "주석", "포맷팅", "format", "단순"]):
            return "cost"
        if complexity >= 8 or any(k in lower for k in ["보안", "security", "아키텍처", "architecture", "리팩터링", "취약점"]):
            return "quality"
        if any(k in lower for k in ["빠르게", "급함", "지연", "latency", "speed", "동시", "병렬"]):
            return "speed"
        return "balanced"

    def _resolve_hardware_tier(
        self,
        hardware_tier: Optional[Union[str, LocalExecutionTier, LocalExecutionTierInfo]] = None,
    ) -> LocalExecutionTierInfo:
        """주어진 하드웨어 티어 또는 자동 감지된 하드웨어 티어 정보를 반환한다.

        알 수 없는 티어 값은 ``ValueError``(``parse_tier``)이거나 불리언 입력에서
        ``TypeError`` 다. 후자는 계획 계층의 계약 위반이므로 ``DecisionPlanError`` 로
        변환한다(원시 ``TypeError`` 크래시 금지).
        """
        if isinstance(hardware_tier, LocalExecutionTierInfo):
            return hardware_tier
        spec = detect_hardware()
        if hardware_tier is None:
            return determine_local_tier(spec)
        try:
            tier = parse_tier(hardware_tier)
        except TypeError as exc:
            raise DecisionPlanError(f"invalid hardware tier: {hardware_tier!r}") from exc
        return determine_local_tier(spec, override_tier=str(tier.value))

    def select_decision_model(
        self,
        role: str = "planner",
        mode: str = "balanced",
        complexity: int = 5,
        privacy_consent: bool = False,
        route: Optional[Union[str, ExecutionRoute]] = None,
    ) -> str:
        """
        [고정 의사결정 모델 라인업 라우팅]
        기획/의사결정/조사 단계에서 앱 릴리스에 고정된 고성능 의사결정 모델을 우선 매핑:
        1. baseten/mammoth-1: quality/balanced 모드 또는 복잡도 7 이상의 최고정밀 의사결정
        2. openrouter/d1-ultra: 복잡도 8 이상 또는 quality 모드의 초고추론 기획
        3. openrouter/drex-max: 대규모 컨텍스트 및 복잡 의사결정
        4. openrouter/subq-snap-1.1: speed 모드 또는 경량 쿼리/분해
        5. openrouter/elephant-9b: 기본 기획 및 전문 의사결정

        ``route`` 를 주면 이 라인업 조회도 **경로 ∩ 동의** 게이트를 통과해야 한다. 즉
        무동의 턴(``privacy_consent=False``)에서는 어떤 클라우드 라인업 이름도 반환하지
        않고 ``ModelRoutingBlocked`` 를 던진다(클라우드로 암묵 승격하지 않는다). ``route``
        를 주지 않는 호출은 "라인업 조회"이며 배정이 아니다 — 배정은 언제나
        ``build_plan()``/``validate_turn_plan()`` 의 게이트를 통과해야 한다.
        """
        catalog_ids = {m.model_id for m in self.registry.catalog}

        proposed: Optional[str] = None
        if (mode in ("quality", "balanced") or complexity >= 7) and "baseten/mammoth-1" in catalog_ids:
            proposed = "baseten/mammoth-1"
        elif complexity >= 8 or mode == "quality":
            proposed = "openrouter/d1-ultra"
        elif mode == "speed" or complexity <= 3:
            proposed = "openrouter/subq-snap-1.1"
        elif "max" in mode or complexity >= 7:
            proposed = "openrouter/drex-max"
        else:
            proposed = "openrouter/elephant-9b"

        if proposed is not None and proposed not in catalog_ids:
            proposed = None
        if proposed is not None:
            entry = _lookup_entry(self.registry, proposed)
            if entry is not None and not _role_eligible(entry, role):
                # 라인업 항목이 그 역할을 선언하지 않았다(예: mammoth-1 은 planner/researcher 전용).
                proposed = None
            elif entry is not None and route is not None:
                requested = _coerce_route(route, privacy_consent)
                gate_reason = _route_gate(
                    entry, _connection_route(requested, privacy_consent), privacy_consent
                )
                if gate_reason:
                    raise ModelRoutingBlocked(
                        f"decision model {proposed!r} cannot serve route "
                        f"{requested.value} with privacy_consent={privacy_consent}: {gate_reason}"
                    )
        if proposed is not None:
            return proposed

        # 카탈로그 일반 선택으로 폴백 (등록되지 않은 이름을 발명하지 않는다).
        if role in BACKGROUND_ROLE_NAMES:
            raise ModelRoutingBlocked(
                f"role {role!r} is reserved for the background track; "
                f"use registry.select_background_model()"
            )
        try:
            selected = self.registry.select_model(
                role=role,
                mode=mode if mode in OPTIMIZATION_MODES else "balanced",
                privacy_consent=privacy_consent,
                route=(_connection_route(_coerce_route(route, privacy_consent), privacy_consent).value
                       if route is not None else None),
            )
        except (RuntimeError, ValueError, KeyError, AttributeError) as exc:
            raise ModelRoutingBlocked(f"no compliant decision model for role {role!r}: {exc}") from exc
        if not _role_eligible(selected, role):
            raise ModelRoutingBlocked(
                f"decision model {selected.model_id!r} cannot serve foreground role {role!r}"
            )
        return selected.model_id

    def build_plan(
        self,
        prompt: str,
        mode: str = "auto",
        privacy_consent: bool = False,
        hardware_tier: Optional[Union[str, LocalExecutionTier, LocalExecutionTierInfo]] = None,
        route: Optional[Union[str, ExecutionRoute]] = None,
        *,
        machine: Optional[MachineProfile] = None,
    ) -> ExecutionDAGPlan:
        """DAG 계획 합성. 경로와 동의는 독립이며 배정 게이트는 **교집합**을 쓴다.

        ``route`` 는 호출자가 요청한 값을 그대로 보고하지만(``plan.route``), 모델 배정은
        ``privacy_consent=False`` 이면 어떤 클라우드 경로에서도 오프디바이스 모델을 고르지
        않는다. 실행 가능한 후보가 없으면 대체 모델을 발명하지 않고 ``blocked=True`` 인
        계획을 돌려준다(노드는 ``executable=False`` + 사유, 모델 ID는 진단용 이름일 뿐이다).

        ``machine`` 을 주면 로컬 모델의 런타임/가중치/적재 산술까지 게이트한다. 주지 않으면
        적재 산술은 하지 않는다(호스트 프로브는 호출자 판단이다).
        """
        text = _require_text(prompt)
        consent = _require_bool(privacy_consent, "privacy_consent")
        requested_mode = _require_mode(mode)
        requested_route = _coerce_route(route, consent)
        plan = self._build_plan(text, requested_mode, consent, hardware_tier, requested_route, machine)
        plan.route = requested_route
        plan.cloud_consent = consent
        plan.privacy_consent = consent
        for node in plan.nodes:
            node.route = requested_route
        plan.estimated_budget_usd = round(sum(n.estimated_cost_usd for n in plan.nodes), 8)
        return plan

    def _decision_model_or_none(
        self,
        role: str,
        mode: str,
        complexity: int,
        cloud_consent: bool,
    ) -> Optional[str]:
        """의사결정 모델 라인업 후보(없으면 ``None``; 게이트가 최종 판정한다)."""
        try:
            return self.select_decision_model(role, mode, complexity, cloud_consent)
        except ModelRoutingBlocked:
            return None

    def _build_plan(
        self,
        prompt: str,
        mode: str = "auto",
        cloud_consent: bool = False,
        hardware_tier: Optional[Union[str, LocalExecutionTier, LocalExecutionTierInfo]] = None,
        route: ExecutionRoute = ExecutionRoute.LOCAL_ONLY,
        machine: Optional[MachineProfile] = None,
    ) -> ExecutionDAGPlan:
        tier_info = self._resolve_hardware_tier(hardware_tier)
        context = _ModelGateContext(
            # 게이트는 경로 ∩ 동의를 본다: 무동의 턴은 어떤 클라우드 경로에서도
            # 오프디바이스 모델을 고르지 않는다.
            route=_connection_route(route, cloud_consent),
            cloud_consent=cloud_consent,
            tier_info=tier_info,
            machine=machine,
            requested_route=route,
        )
        complexity = self.estimate_complexity(prompt)
        # mode="auto"일 때 사용자의 개입 없이 내부 자율 판정
        effective_mode = (self.auto_infer_mode(prompt, complexity, hardware_tier=tier_info.tier)
                          if mode == "auto" else mode)
        plan_id = str(uuid.uuid4())
        prompt_tokens = estimate_tokens(prompt)
        target_files = self.detect_target_files(prompt)

        # 1. Simple-Task Fast-Path
        if self.is_simple_task(prompt):
            files = target_files or ["src/app.py"]
            # [Tier 라우팅 규칙]
            # Tier 0 (rule_based_only): 로컬 LLM 이 없다. 동의가 있으면 클라우드 결정 모델이
            #   후보가 되고, 동의가 없으면 어떤 후보도 실행 가능하지 않다(막힌 계획으로 보고).
            # Tier >= 1: 0 지연 / $0 비용의 로컬 SLM/LLM 모델로 즉시 처리 가능
            if tier_info.tier == LocalExecutionTier.RULE_BASED_ONLY:
                fastpath_model: Optional[str] = "deepseek/deepseek-v4.1-flash-1017"
            else:
                fastpath_model = tier_info.registry_model_id or DEFAULT_LOCAL_MODEL_ID

            node = self._make_node(
                node_id="task-01-fastpath",
                role="light_worker",
                instruction=prompt,
                target_files=files,
                reasoning_effort="low",
                input_tokens=prompt_tokens,
                output_tokens=300,
                cache_hit_ratio=0.5,
                verification_command=self._verification_for(files, prompt),
                mode=effective_mode,
                context=context,
                preferred_model_id=fastpath_model,
            )
            return self._finalize_plan(
                plan_id=plan_id,
                complexity=complexity,
                fast_path=True,
                nodes=[node],
                mode=effective_mode,
                context=context,
                tier_info=tier_info,
            )

        # 2. Track 2/구현 DAG 합성 (트랙별 결정론적 분기)
        track = self.classify_execution_track(prompt)
        nodes: List[DAGNode] = []
        workers: List[DAGNode] = []
        lead_dep_id: Optional[str] = None

        if track == "survey_and_plan":
            # [Track 2: 복잡/불명확 작업] -> 1단계 조사 -> 2단계 계획 노드를 선행 배치
            survey_id = "task-01-survey"
            survey_files = ["docs/investigation.md"] + (target_files[:2] if target_files else [])

            # Tier 2 이상(standard_local 이상)은 1차 조사를 로컬에서 $0 비용으로 수행 가능
            if tier_info.tier >= LocalExecutionTier.STANDARD_LOCAL and tier_info.registry_model_id:
                survey_model = tier_info.registry_model_id
            else:
                survey_model = self._decision_model_or_none(
                    "researcher", effective_mode, complexity, context.cloud_consent)

            nodes.append(
                self._make_node(
                    node_id=survey_id,
                    role="researcher",
                    instruction=f"코드베이스 및 기술 사양 1차 심층 조사, 문제 원인 규명: {prompt}",
                    target_files=survey_files,
                    reasoning_effort="medium",
                    input_tokens=prompt_tokens + 400,
                    output_tokens=800,
                    cache_hit_ratio=0.4,
                    mode=effective_mode,
                    context=context,
                    preferred_model_id=survey_model,
                )
            )

            plan_node_id = "task-02-plan"
            # Planner 노드는 앱 릴리스에 고정된 의사결정 모델 라인업(openrouter/elephant-9b, d1-ultra 등) 활용
            planner_model = self._decision_model_or_none(
                "planner", effective_mode, complexity, context.cloud_consent)

            nodes.append(
                self._make_node(
                    node_id=plan_node_id,
                    role="planner",
                    instruction=f"1차 조사 결과 기반 세부 구현 전략 및 인터페이스 명세 수립: {prompt}",
                    target_files=["docs/spec.md"] + target_files,
                    dependencies=[survey_id],
                    reasoning_effort="high" if complexity >= 7 else "medium",
                    input_tokens=prompt_tokens + 1000,
                    output_tokens=1000 + 100 * complexity,
                    cache_hit_ratio=0.3,
                    mode=effective_mode,
                    context=context,
                    preferred_model_id=planner_model,
                )
            )
            lead_dep_id = plan_node_id
        else:
            # [Track 1: 간단/명확한 작업] -> 조사/계획 오버헤드 없이 즉시 구현 진행
            if complexity >= 6:
                design_id = "task-01-spec"
                design_files = ["docs/spec.md"] + target_files
                planner_model = self._decision_model_or_none(
                    "planner", effective_mode, complexity, context.cloud_consent)
                nodes.append(
                    self._make_node(
                        node_id=design_id,
                        role="planner",
                        instruction=f"명확한 요구사항의 인터페이스 명세화: {prompt}",
                        target_files=design_files,
                        reasoning_effort="low",
                        input_tokens=prompt_tokens,
                        output_tokens=600,
                        cache_hit_ratio=0.4,
                        mode=effective_mode,
                        context=context,
                        preferred_model_id=planner_model,
                    )
                )
                lead_dep_id = design_id

        subtasks = self.decompose(prompt) or [prompt]
        if complexity >= 8 and len(subtasks) == 1:
            subtasks = [prompt, "회귀 테스트 및 경계 조건 검증"]
        subtasks = subtasks[:MAX_PARALLEL_WORKERS]

        for index, subtask in enumerate(subtasks, start=1):
            role = self._role_for(subtask)
            files = target_files[index - 1:index] or target_files or ["src/main.py"]

            # Tier 3(advanced_local)에서는 일반 worker도 로컬 14B~32B 모델 활용 가능
            worker_pref_model: Optional[str] = None
            if tier_info.tier == LocalExecutionTier.ADVANCED_LOCAL and tier_info.registry_model_id:
                worker_pref_model = tier_info.registry_model_id

            worker = self._make_node(
                node_id=f"task-{len(nodes) + 1:02d}-{role}",
                role=role,
                instruction=f"{subtask} (전체 목표: {prompt})",
                target_files=files,
                dependencies=[lead_dep_id] if lead_dep_id else [],
                reasoning_effort="medium" if complexity < 8 else "high",
                input_tokens=prompt_tokens + estimate_tokens(subtask) + 800,
                output_tokens=1200 + 180 * complexity,
                cache_hit_ratio=0.35,
                verification_command=self._verification_for(files, subtask),
                mode=effective_mode,
                context=context,
                preferred_model_id=worker_pref_model,
            )
            nodes.append(worker)
            workers.append(worker)

        review_files = target_files or ["src/main.py"]
        review_id = f"task-{len(nodes) + 1:02d}-review"
        nodes.append(
            self._make_node(
                node_id=review_id,
                role="reviewer",
                instruction="코드 품질, 정합성 및 회귀 위험 검증: " + "; ".join(s.instruction for s in workers),
                target_files=review_files,
                dependencies=[w.node_id for w in workers],
                reasoning_effort="low",
                input_tokens=estimate_tokens(" ".join(w.instruction for w in workers)) + 600,
                output_tokens=700,
                cache_hit_ratio=0.4,
                mode=effective_mode,
                context=context,
            )
        )

        security_hits = [kw for kw in ("보안", "취약", "security", "cve") if kw in prompt.lower()]
        if security_hits and complexity >= 7:
            nodes.append(
                self._make_node(
                    node_id=f"task-{len(nodes) + 1:02d}-security",
                    role="security_reviewer",
                    instruction=f"보안 위협 모델링 및 취약점 검토 ({', '.join(security_hits)}): {prompt}",
                    target_files=review_files,
                    dependencies=[review_id],
                    reasoning_effort="high",
                    input_tokens=prompt_tokens + 700,
                    output_tokens=900,
                    cache_hit_ratio=0.3,
                    mode=effective_mode,
                    context=context,
                )
            )

        return self._finalize_plan(
            plan_id=plan_id,
            complexity=complexity,
            fast_path=False,
            nodes=nodes,
            mode=effective_mode,
            context=context,
            tier_info=tier_info,
        )

    def _finalize_plan(
        self,
        plan_id: str,
        complexity: int,
        fast_path: bool,
        nodes: List[DAGNode],
        mode: str,
        context: "_ModelGateContext",
        tier_info: LocalExecutionTierInfo,
    ) -> ExecutionDAGPlan:
        """노드 게이트 결과를 계획 레코드에 반영한다(차단 사유는 숨기지 않는다)."""
        blocked_nodes = [n for n in nodes if not n.executable]
        block_reasons: List[str] = []
        for node in blocked_nodes:
            reason = f"{node.role}:{node.block_reason}"
            if reason not in block_reasons:
                block_reasons.append(reason)
        blocked = bool(nodes) and len(blocked_nodes) == len(nodes)
        detail: Dict[str, Any] = {}
        if blocked:
            detail = {
                "route": context.requested_route.value if context.requested_route else context.route.value,
                "effective_route": context.route.value,
                "cloud_consent": context.cloud_consent,
                "tier": tier_info.tier.value,
                "local_capability": tier_info.uses_local_llm,
                "missing": block_reasons,
            }
        return ExecutionDAGPlan(
            plan_id=plan_id,
            task_complexity=complexity,
            fast_path=fast_path,
            estimated_budget_usd=round(sum(n.estimated_cost_usd for n in nodes), 8),
            nodes=nodes,
            privacy_consent=context.cloud_consent,
            mode=mode,
            route=context.route,
            cloud_consent=context.cloud_consent,
            blocked=blocked,
            block_reasons=block_reasons,
            block_detail=detail,
        )

    # ------------------------------------------------------------------ #
    # 백그라운드 인지 작업 계획 합성 (Bonsai-2 27B 전담)
    # ------------------------------------------------------------------ #
    def build_background_plan(
        self,
        task_type: str = "compaction",
        context: str = "",
        tier: Optional[Union[str, LocalExecutionTier, LocalExecutionTierInfo]] = None,
        machine: Optional[MachineProfile] = None,
    ) -> ExecutionDAGPlan:
        """백그라운드 인지 작업용 단일 노드 DAG를 합성한다(계획 오버헤드 0).

        세션 압축/제목·커밋 메시지 생성/FTS5 메모리 인덱싱·증류/백그라운드 트리아지·
        루프 가드 진단은 포그라운드 DAG와 분리된 백그라운드 작업이며, 모델 배정은
        ``registry.select_background_model()`` 만 한다.

        배정이 불가하면(``status="unavailable"``) 포그라운드 ``select_model`` 로 대체하지
        않는다 — 그 호출은 백그라운드 역할에서 ``BackgroundModelUnavailableError`` 를 던진다.
        대신 ``blocked=True`` + 사유가 담긴 계획을 돌려주고, 모델이 필요하면 호출자가
        ``select_background_model().require_entry()`` 로 명시적 예외를 받는다.
        """
        if not isinstance(context, str):
            raise DecisionPlanError(f"context must be a string, got {type(context).__name__}")
        tier_info = self._resolve_hardware_tier(tier)
        canonical = self.registry.canonical_background_task_type(task_type)
        role = self.registry.background_role_for(canonical)
        selection = self.registry.select_background_model(canonical, tier=tier_info.tier, machine=machine)
        output_tokens = _BACKGROUND_TASK_OUTPUT_TOKENS.get(canonical, 600)
        instruction = _BACKGROUND_TASK_INSTRUCTIONS.get(canonical, "백그라운드 인지 작업 수행: ") + context.strip()

        if not selection.is_ready:
            reason = f"background_unavailable:{canonical}:{selection.reason}"
            return ExecutionDAGPlan(
                plan_id=str(uuid.uuid4()),
                task_complexity=1,
                fast_path=True,
                estimated_budget_usd=0.0,
                nodes=[
                    DAGNode(
                        node_id=f"bg-01-{role}",
                        role=role,
                        model_id="",
                        reasoning_effort="off",
                        dependencies=[],
                        target_files=[],
                        instruction=instruction,
                        verification_command=[],
                        executable=False,
                        block_reason=reason,
                    )
                ],
                privacy_consent=False,
                mode="cost",
                route=ExecutionRoute.LOCAL_ONLY,
                cloud_consent=False,
                blocked=True,
                block_reasons=[reason],
                block_detail={
                    "task_type": canonical,
                    "role": role,
                    "tier": tier_info.tier.value,
                    "candidate_model_id": selection.candidate_model_id,
                    "reason": selection.reason,
                },
            )

        entry = selection.require_entry()
        gate = _ModelGateContext(
            route=ExecutionRoute.LOCAL_ONLY, cloud_consent=False, tier_info=tier_info, machine=machine
        )
        node = self._make_node(
            node_id=f"bg-01-{role}",
            role=role,
            instruction=instruction,
            target_files=[],
            reasoning_effort="low" if output_tokens <= 400 else "medium",
            input_tokens=estimate_tokens(context),
            output_tokens=output_tokens,
            cache_hit_ratio=0.5,
            mode="cost",
            context=gate,
            preferred_model_id=entry.model_id,
        )
        return self._finalize_plan(
            plan_id=str(uuid.uuid4()),
            complexity=1,
            fast_path=True,
            nodes=[node],
            mode="cost",
            context=gate,
            tier_info=tier_info,
        )


# ====================================================================== #
# TurnPlan 구조체 및 동적 턴 계획 수립/검증 레이어
# ====================================================================== #
TURN_PLAN_SCHEMA = "harness.turn_plan/1"
VALID_REASONING_GRADES: Sequence[str] = ("off", "low", "medium", "high", "xhigh")
DEFAULT_TOOLS: Sequence[str] = ("read", "glob", "grep", "find")


@dataclass(frozen=True)
class SubagentSlot:
    """단일 서브에이전트 역할 및 호출 목적 명세."""
    role: str
    count: int = 1
    purpose: str = ""


@dataclass(frozen=True)
class TurnPlan:
    """턴 단위 동적 실행 계획 (조언 레코드).

    모델 지정은 3상태다.

    * ``model_id="<catalog id>"`` — 호출자가 지정한 모델(``model_selection="caller"``).
    * ``model_id=AUTO_MODEL_ID`` (``"auto"``) — 게이트웨이가 정한다. 검증기가 (경로 ∩ 동의)
      게이트를 통과하는 카탈로그 항목으로 해석하므로, 해석 결과가 없으면 거부된다.
    * ``model_id=DEFERRED_MODEL_ID`` (``"gateway_deferred"``) — 플래너가 **모른다**고 선언한
      지연 상태. 검증기는 이 상태를 경로가 만족 가능할 때만(= 자동 해석 후보가 존재할 때만)
      받아들이고, 후보가 없으면 거부한다. 특정 모델명을 발명하지 않는다.

    사고 등급도 같은 3상태다: 명시 등급, ``AUTO_REASONING_GRADE``(게이트웨이가 정하고
    검증기가 모델 지원 등급과 교집합), 그리고 ``reasoning_grade_recommended`` 에 남는
    플래너의 **관찰 가능한 추천**(강제 아님).
    """
    turn_plan_schema: str = TURN_PLAN_SCHEMA
    turn_id: str = ""
    origin: str = "defaults"
    subagents: List[SubagentSlot] = field(default_factory=list)
    model_role: str = "light_worker"
    model_id: str = AUTO_MODEL_ID
    reasoning_grade: str = "medium"
    skills: List[str] = field(default_factory=list)
    tools: List[str] = field(default_factory=lambda: list(DEFAULT_TOOLS))
    context_budget_tokens: int = 0
    context_history: str = "last_turn"
    expected_cost_class: str = "unknown"
    rationale: str = "default_plan"
    constraints_applied: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    #: 실행 가능한 모델 배정이 없으면 ``True``. 이때 ``model_id`` 는 빈 문자열이며
    #: ``block_reasons`` 가 빠진 능력(로컬 LLM 부재, 동의 부재 등)을 이름으로 남긴다.
    blocked: bool = False
    block_reasons: List[str] = field(default_factory=list)
    #: 플래너가 **권고**하는 사고 등급(강제 아님, 게이트웨이 결정과 비교용).
    reasoning_grade_recommended: str = "medium"
    #: 위 권고를 만든 관찰 가능한 입력 기록(프롬프트 크기·도구 사용·경로·출력 크기).
    reasoning_grade_factors: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ValidatedTurnPlan:
    """결정론적 가드레일(turn_validator)을 통과한 유계 실행 계획."""
    plan: TurnPlan
    accepted: bool
    violations: List[Dict[str, Any]] = field(default_factory=list)
    clamps: List[str] = field(default_factory=list)
    approvals_required: List[str] = field(default_factory=list)
    effective_model_id: str = ""
    effective_reasoning_grade: str = "medium"
    effective_subagents: List[SubagentSlot] = field(default_factory=list)
    effective_tools: List[str] = field(default_factory=list)
    effective_skills: List[str] = field(default_factory=list)
    effective_context_budget_tokens: int = 0
    effective_route: str = ""
    #: ``CALLER_SELECTION`` 또는 ``GATEWAY_SELECTION``: 모델을 누가 정했는지.
    effective_model_selection: str = CALLER_SELECTION
    #: ``CALLER_SELECTION`` 또는 ``GATEWAY_SELECTION``: 사고 등급을 누가 정했는지.
    effective_grade_selection: str = CALLER_SELECTION
    #: 플래너 권고 등급과 게이트웨이/호출자 결정이 다르면 그 차이를 기록한다(비교 관측점).
    grade_recommendation_delta: Optional[str] = None


def _reject(
    plan: TurnPlan,
    violations: List[Dict[str, Any]],
    clamps: Optional[List[str]] = None,
) -> ValidatedTurnPlan:
    """거부 결과(항상 같은 모양: 실행 불가 모델 + off 등급)."""
    automatic_model = isinstance(plan.model_id, str) and plan.model_id in (AUTO_MODEL_ID, DEFERRED_MODEL_ID)
    automatic_grade = isinstance(plan.reasoning_grade, str) and plan.reasoning_grade == AUTO_REASONING_GRADE
    return ValidatedTurnPlan(
        plan=plan,
        accepted=False,
        violations=violations,
        clamps=list(clamps or []),
        effective_model_id="rejected",
        effective_reasoning_grade="off",
        effective_model_selection=GATEWAY_SELECTION if automatic_model else CALLER_SELECTION,
        effective_grade_selection=GATEWAY_SELECTION if automatic_grade else CALLER_SELECTION,
    )


def recommend_reasoning_grade(
    track: str,
    complexity: int,
    prompt_tokens: int,
    tool_count: int,
    route: ExecutionRoute,
    requested_output_tokens: int = 0,
) -> Tuple[str, Dict[str, Any]]:
    """플래너의 **권고** 사고 등급과 그 관찰 가능한 입력 기록.

    반환값은 ``(grade, factors)`` 다. 이 값은 *권고*이며 게이트웨이의 자동 선택을 강제하지
    않는다. 게이트웨이 결정과 비교할 수 있도록 입력을 그대로 남긴다.
    """
    factors: Dict[str, Any] = {
        "track": track,
        "complexity": complexity,
        "prompt_tokens": prompt_tokens,
        "tool_count": tool_count,
        "route": route.value if isinstance(route, ExecutionRoute) else str(route),
        "requested_output_tokens": requested_output_tokens,
    }
    grade = "low" if track == "direct_execute" else ("high" if complexity >= 8 else "medium")
    if prompt_tokens > 20_000 or requested_output_tokens > 4_000:
        # 대형 컨텍스트/장문 생성은 얕은 사고로 처리하지 않는다(한 단계만 올린다).
        index = min(REASONING_GRADE_ORDER.index(grade) + 1, REASONING_GRADE_ORDER.index(MAX_AUTO_REASONING_GRADE))
        grade = REASONING_GRADE_ORDER[index]
    factors["recommended_grade"] = grade
    return grade, factors


def _model_supported_grades(entry: Optional[ModelIntelligenceEntry]) -> Tuple[str, ...]:
    """모델이 실제로 지원하는 사고 등급.

    카탈로그 항목은 등급 목록을 갖지 않으므로(릴리스 프리셋에 그 필드가 없다), 온디바이스
    소형 모델은 ``off/low/medium`` 까지, 원격 대형 모델은 5값 전부로 결정론적으로 한정한다.
    카탈로그가 ``reasoning_grades`` 를 스스로 선언하면 그 선언을 우선한다(추정하지 않는다).
    """
    if entry is None:
        return ()
    declared = getattr(entry, "reasoning_grades", None)
    if declared:
        return tuple(grade for grade in REASONING_GRADE_ORDER if grade in set(declared))
    if getattr(entry, "provider", "") == "local":
        return ("off", "low", "medium")
    return REASONING_GRADE_ORDER


def _clamp_grade(requested: Any, supported: Sequence[str]) -> Tuple[str, Optional[str]]:
    """``(effective, clamp_note)``. 위로 올리지 않고, 가장 가까운 **낮은** 등급으로 자른다."""
    if not isinstance(requested, str) or requested not in REASONING_GRADE_ORDER:
        return "off", "grade:fallback_off"
    if not supported:
        return "off", "grade:no_supported_grade"
    top = REASONING_GRADE_ORDER.index(requested)
    for candidate in reversed(REASONING_GRADE_ORDER[: top + 1]):
        if candidate in supported:
            if candidate == requested:
                return candidate, None
            return candidate, f"grade:clamped_{requested}_to_{candidate}"
    return "off", "grade:clamped_to_off"


def _context_bound(entry: Optional[ModelIntelligenceEntry], cap: int) -> int:
    """모델 컨텍스트 창과 릴리스 상한 중 작은 값(비정상 창은 상한으로 대체)."""
    try:
        window = int(getattr(entry, "context_window", 0) or 0) if entry is not None else 0
    except (TypeError, ValueError):
        return cap
    if window <= 0:
        return cap
    return min(window, cap)


def _subagent_role_allowed(role: str, allowed: Sequence[str]) -> bool:
    """서브에이전트 역할은 포그라운드 역할 집합에 속해야 한다(백그라운드 전담 금지)."""
    return role in allowed and role not in BACKGROUND_ROLE_NAMES


def default_turn_plan(
    planner: IntelligencePlanner,
    prompt: str,
    hardware_tier: Optional[Union[str, LocalExecutionTier, LocalExecutionTierInfo]] = None,
    route: ExecutionRoute = ExecutionRoute.LOCAL_ONLY,
    privacy_consent: bool = False,
    machine: Optional[MachineProfile] = None,
) -> TurnPlan:
    """결정 모델 실패, 부재 또는 마감 초과 시 작동하는 보수적 결정론적 폴백 계획.
    폴백 시 결정 모델 네트워크 호출이 발생하지 않는다 (no decision-model network call on fallback).

    하드웨어 준비도가 권위다. ``rule_based_only`` 처럼 로컬 LLM 을 구동할 수 없는 기계에서
    무동의 ``LOCAL_ONLY`` 계획이 실행 가능한 로컬 노드를 달고 나오지 않는다 — 그 대신
    ``blocked=True`` 와 함께 빠진 능력(로컬 LLM 부재)과 동의 부재를 이름으로 남긴다.
    """
    text = _require_text(prompt)
    consent = _require_bool(privacy_consent, "privacy_consent")
    requested_route = _coerce_route(route, consent)
    track = planner.classify_execution_track(text)
    complexity = planner.estimate_complexity(text)
    detected = planner.detect_target_files(text)
    tier_info = planner._resolve_hardware_tier(hardware_tier)

    gate = _ModelGateContext(
        route=_connection_route(requested_route, consent), cloud_consent=consent, tier_info=tier_info, machine=machine
    )
    reasons: List[str] = []
    resolved_model = ""
    cost_class = "local_zero"
    preferred_role = "light_worker" if track == "direct_execute" else "planner"

    if tier_info.uses_local_llm and tier_info.registry_model_id:
        candidate = _lookup_entry(planner.registry, tier_info.registry_model_id)
        if candidate is not None and not _role_eligible(candidate, preferred_role):
            # 이 티어의 로컬 모델이 그 역할을 선언하지 않았다(예: 7B 는 planner 역할이 없다).
            # 모델을 바꾸지 않고 계획의 역할 키를 모델이 실제로 선언한 포그라운드 역할로 맞춘다.
            supported = [role for role in ("light_worker", "worker") if _role_eligible(candidate, role)]
            if supported:
                preferred_role = supported[0]
        reason = planner._gate(candidate, preferred_role, gate)
        if not reason:
            resolved_model = tier_info.registry_model_id
        else:
            reasons.append(reason)
    else:
        reasons.append(f"local_capability_missing:tier={tier_info.tier.value}")

    if not resolved_model:
        # 경로 ∩ 동의 교집합 안에서만 클라우드 후보를 찾는다.
        if _connection_route(requested_route, consent) != ExecutionRoute.LOCAL_ONLY:
            candidate = _lookup_entry(planner.registry, "deepseek/deepseek-v4.1-flash-1017")
            reason = planner._gate(candidate, preferred_role, gate)
            if not reason:
                resolved_model = candidate.model_id if candidate is not None else ""
                cost_class = "metered"
            else:
                reasons.append(reason)
        else:
            reasons.append("cloud_route_requires_explicit_consent")

    blocked = not resolved_model
    if blocked:
        cost_class = "unknown"

    # 서브에이전트 배치 (단순 작업은 0, 복잡 작업은 단일/다중 제약)
    subagents: List[SubagentSlot] = []
    if not blocked:
        if track == "survey_and_plan" and complexity >= 6:
            subagents.append(SubagentSlot(role="researcher", count=1, purpose="초기 사양 및 인터페이스 조사"))
            if complexity >= 8:
                subagents.append(SubagentSlot(role="planner", count=1, purpose="다중 모듈 구현 계획 수립"))

    grade = "low" if track == "direct_execute" else ("high" if complexity >= 8 else "medium")
    recommended_grade, grade_factors = recommend_reasoning_grade(
        track=track,
        complexity=complexity,
        prompt_tokens=estimate_tokens(text),
        tool_count=len(DEFAULT_TOOLS),
        route=requested_route,
        requested_output_tokens=0,
    )

    notes = ["origin:defaults"]
    notes.append(f"reasoning_grade_recommended:{recommended_grade}")
    if blocked:
        notes.append("blocked:no_executable_model")

    return TurnPlan(
        turn_plan_schema=TURN_PLAN_SCHEMA,
        turn_id=str(uuid.uuid4())[:8],
        origin="defaults",
        subagents=subagents,
        model_role=preferred_role,
        model_id=resolved_model,
        reasoning_grade=grade if not blocked else "off",
        skills=[],
        tools=list(DEFAULT_TOOLS),
        context_budget_tokens=0,
        context_history="last_turn",
        expected_cost_class=cost_class,
        rationale=f"Track {track}, complexity {complexity}, files {len(detected)} fallback",
        constraints_applied=[f"route={requested_route.value}", f"consent={str(consent).lower()}"]
        + [f"blocked_reason={reason}" for reason in reasons],
        notes=notes,
        blocked=blocked,
        block_reasons=list(reasons),
        reasoning_grade_recommended=recommended_grade,
        reasoning_grade_factors=grade_factors,
    )


def validate_turn_plan(
    plan: TurnPlan,
    registry: ModelIntelligenceRegistry,
    route: ExecutionRoute = ExecutionRoute.LOCAL_ONLY,
    privacy_consent: bool = False,
    max_subagents: int = MAX_PARALLEL_WORKERS,
    available_tools: Sequence[str] = DEFAULT_TOOLS,
    available_grades: Sequence[str] = VALID_REASONING_GRADES,
    cost_budget_usd: Optional[float] = None,
    available_skills: Sequence[str] = (),
    approved_tools: Sequence[str] = (),
    machine: Optional[MachineProfile] = None,
) -> ValidatedTurnPlan:
    """턴 플랜을 결정론적 제약으로 검증하고 상한(clamp)·승인 보류를 강제한다.

    판정 순서(설계 §4.3): V-01 스키마 → V-02 경로∩동의 → V-03 카탈로그/역할/적재 →
    V-04 등급 → V-05 컨텍스트 → V-06 서브에이전트 → V-07 비용 → V-08 도구 → V-09 스킬.

    계약 위반은 ``DecisionPlanError``(ValueError)이고, 계약은 지켰지만 정책상 불가한 값은
    ``accepted=False`` + ``violations``(거부) 또는 ``clamps``(하향 조정)다. 어느 경우에도
    ``KeyError``/``AttributeError``/``TypeError`` 로 터지지 않는다.
    """
    if not isinstance(plan, TurnPlan):
        raise DecisionPlanError(f"plan must be a TurnPlan, got {type(plan).__name__}")
    if not callable(getattr(registry, "get_model", None)):
        raise DecisionPlanError("registry must expose get_model(model_id)")
    requested_route = _coerce_route(route, privacy_consent)
    consent = _require_bool(privacy_consent, "privacy_consent")
    ceiling = min(_require_count(max_subagents, "max_subagents"), MAX_PARALLEL_WORKERS)
    budget = _require_budget(cost_budget_usd)
    tools_allowed = _require_names(available_tools, "available_tools")
    skills_allowed = _require_names(available_skills, "available_skills")
    approvals_granted = _require_names(approved_tools, "approved_tools")
    grades_allowed = tuple(g for g in REASONING_GRADE_ORDER if g in _require_names(available_grades, "available_grades"))

    violations: List[Dict[str, Any]] = []
    clamps: List[str] = []
    approvals_required: List[str] = []
    # 경로 ∩ 동의: 동의가 없으면 이 계획이 쓸 수 있는 경로는 LOCAL_ONLY 뿐이다.
    connection_route = _connection_route(requested_route, consent)

    # 차단(blocked) 계획은 실행 레코드가 아니다: 다른 판정보다 먼저 사유를 그대로 올려 거부한다.
    if plan.blocked:
        violations.append({
            "check": "V-03",
            "error": "plan is blocked: " + "; ".join(plan.block_reasons or ["no_executable_model"]),
        })
        return _reject(plan, violations, clamps)

    # V-01 schema / 타입 / 열거
    schema_error = _schema_violation(plan)
    if schema_error is not None:
        violations.append(schema_error)
        return _reject(plan, violations, clamps)

    # 백그라운드 전담 역할은 포그라운드 계획의 배정 대상이 아니다(자동 선택도 마찬가지).
    if plan.model_role in BACKGROUND_ROLE_NAMES:
        violations.append({
            "check": "V-03",
            "error": f"role {plan.model_role!r} is reserved for the background track; "
                     f"use build_background_plan()/select_background_model()",
        })
        return _reject(plan, violations, clamps)

    # V-02/V-03 모델 해석 (auto/gateway_deferred → 경로∩동의 안의 실행 후보) + 역할/적재 게이트
    gate = _ModelGateContext(
        route=connection_route, cloud_consent=consent, tier_info=None, machine=machine
    )
    entry: Optional[ModelIntelligenceEntry] = None
    effective_model_selection = CALLER_SELECTION
    if plan.model_id == AUTO_MODEL_ID:
        entry = _auto_model_entry(registry, plan.model_role, gate)
        if entry is None:
            violations.append({
                "check": "V-03",
                "error": f"automatic model selection found no executable model on route {connection_route.value}",
            })
            return _reject(plan, violations, clamps)
        effective_model_id = entry.model_id
        effective_model_selection = GATEWAY_SELECTION
        clamps.append("model:auto_resolved")
    elif plan.model_id == DEFERRED_MODEL_ID:
        # 문서화된 지연 상태: 플래너가 모델을 모르므로 게이트웨이가 정한다. 다만 이 경로에서
        # 게이트웨이가 만족할 수 있는 후보가 실제로 있어야 한다 — 없으면 지연은 은폐된 실패다.
        entry = _auto_model_entry(registry, plan.model_role, gate)
        if entry is None:
            violations.append({
                "check": "V-03",
                "error": f"deferred model selection cannot be satisfied on route "
                         f"{connection_route.value}: no executable candidate",
            })
            return _reject(plan, violations, clamps)
        effective_model_id = DEFERRED_MODEL_ID
        effective_model_selection = GATEWAY_SELECTION
        clamps.append("model:deferred_to_gateway")
    else:
        entry = _lookup_entry(registry, plan.model_id)
        if entry is None:
            violations.append({"check": "V-03", "error": f"Model {plan.model_id} not in catalog"})
            return _reject(plan, violations, clamps)
        effective_model_id = entry.model_id

    if not _role_eligible(entry, plan.model_role):
        violations.append({
            "check": "V-03",
            "error": f"Model {entry.model_id} cannot serve foreground role {plan.model_role!r}",
        })
        return _reject(plan, violations, clamps)
    if not _route_allows(entry, connection_route, consent):
        violations.append({
            "check": "V-02",
            "error": f"Model {entry.model_id} violates privacy/local_only consent constraints",
        })
        return _reject(plan, violations, clamps)
    if machine is not None and entry.provider == "local":
        fit_reason = _local_fit_reason(registry, entry, machine)
        if fit_reason:
            violations.append({
                "check": "V-03",
                "error": f"Model {entry.model_id} cannot be loaded on this machine: {fit_reason}",
            })
            return _reject(plan, violations, clamps)

    # V-04 등급: 요청 ∩ 모델 지원 등급. 올리지 않고 가장 가까운 낮은 등급으로 자른다.
    # ``AUTO_REASONING_GRADE`` 는 호출자의 명시 선택이 아니라 게이트웨이 위임이므로
    # 플래너 권고 등급과 상한(MAX_AUTO_REASONING_GRADE)으로 먼저 해석한다.
    supported = [g for g in grades_allowed if g in set(_model_supported_grades(entry))]
    requested_grade = plan.reasoning_grade
    effective_grade_selection = CALLER_SELECTION
    if requested_grade == AUTO_REASONING_GRADE:
        effective_grade_selection = GATEWAY_SELECTION
        recommended = plan.reasoning_grade_recommended
        if not isinstance(recommended, str) or recommended not in REASONING_GRADE_ORDER:
            recommended = "off"
            clamps.append("grade:recommendation_missing")
        ceiling_index = REASONING_GRADE_ORDER.index(MAX_AUTO_REASONING_GRADE)
        if REASONING_GRADE_ORDER.index(recommended) > ceiling_index:
            clamps.append(f"grade:auto_ceiling_{recommended}_to_{MAX_AUTO_REASONING_GRADE}")
            recommended = MAX_AUTO_REASONING_GRADE
        requested_grade = recommended
        clamps.append(f"grade:auto_from_recommendation_{recommended}")
    effective_grade, grade_note = _clamp_grade(requested_grade, supported)
    if grade_note:
        clamps.append(grade_note)

    # V-05 컨텍스트 예산
    window = _context_bound(entry, MAX_CONTEXT_BUDGET_TOKENS)
    raw_budget = plan.context_budget_tokens
    if not _is_strict_int(raw_budget):
        raise DecisionPlanError(
            f"context_budget_tokens must be an int, got {type(raw_budget).__name__}"
        )
    if raw_budget < 0:
        violations.append({"check": "V-05", "error": f"context_budget_tokens must be >= 0, got {raw_budget}"})
        return _reject(plan, violations, clamps)
    if raw_budget > MAX_CONTEXT_BUDGET_TOKENS:
        violations.append({
            "check": "V-05",
            "error": f"context_budget_tokens {raw_budget} exceeds the release cap {MAX_CONTEXT_BUDGET_TOKENS}",
        })
        return _reject(plan, violations, clamps)
    if raw_budget == 0:
        effective_context = window
        clamps.append("context:auto_resolved")
    elif raw_budget > window:
        effective_context = window
        clamps.append(f"context:clamped_{raw_budget}_to_{window}")
    else:
        effective_context = raw_budget

    # V-06 서브에이전트: 엄격한 int(불리언 금지) + 역할 열거 + 누적 상한(음수 우회 금지)
    effective_subagents: List[SubagentSlot] = []
    running_count = 0
    for slot in plan.subagents:
        if not isinstance(slot, SubagentSlot):
            violations.append({"check": "V-06", "error": f"subagent slot must be SubagentSlot, got {type(slot).__name__}"})
            return _reject(plan, violations, clamps)
        if not isinstance(slot.role, str):
            violations.append({"check": "V-06", "error": f"subagent role must be a string, got {type(slot.role).__name__}"})
            return _reject(plan, violations, clamps)
        if not _is_strict_int(slot.count):
            violations.append({"check": "V-06", "error": f"subagent count must be an int, got {slot.count!r}"})
            return _reject(plan, violations, clamps)
        if slot.count < 0:
            violations.append({"check": "V-06", "error": f"subagent count must be >= 0, got {slot.count}"})
            return _reject(plan, violations, clamps)
        if not _subagent_role_allowed(slot.role, VALID_ROLES):
            clamps.append(f"subagents:role_rejected_{slot.role}")
            continue
        if slot.count == 0:
            clamps.append(f"subagents:dropped_{slot.role}")
            continue
        if running_count >= ceiling:
            clamps.append(f"subagents:dropped_{slot.role}")
            continue
        count = min(slot.count, ceiling - running_count)
        if count < slot.count:
            clamps.append(f"subagents:clamped_{slot.role}_{slot.count}_to_{count}")
        effective_subagents.append(SubagentSlot(role=slot.role, count=count, purpose=slot.purpose))
        running_count += count
    if running_count > MAX_PARALLEL_WORKERS:
        violations.append({"check": "V-06", "error": f"subagent total {running_count} exceeds {MAX_PARALLEL_WORKERS}"})
        return _reject(plan, violations, clamps)

    # V-07 비용: 유료 모델은 단가가 알려져 있어야 하고, 예산이 있으면 그 안에 들어야 한다.
    # 자동/지연 선택도 **실제로 서빙할 모델**(entry)로 같은 산술을 적용한다.
    if entry.provider != "local":
        if _pricing_unknown(entry):
            violations.append({
                "check": "V-07",
                "error": f"Model {entry.model_id} has unknown pricing; paid models require known unit costs",
            })
            return _reject(plan, violations, clamps)
        estimate = _attempt_cost(entry, DEFAULT_INPUT_TOKENS, DEFAULT_OUTPUT_TOKENS)
        if estimate is None:
            violations.append({
                "check": "V-07",
                "error": f"Model {entry.model_id} cost could not be computed; refusing an unpriced run",
            })
            return _reject(plan, violations, clamps)
        if budget is not None:
            if budget <= 0:
                violations.append({
                    "check": "V-07",
                    "error": f"cost_budget_usd {budget} is exhausted; paid model {entry.model_id} cannot run",
                })
                return _reject(plan, violations, clamps)
            if estimate > budget:
                violations.append({
                    "check": "V-07",
                    "error": f"estimated cost {estimate:.8f} USD exceeds remaining budget {budget:.8f} USD",
                })
                return _reject(plan, violations, clamps)

    # V-08 도구: 넓히기 거부 + L3는 승인 전까지 실행 집합에서 제외
    effective_tools: List[str] = []
    for tool in plan.tools:
        if not isinstance(tool, str):
            raise DecisionPlanError(f"tool names must be strings, got {type(tool).__name__}")
        if tool not in tools_allowed:
            clamps.append(f"tools:widen_rejected_{tool}")
            continue
        if _requires_approval(tool):
            if tool not in approvals_granted:
                approvals_required.append(tool)
                clamps.append(f"tools:pending_approval_{tool}")
                continue
        if tool not in effective_tools:
            effective_tools.append(tool)

    # V-09 스킬: 세션이 보고한 목록의 부분집합만 남긴다.
    effective_skills: List[str] = []
    for skill in plan.skills:
        if not isinstance(skill, str):
            raise DecisionPlanError(f"skill names must be strings, got {type(skill).__name__}")
        if skill not in skills_allowed:
            clamps.append(f"skills:dropped_unknown_{skill}")
            continue
        if skill not in effective_skills:
            effective_skills.append(skill)

    recommended_grade = plan.reasoning_grade_recommended
    grade_delta: Optional[str] = None
    if isinstance(recommended_grade, str) and recommended_grade in REASONING_GRADE_ORDER:
        if recommended_grade != effective_grade:
            grade_delta = f"recommended={recommended_grade};effective={effective_grade}"

    return ValidatedTurnPlan(
        plan=plan,
        accepted=True,
        violations=violations,
        clamps=clamps,
        approvals_required=approvals_required,
        effective_model_id=effective_model_id,
        effective_reasoning_grade=effective_grade,
        effective_subagents=effective_subagents,
        effective_tools=effective_tools,
        effective_skills=effective_skills,
        effective_context_budget_tokens=effective_context,
        effective_route=requested_route.value,
        effective_model_selection=effective_model_selection,
        effective_grade_selection=effective_grade_selection,
        grade_recommendation_delta=grade_delta,
    )


def _require_count(value: Any, name: str) -> int:
    """상한/개수 인자 계약: 불리언이 아닌 0 이상의 정수."""
    if not _is_strict_int(value) or value < 0:
        raise DecisionPlanError(f"{name} must be a non-negative int, got {value!r}")
    return int(value)


def _require_names(values: Any, name: str) -> Tuple[str, ...]:
    """이름 목록 인자 계약: 문자열의 반복 가능 값."""
    if isinstance(values, str) or not isinstance(values, (list, tuple, set, frozenset)):
        raise DecisionPlanError(f"{name} must be a sequence of strings, got {type(values).__name__}")
    for item in values:
        if not isinstance(item, str):
            raise DecisionPlanError(f"{name} must contain strings, got {type(item).__name__}")
    return tuple(values)


def _schema_violation(plan: TurnPlan) -> Optional[Dict[str, Any]]:
    """V-01: 스키마 버전 · 타입 · 열거 검사. 위반이면 violation 딕셔너리."""
    if plan.turn_plan_schema != TURN_PLAN_SCHEMA:
        return {"check": "V-01", "error": f"Invalid schema: {plan.turn_plan_schema}"}
    if not isinstance(plan.origin, str) or plan.origin not in VALID_PLAN_ORIGINS:
        return {"check": "V-01", "error": f"Invalid origin: {plan.origin!r}"}
    if not isinstance(plan.context_history, str) or plan.context_history not in VALID_CONTEXT_HISTORY:
        return {"check": "V-01", "error": f"Invalid context_history: {plan.context_history!r}"}
    if not isinstance(plan.expected_cost_class, str) or plan.expected_cost_class not in VALID_COST_CLASSES:
        return {"check": "V-01", "error": f"Invalid expected_cost_class: {plan.expected_cost_class!r}"}
    if not isinstance(plan.model_role, str) or plan.model_role not in VALID_ROLES:
        return {"check": "V-01", "error": f"Invalid model_role: {plan.model_role!r}"}
    if not isinstance(plan.model_id, str) or not plan.model_id:
        return {"check": "V-01", "error": f"Invalid model_id: {plan.model_id!r}"}
    # ``reasoning_grade`` 는 열거 밖 값이면 V-01 거부가 아니라 V-04 clamp(→off)다(기존 계약).
    # 단, 타입이 문자열이 아니거나 새 필드가 깨진 경우는 스키마 위반이다.
    if not isinstance(plan.reasoning_grade, str):
        return {"check": "V-01", "error": f"Invalid reasoning_grade: {plan.reasoning_grade!r}"}
    if not isinstance(plan.reasoning_grade_recommended, str) \
            or plan.reasoning_grade_recommended not in REASONING_GRADE_ORDER:
        return {
            "check": "V-01",
            "error": f"Invalid reasoning_grade_recommended: {plan.reasoning_grade_recommended!r}",
        }
    if not isinstance(plan.reasoning_grade_factors, dict):
        return {"check": "V-01", "error": "reasoning_grade_factors must be a dict"}
    if not isinstance(plan.subagents, list):
        return {"check": "V-01", "error": "subagents must be a list"}
    if not isinstance(plan.tools, list):
        return {"check": "V-01", "error": "tools must be a list"}
    if not isinstance(plan.skills, list):
        return {"check": "V-01", "error": "skills must be a list"}
    return None


def _auto_model_entry(
    registry: ModelIntelligenceRegistry,
    role: str,
    gate: "_ModelGateContext",
) -> Optional[ModelIntelligenceEntry]:
    """자동 모델 선택의 결정론적 해석: 게이트를 통과하는 첫 카탈로그 항목.

    ``select_model`` 을 먼저 시도하고(역할순 ECPS), 실패하면 같은 게이트로 카탈로그를
    정렬 순회한다. 후보는 카탈로그 실재 + 포그라운드 역할 + (경로 ∩ 동의) + 하드웨어
    준비도를 모두 통과해야 하며, 통과 항목이 없으면 ``None``(호출자가 V-03으로 거부)이다.
    """
    def acceptable(candidate: ModelIntelligenceEntry) -> bool:
        if not _role_eligible(candidate, role):
            return False
        if not _route_allows(candidate, gate.route, gate.cloud_consent):
            return False
        return not _local_fit_reason(registry, candidate, gate.machine)

    if role in VALID_ROLES and role not in BACKGROUND_ROLE_NAMES:
        try:
            candidate = registry.select_model(role, mode="balanced", privacy_consent=gate.cloud_consent,
                                              route=gate.route.value)
        except (RuntimeError, ValueError, KeyError):
            candidate = None
        if candidate is not None and acceptable(candidate):
            return candidate
    try:
        catalogue = list(registry.catalog)
    except (AttributeError, TypeError):
        return None
    for entry in sorted(catalogue, key=lambda item: item.model_id):
        if acceptable(entry):
            return entry
    return None


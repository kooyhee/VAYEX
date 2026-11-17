"""DeepSeek Harness 엔진 패키지 (단일 배포 앱 + 내장 OpenCodex 게이트웨이).

DeepSeek Harness는 OpenCodex 모델 게이트웨이를 앱 내부에 직접 내장(embedded)한 하나의
배포물(데스크톱/CLI)로 제공된다. 모델 카탈로그는 런타임에 외부 목록을 스크래핑/분류하는
동적 서버가 아니라, 개발자가 검증해 앱 업데이트에 동봉하는 큐레이션 프리셋
(``CURATED_APP_RELEASE_VERSION``)이며 기본 모델은
``deepseek/deepseek-v4.1-flash-1017``이다.

구성:
- ``registry``: 큐레이션 내장 프리셋 레지스트리 + ECPS 라우팅 + 프라이버시 필터
- ``decision_planner``: 2-Track 결정론적 실행 플래너 (direct_execute / survey_and_plan)
- ``dag_orchestrator``: 앱 내장 결정론적 DAG 실행기 (재시도/승격/롤백)
- ``fts5_memory``: SQLite FTS5 기반 하이브리드 컨텍스트 메모리
- ``lm_client``: OpenAI 호환 스트리밍 클라이언트 (사용량 기반 비용)
- ``runner`` / ``file_tools``: 모델 편집 실행 + 경로 격리/해시 검증/원자적 쓰기
"""
from .hardware_profiler import (
    HardwareSpec,
    detect_hardware,
    determine_local_tier,
    LocalExecutionTier,
    LocalExecutionTierInfo,
    clear_hardware_cache,
    parse_tier,
)
from .registry import (
    ModelIntelligenceRegistry,
    ModelIntelligenceEntry,
    PricingInfo,
    PrivacyPolicy,
    BetaSuccessTracker,
    escalation_role,
    CURATED_APP_RELEASE_VERSION,
    EMBEDDED_GATEWAY_MODE,
    PRIMARY_MODEL_ID,
    UPDATE_POLICY,
    BACKGROUND_MODEL_ID,
    VALID_ROLES,
)
from .decision_planner import (
    IntelligencePlanner,
    ExecutionDAGPlan,
    DAGNode,
    SymbolSlice,
    estimate_tokens,
)
from .dag_orchestrator import (
    DeterministicDAGOrchestrator,
    FileIsolationWorkspace,
    BudgetExhaustedError,
    AttemptOutcome,
)
from .fts5_memory import (
    HybridContextMemoryEngine,
    sanitize_fts5_query,
    BONSAI_BACKGROUND_MODEL_ID,
)
from .decision_planner import ExecutionRoute
from .lm_client import (
    LmClient, Usage, ProviderNotConfiguredError, AuthError, RateLimitError,
    ProviderUnavailable, BadRequest,
)
from .runner import NodeRunner
from .file_tools import resolve_within, apply_edits, HashMismatchError, PathContainmentError

__all__ = [
    "ExecutionRoute", "LmClient", "Usage", "NodeRunner", "ProviderNotConfiguredError",
    "AuthError", "RateLimitError", "ProviderUnavailable", "BadRequest",
    "resolve_within", "apply_edits", "HashMismatchError", "PathContainmentError",
    "HardwareSpec",
    "detect_hardware",
    "determine_local_tier",
    "LocalExecutionTier",
    "LocalExecutionTierInfo",
    "clear_hardware_cache",
    "parse_tier",
    "ModelIntelligenceRegistry",
    "ModelIntelligenceEntry",
    "PricingInfo",
    "PrivacyPolicy",
    "BetaSuccessTracker",
    "escalation_role",
    "CURATED_APP_RELEASE_VERSION",
    "EMBEDDED_GATEWAY_MODE",
    "PRIMARY_MODEL_ID",
    "UPDATE_POLICY",
    "IntelligencePlanner",
    "ExecutionDAGPlan",
    "DAGNode",
    "SymbolSlice",
    "estimate_tokens",
    "DeterministicDAGOrchestrator",
    "FileIsolationWorkspace",
    "BudgetExhaustedError",
    "AttemptOutcome",
    "HybridContextMemoryEngine",
    "sanitize_fts5_query",
]

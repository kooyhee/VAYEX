"""큐레이션 내장 프리셋 레지스트리 (Curated Built-in Preset Registry).

DeepSeek Harness는 OpenCodex 모델 게이트웨이를 내부에 직접 내장(embedded)한 단일 배포
데스크톱/CLI 애플리케이션이다. 따라서 이 모듈은 외부 모델 목록을 실시간으로 스크래핑/분류하는
서버가 아니라, 개발자가 검증해 앱 릴리스에 동봉한 프리셋 카탈로그
(``CURATED_APP_RELEASE_VERSION``)를 그대로 사용하는 내장 레지스트리다. 프리셋 갱신은
런타임 네트워크 호출이 아니라 정기 애플리케이션 업데이트
(``UPDATE_POLICY = "periodic_developer_release"``)로만 이루어진다.

기본(primary) 프리셋은 ``deepseek/deepseek-v4.1-flash-1017``이며, 실패 복구 시
승격(escalation) 폴백은 ``anthropic/claude-sonnet-4.5`` 같은 상위 프리셋을 사용한다.
카탈로그의 모델 ID와 단가(USD/1M tokens)는 릴리스 시점에 검증해 동봉한 값이고,
Intelligence Index도 같은 시점에 고정된 시드 값이다(런타임 재수집 없음).

역할별 라우팅은 다음 ECPS(Expected Cost per Success)를 최소화한다::

    c    = (T_in*(1-r)*P_in + T_in*r*P_cache + T_out*P_out) / 1e6
    p    = Beta-Bernoulli 사후 성공확률 (모델 x 역할)
    ECPS = c/p + lambda * c * (1-p)/p

``c/p``는 성공까지 필요한 기하분포 기대 시도 횟수(1/p)를 반영한 성공 1건당 기대
지출이고, ``lambda * c * (1-p)/p``는 버려진 시도(폐기 토큰, 재검증, 롤백)의 상대
비용 패널티다. 캐시 적중률 ``r``이 높을수록 ``P_cache``(<``P_in``) 가중치가 커져
ECPS가 감소한다.
"""
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

from .hardware_profiler import (
    HardwareSpec,
    LocalExecutionTier,
    LocalExecutionTierInfo,
    detect_hardware,
    determine_local_tier,
    parse_tier,
    probe_runtime,
)
from .vram_budget import (
    Accelerator,
    BONSAI_RUNTIME_BUFFER_BYTES,
    DEFAULT_OS_RESERVED_BYTES,
    GIB,
    MachineProfile,
    ModelRequirement,
    P_RUNTIME_OVERHEAD_BYTES,
    RUNTIME_PRISM_FORK,
    RUNTIME_STOCK,
    STOCK_MIN_BUILD_Q2_0,
    SelectionDecision,
    SIZE_CLASS_ORDER,
    Unavailable,
    select,
)

VALID_ROLES = {
    "main", "planner", "worker", "heavy_worker",
    "frontend_worker", "backend_worker", "reviewer",
    "security_reviewer", "researcher", "light_worker", "vision_worker",
    # 백그라운드 인지 작업 전용 역할 (Tier 3 로컬 Bonsai-2 27B 전담)
    "background_worker", "memory_distiller", "compactor",
    # 소형 로컬 보조 모델(aux) 전담 역할: 세션 제목/질의 재작성/증류/압축/임베딩
    "session_titler", "query_rewriter", "embedding",
}

#: aux 선택기가 후보로 받아들이는 승인 역할 전체(생성 aux + 임베딩).
#: 이 역할들은 클라우드 라우팅(``select_model``)으로 해석되지 않는다.
AUX_APPROVED_ROLE_NAMES = frozenset(
    {"session_titler", "query_rewriter", "memory_distiller", "compactor", "embedding"}
)

# 승격(escalation) 단계에서 사용할 상위 역할 매핑: 저계층 역할 -> 상위 역할
ESCALATION_ROLE_MAP: Dict[str, str] = {
    "light_worker": "worker",
    "worker": "heavy_worker",
    "backend_worker": "heavy_worker",
    "frontend_worker": "heavy_worker",
    "researcher": "heavy_worker",
    "reviewer": "security_reviewer",
    "security_reviewer": "heavy_worker",
    "planner": "heavy_worker",
    "vision_worker": "heavy_worker",
    "heavy_worker": "heavy_worker",
    "main": "heavy_worker",
    # 백그라운드 작업은 Bonsai 전담이다: 승격도 같은 백그라운드 역할 안에 머물러
    # 클라우드/Qwen 으로 조용히 대체되지 않는다(불가는 BackgroundModelUnavailableError).
    "background_worker": "background_worker",
    "memory_distiller": "memory_distiller",
    "compactor": "compactor",
    # aux/임베딩 작업도 같은 규칙이다: 제목/질의 재작성이 클라우드로 승격되지 않는다.
    "session_titler": "session_titler",
    "query_rewriter": "query_rewriter",
    "embedding": "embedding",
}

#: 백그라운드 인지 작업(세션 압축/제목 생성/메모리 증류/트리아지)의 전담 로컬 모델.
#: 역할 규칙(R-BG2-01)으로 대체되었으며, 이 상수는 레거시 진단용 이름일 뿐 선택 근거가
#: 아니다. 선택은 ``select_background_model()``이 카탈로그의 ``bg_approved`` 항목 중에서
#: 예산·런타임·상주 산술로 결정한다(R-BG2-03). 승인 목록에는 27B 세 양자화 외에 9B/4B/2B와
#: Qwen 7B도 있으므로, Tier 3 16 GB 예산에서 산술로 뽑히는 기본 승자가 이 PQ2_0 프리셋이다.
#: 후보가 하나뿐이라는 뜻이 아니며, 이 이름을 요구 조건으로 쓰지 않는다.
BACKGROUND_MODEL_ID = "local/bonsai-2-27b-pq2"
#: 기본 백그라운드 작업 유형
DEFAULT_BACKGROUND_TASK_TYPE = "compaction"

#: 백그라운드 모델 배정 상태 값(ready = 사용 가능, unavailable = 명시적 불가)
BACKGROUND_STATUS_READY = "ready"
BACKGROUND_STATUS_UNAVAILABLE = "unavailable"

#: 역할 규칙의 **필요조건**(충분조건 아님). 실제 판정은 ``vram_budget.select()``의
#: 적재 산술이 한다.
BACKGROUND_REQUIRED_TIER = LocalExecutionTier.ADVANCED_LOCAL
#: 위 티어 판정에 쓰이는 하드웨어 하한(사유 문구/문서용 상수: RAM >= 32GB, VRAM >= 12GB)
BACKGROUND_MIN_RAM_GB = 32.0
BACKGROUND_MIN_VRAM_GB = 12.0

#: 백그라운드 역할을 맡을 수 있는 후보를 고르는 순서(설계문서 §2.3 5단계).
BACKGROUND_SELECTION_ORDER = "resident_first_then_size_class_desc_then_model_id_asc"

#: Bonsai 로컬 엔드포인트를 지정하는 환경변수 이름(런처/설정과 공유하는 이름일 뿐,
#: 이 모듈은 어떤 HTTP 호출도 하지 않는다)
BACKGROUND_ENDPOINT_ENV = "HARNESS_LOCAL_BASE_URL"

#: 소형 로컬 aux 작업 유형 별칭 -> 정규 작업 유형. 호출자는 역할 이름을 몰라도 된다.
AUX_TASK_ALIASES: Dict[str, str] = {
    "titling": "title",
    "session_title": "title",
    "title_generation": "title",
    "generate_title": "title",
    "branch_name": "title",
    "rewrite": "query_rewrite",
    "query_rewriting": "query_rewrite",
    "query_rewriter": "query_rewrite",
    "search_rewrite": "query_rewrite",
    "memory_distillation": "distillation",
    "distill": "distillation",
    "context_compaction": "compaction",
    "session_compaction": "compaction",
    "history_compaction": "compaction",
    "embed": "embedding",
    "embeddings": "embedding",
}

#: 정규 aux 작업 유형 -> 레지스트리 역할. 임베딩은 생성 작업과 분리된 역할이다.
AUX_TASK_ROLES: Dict[str, str] = {
    "title": "session_titler",
    "query_rewrite": "query_rewriter",
    "distillation": "memory_distiller",
    "compaction": "compactor",
    "embedding": "embedding",
}

#: aux 모델 배정 상태 값(백그라운드와 같은 문자열 계약)
AUX_STATUS_READY = "ready"
AUX_STATUS_UNAVAILABLE = "unavailable"

#: aux 역할의 **필요조건**(충분조건 아님). 실제 판정은 ``vram_budget.select()``의
#: 적재 산술이 한다. 소형 모델은 경량 로컬 하드웨어에서도 의미가 있다.
AUX_REQUIRED_TIER = LocalExecutionTier.LIGHTWEIGHT_LOCAL
#: 위 티어 판정에 쓰이는 하드웨어 하한(사유 문구/문서용 상수):
#: RAM >= 8GB **또는** VRAM >= 2GB. 이는 정책 하한이며 후보의 적재 보장이 아니다.
#: 실제 파일/헤더가 확인된 요구량과 측정 예산의 적재 산술만 실행 가능성을 결정한다.
AUX_MIN_RAM_GB = 8.0
AUX_MIN_VRAM_GB = 2.0

#: aux 후보 정렬: 상주 가능 후보를 먼저, 그 안에서 작은 size_class, 그다음 model_id.
#: 작은 모델을 우선하는 것이 aux 평면의 목적(저VRAM/저비용)에 맞는다.
AUX_SELECTION_ORDER = "resident_first_then_size_class_asc_then_model_id_asc"


class BackgroundModelUnavailableError(RuntimeError):
    """백그라운드 인지 작업의 유일 허용 모델(Bonsai)을 실행할 수 없을 때 발생한다."""


class AuxModelUnavailableError(BackgroundModelUnavailableError):
    """aux/임베딩 작업에 실행 가능한 로컬 후보가 없을 때 발생한다.

    ``BackgroundModelUnavailableError``의 하위 타입이므로, 로컬 대체 금지를 이미
    처리하는 호출자는 같은 예외 처리로 aux 불가를 받는다.
    """


#: 백그라운드 작업 유형 별칭 -> 정규(canonical) 작업 유형
BACKGROUND_TASK_ALIASES: Dict[str, str] = {
    "context_compaction": "compaction",
    "session_compaction": "compaction",
    "history_compaction": "compaction",
    "title_generation": "title",
    "branch_name": "title",
    "memory_distillation": "distillation",
    "distill": "distillation",
    "indexing": "memory_indexing",
    "rerank": "rerank",
    "reranking": "rerank",
    "task_triage": "triage",
    "loop_diagnostics": "loop_guard",
    "loop_guard_diagnostics": "loop_guard",
}

#: 정규 백그라운드 작업 유형 -> 레지스트리 역할 매핑
BACKGROUND_TASK_ROLES: Dict[str, str] = {
    "compaction": "compactor",
    "title": "background_worker",
    "commit_message": "background_worker",
    "memory_indexing": "memory_distiller",
    "rerank": "memory_distiller",
    "distillation": "memory_distiller",
    "triage": "background_worker",
    "loop_guard": "background_worker",
    "diagnostics": "background_worker",
}

#: 백그라운드 인지 작업 전용 역할(클라우드/Qwen 대체 배정 금지 대상)
BACKGROUND_ROLES = frozenset(BACKGROUND_TASK_ROLES.values())

DEFAULT_INPUT_TOKENS = 2000
DEFAULT_OUTPUT_TOKENS = 600
DEFAULT_RETRY_PENALTY_FACTOR = 0.5
PRIOR_STRENGTH = 8.0
OPTIMIZATION_MODES = ("quality", "balanced", "cost", "speed")

# ---------------------------------------------------------------------------
# 단일 배포 앱(DeepSeek Harness) 번들 메타데이터
# ---------------------------------------------------------------------------
#: 앱 릴리스에 동봉되는 큐레이션 프리셋 카탈로그의 버전
CURATED_APP_RELEASE_VERSION = "2026.11.1"
#: OpenCodex 게이트웨이가 앱 내부에 내장되었음을 나타내는 모드(외부 모델 라우터 미사용)
EMBEDDED_GATEWAY_MODE = "embedded_opencodex_gateway"
#: 모든 실행 트랙의 기본(primary) 모델
PRIMARY_MODEL_ID = "deepseek/deepseek-v4.1-flash-1017"
#: 프리셋 갱신 정책: 런타임 스크래핑 없이 정기 개발자 릴리스로만 갱신
UPDATE_POLICY = "periodic_developer_release"


def escalation_role(role: str) -> str:
    """저계층 역할을 승격 대상 상위 역할로 변환한다."""
    return ESCALATION_ROLE_MAP.get(role, "heavy_worker")


@dataclass
class PricingInfo:
    input_per_million: float = 0.0
    output_per_million: float = 0.0
    cache_read_per_million: float = 0.0

    def __init__(
        self,
        input_per_million: float = 0.0,
        output_per_million: float = 0.0,
        cache_read_per_million: float = 0.0,
        *,
        input_cost_per_m: Optional[float] = None,
        output_cost_per_m: Optional[float] = None,
        cached_input_cost_per_m: Optional[float] = None,
    ):
        if input_cost_per_m is not None:
            input_per_million = input_cost_per_m
        if output_cost_per_m is not None:
            output_per_million = output_cost_per_m
        if cached_input_cost_per_m is not None:
            cache_read_per_million = cached_input_cost_per_m
        self.input_per_million = float(input_per_million)
        self.output_per_million = float(output_per_million)
        self.cache_read_per_million = float(cache_read_per_million)

    @property
    def input_cost_per_m(self) -> float:
        return self.input_per_million

    @property
    def output_cost_per_m(self) -> float:
        return self.output_per_million

    @property
    def cached_input_cost_per_m(self) -> float:
        return self.cache_read_per_million

    def attempt_cost_usd(
        self,
        input_tokens: int,
        output_tokens: int,
        cache_hit_ratio: float = 0.0,
    ) -> float:
        """단일 시도의 토큰 비용. 캐시 적중 토큰은 cache_read 단가로 과금한다."""
        ratio = min(1.0, max(0.0, float(cache_hit_ratio)))
        cached_tokens = max(0, int(input_tokens)) * ratio
        uncached_tokens = max(0, int(input_tokens)) - cached_tokens
        cache_rate = (
            self.cache_read_per_million
            if self.cache_read_per_million > 0
            else self.input_per_million
        )
        cost = (
            uncached_tokens * self.input_per_million
            + cached_tokens * cache_rate
            + max(0, int(output_tokens)) * self.output_per_million
        )
        return cost / 1_000_000.0


@dataclass
class PrivacyPolicy:
    zero_data_retention: bool
    training_opt_out: bool


@dataclass
class BetaSuccessTracker:
    """역할 x 모델 단위 Beta-Bernoulli 성공률 추적기.

    Prior: ``Beta(p0*s, (1-p0)*s)``. 사후 평균 ``alpha/(alpha+beta)``가 ECPS의
    성공확률 ``p``로 사용된다.
    """
    alpha: float = 1.0
    beta: float = 1.0
    prior_strength: float = 0.0

    @classmethod
    def from_prior(cls, success_rate: float, strength: float = PRIOR_STRENGTH) -> "BetaSuccessTracker":
        p = min(1.0 - 1e-9, max(1e-9, float(success_rate)))
        return cls(alpha=p * strength, beta=(1.0 - p) * strength, prior_strength=float(strength))

    def record(self, success: bool) -> float:
        if success:
            self.alpha += 1.0
        else:
            self.beta += 1.0
        return self.mean

    @property
    def mean(self) -> float:
        return self.alpha / (self.alpha + self.beta)

    @property
    def variance(self) -> float:
        total = self.alpha + self.beta
        return (self.alpha * self.beta) / (total * total * (total + 1.0))

    @property
    def observations(self) -> float:
        return max(0.0, (self.alpha + self.beta) - self.prior_strength)


@dataclass
class ModelIntelligenceEntry:
    model_id: str
    display_name: str
    provider: str
    #: 0.0은 "공개된 벤치마크 없음"이지 "품질 0"이 아니다. 수치를 만들어 넣지 않기
    #: 위해 미공개 모델은 0.0으로 두고 ``benchmark_note``에 그 사실을 적는다.
    intelligence_index: float
    context_window: int
    roles: List[str]
    pricing: PricingInfo
    privacy: PrivacyPolicy
    success_rate: float = 0.90
    average_latency_ms: int = 1000
    # --- 로컬 적재 요구량 (선택기 입력). 원격 모델은 전부 None/false ---
    #: 실제 배포 파일의 크기. ``None``은 "미확인"이며 추정하지 않는다.
    weights_bytes: Optional[int] = None
    #: 컨텍스트 1토큰당 KV 캐시 바이트(아키텍처에서 계산, 2*K+V 가 이미 반영됨).
    kv_bytes_per_token: Optional[int] = None
    #: 포그라운드/백그라운드 최소 컨텍스트.
    min_context: int = 0
    size_class: str = "small"
    #: 백그라운드 역할을 맡을 수 있다고 릴리스가 고정한 승인 목록 표시.
    bg_approved: bool = False
    license: Optional[str] = None
    quant_label: Optional[str] = None
    #: 양자화가 요구하는 런타임 종류/최소 빌드. 원격 모델은 의미 없음.
    runtime_kind: str = RUNTIME_STOCK
    runtime_min_build: Optional[int] = None
    #: 이 계열의 프로세스 런타임 버퍼(bytes). Bonsai 2 계열은 1.21 GiB.
    runtime_buffer_bytes: int = P_RUNTIME_OVERHEAD_BYTES
    #: 값이 실제 파일/헤더로 확인되지 않았으면 True (선택 불가).
    pending_confirmation: bool = False
    #: ``weights_bytes``의 출처. 측정/배포목록/추정을 구분한다.
    weights_basis: str = "distributor_listing"
    #: 벤치마크가 없는 모델은 그 사실을 적는다(품질 미확인을 함의하지 않는다).
    benchmark_note: Optional[str] = None

    def requirement(self) -> ModelRequirement:
        """선택기가 쓰는 요구량 레코드로 변환한다."""
        return ModelRequirement(
            model_id=self.model_id,
            weights_bytes=self.weights_bytes,
            kv_bytes_per_token=self.kv_bytes_per_token,
            min_context=self.min_context or 0,
            context_window=int(self.context_window),
            size_class=self.size_class,
            roles=tuple(self.roles),
            bg_approved=self.bg_approved and bool(set(self.roles) & set(BACKGROUND_TASK_ROLES.values())),
            aux_approved=bool(set(self.roles) & AUX_APPROVED_ROLE_NAMES),
            license=self.license,
            quant_label=self.quant_label,
            runtime_kind=self.runtime_kind,
            runtime_min_build=self.runtime_min_build,
            pending_confirmation=self.pending_confirmation,
            weights_basis=self.weights_basis,
            benchmark_note=self.benchmark_note,
            runtime_buffer_bytes=self.runtime_buffer_bytes,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "model_id": self.model_id,
            "display_name": self.display_name,
            "provider": self.provider,
            "context_window": int(self.context_window),
            "roles": list(self.roles),
            "weights_bytes": self.weights_bytes,
            "kv_bytes_per_token": self.kv_bytes_per_token,
            "min_context": self.min_context,
            "size_class": self.size_class,
            "bg_approved": self.bg_approved,
            "license": self.license,
            "quant_label": self.quant_label,
            "runtime_kind": self.runtime_kind,
            "runtime_min_build": self.runtime_min_build,
            "pending_confirmation": self.pending_confirmation,
            "weights_basis": self.weights_basis,
            "benchmark_note": self.benchmark_note,
        }


@dataclass(frozen=True)
class BackgroundModelSelection:
    """백그라운드 인지 작업 모델 배정 결과(대체 모델 없음).

    역할 규칙(R-BG2-01): 승인 목록(``bg_approved``)에 속한, 포그라운드와 다른 전담
    로컬 모델 하나를 예산·런타임·상주 산술로 고른다. 적합한 후보가 없으면
    ``status='unavailable'``과 사유를 돌려주며, Qwen/클라우드/포그라운드 모델로
    조용히 대체하지 않는다(``entry``는 ``None``).

    - ``model_id``: 선택 산술이 실제로 고른 백그라운드 후보 ID(후보가 없으면 빈 문자열).
      후보가 있다는 사실은 실행 가능을 뜻하지 않는다 — 실행 계약은 ``status``와
      ``entry``/``require_entry()``다. 런타임 부재·가중치 미확인·티어 미달·엔드포인트
      부재·적재 불가에서는 후보 이름이 진단용으로만 남고 ``entry``는 ``None``이다.
    - ``tier``: 이 배정이 사용한(호출자 지정 override 포함) 실행 티어
    - ``capability_tier``: 측정된 하드웨어가 실제로 감당 가능한 티어(진단용)
    - ``required_tier``: 역할 규칙의 필요조건 티어(충분조건 아님)
    """
    task_type: str
    role: str
    status: str
    model_id: str
    tier: str
    required_tier: str
    reason: Optional[str] = None
    reasons: Tuple[str, ...] = ()
    capability_tier: Optional[str] = None
    #: 적재 산술이 실제로 산출한 백그라운드 후보(진단용). 카탈로그 프리셋이 확인된
    #: 경우에만 채워지며, 실행 가능을 뜻하지 않는다. 후보가 없으면 ``None``.
    candidate_model_id: Optional[str] = None
    hardware: Optional[Dict[str, Any]] = None
    entry: Optional[ModelIntelligenceEntry] = None
    foreground_model_id: Optional[str] = None
    ctx_tokens: Optional[int] = None
    residency: Optional[str] = None
    co_resident: Optional[bool] = None
    budget_gib: Optional[float] = None

    @property
    def is_ready(self) -> bool:
        return self.status == BACKGROUND_STATUS_READY

    @property
    def is_unavailable(self) -> bool:
        return self.status == BACKGROUND_STATUS_UNAVAILABLE

    def require_entry(self) -> ModelIntelligenceEntry:
        """사용 가능 상태에서만 카탈로그 프리셋을 반환한다(불가는 명시적 예외)."""
        if self.entry is None:
            raise BackgroundModelUnavailableError(
                f"{self.model_id} unavailable for background task {self.task_type!r}: {self.reason}"
            )
        return self.entry

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_type": self.task_type,
            "role": self.role,
            "model_id": self.model_id,
            "candidate_model_id": self.candidate_model_id,
            "status": self.status,
            "reason": self.reason,
            "reasons": list(self.reasons),
            "tier": self.tier,
            "required_tier": self.required_tier,
            "capability_tier": self.capability_tier,
            "foreground_model_id": self.foreground_model_id,
            "ctx_tokens": self.ctx_tokens,
            "residency": self.residency,
            "co_resident": self.co_resident,
            "budget_gib": self.budget_gib,
            "hardware": dict(self.hardware) if self.hardware else None,
        }


@dataclass(frozen=True)
class AuxModelSelection:
    """소형 로컬 보조(aux)·임베딩 작업 모델 배정 결과(대체 모델 없음).

    ``BackgroundModelSelection``과 같은 준비도 계약을 쓴다:

    * ``status``는 ``"ready"``(실행 계약 성립) 또는 ``"unavailable"``(명시적 불가).
    * ``model_id``는 **실행 가능한 배정에서만** 채운다. 후보가 산출되었지만 실행할 수
      없으면 빈 문자열이고, 그 신원은 ``candidate_model_id``(진단용)에만 남는다.
    * ``entry``가 ``None``이면 ``require_entry()``가 예외를 던진다.
    * 적합한 로컬 후보가 없거나 런타임/가중치/적재가 확인되지 않으면 클라우드·포그라운드
      모델로 조용히 대체하지 않는다.

    ``detail``은 선택 산술의 근거(후보 거절 사유, 적재 산술)를 사람이 검산할 수 있는
    문자열로 담는다. 측정하지 않은 값은 만들지 않는다.
    """

    task_type: str
    role: str
    status: str
    model_id: str
    tier: str
    required_tier: str
    reason: Optional[str] = None
    detail: Optional[str] = None
    reasons: Tuple[str, ...] = ()
    capability_tier: Optional[str] = None
    #: 적재 산술이 실제로 산출한 aux 후보(진단용). 실행 가능을 뜻하지 않는다.
    candidate_model_id: Optional[str] = None
    hardware: Optional[Dict[str, Any]] = None
    entry: Optional[ModelIntelligenceEntry] = None
    foreground_model_id: Optional[str] = None
    ctx_tokens: Optional[int] = None
    residency: Optional[str] = None
    co_resident: Optional[bool] = None
    budget_gib: Optional[float] = None

    @property
    def is_ready(self) -> bool:
        return self.status == AUX_STATUS_READY

    @property
    def is_unavailable(self) -> bool:
        return self.status == AUX_STATUS_UNAVAILABLE

    def require_entry(self) -> ModelIntelligenceEntry:
        """사용 가능 상태에서만 카탈로그 프리셋을 반환한다(불가는 명시적 예외)."""
        if self.entry is None:
            raise AuxModelUnavailableError(
                f"{self.model_id or '<no candidate>'} unavailable for aux task "
                f"{self.task_type!r}: {self.reason}"
            )
        return self.entry

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_type": self.task_type,
            "role": self.role,
            "model_id": self.model_id,
            "candidate_model_id": self.candidate_model_id,
            "status": self.status,
            "reason": self.reason,
            "detail": self.detail,
            "reasons": list(self.reasons),
            "tier": self.tier,
            "required_tier": self.required_tier,
            "capability_tier": self.capability_tier,
            "foreground_model_id": self.foreground_model_id,
            "ctx_tokens": self.ctx_tokens,
            "residency": self.residency,
            "co_resident": self.co_resident,
            "budget_gib": self.budget_gib,
            "hardware": dict(self.hardware) if self.hardware else None,
        }


class ModelIntelligenceRegistry:
    """
    큐레이션 내장 프리셋 레지스트리 (Curated Built-in Preset Registry)
    - 단일 배포 앱(DeepSeek Harness + 내장 OpenCodex 게이트웨이)에 동봉된 프리셋만 사용하며,
      런타임 모델 스크래핑/분류는 수행하지 않는다(갱신은 정기 앱 릴리스로만).
    - Intelligence Index >= 40점 품질 필터 (단, light_worker 등 특수 고효율 모델 예외 허용)
    - 11대 역할별 ECPS 최소화 라우팅 및 프라이버시 정책(Zero Data Retention) 필터링
    - 역할 x 모델 Beta-Bernoulli 성공률 추적으로 라우팅을 온라인 보정
    - ``select_background_model()``: 세션 압축/제목·커밋 메시지/메모리 증류/백그라운드
      트리아지 같은 인지형 백그라운드 작업을 **역할 규칙**으로 배정한다. 승인 목록
      (``bg_approved``)에 속한, 포그라운드와 다른 전담 로컬 모델 하나를 적재 산술로
      고르며, 고정 27B 이름을 요구하지 않는다. 적합한 후보가 없으면 Qwen·클라우드
      대체 없이 ``background.status = "unavailable"`` + ``reason`` 으로 명시한다.
    - ``app_bundle_info()``: 릴리스 버전/내장 게이트웨이 모드/기본 모델/갱신 정책 노출
    """

    def __init__(
        self,
        min_intelligence_index: float = 40.0,
        prior_strength: float = PRIOR_STRENGTH,
    ):
        self.min_intelligence_index = min_intelligence_index
        self.prior_strength = prior_strength
        self._catalog: Dict[str, ModelIntelligenceEntry] = {}
        self._trackers: Dict[Tuple[str, str], BetaSuccessTracker] = {}
        self._load_default_catalog()

    @property
    def catalog(self) -> List[ModelIntelligenceEntry]:
        return [self._catalog[model_id] for model_id in sorted(self._catalog)]

    def app_bundle_info(self) -> Dict[str, str]:
        """단일 배포 앱 번들의 내장 게이트웨이 메타데이터를 반환한다.

        카탈로그는 런타임 스크래핑 결과가 아니라 앱 릴리스에 동봉된 큐레이션 프리셋이므로,
        현재 실행 중인 번들의 릴리스 버전과 갱신 정책을 그대로 노출한다.
        """
        return {
            "release_version": CURATED_APP_RELEASE_VERSION,
            "gateway_mode": EMBEDDED_GATEWAY_MODE,
            "primary_model": PRIMARY_MODEL_ID,
            "update_policy": UPDATE_POLICY,
        }

    def get_model(self, model_id: str) -> ModelIntelligenceEntry:
        return self._catalog[model_id]

    def _load_default_catalog(self) -> None:
        # 앱 릴리스에 동봉되는 정적 큐레이션 프리셋 목록(런타임 스크래핑/재분류 없음).
        # (entry, allow_special_exception): qwen coder는 40점 미만이지만 비용 효율
        # 특수 역할(light_worker 등)을 위해 예외 등록한다.
        default_models: List[Tuple[ModelIntelligenceEntry, bool]] = [
            (
                ModelIntelligenceEntry(
                    model_id="anthropic/claude-sonnet-4.5",
                    display_name="Claude Sonnet 4.5",
                    provider="openrouter",
                    intelligence_index=63.0,
                    context_window=1_000_000,
                    roles=[
                        "main", "planner", "heavy_worker", "reviewer",
                        "security_reviewer", "frontend_worker", "vision_worker",
                    ],
                    pricing=PricingInfo(3.0, 15.0, 0.30),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.96,
                    average_latency_ms=2100,
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="anthropic/claude-haiku-4.5",
                    display_name="Claude Haiku 4.5",
                    provider="openrouter",
                    intelligence_index=55.0,
                    context_window=200_000,
                    roles=["worker", "light_worker", "reviewer", "frontend_worker", "vision_worker"],
                    pricing=PricingInfo(1.0, 5.0, 0.10),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.94,
                    average_latency_ms=850,
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="deepseek/deepseek-v4.1-flash-1017",
                    display_name="DeepSeek V4.1 Flash (1017) [Primary Main]",
                    provider="openrouter",
                    intelligence_index=62.0,
                    context_window=131_072,
                    roles=[
                        "main", "planner", "worker", "backend_worker",
                        "frontend_worker", "reviewer", "researcher", "light_worker",
                    ],
                    pricing=PricingInfo(0.06, 0.12, 0.006),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.96,
                    average_latency_ms=450,
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="deepseek/deepseek-chat-v3.1",
                    display_name="DeepSeek V3.1 (No-Log)",
                    provider="openrouter",
                    intelligence_index=51.0,
                    context_window=163_840,
                    roles=[
                        "main", "planner", "heavy_worker", "worker",
                        "backend_worker", "reviewer", "researcher",
                    ],
                    pricing=PricingInfo(0.25, 0.95, 0.13),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.93,
                    average_latency_ms=1100,
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="a6api/deepseek-chat-v3.1",
                    display_name="DeepSeek V3.1 (A6API Proxy)",
                    provider="a6api",
                    intelligence_index=50.0,
                    context_window=163_840,
                    roles=["worker", "backend_worker", "reviewer", "researcher"],
                    pricing=PricingInfo(0.05, 0.10, 0.005),
                    privacy=PrivacyPolicy(zero_data_retention=False, training_opt_out=False),
                    success_rate=0.90,
                    average_latency_ms=1300,
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="google/gemini-2.5-flash",
                    display_name="Gemini 2.5 Flash",
                    provider="openrouter",
                    intelligence_index=45.0,
                    context_window=1_048_576,
                    roles=["researcher", "vision_worker", "light_worker", "frontend_worker", "worker"],
                    pricing=PricingInfo(0.30, 2.50, 0.03),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.91,
                    average_latency_ms=700,
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="openai/gpt-4.1-mini",
                    display_name="GPT-4.1 mini",
                    provider="openrouter",
                    intelligence_index=40.0,
                    context_window=1_047_576,
                    roles=["worker", "backend_worker", "reviewer", "frontend_worker"],
                    pricing=PricingInfo(0.40, 1.60, 0.10),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.90,
                    average_latency_ms=800,
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="z-ai/glm-4.5-air",
                    display_name="GLM-4.5 Air",
                    provider="openrouter",
                    intelligence_index=42.0,
                    context_window=131_072,
                    roles=["light_worker", "worker"],
                    pricing=PricingInfo(0.13, 0.85, 0.025),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.88,
                    average_latency_ms=600,
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="qwen/qwen3-coder-30b-a3b-instruct",
                    display_name="Qwen3 Coder 30B A3B",
                    provider="openrouter",
                    intelligence_index=38.0,
                    context_window=262_144,
                    roles=["light_worker", "worker", "frontend_worker", "backend_worker"],
                    pricing=PricingInfo(0.15, 0.60, 0.0),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.86,
                    average_latency_ms=500,
                ),
                True,
            ),
            # ---------------------------------------------------------------
            # 고정 의사결정 모델 라인업 (Fixed Decision Model Lineup for Planner)
            # 앱 릴리스에 고정된 Baseten / OpenRouter 엔드포인트 의사결정/기획 전용 프리셋
            # ---------------------------------------------------------------
            (
                ModelIntelligenceEntry(
                    model_id="baseten/mammoth-1",
                    display_name="Mammoth-1 (27B Decision)",
                    provider="baseten",
                    intelligence_index=88.0,
                    context_window=16_384,
                    roles=["planner", "researcher"],
                    pricing=PricingInfo(input_cost_per_m=0.10, output_cost_per_m=0.0, cached_input_cost_per_m=0.01),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.94,
                    average_latency_ms=530,
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="openrouter/d1-ultra",
                    display_name="D1 Ultra (Ultra-High Reasoning Decision)",
                    provider="openrouter",
                    intelligence_index=72.0,
                    context_window=262_144,
                    roles=["planner", "researcher", "main"],
                    pricing=PricingInfo(1.80, 7.20, 0.18),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.98,
                    average_latency_ms=1800,
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="openrouter/subq-snap-1.1",
                    display_name="SubQ Snap 1.1 (Fast Structured Query / Decomposition)",
                    provider="openrouter",
                    intelligence_index=48.0,
                    context_window=131_072,
                    roles=["planner", "researcher", "light_worker"],
                    pricing=PricingInfo(0.04, 0.08, 0.004),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.92,
                    average_latency_ms=320,
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="openrouter/elephant-9b",
                    display_name="Elephant 9B (Efficient Specialized Planning / Decision)",
                    provider="openrouter",
                    intelligence_index=54.0,
                    context_window=131_072,
                    roles=["planner", "researcher", "worker"],
                    pricing=PricingInfo(0.08, 0.20, 0.008),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.94,
                    average_latency_ms=520,
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="openrouter/drex-max",
                    display_name="Drex Max (Maximum Context / Complex Decision)",
                    provider="openrouter",
                    intelligence_index=68.0,
                    context_window=1_048_576,
                    roles=["planner", "researcher", "heavy_worker"],
                    pricing=PricingInfo(1.20, 4.80, 0.12),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.97,
                    average_latency_ms=1400,
                ),
                False,
            ),
            # ---------------------------------------------------------------
            # 로컬 실행 모델 라인업 (Zero Pricing, Zero Latency / ZDR Local GGUF)
            # Tier 1 ~ Tier 3 실행 환경에서 프라이버시 100% 보장 및 토큰 비용 $0
            # ---------------------------------------------------------------
            # 7B Q4_K_M은 이 PC에서 실측된 파일 크기(4.36 GiB)를 쓴다. 배포 파일과의
            # SHA-256 동일성은 아직 확인되지 않았으므로(design §7.3) 그 사실을
            # weights_basis에 남긴다. 값 자체를 추정하지는 않는다.
            (
                ModelIntelligenceEntry(
                    model_id="local/qwen2.5-coder-1.5b-gguf",
                    display_name="Qwen2.5 Coder 1.5B (Local GGUF)",
                    provider="local",
                    intelligence_index=35.0,
                    context_window=32_768,
                    roles=[
                        "light_worker", "worker",
                        # 카탈로그 선언과 코드 판정의 모순 해소: 이 항목은 실제로
                        # 백그라운드 역할을 맡을 수 있다(승인 목록 소속).
                        "background_worker", "memory_distiller", "compactor",
                    ],
                    pricing=PricingInfo(0.0, 0.0, 0.0),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.88,
                    average_latency_ms=120,
                    # 파일 크기·KV 메타데이터가 확인되지 않았다. 추정하지 않고
                    # pending으로 두며, 확인 전에는 선택 후보가 아니다.
                    weights_bytes=None,
                    kv_bytes_per_token=None,
                    min_context=4096,
                    size_class="small",
                    bg_approved=True,
                    license="apache-2.0",
                    quant_label="Q4_K_M",
                    pending_confirmation=True,
                    weights_basis="unverified",
                    benchmark_note="vendor model card not checked in this release",
                ),
                True,  # 경량 특수 역할 예외 등록 허용
            ),
            (
                ModelIntelligenceEntry(
                    model_id="local/qwen2.5-coder-7b-gguf",
                    display_name="Qwen2.5 Coder 7B (Local GGUF)",
                    provider="local",
                    intelligence_index=52.0,
                    context_window=65_536,
                    roles=[
                        "worker", "light_worker", "frontend_worker", "backend_worker",
                        "reviewer", "researcher",
                        # 선언과 판정의 모순 해소: 백그라운드 역할 수행 가능.
                        "background_worker", "memory_distiller", "compactor",
                    ],
                    pricing=PricingInfo(0.0, 0.0, 0.0),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.93,
                    average_latency_ms=380,
                    # 4.36 GiB: 이 PC에서 관측된 Q4_K_M 파일 크기(설계문서 [측정]).
                    # byte 값은 그 GiB를 정확히 환산한 것이며, 배포 파일과의 SHA-256
                    # 동일성은 아직 확인되지 않았다.
                    weights_bytes=4_681_514_353,
                    # Qwen2.5-7B: 2 * 28 layer * 4 KV head * 128 head_dim * 2 byte.
                    kv_bytes_per_token=57_344,
                    min_context=4096,
                    size_class="medium",
                    bg_approved=True,
                    license="apache-2.0",
                    quant_label="Q4_K_M",
                    weights_basis="measured_host_file_4.36_gib",
                ),
                False,
            ),
            (
                ModelIntelligenceEntry(
                    model_id="local/qwen2.5-coder-14b-gguf",
                    display_name="Qwen2.5 Coder 14B (Local GGUF)",
                    provider="local",
                    intelligence_index=61.0,
                    context_window=65_536,
                    roles=["planner", "worker", "heavy_worker", "reviewer", "security_reviewer", "researcher"],
                    pricing=PricingInfo(0.0, 0.0, 0.0),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.95,
                    average_latency_ms=650,
                    weights_bytes=None,
                    kv_bytes_per_token=None,
                    min_context=4096,
                    size_class="large",
                    license="apache-2.0",
                    quant_label="Q4_K_M",
                    pending_confirmation=True,
                    weights_basis="unverified",
                ),
                False,
            ),
        ]
        default_models.extend(self._aux_entries())
        default_models.extend(self._bonsai_entries())
        for entry, allow_exception in default_models:
            self.register_model(entry, allow_special_exception=allow_exception)

    @staticmethod
    def _aux_entries() -> List[Tuple[ModelIntelligenceEntry, bool]]:
        """소형 로컬 aux/임베딩 후보 계층 — 선언만 있고 측정값은 없다.

        이 릴리스는 aux 평면의 **후보 계층**(아주 작은 로컬 가중치 한 종류와 로컬
        임베딩 후보 하나)을 카탈로그에 선언한다. 그러나 실제 배포 파일의 크기, KV
        바이트/token, 벤치마크 수치는 확인되지 않았으므로 하나도 적지 않는다:

        * ``weights_bytes``/``kv_bytes_per_token`` = ``None`` (미확인, 추정 금지)
        * ``pending_confirmation=True`` (기존 게이트가 후보에서 제외한다)
        * ``intelligence_index=0.0`` — 이 코드베이스에서 0.0은 "공개 벤치마크 없음"이며
          품질 0이나 측정된 점수를 뜻하지 않는다(``benchmark_note``에 명시).
        * ``license=None`` — 가중치 계열/배포자를 아직 고정하지 않았으므로 라이선스를
          주장하지 않는다.

        따라서 이 항목들은 어떤 다운로드도 없고, 로드된 적도 없고, 측정된 적도 없다.
        가중치가 확인되면 같은 ``vram_budget.select()`` 게이트가 그때 판정한다.
        """
        common = dict(
            provider="local",
            intelligence_index=0.0,
            context_window=8_192,
            pricing=PricingInfo(0.0, 0.0, 0.0),
            privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
            # Unobserved Beta prior, not a measured success rate; latency 0 means unknown.
            success_rate=0.90,
            average_latency_ms=0,
            weights_bytes=None,
            kv_bytes_per_token=None,
            min_context=2_048,
            size_class="small",
            pending_confirmation=True,
            weights_basis="unverified",
            benchmark_note=(
                "no candidate is downloaded, loaded or benchmarked in this release; "
                "weights, KV shape and any score are unconfirmed"
            ),
        )
        return [
            (
                ModelIntelligenceEntry(
                    model_id="local/aux-tiny-gguf",
                    display_name="Tiny Local Aux Generator (sub-1B class, Q4-class GGUF)",
                    # 이 계층은 제목/질의 재작성만 선언한다. 증류·압축은 더 큰 문맥과
                    # 품질이 필요하므로, 측정 없이 작은 모델에 배정하지 않는다.
                    roles=["session_titler", "query_rewriter"],
                    quant_label="Q4-class",
                    **common,
                ),
                True,  # 품질 점수가 없으므로 예외 등록(점수를 만들어 넣지 않는다)
            ),
            (
                ModelIntelligenceEntry(
                    model_id="local/aux-embed-gguf",
                    display_name="Local Aux Embedding (small embedding class, GGUF)",
                    roles=["embedding"],
                    quant_label="f16-class",
                    **common,
                ),
                True,
            ),
        ]

    @staticmethod
    def _bonsai_entries() -> List[Tuple[ModelIntelligenceEntry, bool]]:
        """Prism ML Bonsai 2 계열 — 크기는 배포 파일 목록의 정확한 byte 수.

        KV/token은 아키텍처에서 계산했고, 27B의 64 KiB/token은 벤더 자체 표기와
        일치한다. Q2_0는 stock llama.cpp b11556 이상에서 적재되고, PQ2_0/PTQ1_0은
        PrismML 포크(ggml type 142/143)에서만 적재된다. 2B/4B/9B 모델 카드는 벤치마크
        수치를 공개하지 않으므로 ``intelligence_index=0.0``(공개 수치 없음)과
        ``benchmark_note``로 기록하며, 어떤 능력 등급도 함의하지 않는다. 이 가족은
        포그라운드 코더 역할을 갖지 않는다(백그라운드 전담).
        """
        q2_build = STOCK_MIN_BUILD_Q2_0
        no_bench = "model card publishes no benchmark numbers; quality is unquantified"
        specs = (
            # Prism 가족은 배경 역할 전담이다. 포그라운드 코더는 Qwen 7B류가 맡고,
            # 이 가족은 (1) 8 GB에서 상주/교체로 들어가는 크기, (2) 양자화별 런타임
            # 요구가 다르다는 두 사실을 카탈로그에 그대로 적는다.
            # (id, display, weights, kv/token, ctx, size_class, quant, runtime, min_build,
            #  intelligence, benchmark_note)
            ("local/bonsai-2-27b-ptq1", "Ternary Bonsai-2 27B PTQ1_0 (Local GGUF)",
             5_946_648_928, 65_536, 262_144, "large", "PTQ1_0", RUNTIME_PRISM_FORK, None,
             84.8, None),
            ("local/bonsai-2-27b-pq2", "Ternary Bonsai-2 27B PQ2_0 (Local GGUF)",
             7_206_168_928, 65_536, 262_144, "large", "PQ2_0", RUNTIME_PRISM_FORK, None,
             84.8, None),
            ("local/bonsai-2-27b-q2", "Ternary Bonsai-2 27B Q2_0 (Local GGUF)",
             7_626_008_928, 65_536, 262_144, "large", "Q2_0", RUNTIME_STOCK, q2_build,
             None, None),
            ("local/bonsai-2-9b-ptq1", "Ternary Bonsai-2 9B PTQ1_0 (Local GGUF)",
             1_997_486_976, 32_768, 32_768, "medium", "PTQ1_0", RUNTIME_PRISM_FORK, None,
             None, no_bench),
            ("local/bonsai-2-9b-pq2", "Ternary Bonsai-2 9B PQ2_0 (Local GGUF)",
             2_416_851_840, 32_768, 32_768, "medium", "PQ2_0", RUNTIME_PRISM_FORK, None,
             None, no_bench),
            ("local/bonsai-2-9b-q2", "Ternary Bonsai-2 9B Q2_0 (Local GGUF)",
             2_556_640_128, 32_768, 32_768, "medium", "Q2_0", RUNTIME_STOCK, q2_build,
             None, no_bench),
            ("local/bonsai-2-4b-ptq1", "Ternary Bonsai-2 4B PTQ1_0 (Local GGUF)",
             949_549_920, 32_768, 32_768, "small", "PTQ1_0", RUNTIME_PRISM_FORK, None,
             None, no_bench),
            ("local/bonsai-2-4b-q2", "Ternary Bonsai-2 4B Q2_0 (Local GGUF)",
             1_212_103_520, 32_768, 32_768, "small", "Q2_0", RUNTIME_STOCK, q2_build,
             None, no_bench),
            ("local/bonsai-2-2b-ptq1", "Ternary Bonsai-2 2B PTQ1_0 (Local GGUF)",
             429_183_456, 12_288, 32_768, "small", "PTQ1_0", RUNTIME_PRISM_FORK, None,
             None, no_bench),
            ("local/bonsai-2-2b-q2", "Ternary Bonsai-2 2B Q2_0 (Local GGUF)",
             546_689_504, 12_288, 32_768, "small", "Q2_0", RUNTIME_STOCK, q2_build,
             None, no_bench),
        )
        entries: List[Tuple[ModelIntelligenceEntry, bool]] = []
        for (model_id, display, weights, kv, ctx, size_class, quant,
             runtime_kind, min_build, intelligence, bench_note) in specs:
            entries.append((
                ModelIntelligenceEntry(
                    model_id=model_id,
                    display_name=display,
                    provider="local",
                    intelligence_index=intelligence if intelligence is not None else 40.0,
                    context_window=ctx,
                    roles=["background_worker", "memory_distiller", "compactor"],
                    pricing=PricingInfo(0.0, 0.0, 0.0),
                    privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
                    success_rate=0.90 if intelligence is None else 0.93,
                    average_latency_ms=120 if intelligence is None else 12.0,
                    weights_bytes=weights,
                    kv_bytes_per_token=kv,
                    min_context=4096,
                    size_class=size_class,
                    bg_approved=True,
                    license="apache-2.0",
                    quant_label=quant,
                    runtime_kind=runtime_kind,
                    runtime_min_build=min_build,
                    runtime_buffer_bytes=BONSAI_RUNTIME_BUFFER_BYTES,
                    weights_basis="distributor_listing",
                    benchmark_note=bench_note,
                ),
                # 2B/4B/9B는 40점 미만일 수 있으므로 예외 등록을 허용한다.
                intelligence is None,
            ))
        return entries

    def register_model(self, entry: ModelIntelligenceEntry, allow_special_exception: bool = False) -> bool:
        if entry.intelligence_index < self.min_intelligence_index and not allow_special_exception:
            return False
        invalid = set(entry.roles) - VALID_ROLES
        if invalid:
            raise ValueError(f"Invalid roles: {invalid}")
        self._catalog[entry.model_id] = entry
        return True

    def _tracker(self, model_id: str, role: str) -> BetaSuccessTracker:
        entry = self._catalog[model_id]
        key = (model_id, role)
        if key not in self._trackers:
            self._trackers[key] = BetaSuccessTracker.from_prior(entry.success_rate, self.prior_strength)
        return self._trackers[key]

    def success_probability(self, model_id: str, role: str) -> float:
        """모델 x 역할 Beta 사후 성공확률 평균."""
        return self._tracker(model_id, role).mean

    def record_outcome(self, model_id: str, role: str, success: bool) -> float:
        """실행 결과를 성공/실패로 기록하고 갱신된 사후 평균을 돌려준다."""
        if model_id not in self._catalog:
            raise KeyError(model_id)
        return self._tracker(model_id, role).record(success)

    def attempt_cost_usd(
        self,
        model_id: str,
        input_tokens: int = DEFAULT_INPUT_TOKENS,
        output_tokens: int = DEFAULT_OUTPUT_TOKENS,
        cache_hit_ratio: float = 0.0,
    ) -> float:
        return self.get_model(model_id).pricing.attempt_cost_usd(
            input_tokens, output_tokens, cache_hit_ratio
        )

    def expected_cost_per_success(
        self,
        model_id: str,
        role: str,
        input_tokens: int = DEFAULT_INPUT_TOKENS,
        output_tokens: int = DEFAULT_OUTPUT_TOKENS,
        cache_hit_ratio: float = 0.0,
        retry_penalty_factor: float = DEFAULT_RETRY_PENALTY_FACTOR,
    ) -> float:
        """ECPS = c/p + lambda*c*(1-p)/p (c: 시도 1회 비용, p: 사후 성공확률)."""
        attempt_cost = self.attempt_cost_usd(model_id, input_tokens, output_tokens, cache_hit_ratio)
        probability = min(1.0 - 1e-9, max(1e-9, self.success_probability(model_id, role)))
        expected_attempts_cost = attempt_cost / probability
        failure_penalty = retry_penalty_factor * attempt_cost * (1.0 - probability) / probability
        return expected_attempts_cost + failure_penalty

    def rank_models(
        self,
        role: str,
        mode: str = "balanced",
        privacy_consent: bool = False,
        input_tokens: int = DEFAULT_INPUT_TOKENS,
        output_tokens: int = DEFAULT_OUTPUT_TOKENS,
        cache_hit_ratio: float = 0.0,
        retry_penalty_factor: float = DEFAULT_RETRY_PENALTY_FACTOR,
        include_local: bool = False,
        route: Optional[str] = None,
    ) -> List[ModelIntelligenceEntry]:
        """
        역할/모드/프라이버시 조건을 만족하는 모델을 ECPS 기반으로 정렬해 반환한다.
        privacy_consent=False(기본값)일 때 zero_data_retention + training_opt_out 모델만 허용.
        include_local=False(기본값): 일반 클라우드 게이트웨이 라우팅 시 로컬 모델은 제외.
        (로컬 모델은 hardware_tier 기반 플래너/오케스트레이터에서 직접 지정/선택함)
        """
        if mode not in OPTIMIZATION_MODES:
            raise ValueError(f"Unknown optimization mode: {mode}")
        if role in BACKGROUND_ROLES:
            raise BackgroundModelUnavailableError(
                f"role {role!r} is reserved for the Bonsai background track; "
                f"use select_background_model() instead of selecting a substitute model"
            )
        if role in AUX_APPROVED_ROLE_NAMES:
            raise AuxModelUnavailableError(
                f"role {role!r} is reserved for the local aux/embedding plane; "
                f"use select_aux_model() instead of selecting a substitute model"
            )
        route_value = getattr(route, "value", route) or ("any_cloud" if privacy_consent else "zdr_cloud")
        if route_value not in ("local_only", "zdr_cloud", "any_cloud"):
            raise ValueError(f"Unknown execution route: {route_value}")
        candidates = [
            m for m in self._catalog.values()
            if role in m.roles
            and ((m.provider == "local") if route_value == "local_only"
                 else (include_local or m.provider != "local"))
            and (route_value == "any_cloud" or (m.privacy.zero_data_retention and m.privacy.training_opt_out))
        ]
        if not candidates:
            raise RuntimeError(
                f"503 Service Unavailable (No Compliant Route for role={role}, privacy_consent={privacy_consent})"
            )

        scored: List[Tuple[ModelIntelligenceEntry, float, float, float]] = []
        for model in candidates:
            ecps = self.expected_cost_per_success(
                model.model_id,
                role,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cache_hit_ratio=cache_hit_ratio,
                retry_penalty_factor=retry_penalty_factor,
            )
            quality_adjusted = ecps * (100.0 / max(model.intelligence_index, 1.0))
            scored.append((model, ecps, self.success_probability(model.model_id, role), quality_adjusted))

        if mode == "quality":
            scored.sort(key=lambda s: (-s[0].intelligence_index, s[1], s[0].model_id))
        elif mode == "cost":
            scored.sort(key=lambda s: (s[1], -s[0].intelligence_index, s[0].model_id))
        elif mode == "speed":
            scored.sort(key=lambda s: (s[0].average_latency_ms, s[1], s[0].model_id))
        else:  # balanced: 100 지능지수 환산 기준 ECPS 최소화
            scored.sort(key=lambda s: (s[3], s[1], s[0].model_id))
        return [item[0] for item in scored]

    def select_model(
        self,
        role: str,
        mode: str = "balanced",
        privacy_consent: bool = False,
        input_tokens: int = DEFAULT_INPUT_TOKENS,
        output_tokens: int = DEFAULT_OUTPUT_TOKENS,
        cache_hit_ratio: float = 0.0,
        include_local: bool = False,
        route: Optional[str] = None,
    ) -> ModelIntelligenceEntry:
        """Select a compliant catalog model; the boolean is a deprecated route mapper."""
        return self.rank_models(
            role,
            mode=mode,
            privacy_consent=privacy_consent,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_hit_ratio=cache_hit_ratio,
            include_local=include_local,
            route=route,
        )[0]

    def background_role_for(self, task_type: str = DEFAULT_BACKGROUND_TASK_TYPE) -> str:
        """백그라운드 작업 유형(별칭 허용)을 레지스트리 역할로 정규화한다."""
        return BACKGROUND_TASK_ROLES.get(self.canonical_background_task_type(task_type), "background_worker")

    def canonical_background_task_type(self, task_type: str = DEFAULT_BACKGROUND_TASK_TYPE) -> str:
        """백그라운드 작업 유형 별칭(``session_compaction`` 등)을 정규 이름으로 변환한다."""
        key = str(task_type or DEFAULT_BACKGROUND_TASK_TYPE).strip().lower()
        key = key.replace("-", "_").replace(" ", "_")
        return BACKGROUND_TASK_ALIASES.get(key, key)

    def background_tier_info(
        self,
        tier: Optional[Union[LocalExecutionTier, str, LocalExecutionTierInfo]] = None,
    ) -> LocalExecutionTierInfo:
        """백그라운드 모델이 실행될 티어 판정 정보.

        ``tier=None``이면 **측정된 하드웨어**로 판정한다(이전 구현은 Tier 3으로 가정해
        Bonsai를 실행할 수 없는 노트북에서도 '선택됨'으로 보고했다). 명시적 ``tier``는
        사용자 override(예: 원격 로컬 엔드포인트)로 존중하되, 하드웨어가 실제로 감당
        가능한 티어를 ``capability_tier``에 함께 남겨 호출자가 진실을 볼 수 있게 한다.
        """
        if isinstance(tier, LocalExecutionTierInfo):
            return tier
        spec = detect_hardware()
        if tier is None:
            return determine_local_tier(spec)
        return determine_local_tier(spec, override_tier=str(parse_tier(tier).value))

    def local_catalogue(self) -> List[ModelRequirement]:
        """선택기 입력: 로컬 모델의 요구량 레코드(정렬된 순서)."""
        return [
            entry.requirement()
            for entry in self.catalog
            if entry.provider == "local"
        ]

    def machine_profile(
        self,
        tier_info: LocalExecutionTierInfo,
        runtime: Optional[Dict[str, Any]] = None,
        vram_free_gib: Optional[float] = None,
        display_attached: Optional[bool] = None,
        weights_present: Optional[bool] = None,
    ) -> MachineProfile:
        """측정된 ``HardwareSpec``(+프로브)을 선택기의 ``MachineProfile``로 변환한다.

        ``tier_info.hardware``만으로는 여유 VRAM·런타임·가중치 존재를 알 수 없으므로,
        호출자가 프로브 결과를 넘기거나(``runtime``) 테스트가 프로필을 직접 주입한다.
        측정하지 못한 값은 0이 아니라 ``None``으로 남긴다. ``weights_present``도 같은
        3상태이며, 기본값 ``None``(미확인)은 실행 가능으로 승격되지 않는다 — 선택기는
        ``True``만 적재 가능으로 본다(M-15, E-LOC-02).
        """
        spec = tier_info.hardware
        has_gpu = bool(spec is not None and spec.has_gpu and spec.vram_gb > 0)
        runtime = runtime if runtime is not None else probe_runtime()
        present = bool(runtime.get("present"))
        return MachineProfile(
            accelerator=Accelerator.DISCRETE_GPU if has_gpu else Accelerator.NONE,
            vram_total_bytes=int(spec.vram_gb * GIB) if has_gpu else None,
            vram_free_bytes=int(vram_free_gib * GIB) if vram_free_gib is not None else None,
            os_reserved_bytes=DEFAULT_OS_RESERVED_BYTES,
            display_attached=display_attached,
            ram_total_bytes=int(spec.ram_gb * GIB) if spec is not None and spec.ram_gb > 0 else None,
            cpu_physical_cores=int(spec.cpu_cores) if spec is not None else 1,
            gpu_name=spec.gpu_name if spec is not None else "",
            runtime_present=present,
            runtime_kind=runtime.get("kind") if present else None,
            runtime_build=runtime.get("build") if present else None,
            runtime_backend=runtime.get("backend") if present else None,
            weights_present=weights_present,
        )

    def select_background_model(
        self,
        task_type: str = DEFAULT_BACKGROUND_TASK_TYPE,
        tier: Optional[Union[LocalExecutionTier, str, LocalExecutionTierInfo]] = None,
        machine: Optional[MachineProfile] = None,
        foreground_model_id: Optional[str] = None,
    ) -> BackgroundModelSelection:
        """역할 규칙으로 백그라운드 전담 로컬 모델을 고른다(대체 모델 없음).

        R-BG2-01/R-BG2-02: 압축/제목·커밋 메시지/메모리 인덱싱·증류/리랭크/트리아지/
        루프 가드 진단은 **승인 목록**(``bg_approved``)에 속한, 포그라운드와 다른 전담
        로컬 모델 하나로 실행한다. 선택은 ``vram_budget.select()``의 적재 산술이 하며,
        고정 27B 이름을 요구하지 않는다 — 27B는 8 GB에서 어떤 양자화로도 들어가지 않는다.

        후보가 없거나 런타임/가중치/엔드포인트가 준비되지 않았으면 ``status='unavailable'``
        과 사유를 돌려주고 ``entry``는 ``None``이다. Qwen·클라우드·포그라운드 모델로
        조용히 대체하지 않는다.
        """
        canonical = self.canonical_background_task_type(task_type)
        role = self.background_role_for(canonical)
        tier_info = self.background_tier_info(tier)
        resolved_tier = tier_info.tier
        # override 로 적어 넣은 티어가 적재 능력을 만들어 내지는 못한다.
        capable_tier = tier_info.capability_tier or resolved_tier
        hostable_tier = resolved_tier if resolved_tier.level <= capable_tier.level else capable_tier
        spec = tier_info.hardware

        reasons: List[str] = []
        if hostable_tier.level < BACKGROUND_REQUIRED_TIER.level:
            measured = (
                f"; measured RAM {spec.ram_gb:.1f}GB / VRAM {spec.vram_gb:.1f}GB"
                if spec is not None else ""
            )
            reasons.append(
                f"tier {hostable_tier.value} below required {BACKGROUND_REQUIRED_TIER.value}: "
                f"background work needs RAM >= {BACKGROUND_MIN_RAM_GB:.0f}GB or "
                f"VRAM >= {BACKGROUND_MIN_VRAM_GB:.0f}GB{measured}"
            )
        if not (os.environ.get(BACKGROUND_ENDPOINT_ENV) or "").strip():
            reasons.append(f"{BACKGROUND_ENDPOINT_ENV} is not set")

        profile = machine if machine is not None else self.machine_profile(tier_info)
        decision = select(
            profile,
            self.local_catalogue(),
            foreground_model_id=foreground_model_id,
            background_role=role,
        )

        bg_entry: Optional[ModelIntelligenceEntry] = None
        candidate_id: Optional[str] = None
        ctx_tokens: Optional[int] = None
        residency: Optional[str] = None
        co_resident: Optional[bool] = None
        budget_gib: Optional[float] = None
        fore_id: Optional[str] = foreground_model_id
        if isinstance(decision, Unavailable):
            reasons.append(f"{decision.reason}: {decision.detail}")
        else:
            fore_id = decision.fore_model_id
            budget_gib = round(decision.budget_bytes / GIB, 3)
            if decision.bg_model_id is None:
                reasons.append(
                    "no approved background model fits: "
                    + "; ".join(decision.reasons[-1:])
                )
            else:
                candidate_id = decision.bg_model_id
                bg_entry = self._catalog.get(decision.bg_model_id)
                if bg_entry is None:
                    reasons.append(
                        f"{decision.bg_model_id} is not in the curated catalog"
                    )
                    candidate_id = None
                else:
                    ctx_tokens = decision.bg_ctx_tokens
                    residency = decision.residency
                    co_resident = bool(decision.co_residency and decision.co_residency.ok)

        status = BACKGROUND_STATUS_UNAVAILABLE if reasons else BACKGROUND_STATUS_READY
        return BackgroundModelSelection(
            task_type=canonical,
            role=role,
            status=status,
            # 실행 계약: 모델 ID는 실제로 실행 가능한 배정에서만 채운다. 후보는
            # candidate_model_id에 남기므로 진단 정보가 사라지지 않는다.
            model_id=bg_entry.model_id if status == BACKGROUND_STATUS_READY and bg_entry is not None else "",
            candidate_model_id=candidate_id,
            tier=resolved_tier.value,
            required_tier=BACKGROUND_REQUIRED_TIER.value,
            reason="; ".join(reasons) if reasons else None,
            reasons=tuple(reasons),
            capability_tier=(tier_info.capability_tier.value if tier_info.capability_tier else None),
            hardware=tier_info.to_dict(),
            entry=bg_entry if not reasons else None,
            foreground_model_id=fore_id,
            ctx_tokens=ctx_tokens,
            residency=residency,
            co_resident=co_resident,
            budget_gib=budget_gib,
        )

    # ------------------------------------------------------------------ #
    # 소형 로컬 aux/임베딩 평면 (session titling / rewrite / distill / compact / embed)
    # ------------------------------------------------------------------ #
    def canonical_aux_task_type(self, task: str = "title") -> str:
        """aux 작업 이름/별칭을 정규 작업 유형으로 바꾼다(호출자는 역할을 몰라도 된다)."""
        key = str(task or "title").strip().lower()
        key = key.replace("-", "_").replace(" ", "_")
        return AUX_TASK_ALIASES.get(key, key)

    def aux_role_for(self, task: str = "title") -> Optional[str]:
        """aux 작업 유형 -> 레지스트리 역할. 선언되지 않은 작업은 ``None``."""
        return AUX_TASK_ROLES.get(self.canonical_aux_task_type(task))

    def aux_tier_info(
        self,
        tier: Optional[Union[LocalExecutionTier, str, LocalExecutionTierInfo]] = None,
    ) -> LocalExecutionTierInfo:
        """aux 모델이 실행될 티어 판정 정보(백그라운드와 같은 측정 경로).

        ``tier=None``이면 측정된 하드웨어로 판정하고, 명시적 ``tier``는 override로
        존중하되 실제 감당 가능한 티어를 ``capability_tier``에 함께 남긴다.
        """
        return self.background_tier_info(tier)

    def select_aux_model(
        self,
        task: str,
        tier: Optional[Union[LocalExecutionTier, str, LocalExecutionTierInfo]] = None,
        machine: Optional[MachineProfile] = None,
        foreground_model_id: Optional[str] = None,
    ) -> AuxModelSelection:
        """소형 로컬 aux/임베딩 모델을 작업 이름만으로 고른다(대체 모델 없음).

        세션 제목(``title``), 질의 재작성(``query_rewrite``), 메모리 증류
        (``distillation``), 압축(``compaction``), 임베딩(``embedding``)은 작은 로컬
        모델로 충분하며 API 비용이 들지 않는다. 선택은 ``select_background_model``과
        같은 게이트를 그대로 통과한다: 런타임 존재, 가중치 **확인**(``True``만 존재),
        런타임 종류, 예산/적재 산술. 후보는 aux/임베딩 역할을 선언한 로컬 항목뿐이며,
        적합한 후보가 없으면 ``status='unavailable'``과 사유를 돌려준다.

        준비되지 않은 이유는 사유 코드로 구분된다: 가중치 파일이 없으면
        ``weights_missing``, 존재가 확인되지 않았으면 ``weights_unconfirmed``.
        어떤 경우에도 클라우드나 포그라운드 코더로 조용히 대체하지 않는다.
        """
        canonical = self.canonical_aux_task_type(task)
        role = AUX_TASK_ROLES.get(canonical)
        tier_info = self.aux_tier_info(tier)
        resolved_tier = tier_info.tier
        # override 로 적어 넣은 티어가 적재 능력을 만들어 내지는 못한다.
        capable_tier = tier_info.capability_tier or resolved_tier
        hostable_tier = resolved_tier if resolved_tier.level <= capable_tier.level else capable_tier
        spec = tier_info.hardware

        reasons: List[str] = []
        detail: Optional[str] = None
        candidate_id: Optional[str] = None
        entry: Optional[ModelIntelligenceEntry] = None
        ctx_tokens: Optional[int] = None
        residency: Optional[str] = None
        co_resident: Optional[bool] = None
        budget_gib: Optional[float] = None
        fore_id: Optional[str] = foreground_model_id

        if role is None:
            reasons.append(
                f"unknown aux task {task!r}: declared tasks are {sorted(AUX_TASK_ROLES)}"
            )
        elif hostable_tier.level < AUX_REQUIRED_TIER.level:
            measured = (
                f"; measured RAM {spec.ram_gb:.1f}GB / VRAM {spec.vram_gb:.1f}GB"
                if spec is not None else ""
            )
            reasons.append(
                f"tier {hostable_tier.value} below required {AUX_REQUIRED_TIER.value}: "
                f"aux work needs RAM >= {AUX_MIN_RAM_GB:.0f}GB or "
                f"VRAM >= {AUX_MIN_VRAM_GB:.0f}GB{measured}"
            )

        if role is not None:
            profile = machine if machine is not None else self.machine_profile(tier_info)
            decision = select(
                profile,
                self.local_catalogue(),
                foreground_model_id=foreground_model_id,
                aux_role=role,
            )
            if isinstance(decision, Unavailable):
                reasons.append(f"{decision.reason}: {decision.detail}")
                detail = decision.detail
                budget_gib = round(decision.budget_bytes / GIB, 3) if decision.budget_bytes else None
            else:
                fore_id = decision.fore_model_id or foreground_model_id
                budget_gib = round(decision.budget_bytes / GIB, 3)
                detail = "; ".join(decision.reasons)
                if decision.bg_model_id is None:
                    reasons.append("no approved aux/embedding model fits: " + detail)
                candidate_id = decision.bg_model_id
                entry = self._catalog.get(candidate_id) if candidate_id else None
                if candidate_id is not None and entry is None:
                    reasons.append(f"{candidate_id} is not in the curated catalog")
                    candidate_id = None
                elif entry is not None and entry.provider != "local":
                    # aux 작업은 로컬 전용이다: 비-로컬 후보는 배정하지 않는다.
                    reasons.append(
                        f"{entry.model_id} is provider {entry.provider!r}: "
                        "aux work has no non-local candidate"
                    )
                    entry = None
                elif entry is not None:
                    ctx_tokens = decision.bg_ctx_tokens
                    residency = decision.residency
                    co_resident = bool(decision.co_residency and decision.co_residency.ok)

        status = AUX_STATUS_UNAVAILABLE if (reasons or entry is None) else AUX_STATUS_READY
        return AuxModelSelection(
            task_type=canonical,
            role=role or "",
            status=status,
            # 실행 계약: 모델 ID는 실제로 실행 가능한 배정에서만 채운다.
            model_id=entry.model_id if status == AUX_STATUS_READY and entry is not None else "",
            candidate_model_id=candidate_id,
            tier=resolved_tier.value,
            required_tier=AUX_REQUIRED_TIER.value,
            reason="; ".join(reasons) if reasons else None,
            detail=detail,
            reasons=tuple(reasons),
            capability_tier=(tier_info.capability_tier.value if tier_info.capability_tier else None),
            hardware=tier_info.to_dict(),
            entry=entry if status == AUX_STATUS_READY else None,
            foreground_model_id=fore_id,
            ctx_tokens=ctx_tokens,
            residency=residency,
            co_resident=co_resident,
            budget_gib=budget_gib,
        )



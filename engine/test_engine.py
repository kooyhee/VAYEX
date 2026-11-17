import asyncio
import hashlib
import os
import unittest
from pathlib import Path
from unittest.mock import patch

try:
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
        BACKGROUND_MODEL_ID,
        BACKGROUND_ENDPOINT_ENV,
        BACKGROUND_STATUS_READY,
        BACKGROUND_STATUS_UNAVAILABLE,
        BACKGROUND_TASK_ROLES,
        BACKGROUND_ROLES,
        BackgroundModelUnavailableError,
        DEFAULT_BACKGROUND_TASK_TYPE,
        VALID_ROLES,
        AUX_STATUS_READY,
        AUX_STATUS_UNAVAILABLE,
        AUX_REQUIRED_TIER,
        AUX_TASK_ROLES,
        AuxModelUnavailableError,
    )
    from .decision_planner import (
        IntelligencePlanner,
        ExecutionDAGPlan,
        DAGNode,
        estimate_tokens,
    )
    from .dag_orchestrator import (
        DeterministicDAGOrchestrator,
        FileIsolationWorkspace,
        BudgetExhaustedError,
        AttemptOutcome,
    )
    from .fts5_memory import (
        BONSAI_BACKGROUND_MODEL_ID,
        HybridContextMemoryEngine,
        sanitize_fts5_query,
    )
except (ImportError, ValueError):
    from engine.hardware_profiler import (  # type: ignore
        HardwareSpec,
        detect_hardware,
        determine_local_tier,
        LocalExecutionTier,
        LocalExecutionTierInfo,
        clear_hardware_cache,
        parse_tier,
    )
    from engine.registry import (  # type: ignore
        ModelIntelligenceRegistry,
        ModelIntelligenceEntry,
        PricingInfo,
        PrivacyPolicy,
        BetaSuccessTracker,
        escalation_role,
        CURATED_APP_RELEASE_VERSION,
        BACKGROUND_MODEL_ID,
        BACKGROUND_ENDPOINT_ENV,
        BACKGROUND_STATUS_READY,
        BACKGROUND_STATUS_UNAVAILABLE,
        BACKGROUND_TASK_ROLES,
        BACKGROUND_ROLES,
        BackgroundModelUnavailableError,
        DEFAULT_BACKGROUND_TASK_TYPE,
        VALID_ROLES,
        AUX_STATUS_READY,
        AUX_STATUS_UNAVAILABLE,
        AUX_REQUIRED_TIER,
        AUX_TASK_ROLES,
        AuxModelUnavailableError,
    )
    from engine.decision_planner import (  # type: ignore
        IntelligencePlanner,
        ExecutionDAGPlan,
        DAGNode,
        estimate_tokens,
    )
    from engine.dag_orchestrator import (  # type: ignore
        DeterministicDAGOrchestrator,
        FileIsolationWorkspace,
        BudgetExhaustedError,
        AttemptOutcome,
    )
    from engine.fts5_memory import (  # type: ignore
        BONSAI_BACKGROUND_MODEL_ID,
        HybridContextMemoryEngine,
        sanitize_fts5_query,
    )


from engine.tests_stub import (TestEngineSafety, TestModelExecution, TestDshPayload,
                               temporary_workspace)

#: 백그라운드 Bonsai 실행이 가능한(Tier 3) 가상 사양: RAM >= 32GB AND VRAM >= 12GB
TIER3_SPEC = HardwareSpec(cpu_cores=16, ram_gb=64.0, has_gpu=True, vram_gb=16.0, gpu_name="RTX 4080")
#: 이 프로젝트 노트북 사양(RTX 4060 Laptop 8GB): Tier 2
TIER2_SPEC = HardwareSpec(cpu_cores=16, ram_gb=39.3, has_gpu=True, vram_gb=8.0, gpu_name="RTX 4060 Laptop")
#: 선택 산술이 통과하려면 런타임 종류/백엔드가 확인되어야 한다(prism_fork 양자화).
#: 호스트에 llama-server가 설치되었는지와 무관하게 증거를 주입한다.
READY_RUNTIME = {
    "present": True,
    "path": "C:/tools/llama-server.exe",
    "build": 12_000,
    "kind": "prism_fork",
    "backend": "cuda12",
}
#: 실행 조건의 마지막 조각(로컬 엔드포인트). 이것도 호스트 환경이 아니라 테스트가 준다.
READY_LOCAL_ENV = {"HARNESS_LOCAL_BASE_URL": "http://127.0.0.1:11434/v1"}


def select_background_on(
    registry,
    task_type="compaction",
    *,
    spec=TIER3_SPEC,
    tier=None,
    runtime=READY_RUNTIME,
    endpoint=True,
    weights_present=True,
):
    """실행 증거를 전부 주입한 상태로 백그라운드 배정을 조회한다.

    호스트의 실제 런타임/가중치/엔드포인트에 의존하지 않도록 ``detect_hardware``·
    ``probe_runtime``·``machine_profile``을 테스트가 직접 공급한다.
    """
    with patch("engine.registry.detect_hardware", return_value=spec), \
            patch("engine.registry.probe_runtime", return_value=runtime), \
            patch.dict(os.environ, READY_LOCAL_ENV if endpoint else {}):
        if not endpoint:
            os.environ.pop(BACKGROUND_ENDPOINT_ENV, None)
        machine = registry.machine_profile(
            registry.background_tier_info(),
            runtime=runtime,
            weights_present=weights_present,
        )
        return registry.select_background_model(task_type, tier=tier, machine=machine)


#: aux 평면의 저VRAM 대조군. 이 사양에서 aux 후보가 실제로 들어가는지 본다.
AUX_TEST_SPEC = TIER2_SPEC
AUX_TEST_MODEL_ID = "local/aux-test-tiny"


def select_aux_on(
    registry,
    task="title",
    *,
    spec=AUX_TEST_SPEC,
    tier=None,
    runtime=READY_RUNTIME,
    weights_present=True,
):
    """실행 증거를 전부 주입한 상태로 aux 배정을 조회한다(호스트 무의존).

    ``detect_hardware``·``probe_runtime``을 테스트가 공급하고, ``machine_profile``로
    가중치 3상태를 명시한다. aux 선택은 로컬 엔드포인트 환경변수에 의존하지 않는다.
    """
    with patch("engine.registry.detect_hardware", return_value=spec), \
            patch("engine.registry.probe_runtime", return_value=runtime):
        machine = registry.machine_profile(
            registry.aux_tier_info(),
            runtime=runtime,
            weights_present=weights_present,
        )
        return registry.select_aux_model(task, tier=tier, machine=machine)


def registry_with_confirmed_aux():
    """게이트를 통과할 수 있는 **테스트 픽스처** aux 항목을 넣은 레지스트리.

    배포 카탈로그의 선언 항목은 가중치가 미확인이라 실행 불가이므로, 게이트의
    "확인된 가중치에서만 ready" 계약을 검사하려면 확인된 요구량을 가진 항목이 하나
    필요하다. 여기 값은 테스트 픽스처일 뿐 카탈로그에 측정값으로 기록되지 않는다.
    """
    from engine.vram_budget import GIB

    registry = ModelIntelligenceRegistry()
    registry.register_model(
        ModelIntelligenceEntry(
            model_id=AUX_TEST_MODEL_ID,
            display_name="Aux test fixture (confirmed weights)",
            provider="local",
            intelligence_index=0.0,
            context_window=8_192,
            roles=["session_titler", "query_rewriter", "memory_distiller", "compactor"],
            pricing=PricingInfo(0.0, 0.0, 0.0),
            privacy=PrivacyPolicy(zero_data_retention=True, training_opt_out=True),
            weights_bytes=2 * GIB,
            kv_bytes_per_token=32_768,
            min_context=2_048,
            size_class="small",
            license="apache-2.0",
            quant_label="Q4_K_M",
            weights_basis="test_fixture",
            benchmark_note="test fixture, not a catalog claim",
        ),
        allow_special_exception=True,
    )
    return registry


class TestModelIntelligenceRegistry(unittest.TestCase):
    def setUp(self):
        self.registry = ModelIntelligenceRegistry()

    def test_verified_model_catalog(self):
        # OpenRouter 실측 모델 ID가 정상 등록되었는지 검증
        model_ids = {m.model_id for m in self.registry.catalog}
        expected = {
            "anthropic/claude-sonnet-4.5",
            "anthropic/claude-haiku-4.5",
            "deepseek/deepseek-chat-v3.1",
            "a6api/deepseek-chat-v3.1",
            "google/gemini-2.5-flash",
            "openai/gpt-4.1-mini",
            "z-ai/glm-4.5-air",
            "qwen/qwen3-coder-30b-a3b-instruct",
            "openrouter/d1-ultra",
            "openrouter/subq-snap-1.1",
            "openrouter/elephant-9b",
            "openrouter/drex-max",
            "baseten/mammoth-1",
            "local/qwen2.5-coder-1.5b-gguf",
            "local/qwen2.5-coder-7b-gguf",
            "local/qwen2.5-coder-14b-gguf",
            "local/bonsai-2-27b-pq2",
        }
        self.assertTrue(expected.issubset(model_ids), f"Missing: {expected - model_ids}")

    def test_privacy_routing_enforcement(self):
        # privacy_consent=False(기본) 시 No-Log + Opt-Out 충족 모델만 선택
        m_no_consent = self.registry.select_model("worker", mode="cost", privacy_consent=False)
        self.assertTrue(m_no_consent.privacy.zero_data_retention)
        self.assertTrue(m_no_consent.privacy.training_opt_out)

        # privacy_consent=True 시 저비용 프록시(A6API) 허용
        m_consent = self.registry.select_model("backend_worker", mode="cost", privacy_consent=True)
        self.assertEqual(m_consent.provider, "a6api")
        self.assertEqual(m_consent.model_id, "a6api/deepseek-chat-v3.1")

    def test_ecps_mathematical_formula_with_cache(self):
        # 캐시 적중률이 올라갈수록 ECPS가 감소해야 함
        ecps_no_cache = self.registry.expected_cost_per_success(
            "anthropic/claude-sonnet-4.5", "heavy_worker",
            input_tokens=10000, output_tokens=1000, cache_hit_ratio=0.0
        )
        ecps_cached = self.registry.expected_cost_per_success(
            "anthropic/claude-sonnet-4.5", "heavy_worker",
            input_tokens=10000, output_tokens=1000, cache_hit_ratio=0.8
        )
        self.assertLess(ecps_cached, ecps_no_cache)

        # 수식 일관성 검증: c = (T_in*(1-r)*P_in + T_in*r*P_cache + T_out*P_out) / 1e6
        # ECPS = c/p + lambda*c*(1-p)/p
        entry = self.registry.get_model("deepseek/deepseek-chat-v3.1")
        p = self.registry.success_probability("deepseek/deepseek-chat-v3.1", "worker")
        c = (1000 * 0.5 * entry.pricing.input_per_million
             + 1000 * 0.5 * entry.pricing.cache_read_per_million
             + 500 * entry.pricing.output_per_million) / 1_000_000.0
        expected_ecps = (c / p) + 0.5 * c * (1.0 - p) / p
        actual_ecps = self.registry.expected_cost_per_success(
            "deepseek/deepseek-chat-v3.1", "worker",
            input_tokens=1000, output_tokens=500, cache_hit_ratio=0.5, retry_penalty_factor=0.5
        )
        self.assertAlmostEqual(actual_ecps, expected_ecps, places=9)

    def test_embedded_opencodex_gateway_bundle_info(self):
        # 단일 배포 앱(DeepSeek Harness)에 내장된 OpenCodex 게이트웨이 메타데이터 검증
        info = self.registry.app_bundle_info()
        self.assertEqual(info["release_version"], "2026.11.1")
        self.assertEqual(info["gateway_mode"], "embedded_opencodex_gateway")
        self.assertEqual(info["primary_model"], "deepseek/deepseek-v4.1-flash-1017")
        self.assertEqual(info["update_policy"], "periodic_developer_release")
        self.assertEqual(info["release_version"], CURATED_APP_RELEASE_VERSION)

        # 큐레이션 프리셋: 기본 모델이 카탈로그에 존재하고 balanced 라우팅에서 최우선 선택됨
        primary = self.registry.get_model(info["primary_model"])
        self.assertIn("main", primary.roles)
        self.assertEqual(self.registry.select_model("main", mode="balanced").model_id, info["primary_model"])

        # 런타임 스크래핑/동적 등록 없이 동봉된 정적 프리셋만 사용한다(카탈로그 불변)
        before = [m.model_id for m in self.registry.catalog]
        self.assertEqual(self.registry.app_bundle_info(), info)
        self.assertEqual([m.model_id for m in self.registry.catalog], before)

    def test_background_roles_registered_for_bonsai(self):
        # 백그라운드 인지 작업 전용 역할 3종이 유효 역할 집합에 포함되고,
        # Bonsai-2 27B 프리셋이 세 역할을 모두 명시적으로 보유하는지 검증
        for role in ("background_worker", "memory_distiller", "compactor"):
            self.assertIn(role, VALID_ROLES)
            # 승격도 같은 백그라운드 역할에 머문다(클라우드/Qwen 대체 금지)
            self.assertEqual(escalation_role(role), role)

        bonsai = self.registry.get_model(BACKGROUND_MODEL_ID)
        for role in ("background_worker", "memory_distiller", "compactor"):
            self.assertIn(role, bonsai.roles)
        self.assertEqual(bonsai.provider, "local")
        self.assertTrue(bonsai.privacy.zero_data_retention)
        self.assertTrue(bonsai.privacy.training_opt_out)
        self.assertEqual(self.registry.attempt_cost_usd(BACKGROUND_MODEL_ID, 20000, 4000), 0.0)

        # R-BG2-03: 승인 목록은 릴리스가 카탈로그에 고정한다. 백그라운드 역할을 선언한
        # 항목은 반드시 승인 목록에 속하고, 승인 목록 항목은 백그라운드 역할을 선언하며,
        # 포그라운드 코더(Qwen)와 Bonsai 가족이 함께 들어 있다. 고정 이름은 하나가 아니다.
        declared, approved = set(), set()
        for model in self.registry.catalog:
            if model.provider != "local":
                continue
            if set(model.roles) & BACKGROUND_ROLES:
                declared.add(model.model_id)
                self.assertTrue(model.bg_approved, model.model_id)
            if model.bg_approved:
                approved.add(model.model_id)
                self.assertTrue(set(model.roles) & BACKGROUND_ROLES, model.model_id)
        self.assertEqual(declared, approved)
        self.assertIn(BACKGROUND_MODEL_ID, approved)
        for model_id in (
            "local/bonsai-2-27b-ptq1", "local/bonsai-2-27b-q2", "local/bonsai-2-9b-pq2",
            "local/bonsai-2-4b-ptq1", "local/bonsai-2-2b-q2", "local/qwen2.5-coder-7b-gguf",
        ):
            self.assertIn(model_id, approved)

    def test_select_background_model_routes_to_bonsai(self):
        # 실행 조건(런타임/가중치/엔드포인트/하드웨어)을 모두 갖춘 Tier 3 에서는
        # 모든 백그라운드 작업 유형이 같은 전담 로컬 모델로 수렴한다.
        self.assertEqual(DEFAULT_BACKGROUND_TASK_TYPE, "compaction")
        task_types = (
            "compaction", "session_compaction", "title", "commit_message",
            "memory_indexing", "distillation", "rerank", "triage", "loop_guard",
            "diagnostics",
        )
        for task_type in task_types:
            selection = select_background_on(self.registry, task_type)
            self.assertEqual(selection.model_id, BACKGROUND_MODEL_ID, task_type)
            self.assertEqual(selection.candidate_model_id, BACKGROUND_MODEL_ID, task_type)
            self.assertEqual(selection.status, BACKGROUND_STATUS_READY, task_type)
            self.assertIsNone(selection.reason)
            self.assertTrue(selection.is_ready)
            role = self.registry.background_role_for(task_type)
            self.assertEqual(selection.role, role)
            self.assertIn(role, selection.require_entry().roles)

        # 기본 인자(task_type 미지정)만으로도 같은 모델이 배정된다.
        default_selection = select_background_on(self.registry)
        self.assertEqual(default_selection.model_id, BACKGROUND_MODEL_ID)
        self.assertEqual(default_selection.status, BACKGROUND_STATUS_READY)
        # 티어 인자를 적어 넘겨도(override) 실제 하드웨어가 Tier 3 이므로 ready.
        overridden = select_background_on(
            self.registry, tier=LocalExecutionTier.ADVANCED_LOCAL
        )
        self.assertEqual(overridden.status, BACKGROUND_STATUS_READY)

    def test_background_selection_is_unavailable_below_tier3(self):
        # Tier 0/1/2 하드웨어에서는 백그라운드를 실행할 수 없다: Qwen/클라우드 대체 없이
        # 명시적 unavailable. 런타임 증거를 넣어도 티어 게이트는 풀리지 않는다.
        task_types = ("compaction", "title", "memory_indexing", "rerank", "diagnostics")
        specs = {
            LocalExecutionTier.RULE_BASED_ONLY: HardwareSpec(4, 4.0, False, 0.0, ""),
            LocalExecutionTier.LIGHTWEIGHT_LOCAL: HardwareSpec(6, 12.0, False, 0.0, ""),
            LocalExecutionTier.STANDARD_LOCAL: HardwareSpec(16, 39.3, True, 8.0, "RTX 4060 Laptop"),
        }
        approved = {m.model_id for m in self.registry.catalog if m.bg_approved}
        for tier, spec in specs.items():
            with self.subTest(tier=tier.value):
                for task_type in task_types:
                    selection = select_background_on(
                        self.registry, task_type, spec=spec, tier=tier
                    )
                    self.assertEqual(selection.status, BACKGROUND_STATUS_UNAVAILABLE, task_type)
                    self.assertTrue(selection.is_unavailable)
                    # 실행 불가 → 실행 계약 필드(model_id/entry)는 비어 있다.
                    self.assertEqual(selection.model_id, "", task_type)
                    self.assertIsNone(selection.entry)
                    self.assertEqual(selection.required_tier, LocalExecutionTier.ADVANCED_LOCAL.value)
                    self.assertIn("below required advanced_local", selection.reason)
                    # 진단용 후보는 실제 선택기가 산출했을 때만, 승인 목록 안에서만 남는다.
                    if selection.candidate_model_id is not None:
                        self.assertIn(selection.candidate_model_id, approved)
                        self.assertNotIn("qwen2.5-coder-1.5b", selection.candidate_model_id)
                    # 대체 모델은 어떤 형태로도 반환되지 않는다.
                    with self.assertRaises(BackgroundModelUnavailableError):
                        selection.require_entry()
                    self.assertNotIn("qwen", selection.model_id)
                    self.assertNotIn("light_worker", selection.to_dict()["role"])

    def test_override_tier_cannot_fake_bonsai_capability(self):
        # Tier 2 노트북에서 tier=advanced_local 을 주장해도 실제 측정 사양이 부족하면 unavailable.
        selection = select_background_on(
            self.registry, spec=TIER2_SPEC, tier=LocalExecutionTier.ADVANCED_LOCAL
        )
        self.assertEqual(selection.status, BACKGROUND_STATUS_UNAVAILABLE)
        self.assertEqual(selection.model_id, "")
        self.assertIsNone(selection.entry)
        self.assertEqual(selection.tier, LocalExecutionTier.ADVANCED_LOCAL.value)
        self.assertEqual(selection.capability_tier, LocalExecutionTier.STANDARD_LOCAL.value)
        self.assertIn("below required advanced_local", selection.reason)
        self.assertIn("VRAM 8.0GB", selection.reason)
        # 선택 산술은 더 작은 승인 후보를 실제로 찾아냈지만, 티어 게이트가 실행을 막는다.
        self.assertIsNotNone(selection.candidate_model_id)
        self.assertNotEqual(selection.candidate_model_id, selection.model_id)

    def test_background_selection_reports_missing_local_endpoint(self):
        # Tier 3 + 런타임/가중치 증거가 있어도 로컬 엔드포인트가 없으면 ready가 아니다.
        ready = select_background_on(self.registry)  # 실행 조건 전체를 주입한 정상 조건
        self.assertEqual(ready.status, BACKGROUND_STATUS_READY)
        self.assertEqual(ready.require_entry().model_id, BACKGROUND_MODEL_ID)

        selection = select_background_on(self.registry, endpoint=False)
        self.assertEqual(selection.status, BACKGROUND_STATUS_UNAVAILABLE)
        self.assertEqual(selection.model_id, "")
        self.assertIsNone(selection.entry)
        # 후보 신원은 진단용으로 남고, 실행 가능 여부와 분리된다.
        self.assertEqual(selection.candidate_model_id, BACKGROUND_MODEL_ID)
        self.assertIn(f"{BACKGROUND_ENDPOINT_ENV} is not set", selection.reason)
        with self.assertRaises(BackgroundModelUnavailableError):
            selection.require_entry()

    def test_background_selection_without_approved_preset_reports_unavailable(self):
        # R-BG2-03: 승인 목록에서 27B PQ2_0이 빠지면 같은 목록 안의 다음 후보로 간다.
        # 목록 전체가 비면 대체 모델 없이 명시적 unavailable이다(상수 이름은 요구 조건이 아니다).
        without_pq2 = ModelIntelligenceRegistry()
        without_pq2._catalog.pop(BACKGROUND_MODEL_ID)
        next_choice = select_background_on(without_pq2)
        self.assertEqual(next_choice.status, BACKGROUND_STATUS_READY)
        self.assertEqual(next_choice.model_id, next_choice.candidate_model_id)
        self.assertTrue(next_choice.model_id.startswith("local/bonsai-"))

        # Bonsai 가족이 통째로 빠지면 남은 승인 후보로 대체하지 않고 이유를 밝힌다
        # (Qwen 7B는 승인 목록에 있으나 포그라운드가 이미 점유해 상주/교체 산술이 없다).
        no_bonsai = ModelIntelligenceRegistry()
        for model_id in [m.model_id for m in no_bonsai.catalog
                         if m.bg_approved and m.model_id.startswith("local/bonsai-")]:
            no_bonsai._catalog.pop(model_id)
        selection = select_background_on(no_bonsai)
        self.assertEqual(selection.status, BACKGROUND_STATUS_UNAVAILABLE)
        self.assertEqual(selection.model_id, "")
        self.assertIsNone(selection.entry)
        self.assertIn("no approved background model fits", selection.reason)
        with self.assertRaises(BackgroundModelUnavailableError):
            selection.require_entry()

        # 승인 목록 전체가 비면 적재 산술 자체가 후보를 못 만든다(no_fit).
        empty_approved = ModelIntelligenceRegistry()
        for model_id in [m.model_id for m in empty_approved.catalog if m.bg_approved]:
            empty_approved._catalog.pop(model_id)
        empty_selection = select_background_on(empty_approved)
        self.assertEqual(empty_selection.status, BACKGROUND_STATUS_UNAVAILABLE)
        self.assertEqual(empty_selection.model_id, "")
        self.assertIsNone(empty_selection.candidate_model_id)
        self.assertIsNone(empty_selection.entry)
        self.assertTrue(empty_selection.reason)
        with self.assertRaises(BackgroundModelUnavailableError):
            empty_selection.require_entry()

    def test_background_roles_never_resolve_through_normal_routing(self):
        # 일반 라우팅(select_model)으로 백그라운드 역할을 조회하면 대체 모델을 받을 수 없다.
        for role in sorted(set(BACKGROUND_TASK_ROLES.values())):
            with self.assertRaises(BackgroundModelUnavailableError):
                self.registry.select_model(role, mode="cost")

    def test_this_machine_reports_background_bonsai_unavailable(self):
        # 이 머신 같은 Tier 2 노트북(RTX 4060 Laptop 8GB / VRAM 12GB 미만)은
        # 백그라운드를 실행할 수 없다고 보고해야 한다(Qwen/클라우드 대체 없음).
        selection = select_background_on(self.registry, spec=TIER2_SPEC)
        self.assertEqual(selection.tier, LocalExecutionTier.STANDARD_LOCAL.value)
        self.assertEqual(selection.model_id, "")
        self.assertEqual(selection.status, BACKGROUND_STATUS_UNAVAILABLE)
        self.assertIn("below required advanced_local", selection.reason)
        self.assertIn("VRAM 8.0GB", selection.reason)
        self.assertEqual(selection.to_dict()["status"], BACKGROUND_STATUS_UNAVAILABLE)
        self.assertEqual(selection.to_dict()["model_id"], "")
        self.assertEqual(selection.to_dict()["candidate_model_id"], selection.candidate_model_id)

        # 런타임이 없으면 후보 자체가 만들어지지 않는다 — runtime_absent는 소프트 완화 대상이 아니다.
        no_runtime = select_background_on(
            self.registry,
            runtime={"present": False, "path": None, "build": None, "kind": None, "backend": None},
        )
        self.assertEqual(no_runtime.status, BACKGROUND_STATUS_UNAVAILABLE)
        self.assertEqual(no_runtime.model_id, "")
        self.assertIsNone(no_runtime.candidate_model_id)
        self.assertIsNone(no_runtime.entry)
        self.assertIn("runtime_absent", no_runtime.reason)
        with self.assertRaises(BackgroundModelUnavailableError):
            no_runtime.require_entry()

        # 가중치가 확인되지 않아도 마찬가지다.
        no_weights = select_background_on(self.registry, weights_present=False)
        self.assertEqual(no_weights.status, BACKGROUND_STATUS_UNAVAILABLE)
        self.assertIsNone(no_weights.candidate_model_id)
        self.assertIn("weights_missing", no_weights.reason)

    def test_background_selection_requires_confirmed_weights(self):
        # M-15 3상태: 가중치는 True만 "존재"다. None(미확인)은 없는 것과 같이 실행 불가이며,
        # 낙관적으로 통과시키면 적재할 수 없는 모델을 실행 가능하다고 보고하게 된다.
        # 나머지 조건(하드웨어 Tier 3/런타임/엔드포인트)은 전부 주입해 두고 가중치만 흔든다.
        from engine.vram_budget import REASON_WEIGHTS_UNCONFIRMED

        unconfirmed = select_background_on(self.registry, weights_present=None)
        self.assertEqual(unconfirmed.status, BACKGROUND_STATUS_UNAVAILABLE)
        self.assertFalse(unconfirmed.is_ready)
        self.assertEqual(unconfirmed.model_id, "")  # 실행 계약 필드는 비어 있다
        self.assertIsNone(unconfirmed.entry)
        self.assertIn(REASON_WEIGHTS_UNCONFIRMED, unconfirmed.reason)
        self.assertNotIn("weights_missing", unconfirmed.reason)
        with self.assertRaises(BackgroundModelUnavailableError):
            unconfirmed.require_entry()
        # 진단 후보도 만들지 않는다: 가중치 미확인은 후보 산출 이전의 미준비 상태다.
        self.assertIsNone(unconfirmed.candidate_model_id)

        # 같은 조건에서 가중치 존재를 확인해 주면 그때만 실행 가능해진다(대조군).
        confirmed = select_background_on(self.registry, weights_present=True)
        self.assertEqual(confirmed.status, BACKGROUND_STATUS_READY)
        self.assertEqual(confirmed.require_entry().model_id, confirmed.model_id)

    def test_background_swap_reason_without_co_residency_evaluation(self):
        # M-10: 여유 VRAM을 측정하지 못하면 상주 판정(co)이 None으로 남는다. 교체(swap)
        # 사유 문구가 이 None을 역참조하면 AttributeError가 나므로 그 경로를 고정한다.
        from engine.vram_budget import RESIDENCY_SWAP, select

        with patch("engine.registry.detect_hardware", return_value=TIER3_SPEC), \
                patch("engine.registry.probe_runtime", return_value=READY_RUNTIME):
            tier_info = self.registry.background_tier_info()
        profile = self.registry.machine_profile(
            tier_info, runtime=READY_RUNTIME, weights_present=True
        )
        self.assertIsNone(profile.vram_free_bytes)  # 측정 실패를 0으로 바꾸지 않는다

        decision = select(profile, self.registry.local_catalogue(), background_role="compactor")
        self.assertTrue(decision.available)
        self.assertIsNotNone(decision.bg_model_id)
        self.assertEqual(decision.residency, RESIDENCY_SWAP)
        self.assertIsNone(decision.co_residency)
        self.assertTrue(
            any("no co-residency evaluation" in reason for reason in decision.reasons),
            decision.reasons,
        )

    def test_beta_bernoulli_tracker_updates(self):
        model_id = "z-ai/glm-4.5-air"
        role = "light_worker"
        initial_prob = self.registry.success_probability(model_id, role)

        # 3회 연속 실패 기록 시 사후 성공확률 하락
        for _ in range(3):
            self.registry.record_outcome(model_id, role, success=False)
        penalized_prob = self.registry.success_probability(model_id, role)
        self.assertLess(penalized_prob, initial_prob)

        # 5회 연속 성공 기록 시 회복
        for _ in range(5):
            self.registry.record_outcome(model_id, role, success=True)
        recovered_prob = self.registry.success_probability(model_id, role)
        self.assertGreater(recovered_prob, penalized_prob)

    def test_aux_and_embedding_roles_registered(self):
        # aux 작업 역할과 embedding 역할이 VALID_ROLES와 작업 매핑에 포함된다.
        for role in (
            "session_titler", "query_rewriter", "memory_distiller",
            "compactor", "embedding",
        ):
            self.assertIn(role, VALID_ROLES)
            self.assertEqual(escalation_role(role), role)

        self.assertEqual(
            AUX_TASK_ROLES,
            {
                "title": "session_titler",
                "query_rewrite": "query_rewriter",
                "distillation": "memory_distiller",
                "compaction": "compactor",
                "embedding": "embedding",
            },
        )
        self.assertEqual(AUX_REQUIRED_TIER, LocalExecutionTier.LIGHTWEIGHT_LOCAL)

    def test_aux_selection_uses_declared_task_names(self):
        # 호출자는 역할 이름을 몰라도 된다: 작업 이름/별칭이 역할로 정규화되고,
        # 정규화는 select_aux_model의 결과(task_type/role)에 그대로 나타난다.
        registry = ModelIntelligenceRegistry()
        for task, expected in (
            ("title", ("title", "session_titler")),
            ("title_generation", ("title", "session_titler")),
            ("query-rewrite", ("query_rewrite", "query_rewriter")),
            ("rewrite", ("query_rewrite", "query_rewriter")),
            ("memory_distillation", ("distillation", "memory_distiller")),
            ("session_compaction", ("compaction", "compactor")),
            ("embed", ("embedding", "embedding")),
        ):
            selection = select_aux_on(registry, task, weights_present=False)
            self.assertEqual((selection.task_type, selection.role), expected, task)

        # 선언되지 않은 작업은 어떤 후보도 배정하지 않고 이유를 남긴다.
        unknown = select_aux_on(registry, "summarize_everything", weights_present=False)
        self.assertEqual(unknown.status, AUX_STATUS_UNAVAILABLE)
        self.assertEqual(unknown.role, "")
        self.assertEqual(unknown.model_id, "")
        self.assertIn("unknown aux task", unknown.reason)
        with self.assertRaises(AuxModelUnavailableError):
            unknown.require_entry()

    def test_new_aux_and_embedding_entries_have_no_fabricated_measurements(self):
        # 새로 선언한 소형 aux/임베딩 후보는 다운로드·로드·벤치마크된 적이 없다.
        # 따라서 가중치 크기, KV/token, 점수, 라이선스를 만들어 넣지 않고 미확인으로 둔다.
        from engine.vram_budget import REASON_CATALOG_PENDING, select

        for model_id, expected_roles in (
            ("local/aux-tiny-gguf", {"session_titler", "query_rewriter"}),
            ("local/aux-embed-gguf", {"embedding"}),
        ):
            entry = self.registry.get_model(model_id)
            self.assertEqual(entry.provider, "local")
            self.assertEqual(set(entry.roles), expected_roles)
            self.assertEqual(entry.intelligence_index, 0.0, model_id)
            self.assertIsNone(entry.weights_bytes, model_id)
            self.assertIsNone(entry.kv_bytes_per_token, model_id)
            self.assertIsNone(entry.license, model_id)
            self.assertTrue(entry.pending_confirmation, model_id)
            self.assertEqual(entry.weights_basis, "unverified", model_id)
            self.assertIn("no candidate is downloaded", entry.benchmark_note)
            self.assertEqual(self.registry.attempt_cost_usd(model_id, 10_000, 1_000), 0.0)

        # 런타임과 디스크 가중치를 True로 주입해도, 카탈로그 항목 자체가 pending_confirmation
        # 이므로 title/query_rewrite/embedding 은 배포 카탈로그만으로는 절대 ready가 되지 않는다.
        for task in ("title", "query_rewrite", "embedding"):
            selection = select_aux_on(self.registry, task, weights_present=True)
            self.assertEqual(selection.status, AUX_STATUS_UNAVAILABLE, task)
            self.assertTrue(selection.is_unavailable)
            self.assertFalse(selection.is_ready)
            self.assertEqual(selection.model_id, "")
            self.assertIsNone(selection.candidate_model_id)
            self.assertIsNone(selection.entry)
            self.assertIn(REASON_CATALOG_PENDING, selection.reason)
            with self.assertRaises(BackgroundModelUnavailableError):
                selection.require_entry()

        # vram_budget.select도 같은 pending 사유로 거절한다(별도 선택기 없음).
        with patch("engine.registry.detect_hardware", return_value=AUX_TEST_SPEC):
            profile = self.registry.machine_profile(
                self.registry.aux_tier_info(), runtime=READY_RUNTIME, weights_present=True
            )
        decision = select(profile, self.registry.local_catalogue(), aux_role="session_titler")
        self.assertFalse(decision.available)
        self.assertEqual(decision.reason, REASON_CATALOG_PENDING)

    def test_aux_selection_requires_confirmed_weights_and_distinguishes_reasons(self):
        # M-15 3상태 계약: 확인된 가중치(True)만 ready이고, False(weights_missing)와
        # None(weights_unconfirmed)은 사유 코드로 구분되며 둘 다 실행 불가다.
        from engine.vram_budget import REASON_WEIGHTS_MISSING, REASON_WEIGHTS_UNCONFIRMED

        registry = registry_with_confirmed_aux()

        missing = select_aux_on(registry, "title", weights_present=False)
        self.assertEqual(missing.status, AUX_STATUS_UNAVAILABLE)
        self.assertFalse(missing.is_ready)
        self.assertTrue(missing.is_unavailable)
        self.assertEqual(missing.model_id, "")
        self.assertIsNone(missing.candidate_model_id)
        self.assertIsNone(missing.entry)
        self.assertIn(REASON_WEIGHTS_MISSING, missing.reason)
        self.assertNotIn(REASON_WEIGHTS_UNCONFIRMED, missing.reason)
        with self.assertRaises(BackgroundModelUnavailableError):
            missing.require_entry()

        unconfirmed = select_aux_on(registry, "title", weights_present=None)
        self.assertEqual(unconfirmed.status, AUX_STATUS_UNAVAILABLE)
        self.assertFalse(unconfirmed.is_ready)
        self.assertTrue(unconfirmed.is_unavailable)
        self.assertEqual(unconfirmed.model_id, "")
        self.assertIsNone(unconfirmed.candidate_model_id)
        self.assertIsNone(unconfirmed.entry)
        self.assertIn(REASON_WEIGHTS_UNCONFIRMED, unconfirmed.reason)
        self.assertNotIn(REASON_WEIGHTS_MISSING, unconfirmed.reason)
        self.assertNotEqual(missing.reason, unconfirmed.reason)
        with self.assertRaises(BackgroundModelUnavailableError):
            unconfirmed.require_entry()

        # 같은 조건에서 가중치가 True로 확인될 때만 ready이며, 4개 aux 작업이 모두 배정된다.
        for task, expected_role in (
            ("title", "session_titler"),
            ("query_rewrite", "query_rewriter"),
            ("distillation", "memory_distiller"),
            ("compaction", "compactor"),
        ):
            ready = select_aux_on(registry, task, weights_present=True)
            self.assertEqual(ready.status, AUX_STATUS_READY, task)
            self.assertTrue(ready.is_ready)
            self.assertFalse(ready.is_unavailable)
            self.assertEqual(ready.role, expected_role)
            self.assertEqual(ready.model_id, AUX_TEST_MODEL_ID)
            self.assertEqual(ready.candidate_model_id, AUX_TEST_MODEL_ID)
            self.assertEqual(ready.require_entry().model_id, AUX_TEST_MODEL_ID)
            self.assertEqual(ready.require_entry().provider, "local")
            self.assertIsNone(ready.reason)
            self.assertTrue(ready.detail)

    def test_aux_selection_requires_lightweight_local_tier(self):
        # AUX_REQUIRED_TIER는 필요조건이다: rule_based_only 하드웨어에서는 가중치·런타임이
        # 확인되어도 aux 후보를 배정하지 않고, 요구 프로필(RAM/VRAM)을 사유에 남긴다.
        registry = registry_with_confirmed_aux()
        tier0_spec = HardwareSpec(4, 4.0, False, 0.0, "")
        blocked = select_aux_on(registry, "title", spec=tier0_spec, weights_present=True)
        self.assertEqual(blocked.status, AUX_STATUS_UNAVAILABLE)
        self.assertEqual(blocked.model_id, "")
        self.assertIsNone(blocked.entry)
        self.assertIn(f"below required {AUX_REQUIRED_TIER.value}", blocked.reason)
        self.assertIn("RAM >= 8GB or VRAM >= 2GB", blocked.reason)

        # 이 프로젝트 노트북(8 GB VRAM)은 lightweight_local 이상이므로, 가중치가 확인되면
        # 저VRAM에서도 같은 후보가 ready가 된다(aux 평면의 목적).
        low_vram = select_aux_on(registry, "title", spec=TIER2_SPEC, weights_present=True)
        self.assertEqual(low_vram.status, AUX_STATUS_READY)
        self.assertEqual(low_vram.model_id, AUX_TEST_MODEL_ID)

    def test_aux_models_are_rejected_as_foreground(self):
        # aux/백그라운드/임베딩 전용 모델은 어떤 경로로도 포그라운드 코더로 반환되지 않는다.
        from engine.vram_budget import REASON_FOREGROUND_ROLE_MISSING, select

        registry = registry_with_confirmed_aux()
        with patch("engine.registry.detect_hardware", return_value=TIER3_SPEC):
            profile = registry.machine_profile(
                registry.aux_tier_info(), runtime=READY_RUNTIME, weights_present=True
            )

        # 1) 일반 라우팅(select_model / rank_models)은 aux/임베딩 역할을 거부하고,
        #    포그라운드 역할을 조회할 때도 aux 전용 모델을 절대 고르지 않는다.
        for role in ("session_titler", "query_rewriter", "memory_distiller", "compactor", "embedding"):
            with self.assertRaises(BackgroundModelUnavailableError):
                registry.select_model(role, mode="cost")
            with self.assertRaises(BackgroundModelUnavailableError):
                registry.rank_models(role, mode="cost", include_local=True, route="local_only")

        for fg_role in ("main", "planner", "worker", "heavy_worker", "light_worker"):
            ranked_ids = {
                m.model_id
                for m in registry.rank_models(fg_role, mode="cost", include_local=True)
            }
            for non_fg in ("local/aux-tiny-gguf", "local/aux-embed-gguf", AUX_TEST_MODEL_ID, BACKGROUND_MODEL_ID):
                self.assertNotIn(non_fg, ranked_ids)

        # 2) vram_budget.select는 자동 선택에서도, foreground_model_id로 명시해도
        #    aux/백그라운드 전용 모델을 foreground_role_missing으로 거절한다.
        auto = select(profile, registry.local_catalogue())
        self.assertTrue(auto.available)
        self.assertEqual(auto.fore_model_id, "local/qwen2.5-coder-7b-gguf")

        for explicit_id in (AUX_TEST_MODEL_ID, BACKGROUND_MODEL_ID):
            explicit = select(
                profile, registry.local_catalogue(), foreground_model_id=explicit_id
            )
            self.assertFalse(explicit.available, explicit_id)
            self.assertEqual(explicit.reason, REASON_FOREGROUND_ROLE_MISSING, explicit_id)


class TestIntelligencePlanner(unittest.TestCase):
    def setUp(self):
        self.registry = ModelIntelligenceRegistry()
        self.planner = IntelligencePlanner(self.registry)

    def test_simple_task_fast_path(self):
        plan = self.planner.build_plan("src/app.py 오타 수정 및 포맷팅", mode="balanced")
        self.assertTrue(plan.fast_path)
        self.assertEqual(len(plan.nodes), 1)
        self.assertEqual(plan.nodes[0].role, "light_worker")
        self.assertIn("py_compile", plan.nodes[0].verification_command)

    def test_dynamic_dag_synthesis_multi_worker(self):
        prompt = "FastAPI 백엔드 auth 엔드포인트 구현; React 프론트엔드 로그인 UI 개발; 종합 단위 테스트"
        plan = self.planner.build_plan(prompt, mode="auto")
        self.assertFalse(plan.fast_path)
        roles = [n.role for n in plan.nodes]

        # planner -> backend/frontend workers (parallel) -> reviewer
        self.assertIn("planner", roles)
        self.assertTrue("backend_worker" in roles or "frontend_worker" in roles)
        self.assertIn("reviewer", roles)

        # worker 노드들이 선행 기획/스펙 노드에 의존하고, reviewer는 worker들을 의존하는지 검증
        workers = [n for n in plan.nodes if n.role in ("backend_worker", "frontend_worker", "worker")]
        self.assertGreaterEqual(len(workers), 2)
        lead_id = plan.nodes[0].node_id
        for w in workers:
            self.assertTrue(len(w.dependencies) >= 1)

        reviewer = [n for n in plan.nodes if n.role == "reviewer"][0]
        for w in workers:
            self.assertIn(w.node_id, reviewer.dependencies)

    def test_two_track_prompt_classification(self):
        # 트랙 1: 명확/간단한 작업 -> direct_execute (사전 조사 없이 즉시 작업)
        direct_prompt = "src/service.py 파일에 사용자 이메일 유효성 검사 함수 추가해"
        track_direct = self.planner.classify_execution_track(direct_prompt)
        self.assertEqual(track_direct, "direct_execute")
        plan_direct = self.planner.build_plan(direct_prompt, mode="auto")
        # researcher(1차 조사) 노드가 없어야 함
        self.assertNotIn("researcher", [n.role for n in plan_direct.nodes])

        # 트랙 2: 복잡/불명확한 작업 -> survey_and_plan (1차 조사 후 계획 수립)
        unclear_prompt = "분산 이벤트 브로커와 RUL 엔진 사이의 동시성 결함 원인을 조사하고 아키텍처 재설계 방안 수립"
        track_survey = self.planner.classify_execution_track(unclear_prompt)
        self.assertEqual(track_survey, "survey_and_plan")
        plan_survey = self.planner.build_plan(unclear_prompt, mode="auto")
        # 1단계 researcher(조사) 노드와 2단계 planner 노드가 선행 배치되어야 함
        roles = [n.role for n in plan_survey.nodes]
        self.assertEqual(roles[0], "researcher")
        self.assertEqual(roles[1], "planner")
        self.assertIn(plan_survey.nodes[0].node_id, plan_survey.nodes[1].dependencies)

    def test_ast_symbol_extraction_and_slicing(self):
        sample_code = (
            "import os\n\n"
            "class Engine:\n"
            "    def __init__(self, name: str):\n"
            "        self.name = name\n\n"
            "    def start(self) -> bool:\n"
            "        return True\n\n"
            "async def compute(x: int, y: int = 10) -> int:\n"
            "    return x + y\n"
        )
        symbols = self.planner.extract_symbols(sample_code)
        names = {s.name for s in symbols}
        self.assertIn("Engine", names)
        self.assertIn("start", names)
        self.assertIn("compute", names)

        # 특정 심볼만 슬라이스
        sliced = self.planner.slice_code(sample_code, symbols=["compute"])
        self.assertIn("async def compute", sliced)
        self.assertNotIn("class Engine", sliced)

        # 구조화된 슬라이스 사전 반환 검증
        slices = self.planner.extract_code_slices("src/worker.py", sample_code, symbols=["Engine.start"])
        self.assertEqual(len(slices), 1)
        self.assertEqual(slices[0]["name"], "start")
        self.assertEqual(slices[0]["qualification"], "Engine.start")


class TestDeterministicDAGOrchestrator(unittest.TestCase):
    def setUp(self):
        self.registry = ModelIntelligenceRegistry()
        self.planner = IntelligencePlanner(self.registry)
        temp = temporary_workspace()
        self.addCleanup(temp.cleanup)
        self.workspace = FileIsolationWorkspace(root=str(Path(temp.name) / "backups"), base_dir=temp.name)

    def test_escalation_respects_privacy_consent(self):
        # privacy_consent=False일 때 승격 모델도 반드시 ZDR 모델이어야 함
        orch = DeterministicDAGOrchestrator(self.registry, max_budget_usd=0.50, workspace=self.workspace)
        plan = self.planner.build_plan("백엔드 엔진 동시성 최적화 구현", privacy_consent=False)

        def runner_fail_then_escalate(node, attempt):
            # 1, 2차 실패 -> 3차 승격
            if attempt < 3:
                return False
            # 승격 시 선택된 모델의 프라이버시 검증
            model_entry = self.registry.get_model(node.model_id)
            self.assertTrue(model_entry.privacy.zero_data_retention)
            self.assertTrue(model_entry.privacy.training_opt_out)
            return True

        res = orch.execute_plan(plan, runner_fail_then_escalate)
        self.assertEqual(res["overall_status"], "completed")

    def test_actual_cost_accounting(self):
        orch = DeterministicDAGOrchestrator(self.registry, max_budget_usd=0.50, workspace=self.workspace)
        plan = self.planner.build_plan("단순 헬퍼 함수 구현", privacy_consent=False)

        # runner가 실제 발생한 토큰 비용(0.00123 USD)을 반환할 때 정확히 누적되는지 검증
        def mock_runner_with_cost(node, attempt):
            return AttemptOutcome(success=True, cost_usd=0.001234, model_id=node.model_id)

        res = orch.execute_plan(plan, mock_runner_with_cost)
        self.assertEqual(res["overall_status"], "completed")
        expected_total = round(0.001234 * len(plan.nodes), 8)
        self.assertAlmostEqual(res["spent_usd"], expected_total, places=6)

    def test_async_parallel_execution_layer(self):
        orch = DeterministicDAGOrchestrator(self.registry, max_budget_usd=0.50, max_parallelism=4, workspace=self.workspace)
        plan = self.planner.build_plan(
            "API 라우터 추가; 서비스 로직 구현; 데이터 모델 정의",
            mode="balanced"
        )
        # 여러 worker가 포함된 동일 레이어가 존재하는지 확인
        layers = orch.compute_execution_layers(plan)
        worker_layer = max(layers, key=len)
        self.assertGreaterEqual(len(worker_layer), 2)

        # Parallelism is only safe for disjoint targets; overlapping paths are serialized.
        for node in worker_layer:
            node.target_files = [f"{node.node_id}.py"]
            node.verification_command = self.planner._verification_for(node.target_files)
        peers = {n.node_id for n in worker_layer}
        arrived = set()
        gate = asyncio.Event()
        async def async_runner(node, attempt):
            if node.node_id in peers:
                arrived.add(node.node_id)
                if arrived == peers:
                    gate.set()
                await gate.wait()
            return True

        res = asyncio.run(orch.execute_plan_async(plan, async_runner))
        self.assertEqual(res["overall_status"], "completed")
        self.assertEqual(len(res["node_results"]), len(plan.nodes))

    def test_budget_exhaustion_halts_execution(self):
        # 0.0001 USD 초저예산으로 설정 시 BudgetExhaustedError 발생 검증
        orch = DeterministicDAGOrchestrator(self.registry, max_budget_usd=0.0001)
        plan = self.planner.build_plan("대규모 아키텍처 리팩터링 및 전체 테스트", mode="balanced")
        # 계획 검증(사전 예산 초과) 또는 실행 중 예산 초과 발생
        with self.assertRaises((ValueError, BudgetExhaustedError)):
            orch.execute_plan(plan, lambda node, attempt: (True, 0.05))

    def test_file_isolation_workspace_rollback(self):
        with temporary_workspace() as tmpdir:
            base = Path(tmpdir)
            target = base / "target.py"
            target.write_text("ORIGINAL_CONTENT", encoding="utf-8")

            workspace = FileIsolationWorkspace(root=str(base / "backups"), base_dir=str(base))
            orch = DeterministicDAGOrchestrator(self.registry, max_budget_usd=0.50, workspace=workspace)

            plan = ExecutionDAGPlan(
                plan_id="test-plan",
                task_complexity=3,
                fast_path=False,
                estimated_budget_usd=0.01,
                nodes=[
                    DAGNode(
                        node_id="node-1",
                        role="worker",
                        model_id="anthropic/claude-haiku-4.5",
                        reasoning_effort="low",
                        dependencies=[],
                        target_files=["target.py"],
                        instruction="오염 시도",
                    )
                ],
            )

            def sabotaging_runner(node, attempt):
                # 파일 덮어쓰기 후 실패 리턴
                target.write_text("CORRUPTED_CONTENT", encoding="utf-8")
                return False

            res = orch.execute_plan(plan, sabotaging_runner)
            self.assertEqual(res["overall_status"], "rolled_back")
            # 롤백 후 원본 내용이 그대로 복원되어야 함
            self.assertEqual(target.read_text(encoding="utf-8"), "ORIGINAL_CONTENT")


class TestHybridContextMemoryEngine(unittest.TestCase):
    def setUp(self):
        self.mem = HybridContextMemoryEngine(":memory:")

    def tearDown(self):
        self.mem.close()

    def test_fts5_sanitized_punctuation_search(self):
        # 특수문자, 따옴표, 구두점이 포함된 질의가 syntax error 없이 안전하게 검색되는지 검증
        self.mem.index_document("code", "AST Parser", "def extract_symbols(source: str) -> List[Symbol]: pass")
        self.mem.index_document("rule", "Privacy", "X-Privacy-Consent: true enforces zero data retention")

        # syntax error 유발 패턴
        queries = [
            'def extract_symbols(source: str):',
            'X-Privacy-Consent: true',
            'JSON["key"] == "value" * 10',
            'AND OR NOT () "" :: **',
        ]
        for q in queries:
            try:
                results = self.mem.search(q)
                self.assertIsInstance(results, list)
            except Exception as e:
                self.fail(f"Search raised an unexpected exception on query '{q}': {e}")

        # 정상 검색 적중 확인
        hits = self.mem.search("extract_symbols source", joiner="AND")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["title"], "AST Parser")

    def test_distill_and_summarize_background_hook(self):
        # 빈 입력은 빈 문자열을 반환(백그라운드 훅 안전성)
        self.assertEqual(self.mem.distill_and_summarize(""), "")
        self.assertEqual(self.mem.distill_and_summarize("   \n\t "), "")

        content = (
            "세션 히스토리 압축이 필요하다.\n"
            "결정: FTS5 인덱스는 Bonsai-2 27B로 증류한다.\n"
            "오류 원인은 토크나이저 구두점 처리였다.\n"
            "날씨 이야기와 잡담은 잡음이다.\n"
            "수정: sanitize_fts5_query가 구두점을 제거한다."
        )
        distilled = self.mem.distill_and_summarize(content)
        self.assertIsInstance(distilled, str)
        self.assertTrue(distilled.startswith("[Extractive summary]"))
        # 우선순위 문장(결정/원인/수정)이 3문장 상한 안에서 채택되고 잡음 문장은 탈락한다
        bullets = [ln for ln in distilled.splitlines() if ln.startswith("- ")]
        self.assertLessEqual(len(bullets), 3)
        self.assertIn("Bonsai-2 27B", distilled)
        self.assertIn("오류 원인", distilled)
        self.assertNotIn("날씨", distilled)

        # A model_id alone never turns extractive keyword selection into an LLM claim.
        custom = self.mem.distill_and_summarize(content, model_id="local/qwen2.5-coder-7b-gguf")
        self.assertEqual(custom, distilled)

        # 증류 메모리는 FTS5 인덱스로 통합되어 백그라운드 지식으로 검색 가능
        doc_id = self.mem.index_distilled_document("memory", "Session Distillation", content)
        self.assertTrue(doc_id)
        hits = self.mem.search("Bonsai", category="memory")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["title"], "Session Distillation")
        self.assertIn("[Extractive summary]", hits[0]["content"])

    def test_checkpoint_filesystem_restore(self):
        with temporary_workspace() as tmpdir:
            base = Path(tmpdir)
            f1 = base / "file1.txt"
            f2 = base / "file2.txt"
            f1.write_text("VERSION_1", encoding="utf-8")
            f2.write_text("VERSION_A", encoding="utf-8")

            # 체크포인트 저장
            self.mem.snapshot_filesystem("cp-v1", ["file1.txt", "file2.txt"], base_dir=str(base), metadata={"tag": "init"})

            # 파일 수정
            f1.write_text("VERSION_2_MODIFIED", encoding="utf-8")
            f2.write_text("VERSION_B_MODIFIED", encoding="utf-8")

            # 체크포인트로부터 파일시스템 실복원
            restored = self.mem.restore_to_filesystem("cp-v1", base_dir=str(base), expected_hashes={
                "file1.txt": hashlib.sha256(b"VERSION_2_MODIFIED").hexdigest(),
                "file2.txt": hashlib.sha256(b"VERSION_B_MODIFIED").hexdigest(),
            })
            self.assertEqual(len(restored), 2)
            self.assertEqual(f1.read_text(encoding="utf-8"), "VERSION_1")
            self.assertEqual(f2.read_text(encoding="utf-8"), "VERSION_A")


class TestHardwareProfilerAndTierSelector(unittest.TestCase):
    def tearDown(self):
        clear_hardware_cache()

    def test_detect_hardware_live(self):
        # 실측 하드웨어 감지 검증 (표준 라이브러리 fallback 정상 동작)
        spec = detect_hardware()
        self.assertIsInstance(spec, HardwareSpec)
        self.assertGreaterEqual(spec.cpu_cores, 1)
        self.assertGreaterEqual(spec.ram_gb, 0.0)
        self.assertIsInstance(spec.has_gpu, bool)
        self.assertGreaterEqual(spec.vram_gb, 0.0)
        self.assertIsInstance(spec.gpu_name, str)

        # to_dict 직렬화 검증
        d = spec.to_dict()
        self.assertIn("cpu_cores", d)
        self.assertIn("ram_gb", d)
        self.assertIn("has_gpu", d)
        self.assertIn("vram_gb", d)

    def test_determine_local_tier_all_four_tiers(self):
        # Tier 0: 저사양 (RAM < 8GB 또는 GPU 없는 저사양)
        spec_t0 = HardwareSpec(cpu_cores=4, ram_gb=4.0, has_gpu=False, vram_gb=0.0, gpu_name="")
        info_t0 = determine_local_tier(spec_t0)
        self.assertEqual(info_t0.tier, LocalExecutionTier.RULE_BASED_ONLY)
        self.assertIsNone(info_t0.registry_model_id)
        self.assertFalse(info_t0.uses_local_llm)
        self.assertIn("로컬 LLM 미사용", info_t0.quantization)

        # Tier 1: 경량 (RAM 8~16GB 또는 GPU VRAM 2~4GB)
        spec_t1_ram = HardwareSpec(cpu_cores=6, ram_gb=12.0, has_gpu=False, vram_gb=0.0, gpu_name="")
        info_t1_ram = determine_local_tier(spec_t1_ram)
        self.assertEqual(info_t1_ram.tier, LocalExecutionTier.LIGHTWEIGHT_LOCAL)
        self.assertEqual(info_t1_ram.registry_model_id, "local/qwen2.5-coder-1.5b-gguf")
        self.assertTrue(info_t1_ram.uses_local_llm)

        spec_t1_gpu = HardwareSpec(cpu_cores=4, ram_gb=6.0, has_gpu=True, vram_gb=3.0, gpu_name="GTX 1060 3GB")
        info_t1_gpu = determine_local_tier(spec_t1_gpu)
        self.assertEqual(info_t1_gpu.tier, LocalExecutionTier.LIGHTWEIGHT_LOCAL)

        # Tier 2: 표준 (RAM >= 16GB 또는 GPU VRAM >= 6GB)
        spec_t2_ram = HardwareSpec(cpu_cores=8, ram_gb=16.0, has_gpu=False, vram_gb=0.0, gpu_name="")
        info_t2_ram = determine_local_tier(spec_t2_ram)
        self.assertEqual(info_t2_ram.tier, LocalExecutionTier.STANDARD_LOCAL)
        self.assertEqual(info_t2_ram.registry_model_id, "local/qwen2.5-coder-7b-gguf")

        spec_t2_gpu = HardwareSpec(cpu_cores=8, ram_gb=8.0, has_gpu=True, vram_gb=8.0, gpu_name="RTX 4060")
        info_t2_gpu = determine_local_tier(spec_t2_gpu)
        self.assertEqual(info_t2_gpu.tier, LocalExecutionTier.STANDARD_LOCAL)

        # Tier 3: 고도 (RAM >= 32GB AND GPU VRAM >= 12GB)
        spec_t3 = HardwareSpec(cpu_cores=16, ram_gb=64.0, has_gpu=True, vram_gb=16.0, gpu_name="RTX 4080")
        info_t3 = determine_local_tier(spec_t3)
        self.assertEqual(info_t3.tier, LocalExecutionTier.ADVANCED_LOCAL)
        self.assertEqual(info_t3.registry_model_id, "local/bonsai-2-27b-pq2")
        self.assertIn("PQ2_0", info_t3.quantization)
        self.assertIn("Ternary 2.13 bpw", info_t3.quantization)

        # RAM은 32GB 이상이나 GPU VRAM이 부족한 경우 Tier 2로 판정
        spec_t3_novram = HardwareSpec(cpu_cores=16, ram_gb=64.0, has_gpu=True, vram_gb=4.0, gpu_name="GTX 1650")
        info_t3_novram = determine_local_tier(spec_t3_novram)
        self.assertEqual(info_t3_novram.tier, LocalExecutionTier.STANDARD_LOCAL)

    def test_tier_comparison_and_override(self):
        self.assertTrue(LocalExecutionTier.RULE_BASED_ONLY < LocalExecutionTier.LIGHTWEIGHT_LOCAL)
        self.assertTrue(LocalExecutionTier.STANDARD_LOCAL < LocalExecutionTier.ADVANCED_LOCAL)
        self.assertTrue(LocalExecutionTier.ADVANCED_LOCAL >= LocalExecutionTier.STANDARD_LOCAL)

        # 사용자 override 지정 검증
        low_spec = HardwareSpec(cpu_cores=2, ram_gb=4.0, has_gpu=False, vram_gb=0.0, gpu_name="")
        overridden = determine_local_tier(low_spec, override_tier="standard_local")
        self.assertEqual(overridden.tier, LocalExecutionTier.STANDARD_LOCAL)
        self.assertTrue(overridden.override_applied)
        self.assertEqual(overridden.capability_tier, LocalExecutionTier.RULE_BASED_ONLY)

    def test_local_model_catalog_pricing_and_privacy(self):
        # 로컬 모델 0달러 단가 및 ZDR 보장 검증
        registry = ModelIntelligenceRegistry()
        for local_id in ("local/qwen2.5-coder-1.5b-gguf", "local/qwen2.5-coder-7b-gguf", "local/qwen2.5-coder-14b-gguf", "local/bonsai-2-27b-pq2"):
            entry = registry.get_model(local_id)
            self.assertEqual(entry.provider, "local")
            self.assertEqual(entry.pricing.input_per_million, 0.0)
            self.assertEqual(entry.pricing.output_per_million, 0.0)
            self.assertEqual(entry.pricing.cache_read_per_million, 0.0)
            self.assertTrue(entry.privacy.zero_data_retention)
            self.assertTrue(entry.privacy.training_opt_out)
            self.assertEqual(registry.attempt_cost_usd(local_id, 10000, 2000), 0.0)

    def test_fixed_decision_models_catalog(self):
        # 고정 의사결정 모델 카탈로그 검증 (baseten/mammoth-1 포함)
        registry = ModelIntelligenceRegistry()
        fixed_models = [
            ("baseten/mammoth-1", "baseten", "planner", 88.0),
            ("openrouter/d1-ultra", "openrouter", "planner", 72.0),
            ("openrouter/subq-snap-1.1", "openrouter", "planner", 48.0),
            ("openrouter/elephant-9b", "openrouter", "planner", 54.0),
            ("openrouter/drex-max", "openrouter", "planner", 68.0),
        ]
        for mid, provider, role, min_intel in fixed_models:
            entry = registry.get_model(mid)
            self.assertEqual(entry.provider, provider)
            self.assertIn(role, entry.roles)
            self.assertGreaterEqual(entry.intelligence_index, min_intel)
            self.assertTrue(entry.privacy.zero_data_retention)

        mammoth = registry.get_model("baseten/mammoth-1")
        self.assertEqual(mammoth.pricing.input_per_million, 0.10)
        self.assertEqual(mammoth.pricing.output_per_million, 0.0)
        self.assertEqual(mammoth.pricing.cache_read_per_million, 0.01)

        # 의사결정 사다리(tiered selection ladder) 라우팅 검증
        planner = IntelligencePlanner(registry)
        self.assertEqual(planner.select_decision_model(mode="quality", complexity=5), "baseten/mammoth-1")
        self.assertEqual(planner.select_decision_model(mode="balanced", complexity=5), "baseten/mammoth-1")
        self.assertEqual(planner.select_decision_model(mode="cost", complexity=7), "baseten/mammoth-1")
        self.assertEqual(planner.select_decision_model(mode="speed", complexity=3), "openrouter/subq-snap-1.1")
        self.assertEqual(planner.select_decision_model(mode="max", complexity=5), "openrouter/drex-max")
        self.assertEqual(planner.select_decision_model(mode="cost", complexity=5), "openrouter/elephant-9b")

    def test_decision_planner_under_tier0_vs_tier2(self):
        registry = ModelIntelligenceRegistry()
        planner = IntelligencePlanner(registry)
        simple_prompt = "src/app.py 오타 수정 및 포맷팅"
        complex_prompt = "분산 이벤트 브로커와 RUL 엔진 사이의 동시성 결함 원인을 조사하고 아키텍처 재설계 방안 수립"

        # --- 무동의(privacy_consent=False)는 클라우드로 폴백하지 않는다 ---
        # 동의 없는 턴의 경로는 LOCAL_ONLY이며, 어떤 노드도 클라우드 모델을 받지 않는다.
        # (과거 이 테스트는 무동의 Tier 0 이 클라우드 flash 로 가는 것을 기대했으나, 이는
        #  from_privacy_consent 계약 -- 무동의 = LOCAL_ONLY -- 과 충돌하는 폐기된 기대다.)
        no_consent = planner.build_plan(simple_prompt, mode="balanced",
                                        hardware_tier=LocalExecutionTier.RULE_BASED_ONLY)
        self.assertTrue(no_consent.fast_path)
        self.assertEqual(no_consent.route.value, "local_only")
        self.assertFalse(no_consent.privacy_consent)
        self.assertTrue(no_consent.nodes[0].model_id.startswith("local/"))
        self.assertNotIn("deepseek", no_consent.nodes[0].model_id)

        # 복잡 작업도 무동의면 전 노드가 로컬이며 클라우드 결정 모델이 끼지 않는다.
        no_consent_complex = planner.build_plan(complex_prompt, mode="balanced",
                                                hardware_tier=LocalExecutionTier.RULE_BASED_ONLY)
        self.assertFalse(no_consent_complex.fast_path)
        self.assertEqual(no_consent_complex.route.value, "local_only")
        for node in no_consent_complex.nodes:
            self.assertEqual(registry.get_model(node.model_id).provider, "local", node.role)

        # --- 명시적 클라우드 동의(privacy_consent=True)에서만 티어별 배정을 확인한다 ---
        # Tier 0 (rule_based_only): 로컬 LLM 없음 -> Fast-Path가 클라우드 기본 flash 모델 호출
        plan_t0 = planner.build_plan(simple_prompt, mode="balanced",
                                     hardware_tier=LocalExecutionTier.RULE_BASED_ONLY,
                                     privacy_consent=True)
        self.assertTrue(plan_t0.fast_path)
        self.assertEqual(plan_t0.route.value, "zdr_cloud")
        self.assertEqual(plan_t0.nodes[0].model_id, "deepseek/deepseek-v4.1-flash-1017")

        # Tier 1 (lightweight_local): Fast-Path가 로컬 1.5B GGUF 모델로 즉시 분기 (비용 0 USD)
        plan_t1 = planner.build_plan(simple_prompt, mode="balanced",
                                     hardware_tier=LocalExecutionTier.LIGHTWEIGHT_LOCAL,
                                     privacy_consent=True)
        self.assertTrue(plan_t1.fast_path)
        self.assertEqual(plan_t1.nodes[0].model_id, "local/qwen2.5-coder-1.5b-gguf")
        self.assertEqual(plan_t1.nodes[0].estimated_cost_usd, 0.0)

        # Tier 2 (standard_local): Fast-Path가 로컬 7B GGUF 모델로 즉시 분기 (비용 0 USD)
        plan_t2 = planner.build_plan(simple_prompt, mode="balanced",
                                     hardware_tier=LocalExecutionTier.STANDARD_LOCAL,
                                     privacy_consent=True)
        self.assertTrue(plan_t2.fast_path)
        self.assertEqual(plan_t2.nodes[0].model_id, "local/qwen2.5-coder-7b-gguf")
        self.assertEqual(plan_t2.nodes[0].estimated_cost_usd, 0.0)

        # 복잡한 작업(survey_and_plan), Tier 0 + 동의:
        # 조사/계획은 의사결정 모델(baseten/mammoth-1)이 맡는 클라우드 파이프라인이다.
        plan_complex_t0 = planner.build_plan(complex_prompt, mode="balanced",
                                             hardware_tier=LocalExecutionTier.RULE_BASED_ONLY,
                                             privacy_consent=True)
        self.assertFalse(plan_complex_t0.fast_path)
        roles = [n.role for n in plan_complex_t0.nodes]
        self.assertEqual(roles[0], "researcher")
        self.assertEqual(roles[1], "planner")
        # Planner 노드에 고정 의사결정 모델 배정 확인 (mammoth-1 우선 배정)
        self.assertEqual(plan_complex_t0.nodes[1].model_id, "baseten/mammoth-1")

        # Tier 2 + 동의: 1단계 조사(researcher)가 로컬 7B 모델로 처리되어 0비용 조사 수행
        plan_complex_t2 = planner.build_plan(complex_prompt, mode="balanced",
                                             hardware_tier=LocalExecutionTier.STANDARD_LOCAL,
                                             privacy_consent=True)
        self.assertEqual(plan_complex_t2.nodes[0].model_id, "local/qwen2.5-coder-7b-gguf")
        self.assertEqual(plan_complex_t2.nodes[0].estimated_cost_usd, 0.0)
        # 계획(planner) 노드는 고정 의사결정 모델로 클라우드 고품질 수립
        self.assertEqual(plan_complex_t2.nodes[1].model_id, "baseten/mammoth-1")

    def test_turn_plan_and_deterministic_guardrails(self):
        # TurnPlan 구조체 및 검증 가드레일(turn_validator) 단위 테스트
        from engine.decision_planner import (
            TurnPlan,
            SubagentSlot,
            default_turn_plan,
            validate_turn_plan,
            ExecutionRoute,
        )

        registry = ModelIntelligenceRegistry()
        planner = IntelligencePlanner(registry)

        # 1. Fallback default_turn_plan 생성 검증 (local_only)
        plan_default = default_turn_plan(
            planner,
            prompt="간단한 리팩토링 수행",
            route=ExecutionRoute.LOCAL_ONLY,
            privacy_consent=False,
        )
        self.assertEqual(plan_default.origin, "defaults")
        self.assertEqual(plan_default.model_id, "local/qwen2.5-coder-7b-gguf")
        self.assertEqual(plan_default.expected_cost_class, "local_zero")
        self.assertEqual(len(plan_default.subagents), 0)

        # 2. 검증기 통과 검증 (로컬 모델 및 기본 도구)
        val = validate_turn_plan(
            plan_default,
            registry=registry,
            route=ExecutionRoute.LOCAL_ONLY,
            privacy_consent=False,
        )
        self.assertTrue(val.accepted)
        self.assertEqual(val.effective_model_id, "local/qwen2.5-coder-7b-gguf")
        self.assertEqual(len(val.violations), 0)

        # 3. Guardrail: 클라우드 모델을 동의 없이 로컬 라우트에 요청 시 V-02 거부
        cloud_plan = TurnPlan(
            turn_id="turn-cloud",
            origin="model",
            model_id="deepseek/deepseek-v4.1-flash-1017",
            subagents=[],
        )
        val_cloud_rejected = validate_turn_plan(
            cloud_plan,
            registry=registry,
            route=ExecutionRoute.LOCAL_ONLY,
            privacy_consent=False,
        )
        self.assertFalse(val_cloud_rejected.accepted)
        self.assertEqual(val_cloud_rejected.violations[0]["check"], "V-02")

        # 4. Guardrail: 서브에이전트 초과 요청 시 clamp (최대 4개)
        excessive_subagents = [
            SubagentSlot(role="researcher", count=3),
            SubagentSlot(role="worker", count=4),
        ]
        subagent_plan = TurnPlan(
            turn_id="turn-subagents",
            origin="model",
            model_id="local/qwen2.5-coder-7b-gguf",
            subagents=excessive_subagents,
            tools=["read", "glob", "bash", "unknown_tool"],
            reasoning_grade="invalid_grade",
        )
        val_clamped = validate_turn_plan(
            subagent_plan,
            registry=registry,
            route=ExecutionRoute.LOCAL_ONLY,
            privacy_consent=False,
            available_tools=["read", "glob", "grep", "find", "bash"],
        )
        self.assertTrue(val_clamped.accepted)
        total_subagents = sum(s.count for s in val_clamped.effective_subagents)
        self.assertEqual(total_subagents, 4)
        self.assertEqual(val_clamped.effective_reasoning_grade, "off")
        self.assertIn("tools:widen_rejected_unknown_tool", val_clamped.clamps)
        self.assertIn("bash", val_clamped.approvals_required)


if __name__ == "__main__":
    unittest.main()


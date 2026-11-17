"""aux_tasks 테스트: 로컬 전용 선택, provenance, 폴백 vs 예외, 예산, 상한, 1회 재시도.

모든 테스트는 가짜 ``lm_client``와 가짜 레지스트리 선택을 쓴다(네트워크/모델 없음).
"""
from __future__ import annotations

import unittest
from types import SimpleNamespace

from engine.aux_tasks import (
    AUX_TASKS,
    FALLBACK_POLICIES,
    LOCAL_ROUTE,
    AuxCloudProviderRefused,
    AuxModelOutputError,
    AuxRegistryContractError,
    AuxTaskError,
    AuxTaskRunner,
    AuxTaskUnavailable,
    AuxTransportError,
    QueryRewrite,
    cap_text,
    normalize_text,
)
from engine.decision_planner import estimate_tokens
from engine.lm_client import ProviderUnavailable, RateLimitError

READY_MODEL = "local/tiny-test-1"


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #
class FakeLmClient:
    """``chat_stream`` 대역.

    ``script`` 항목은 다음 중 하나다: 문자열(그대로 yield), 예외(던짐), 또는
    ``(usage, exception)`` 튜플 — 이 경우 ``usage``를 먼저 보고한 뒤 예외를 던져
    "비용을 보고하고 실패한 시도"를 재현한다(``usage=None``이면 usage 미보고).
    """

    def __init__(self, script=None, cost_usd=0.0, usage_model_id=None):
        self.script = list(script or [])
        self.cost_usd = cost_usd
        self.usage_model_id = usage_model_id
        self.calls = []
        self.usage = None

    def chat_stream(self, messages, model=None, route="zdr_cloud", timeout=60):
        self.calls.append({"messages": messages, "model": model, "route": route})
        if not self.script:
            raise AssertionError("unexpected extra model call (retry loop?)")
        item = self.script.pop(0)
        if isinstance(item, tuple):  # (usage, exception) — 보고 후 실패
            self.usage, failure = item
            raise failure
        if isinstance(item, BaseException):
            raise item
        self.usage = SimpleNamespace(
            input_tokens=1,
            output_tokens=1,
            cached_tokens=0,
            cost_usd=self.cost_usd,
            model_id=self.usage_model_id if self.usage_model_id is not None else (model or ""),
        )
        return iter([item])


def usage(cost_usd, model_id="", input_tokens=1, output_tokens=1):
    return SimpleNamespace(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cached_tokens=0,
        cost_usd=cost_usd,
        model_id=model_id,
    )


def make_selection(
    status="ready",
    model_id=READY_MODEL,
    provider="local",
    reason=None,
    detail=None,
    purge_entry=False,
):
    """``AuxModelSelection`` 계약(status/is_ready/model_id/entry/require_entry/reason/detail)."""

    class Selection:
        def __init__(self):
            self.status = status
            self.model_id = "" if purge_entry and status != "ready" else (model_id or "")
            self.reason = reason
            self.detail = detail
            self.entry = None if purge_entry else (
                SimpleNamespace(model_id=model_id, provider=provider) if status == "ready" else None
            )

        @property
        def is_ready(self):
            return self.status == "ready"

        def require_entry(self):
            if self.entry is None:
                raise RuntimeError(f"not ready: {self.reason}")
            return self.entry

    return Selection()


class FakeRegistry:
    """aux 선택기만 제공한다. 포그라운드 선택기는 호출되면 실패한다."""

    def __init__(self, selection=None, error=None):
        self.selection = selection if selection is not None else make_selection()
        self.error = error
        self.aux_calls = []
        self.foreground_calls = []

    def select_aux_model(self, task, tier=None, machine=None, foreground_model_id=None):
        self.aux_calls.append(
            {
                "task": task,
                "tier": tier,
                "machine": machine,
                "foreground_model_id": foreground_model_id,
            }
        )
        if self.error is not None:
            raise self.error
        return self.selection

    def select_model(self, *args, **kwargs):  # pragma: no cover - 호출 자체가 계약 위반
        self.foreground_calls.append((args, kwargs))
        raise AssertionError("foreground selector must never be used for aux tasks")


class BackgroundOnlyRegistry:
    """``select_aux_model``이 없는 레지스트리 — 이제는 계약 위반으로 **크게 실패**해야 한다.

    과거의 백그라운드 선택기 어댑터는 작업 이름을 다른 역할로 바꾸고 게이트를 상향했으므로
    (8 GB → 32 GB) 제거되었다. 이 대역은 그 대체 경로가 다시 살아나지 않았는지 확인한다.
    """

    def __init__(self, status="ready", reason=None):
        self.status = status
        self.reason = reason
        self.bg_calls = []

    def select_background_model(self, task_type="compaction", tier=None, machine=None,
                                foreground_model_id=None):  # pragma: no cover - 호출 금지
        self.bg_calls.append({"task": task_type, "tier": tier, "machine": machine})
        raise AssertionError("select_background_model must not be used for aux tasks")


class SignatureDriftRegistry:
    """``select_aux_model``이 존재하지만 합의된 키워드를 받지 않는다(드리프트)."""

    def __init__(self):
        self.calls = []

    def select_aux_model(self, task, tier=None):  # pragma: no cover - 호출되면 실패해야 한다
        self.calls.append({"task": task, "tier": tier})
        raise AssertionError("signature drift must be refused before calling the selector")


class NoSelectorRegistry:
    def select_model(self, *args, **kwargs):  # pragma: no cover - 호출 금지
        raise AssertionError("foreground selector must never be used for aux tasks")


UNAVAILABLE = make_selection(
    status="unavailable",
    model_id="",
    reason="HARNESS_LOCAL_BASE_URL is not set",
    detail="tier standard_local below required advanced_local",
    purge_entry=True,
)


def conversation():
    return [
        {"role": "user", "content": "  Fix   the   streaming bug\nin lm_client"},
        {"role": "assistant", "content": "I will inspect the SSE parser."},
    ]


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #
class ReadyLocalModelCase(unittest.TestCase):
    def test_title_uses_local_model_with_zero_cost(self):
        registry = FakeRegistry(make_selection())
        client = FakeLmClient(["  `Streaming   bug fix.`  "])
        runner = AuxTaskRunner(client, registry)

        title = runner.title_session(conversation())

        self.assertEqual(title.text, "Streaming bug fix")
        self.assertEqual(title.source, "model")
        self.assertEqual(title.provider, "local")
        self.assertEqual(title.model_id, READY_MODEL)
        self.assertEqual(title.cost_usd, 0.0)
        self.assertTrue(title.is_local)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(client.calls[0]["model"], READY_MODEL)
        self.assertEqual(client.calls[0]["route"], LOCAL_ROUTE)
        self.assertEqual([call["task"] for call in registry.aux_calls], ["title"])
        self.assertEqual(registry.foreground_calls, [])
        self.assertIn("conversation", client.calls[0]["messages"][1]["content"])

    def test_all_four_jobs_route_through_aux_selector_only(self):
        registry = FakeRegistry(make_selection())
        client = FakeLmClient(
            [
                "Short title",
                '[{"text": "prefers pytest", "category": "preference"}]',
                "Earlier turns agreed to keep the SSE parser.",
                "streaming SSE parse failure",
            ]
        )
        runner = AuxTaskRunner(client, registry)
        transcript = conversation() * 6

        runner.title_session(conversation())
        runner.distill_memory(conversation())
        runner.compact_context(transcript, 100)
        runner.rewrite_query("the bug", history=conversation())

        self.assertEqual([call["task"] for call in registry.aux_calls],
                         ["title", "distillation", "compaction", "query_rewrite"])
        self.assertEqual(registry.foreground_calls, [])
        self.assertEqual({call["route"] for call in client.calls}, {LOCAL_ROUTE})
        stats = runner.stats()
        self.assertEqual(stats["selection_api"], {"select_aux_model": 4})
        self.assertEqual(stats["totals"]["model"] + stats["totals"]["fallback"]
                         + stats["totals"]["structural"], 4)
        self.assertEqual(stats["cost_usd"], 0.0)

    def test_distillation_candidates_are_deduplicable(self):
        registry = FakeRegistry(make_selection())
        client = FakeLmClient(
            ['```json\n[{"text": "Prefers  pytest"}, {"text": "prefers Pytest"}, '
             '{"text": "Ships on Fridays", "category": "decision"}, "bare string"]\n```']
        )
        runner = AuxTaskRunner(client, registry)

        candidates = runner.distill_memory(conversation())

        self.assertEqual(len(candidates), 3)
        self.assertEqual(candidates[0].text, "Prefers pytest")
        self.assertEqual(candidates[1].category, "decision")
        self.assertEqual(candidates[2].category, "note")
        keys = [candidate.canonical_key for candidate in candidates]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(all(candidate.source == "model" for candidate in candidates))

    def test_compaction_uses_model_summary_inside_budget(self):
        registry = FakeRegistry(make_selection())
        client = FakeLmClient(["Decision: keep the SSE parser. Open: retry policy."])
        runner = AuxTaskRunner(client, registry, max_summary_tokens=40)
        transcript = [
            {"role": "user", "content": f"turn {index} " + "details " * 40}
            for index in range(10)
        ]

        result = runner.compact_context(transcript, 200)

        self.assertEqual(result.source, "model")
        self.assertTrue(result.summary_applied)
        self.assertLessEqual(result.token_count, 200)
        self.assertGreater(result.dropped_count, 0)
        self.assertEqual(result.messages[0]["role"], "system")
        self.assertIn("keep the SSE parser", result.messages[0]["content"])
        self.assertIn("dropped", result.dropped_digest)
        self.assertEqual(result.token_count,
                         sum(estimate_tokens(m["content"]) for m in result.messages))


class UnavailabilityCase(unittest.TestCase):
    def test_title_falls_back_and_is_labelled(self):
        registry = FakeRegistry(UNAVAILABLE)
        client = FakeLmClient([])
        runner = AuxTaskRunner(client, registry)

        title = runner.title_session(conversation())

        self.assertEqual(title.source, "fallback")
        self.assertEqual(title.provider, "none")
        self.assertEqual(title.model_id, "")
        self.assertEqual(title.cost_usd, 0.0)
        self.assertEqual(title.text, "Fix the streaming bug in lm_client")
        self.assertIn("HARNESS_LOCAL_BASE_URL is not set", title.provenance.reason)
        self.assertEqual(client.calls, [])
        stats = runner.stats()
        self.assertEqual(stats["jobs"]["title"]["fallback"], 1)
        self.assertEqual(stats["jobs"]["title"]["model"], 0)

    def test_distillation_raises_with_selection_reason(self):
        registry = FakeRegistry(UNAVAILABLE)
        runner = AuxTaskRunner(FakeLmClient([]), registry)

        with self.assertRaises(AuxTaskUnavailable) as caught:
            runner.distill_memory(conversation())

        self.assertEqual(caught.exception.task, "distillation")
        self.assertEqual(caught.exception.reason, "HARNESS_LOCAL_BASE_URL is not set")
        self.assertEqual(caught.exception.detail, "tier standard_local below required advanced_local")
        self.assertIn("HARNESS_LOCAL_BASE_URL is not set", str(caught.exception))
        self.assertEqual(runner.stats()["jobs"]["distillation"]["unavailable"], 1)
        self.assertEqual(runner.stats()["jobs"]["distillation"]["fallback"], 0)

    def test_compaction_falls_back_to_structural_keep_newest(self):
        registry = FakeRegistry(UNAVAILABLE)
        client = FakeLmClient([])
        runner = AuxTaskRunner(client, registry)
        transcript = [
            {"role": "user", "content": f"turn {index} " + "payload " * 30}
            for index in range(8)
        ]

        result = runner.compact_context(transcript, 200)

        self.assertEqual(result.source, "fallback")
        self.assertEqual(result.provider, "none")
        self.assertFalse(result.summary_applied)
        self.assertLessEqual(result.token_count, 200)
        self.assertGreater(result.dropped_count, 0)
        self.assertEqual(result.dropped_indexes, tuple(range(result.dropped_count)))
        self.assertEqual(result.messages[-1]["content"], transcript[-1]["content"])
        self.assertIn("HARNESS_LOCAL_BASE_URL is not set", result.provenance.reason)
        self.assertEqual(client.calls, [])

    def test_rewrite_falls_back_to_normalized_query(self):
        registry = FakeRegistry(UNAVAILABLE)
        runner = AuxTaskRunner(FakeLmClient([]), registry, max_query_chars=20)

        rewritten = runner.rewrite_query("  the\n\nstreaming   bug  ")

        self.assertIsInstance(rewritten, str)
        self.assertEqual(rewritten.source, "fallback")
        self.assertEqual(rewritten, "the streaming bug")
        self.assertLessEqual(len(rewritten), 20)

    def test_documented_fallback_policies_match_behaviour(self):
        self.assertEqual(FALLBACK_POLICIES, {
            "title": "fallback",
            "distillation": "raise",
            "compaction": "fallback",
            "query_rewrite": "fallback",
        })
        runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(make_selection()))
        for job in AUX_TASKS:
            self.assertEqual(runner.fallback_policy(job), FALLBACK_POLICIES[job])

    def test_registry_without_aux_selector_is_refused_loudly(self):
        """백그라운드 선택기로 역할/게이트를 바꾸는 조용한 대체는 금지(계약 위반)."""
        registry = BackgroundOnlyRegistry()
        runner = AuxTaskRunner(FakeLmClient([]), registry)

        with self.assertRaises(AuxRegistryContractError) as caught:
            runner.title_session(conversation())

        self.assertIn("select_aux_model", caught.exception.reason)
        self.assertEqual(registry.bg_calls, [])
        self.assertEqual(runner.stats()["jobs"]["title"]["error"], 1)
        self.assertEqual(runner.stats()["selection_api"], {})

    def test_registry_without_any_selector_is_refused(self):
        runner = AuxTaskRunner(FakeLmClient([]), NoSelectorRegistry())
        with self.assertRaises(AuxRegistryContractError):
            runner.title_session(conversation())
        with self.assertRaises(AuxRegistryContractError):
            runner.distill_memory(conversation())

    def test_signature_drift_is_refused_before_calling_the_selector(self):
        registry = SignatureDriftRegistry()
        runner = AuxTaskRunner(FakeLmClient([]), registry)

        with self.assertRaises(AuxRegistryContractError) as caught:
            runner.rewrite_query("query")

        self.assertIn("machine", caught.exception.reason)
        self.assertIn("foreground_model_id", caught.exception.reason)
        self.assertEqual(registry.calls, [])


class NoCloudFallbackCase(unittest.TestCase):
    def test_cloud_selection_is_refused_even_for_fallback_jobs(self):
        cloud = make_selection(provider="openrouter", model_id="anthropic/claude-sonnet-4.5")
        registry = FakeRegistry(cloud)
        client = FakeLmClient(["should never be used"])
        runner = AuxTaskRunner(client, registry)
        long_transcript = [
            {"role": "user", "content": f"turn {index} " + "details " * 40} for index in range(10)
        ]

        for job_call in (
            lambda: runner.title_session(conversation()),
            lambda: runner.rewrite_query("query"),
            lambda: runner.compact_context(long_transcript, 400),
            lambda: runner.distill_memory(conversation()),
        ):
            with self.assertRaises(AuxCloudProviderRefused) as caught:
                job_call()
            self.assertEqual(caught.exception.provider, "openrouter")
        self.assertEqual(client.calls, [])
        self.assertEqual(registry.foreground_calls, [])
        self.assertEqual({call["task"] for call in registry.aux_calls},
                         {"title", "query_rewrite", "compaction", "distillation"})

    def test_local_route_is_the_only_transport_route(self):
        client = FakeLmClient(["ok"])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))
        runner.title_session(conversation())
        self.assertEqual(client.calls[0]["route"], "local_only")
        self.assertNotIn("any_cloud", str(client.calls))

    def test_injected_paid_client_is_recorded_and_not_labelled_local(self):
        client = FakeLmClient(["Title"], cost_usd=0.0025)
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        title = runner.title_session(conversation())

        self.assertEqual(title.source, "model")
        self.assertEqual(title.provider, "external")
        self.assertFalse(title.is_local)
        self.assertEqual(title.cost_usd, 0.0025)
        self.assertTrue(title.cost_known)
        stats = runner.stats()
        self.assertEqual(stats["paid_calls"], 1)
        self.assertEqual(stats["external_cost_usd"], 0.0025)
        self.assertEqual(stats["cost_usd"], 0.0)


class CostProvenanceCase(unittest.TestCase):
    """미상 비용은 "무료"가 아니고, 모델 불일치는 "로컬"이 아니다."""

    def test_unknown_cost_is_not_reported_as_free_local(self):
        client = FakeLmClient(["Title"], cost_usd=None)
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        title = runner.title_session(conversation())

        self.assertEqual(title.source, "model")
        self.assertEqual(title.provider, "unknown")
        self.assertFalse(title.is_local)
        self.assertIsNone(title.cost_usd)
        self.assertFalse(title.cost_known)
        self.assertIn("pricing unknown", title.provenance.reason)
        stats = runner.stats()
        self.assertEqual(stats["unknown_cost_calls"], 1)
        self.assertEqual(stats["paid_calls"], 0)
        self.assertEqual(stats["cost_usd"], 0.0)

    def test_missing_usage_is_unknown_not_free(self):
        class NoUsageClient:
            usage = None

            def __init__(self, reply):
                self.reply = reply
                self.calls = 0

            def chat_stream(self, messages, model=None, route="zdr_cloud", timeout=60):
                self.calls += 1
                return iter([self.reply])

        client = NoUsageClient("Title")
        title = AuxTaskRunner(client, FakeRegistry(make_selection())).title_session(conversation())

        self.assertEqual(title.provider, "unknown")
        self.assertIsNone(title.cost_usd)
        self.assertFalse(title.is_local)
        self.assertIn("no usage", title.provenance.reason)

    def test_negative_cost_is_unknown(self):
        client = FakeLmClient(["Title"], cost_usd=-0.5)
        title = AuxTaskRunner(client, FakeRegistry(make_selection())).title_session(conversation())
        self.assertEqual(title.provider, "unknown")
        self.assertIsNone(title.cost_usd)

    def test_nan_cost_is_unknown(self):
        client = FakeLmClient(["Title"], cost_usd=float("nan"))
        title = AuxTaskRunner(client, FakeRegistry(make_selection())).title_session(conversation())
        self.assertEqual(title.provider, "unknown")
        self.assertIsNone(title.cost_usd)

    def test_model_id_mismatch_is_unknown_provenance(self):
        client = FakeLmClient(["Title"], cost_usd=0.0, usage_model_id="cloud/other-model")
        title = AuxTaskRunner(client, FakeRegistry(make_selection())).title_session(conversation())

        self.assertEqual(title.provider, "unknown")
        self.assertFalse(title.is_local)
        self.assertIn("cloud/other-model", title.model_id)
        self.assertIn("!=", title.provenance.reason)

    def test_matching_reported_model_stays_local(self):
        client = FakeLmClient(["Title"], cost_usd=0.0, usage_model_id=READY_MODEL)
        title = AuxTaskRunner(client, FakeRegistry(make_selection())).title_session(conversation())
        self.assertEqual(title.provider, "local")
        self.assertEqual(title.model_id, READY_MODEL)
        self.assertTrue(title.is_local)

    def test_paid_attempt_lost_to_retry_is_still_recorded(self):
        client = FakeLmClient(
            [
                (usage(0.01, READY_MODEL), ProviderUnavailable("reset after billing")),
                "Recovered title",
            ]
        )
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        title = runner.title_session(conversation())

        self.assertEqual(title.text, "Recovered title")
        self.assertEqual(title.source, "model")
        self.assertEqual(title.provider, "external")
        self.assertEqual(title.cost_usd, 0.01)
        self.assertEqual(title.provenance.attempts, 2)
        stats = runner.stats()
        self.assertEqual(stats["paid_calls"], 1)
        self.assertEqual(stats["external_cost_usd"], 0.01)
        self.assertEqual(stats["cost_usd"], 0.0)

    def test_paid_attempts_sum_across_failed_and_successful_attempts(self):
        client = FakeLmClient(
            [
                (usage(0.01, READY_MODEL), ProviderUnavailable("reset after billing")),
                (usage(0.02, READY_MODEL), ProviderUnavailable("still down")),
            ]
        )
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        with self.assertRaises(AuxTransportError):
            runner.title_session(conversation())

        stats = runner.stats()
        self.assertEqual(stats["external_cost_usd"], 0.03)
        # paid_calls는 "청구 이벤트"가 아니라 **유료 시도 수**다.
        self.assertEqual(stats["paid_calls"], 2)
        self.assertEqual(stats["jobs"]["title"]["paid_call"], 2)

    def test_two_billed_attempts_then_success_report_two_paid_attempts(self):
        client = FakeLmClient([(usage(0.01, READY_MODEL), ProviderUnavailable("billed, reset")), "Title"])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        title = runner.title_session(conversation())

        self.assertEqual(title.provider, "external")
        self.assertEqual(title.cost_usd, 0.01)
        stats = runner.stats()
        self.assertEqual(stats["paid_calls"], 1)
        self.assertEqual(stats["external_cost_usd"], 0.01)

    def test_stale_usage_object_is_not_billed_twice(self):
        """같은 usage 객체를 값 변경 없이 다시 읽어도 중복 청구하지 않는다."""

        class StickyUsageClient:
            def __init__(self):
                self.usage = usage(0.01, READY_MODEL)
                self.calls = 0

            def chat_stream(self, messages, model=None, route="zdr_cloud", timeout=60):
                self.calls += 1
                if self.calls == 1:
                    raise ProviderUnavailable("billed then failed")
                if self.calls == 2:
                    raise ProviderUnavailable("still down, usage left stale")
                return iter(["unused"])

        client = StickyUsageClient()
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        with self.assertRaises(AuxTransportError):
            runner.title_session(conversation())

        stats = runner.stats()
        self.assertEqual(stats["external_cost_usd"], 0.01)
        self.assertEqual(stats["paid_calls"], 1)

    def test_distinct_usage_objects_are_never_suppressed_by_address_reuse(self):
        """잔여 결함 재현: 시도마다 새 usage 객체를 만들고 이전 객체를 버려도 지출이 남는다.

        과거 구현은 ``id(usage)``로 중복을 판단해, 두 번째 객체가 재활용된 주소를 받으면
        (관측상 200회 중 1회) 0.04 지출을 ``provider="local"``/``cost_usd=0.0``로 숨겼다.
        지금은 원장이 관측한 ``usage`` 참조를 계속 붙들므로 주소 재사용 자체가 불가능하다.
        """

        class FreshUsageClient:
            usage = None

            def __init__(self):
                self.calls = 0

            def chat_stream(self, messages, model=None, route="zdr_cloud", timeout=60):
                self.calls += 1
                if self.calls == 1:
                    self.usage = usage(0.0, READY_MODEL)  # 실패 시도: 무료 보고
                    raise ProviderUnavailable("reset, nothing billed")
                self.usage = usage(0.04, READY_MODEL)  # 성공 시도: 실제 지출
                return iter(["Title"])

        for iteration in range(200):
            client = FreshUsageClient()
            runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

            title = runner.title_session(conversation())

            stats = runner.stats()
            self.assertEqual(title.provider, "external", f"iteration {iteration}")
            self.assertEqual(title.cost_usd, 0.04, f"iteration {iteration}")
            self.assertEqual(stats["paid_calls"], 1, f"iteration {iteration}")
            self.assertEqual(stats["external_cost_usd"], 0.04, f"iteration {iteration}")

    def test_mutated_single_usage_object_records_the_new_cost(self):
        """잔여 결함 재현: 장수 usage 객체를 mutate하는 클라이언트도 지출을 잃지 않는다."""

        class MutatingClient:
            def __init__(self):
                self.usage = usage(0.0, READY_MODEL)
                self.calls = 0

            def chat_stream(self, messages, model=None, route="zdr_cloud", timeout=60):
                self.calls += 1
                if self.calls == 1:
                    raise ProviderUnavailable("first attempt billed 0.09 but failed")
                # 같은 객체를 제자리에서 갱신한다(주소 동일, 값만 다름).
                self.usage.cost_usd = 0.09
                return iter(["Title"])

        client = MutatingClient()
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        title = runner.title_session(conversation())

        self.assertEqual(title.provider, "external")
        self.assertEqual(title.cost_usd, 0.09)
        stats = runner.stats()
        self.assertEqual(stats["paid_calls"], 1)
        self.assertEqual(stats["external_cost_usd"], 0.09)

    def test_mutated_usage_across_two_failures_keeps_both_charges(self):
        class MutatingFailClient:
            def __init__(self):
                self.usage = usage(0.0, READY_MODEL)
                self.calls = 0

            def chat_stream(self, messages, model=None, route="zdr_cloud", timeout=60):
                self.calls += 1
                self.usage.cost_usd = 0.05 * self.calls
                raise ProviderUnavailable(f"attempt {self.calls} billed then failed")

        runner = AuxTaskRunner(MutatingFailClient(), FakeRegistry(make_selection()))

        with self.assertRaises(AuxTransportError):
            runner.title_session(conversation())

        stats = runner.stats()
        self.assertEqual(stats["external_cost_usd"], 0.15)
        self.assertEqual(stats["paid_calls"], 2)

    def test_paid_call_with_unusable_output_keeps_paid_provenance(self):
        client = FakeLmClient(["   "], cost_usd=0.0025)
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        title = runner.title_session(conversation())

        self.assertEqual(title.source, "fallback")
        self.assertEqual(title.provider, "external")
        self.assertFalse(title.is_local)
        self.assertEqual(title.cost_usd, 0.0025)
        self.assertIn("empty title", title.provenance.reason)
        stats = runner.stats()
        self.assertEqual(stats["paid_calls"], 1)
        self.assertEqual(stats["external_cost_usd"], 0.0025)
        self.assertEqual(stats["jobs"]["title"]["fallback"], 1)

    def test_paid_rewrite_with_unusable_output_keeps_paid_provenance(self):
        client = FakeLmClient(["\n  \n"], cost_usd=0.004)
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        rewritten = runner.rewrite_query("the bug")

        self.assertEqual(rewritten.source, "fallback")
        self.assertEqual(rewritten.provider, "external")
        self.assertFalse(rewritten.is_local)
        self.assertEqual(rewritten.cost_usd, 0.004)
        self.assertEqual(str(rewritten), "the bug")
        self.assertEqual(runner.stats()["external_cost_usd"], 0.004)

    def test_paid_compaction_with_empty_summary_keeps_paid_provenance(self):
        client = FakeLmClient(["   "])
        client.cost_usd = 0.006
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))
        transcript = [{"role": "user", "content": f"turn {i} " + "details " * 40} for i in range(10)]

        result = runner.compact_context(transcript, 200)

        self.assertFalse(result.summary_applied)
        self.assertEqual(result.provider, "external")
        self.assertEqual(result.cost_usd, 0.006)
        self.assertEqual(runner.stats()["external_cost_usd"], 0.006)

    def test_unknown_cost_on_terminal_failure_is_counted(self):
        class NoUsageFailingClient:
            usage = None

            def chat_stream(self, messages, model=None, route="zdr_cloud", timeout=60):
                raise ProviderUnavailable("down, no usage reported")

        runner = AuxTaskRunner(NoUsageFailingClient(), FakeRegistry(make_selection()))

        with self.assertRaises(AuxTransportError):
            runner.title_session(conversation())

        stats = runner.stats()
        self.assertEqual(stats["unknown_cost_calls"], 1)
        self.assertEqual(stats["jobs"]["title"]["unknown_cost"], 1)
        self.assertEqual(stats["paid_calls"], 0)

    def test_unpriced_cost_on_terminal_failure_is_counted(self):
        client = FakeLmClient(
            [
                (usage(None, READY_MODEL), ProviderUnavailable("billed, unpriceable")),
                (usage(None, READY_MODEL), ProviderUnavailable("still down")),
            ]
        )
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        with self.assertRaises(AuxTransportError):
            runner.title_session(conversation())

        stats = runner.stats()
        self.assertEqual(stats["unknown_cost_calls"], 1)
        self.assertEqual(stats["paid_calls"], 0)
        self.assertEqual(stats["external_cost_usd"], 0.0)

    def test_non_transient_failure_with_unpriced_cost_is_counted(self):
        client = FakeLmClient([(usage(None, READY_MODEL), RateLimitError("429"))])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        with self.assertRaises(AuxTransportError):
            runner.rewrite_query("query")

        self.assertEqual(runner.stats()["unknown_cost_calls"], 1)

    def test_non_numeric_cost_string_is_unknown_not_billed(self):
        client = FakeLmClient(["Title"], cost_usd="0.5")
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        title = runner.title_session(conversation())

        self.assertEqual(title.provider, "unknown")
        self.assertIsNone(title.cost_usd)
        self.assertIn("non-numeric", title.provenance.reason)
        self.assertEqual(runner.stats()["paid_calls"], 0)
        self.assertEqual(runner.stats()["unknown_cost_calls"], 1)

    def test_boolean_cost_is_unknown_not_billed(self):
        for value in (True, False):
            client = FakeLmClient(["Title"], cost_usd=value)
            runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

            title = runner.title_session(conversation())

            self.assertEqual(title.provider, "unknown", f"cost={value!r}")
            self.assertIsNone(title.cost_usd)
            self.assertEqual(runner.stats()["paid_calls"], 0)
            self.assertEqual(runner.stats()["unknown_cost_calls"], 1)


class BudgetAndBoundsCase(unittest.TestCase):
    def test_compaction_respects_small_budget_and_reports_drops(self):
        registry = FakeRegistry(UNAVAILABLE)
        runner = AuxTaskRunner(FakeLmClient([]), registry)
        transcript = [
            {"role": "user", "content": "word " * 400},
            {"role": "assistant", "content": "word " * 400},
            {"role": "user", "content": "word " * 400},
        ]

        result = runner.compact_context(transcript, 5)

        self.assertLessEqual(result.token_count, 5)
        self.assertEqual(result.token_budget, 5)
        self.assertEqual(len(result.messages), 1)
        self.assertTrue(result.truncated)
        self.assertEqual(result.dropped_count, 2)
        self.assertGreater(result.dropped_token_count, 0)
        self.assertIn("2 earlier message(s) dropped", result.dropped_digest)

    def test_compaction_without_pressure_calls_no_model(self):
        client = FakeLmClient([])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        result = runner.compact_context(conversation(), 1000)

        self.assertEqual(client.calls, [])
        self.assertEqual(result.source, "fallback")
        self.assertEqual(result.dropped_count, 0)
        self.assertEqual(result.dropped_digest, "nothing dropped")
        self.assertEqual(result.token_count,
                         sum(estimate_tokens(m["content"]) for m in result.messages))

    def test_budget_invariant_holds_for_every_budget(self):
        transcript = [
            {"role": "user", "content": "short"},
            {"role": "assistant", "content": "medium length answer " * 5},
            {"role": "user", "content": "long question " * 40},
            {"role": "assistant", "content": "x"},
        ]
        for budget in range(1, 41):
            runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(UNAVAILABLE))
            result = runner.compact_context(transcript, budget)
            self.assertLessEqual(result.token_count, budget, f"budget {budget} exceeded")
            self.assertEqual(
                result.token_count,
                sum(estimate_tokens(message["content"]) for message in result.messages),
                f"budget {budget} count mismatch",
            )
            self.assertEqual(len(result.messages) + result.dropped_count, len(transcript))

    def test_token_budget_must_be_positive(self):
        runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(UNAVAILABLE))
        with self.assertRaises(ValueError):
            runner.compact_context(conversation(), 0)

    def test_title_is_length_capped_and_whitespace_normalized(self):
        client = FakeLmClient(["Fix   the\tSSE   parser streaming bug in lm_client and more"])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()), title_max_chars=20)

        title = runner.title_session(conversation())

        self.assertLessEqual(len(title.text), 20)
        self.assertTrue(title.text.endswith("…"))
        self.assertNotIn("  ", title.text)
        self.assertEqual(title.source, "model")

    def test_title_strips_fence_and_label(self):
        client = FakeLmClient(["```text\nTitle: Compaction budget fix.\n```"])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))
        self.assertEqual(runner.title_session(conversation()).text, "Compaction budget fix")

    def test_rewrite_is_length_capped_and_normalized(self):
        client = FakeLmClient(["  Streaming   bug\nin the SSE  parser plus extra words here  "])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()), max_query_chars=18)

        rewritten = runner.rewrite_query("bug", history=conversation())

        self.assertLessEqual(len(rewritten), 18)
        self.assertNotIn("\n", rewritten)
        self.assertNotIn("  ", rewritten)
        self.assertEqual(rewritten.source, "model")
        payload = client.calls[0]["messages"][1]["content"]
        self.assertIn("history", payload)

    def test_cap_and_normalize_helpers(self):
        self.assertEqual(normalize_text("  a \n\t b  "), "a b")
        self.assertEqual(cap_text("short", 10), "short")
        self.assertEqual(cap_text("exactly_10", 10), "exactly_10")
        self.assertEqual(cap_text("elevenchars", 10), "elevencha…")
        self.assertLessEqual(len(cap_text("a " * 50, 7)), 7)
        self.assertEqual(cap_text("text", 0), "")

    def test_candidates_and_items_are_bounded(self):
        reply = "[" + ", ".join(
            '{"text": "item%02d %s"}' % (i, "x" * 400) for i in range(20)
        ) + "]"
        client = FakeLmClient([reply])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()),
                               max_candidate_chars=30, max_candidates=5)

        candidates = runner.distill_memory(conversation())

        self.assertEqual(len(candidates), 5)
        self.assertTrue(all(len(candidate.text) <= 30 for candidate in candidates))
        self.assertEqual(len({candidate.canonical_key for candidate in candidates}), 5)

    def test_unusable_distillation_output_raises_without_retry(self):
        client = FakeLmClient(["no json here"])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))
        with self.assertRaises(AuxModelOutputError):
            runner.distill_memory(conversation())
        self.assertEqual(len(client.calls), 1)


class RetryCase(unittest.TestCase):
    def test_transient_error_retries_exactly_once_and_succeeds(self):
        client = FakeLmClient([ProviderUnavailable("connection reset"), "Recovered title"])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        title = runner.title_session(conversation())

        self.assertEqual(title.text, "Recovered title")
        self.assertEqual(title.source, "model")
        self.assertEqual(title.provenance.attempts, 2)
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(runner.stats()["jobs"]["title"]["transport_retries"], 1)

    def test_transient_error_stops_after_one_retry(self):
        client = FakeLmClient(
            [ProviderUnavailable("reset"), ProviderUnavailable("still down")]
        )
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        with self.assertRaises(AuxTransportError) as caught:
            runner.title_session(conversation())

        self.assertTrue(caught.exception.transient)
        self.assertEqual(caught.exception.attempts, 2)
        self.assertEqual(len(client.calls), 2)

    def test_retry_count_is_clamped_to_one(self):
        client = FakeLmClient(
            [ProviderUnavailable("reset"), ProviderUnavailable("still down"), "never used"]
        )
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()), max_transport_retries=5)

        with self.assertRaises(AuxTransportError) as caught:
            runner.title_session(conversation())

        self.assertEqual(runner.max_transport_retries, 1)
        self.assertEqual(caught.exception.attempts, 2)
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(runner.stats()["jobs"]["title"]["transport_retries"], 1)

    def test_non_transient_error_is_not_retried(self):
        client = FakeLmClient([RateLimitError("rate limited"), "unused"])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        with self.assertRaises(AuxTransportError) as caught:
            runner.rewrite_query("query")

        self.assertFalse(caught.exception.transient)
        self.assertEqual(caught.exception.attempts, 1)
        self.assertEqual(len(client.calls), 1)


class SmallBudgetReadyModelCase(unittest.TestCase):
    """High 회귀: 준비된 모델이라도 작은 예산에서 예산을 넘거나 빈 요약을 넣지 않는다."""

    TRANSCRIPT = [
        {"role": "user", "content": "first " + "alpha " * 60},
        {"role": "assistant", "content": "second " + "beta " * 60},
        {"role": "user", "content": "third " + "gamma " * 60},
        {"role": "assistant", "content": "fourth " + "delta " * 60},
    ]

    def test_every_budget_respects_limit_and_never_inserts_empty_summary(self):
        for budget in range(1, 65):
            with self.subTest(budget=budget):
                client = FakeLmClient(["summary text"] * 4)
                runner = AuxTaskRunner(client, FakeRegistry(make_selection()))
                result = runner.compact_context(self.TRANSCRIPT, budget)

                self.assertLessEqual(result.token_count, budget)
                self.assertEqual(
                    result.token_count,
                    sum(estimate_tokens(message["content"]) for message in result.messages),
                )
                self.assertTrue(all(m["content"].strip() for m in result.messages))
                # 요약이 들어가지 않았다면 요약 메시지도, 모델 호출도 없어야 한다.
                if not result.summary_applied:
                    self.assertTrue(
                        all(m["role"] != "system" for m in result.messages),
                        f"budget {budget} inserted an unsolicited system message",
                    )
                if result.summary_applied:
                    self.assertEqual(result.source, "model")
                    self.assertGreater(result.dropped_count + result.truncated_token_count, 0)

    def test_no_model_call_when_no_summary_budget_fits(self):
        client = FakeLmClient([])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))
        minimum = runner._summary_minimum()

        for budget in range(1, minimum * 4):
            runner.compact_context(self.TRANSCRIPT, budget)
        self.assertEqual(client.calls, [])
        self.assertEqual(runner.stats()["jobs"]["compaction"]["structural"], minimum * 4 - 1)
        self.assertEqual(runner.stats()["jobs"]["compaction"]["model"], 0)

    def test_summary_budget_exists_only_above_the_minimum(self):
        runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(make_selection()))
        minimum = runner._summary_minimum()
        self.assertEqual(runner._summary_reservation(minimum * 4 - 1), 0)
        self.assertGreaterEqual(runner._summary_reservation(minimum * 4), minimum)

    def test_model_summary_never_exceeds_budget_at_the_boundary(self):
        client = FakeLmClient(["a fairly long summary " * 20] * 4)
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))
        minimum = runner._summary_minimum()

        result = runner.compact_context(self.TRANSCRIPT, minimum * 4)

        self.assertTrue(result.summary_applied)
        self.assertEqual(result.source, "model")
        self.assertLessEqual(result.token_count, minimum * 4)
        self.assertLessEqual(
            estimate_tokens(result.messages[0]["content"]), minimum
        )


class TruncationAccountingCase(unittest.TestCase):
    """Medium 5 회귀: 잘려 나간 꼬리가 버린 내용 회계와 digest에 나타난다."""

    def test_truncated_tail_is_reported_as_lost(self):
        transcript = [{"role": "user", "content": "keep " * 300}]
        runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(UNAVAILABLE))

        result = runner.compact_context(transcript, 20)

        self.assertTrue(result.truncated)
        self.assertEqual(result.truncated_message_index, 0)
        self.assertGreater(result.truncated_token_count, 0)
        self.assertEqual(result.dropped_count, 0)
        self.assertEqual(result.dropped_token_count, result.truncated_token_count)
        self.assertIn("truncated", result.dropped_digest)
        self.assertIn("lost in total", result.dropped_digest)
        self.assertLessEqual(result.token_count, 20)

    def test_lost_tokens_equal_the_missing_tokens(self):
        transcript = [{"role": "user", "content": "token " * 200}]
        runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(UNAVAILABLE))

        result = runner.compact_context(transcript, 30)

        kept_tokens = sum(estimate_tokens(m["content"]) for m in result.messages)
        self.assertEqual(result.token_count, kept_tokens)
        self.assertEqual(
            result.dropped_token_count,
            estimate_tokens(transcript[0]["content"]) - kept_tokens,
        )

    def test_dropped_prefix_and_truncation_are_both_counted(self):
        transcript = [
            {"role": "user", "content": "older " * 80},
            {"role": "assistant", "content": "newest " * 200},
        ]
        runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(UNAVAILABLE))

        result = runner.compact_context(transcript, 40)

        self.assertEqual(result.dropped_indexes, (0,))
        self.assertGreater(result.truncated_token_count, 0)
        total_lost = (
            estimate_tokens(transcript[0]["content"])
            + estimate_tokens(transcript[1]["content"])
            - result.token_count
        )
        self.assertEqual(result.dropped_token_count, total_lost)
        self.assertIn("earlier message(s) dropped", result.dropped_digest)
        self.assertIn("truncated", result.dropped_digest)

    def test_truncation_is_fed_to_the_summary_prompt(self):
        client = FakeLmClient(["Tail captured."])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))
        transcript = [{"role": "user", "content": "prefix " * 400}]

        result = runner.compact_context(transcript, 120)

        self.assertTrue(result.summary_applied)
        self.assertEqual(result.source, "model")
        payload = client.calls[0]["messages"][1]["content"]
        self.assertIn("truncated tail", payload)


class LowItemCase(unittest.TestCase):
    def test_fit_is_structural_not_fallback(self):
        runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(make_selection()))

        result = runner.compact_context(conversation(), 1000)

        self.assertEqual(result.source, "fallback")
        self.assertEqual(result.provider, "none")
        self.assertEqual(result.provenance.reason, "transcript fits the budget; nothing to summarize")
        stats = runner.stats()["jobs"]["compaction"]
        self.assertEqual(stats["structural"], 1)
        self.assertEqual(stats["fallback"], 0)

    def test_model_needed_but_absent_counts_as_fallback(self):
        runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(UNAVAILABLE))
        transcript = [{"role": "user", "content": f"turn {i} " + "payload " * 30} for i in range(8)]

        runner.compact_context(transcript, 200)

        stats = runner.stats()["jobs"]["compaction"]
        self.assertEqual(stats["fallback"], 1)
        self.assertEqual(stats["unavailable"], 1)
        self.assertEqual(stats["structural"], 0)

    def test_empty_array_from_model_is_a_real_empty_result(self):
        client = FakeLmClient(["[]"])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        detailed = runner.distill_memory_detailed(conversation())

        self.assertEqual(detailed.status, "model")
        self.assertEqual(detailed.candidates, ())
        self.assertEqual(detailed.provenance.source, "model")
        self.assertEqual(detailed.provenance.provider, "local")
        self.assertEqual(detailed.to_dict()["status"], "model")

    def test_items_without_usable_text_are_not_an_empty_result(self):
        client = FakeLmClient(['[{"category": "note"}, {"text": "   "}]'])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        with self.assertRaises(AuxModelOutputError):
            runner.distill_memory_detailed(conversation())

        self.assertEqual(runner.stats()["jobs"]["distillation"]["error"], 1)

    def test_empty_session_is_marked_empty(self):
        runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(make_selection()))

        detailed = runner.distill_memory_detailed([])

        self.assertEqual(detailed.status, "empty")
        self.assertEqual(detailed.candidates, ())
        self.assertEqual(detailed.provenance.provider, "none")
        self.assertEqual(runner.stats()["jobs"]["distillation"]["structural"], 1)

    def test_category_is_capped_and_normalized(self):
        client = FakeLmClient(['[{"text": "note", "category": "  very   long   %s  "}]' % ("c" * 200)])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()), max_category_chars=12)

        candidates = runner.distill_memory(conversation())

        self.assertEqual(len(candidates), 1)
        self.assertLessEqual(len(candidates[0].category), 12)
        self.assertNotIn("  ", candidates[0].category)

    def test_query_rewrite_has_full_provenance_parity(self):
        client = FakeLmClient(["streaming SSE parse failure"])
        runner = AuxTaskRunner(client, FakeRegistry(make_selection()))

        rewritten = runner.rewrite_query("the bug")

        self.assertIsInstance(rewritten, QueryRewrite)
        self.assertEqual(rewritten.text, "streaming SSE parse failure")
        self.assertTrue(rewritten.is_local)
        self.assertTrue(rewritten.cost_known)
        payload = rewritten.to_dict()
        self.assertEqual(payload["query"], "streaming SSE parse failure")
        self.assertEqual(payload["provenance"]["source"], "model")
        self.assertEqual(payload["provenance"]["cost_usd"], 0.0)

    def test_unexpected_client_exception_is_wrapped_and_counted(self):
        class ExplodingClient:
            usage = None

            def chat_stream(self, messages, model=None, route="zdr_cloud", timeout=60):
                raise ValueError("client bug")

        runner = AuxTaskRunner(ExplodingClient(), FakeRegistry(make_selection()))

        with self.assertRaises(AuxTransportError) as caught:
            runner.title_session(conversation())

        self.assertIn("ValueError", caught.exception.reason)
        self.assertEqual(runner.stats()["jobs"]["title"]["error"], 1)

    def test_selector_crash_is_an_error_not_an_unavailable_fallback(self):
        registry = FakeRegistry(make_selection(), error=RuntimeError("selector bug"))
        runner = AuxTaskRunner(FakeLmClient([]), registry)

        with self.assertRaises(AuxTaskError) as caught:
            runner.title_session(conversation())

        self.assertIn("selector bug", str(caught.exception))
        stats = runner.stats()["jobs"]["title"]
        self.assertEqual(stats["error"], 1)
        self.assertEqual(stats["fallback"], 0)
        self.assertEqual(stats["unavailable"], 0)


class FilteredIndexCase(unittest.TestCase):
    """Low 3 회귀: 내용 없는 메시지를 걸러도 인덱스는 호출자의 원본 위치를 가리킨다."""

    TRANSCRIPT = [
        {"role": "user", "content": "old " * 200},
        {"role": "assistant", "content": "   "},
        {"role": "user", "content": "newest " * 200},
    ]

    def test_truncated_index_points_at_the_callers_message(self):
        runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(UNAVAILABLE))

        result = runner.compact_context(self.TRANSCRIPT, 30)

        self.assertTrue(result.truncated)
        self.assertEqual(result.truncated_message_index, 2)
        self.assertEqual(result.filtered_truncated_message_index, 1)
        self.assertEqual(result.dropped_indexes, (0,))
        self.assertEqual(result.filtered_dropped_indexes, (0,))
        self.assertEqual(result.kept_indexes, (2,))
        self.assertEqual(result.messages[-1]["content"].startswith("newest"), True)
        self.assertIn("message 2 truncated", result.dropped_digest)

    def test_kept_indexes_skip_the_filtered_gap(self):
        runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(UNAVAILABLE))
        transcript = [
            {"role": "user", "content": "a " * 3},
            {"role": "assistant", "content": ""},
            {"role": "user", "content": "b " * 3},
            {"role": "system", "content": "  \n "},
            {"role": "assistant", "content": "c " * 3},
        ]

        result = runner.compact_context(transcript, 1000)

        self.assertEqual(result.kept_indexes, (0, 2, 4))
        self.assertEqual([m["content"][0] for m in result.messages], ["a", "b", "c"])
        self.assertEqual(result.dropped_indexes, ())

    def test_indexes_map_back_for_every_budget(self):
        runner_for = lambda: AuxTaskRunner(FakeLmClient([]), FakeRegistry(UNAVAILABLE))
        for budget in range(1, 41):
            result = runner_for().compact_context(self.TRANSCRIPT, budget)
            self.assertLessEqual(result.token_count, budget)
            surviving = set(result.kept_indexes)
            self.assertEqual(surviving | set(result.dropped_indexes), {0, 2})
            if result.truncated_message_index is not None:
                self.assertIn(result.truncated_message_index, surviving)
                self.assertEqual(result.truncated_message_index, 2)


class StatsCase(unittest.TestCase):
    def test_stats_separate_model_and_fallback_and_cost_is_structurally_zero(self):
        ready_runner = AuxTaskRunner(FakeLmClient(["T", "Q"]), FakeRegistry(make_selection()))
        ready_runner.title_session(conversation())
        ready_runner.rewrite_query("q")
        stats = ready_runner.stats()

        self.assertTrue(stats["local_only"])
        self.assertEqual(stats["cost_usd"], 0.0)
        self.assertEqual(stats["external_cost_usd"], 0.0)
        self.assertEqual(stats["paid_calls"], 0)
        self.assertEqual(stats["jobs"]["title"]["model"], 1)
        self.assertEqual(stats["jobs"]["title"]["fallback"], 0)
        self.assertEqual(stats["totals"]["model"], 2)
        self.assertEqual(stats["totals"]["cost_usd"], 0.0)

        fallback_runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(UNAVAILABLE))
        fallback_runner.title_session(conversation())
        fallback_runner.rewrite_query("q")
        fallback = fallback_runner.stats()
        self.assertEqual(fallback["jobs"]["title"]["fallback"], 1)
        self.assertEqual(fallback["jobs"]["title"]["model"], 0)
        self.assertEqual(fallback["cost_usd"], 0.0)

    def test_all_job_buckets_exist_before_any_call(self):
        runner = AuxTaskRunner(FakeLmClient([]), FakeRegistry(make_selection()))
        stats = runner.stats()
        self.assertEqual(sorted(stats["jobs"]), sorted(AUX_TASKS))
        self.assertEqual(stats["totals"]["model"], 0)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

"""session_timeline 테스트: 근거 기반 분류, 정렬, 집계, 구조적/모델 문장화, 환각 거부.

모든 테스트는 가짜 이벤트와 가짜 러너/클라이언트만 쓴다(네트워크·실모델·파일 IO 없음).
"""
from __future__ import annotations

import unittest
from types import SimpleNamespace

from engine.session_timeline import (
    ADD,
    CATEGORIES,
    COMPACTOR_ROLE,
    DELETE,
    MODIFY,
    PENDING_ROLE_NOTE,
    SESSION_TIMELINE_JOB,
    UNCLASSIFIED,
    TimelinePhraser,
    build_timeline,
    classify,
    classify_event,
    render_timeline,
)
from engine.aux_tasks import LOCAL_ROUTE


# --------------------------------------------------------------------------- #
# Fakes
# --------------------------------------------------------------------------- #
class FakeLmClient:
    """``chat_stream`` 대역. 모든 호출의 route 를 기록해 로컬 전용을 검증한다."""

    def __init__(self, reply="", cost_usd=0.0, model_id=None):
        self.reply = reply
        self.cost_usd = cost_usd
        self.model_id = model_id
        self.calls = []
        self.usage = None

    def chat_stream(self, messages, model=None, route="zdr_cloud", timeout=60):
        self.calls.append({"messages": messages, "model": model, "route": route})
        self.usage = SimpleNamespace(
            input_tokens=1,
            output_tokens=1,
            cached_tokens=0,
            cost_usd=self.cost_usd,
            model_id=self.model_id if self.model_id is not None else (model or ""),
        )
        return iter([self.reply])


def selection(model_id="local/tiny-timeline-1", provider="local", status="ready", reason=None):
    class Selection:
        def __init__(self):
            self.status = status
            self.model_id = model_id if status == "ready" else ""
            self.reason = reason
            self.detail = None
            self.entry = (
                SimpleNamespace(model_id=model_id, provider=provider)
                if status == "ready" else None
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
    """레지스트리 대역. ``known_tasks`` 밖의 작업은 실제 레지스트리처럼 명시적 불가로 답한다."""

    def __init__(self, grade="ready", provider="local",
                 known_tasks=("compaction", "session_timeline")):
        self.grade = grade
        self.provider = provider
        self.known_tasks = tuple(known_tasks)
        self.aux_calls = []
        self.foreground_calls = []

    def select_aux_model(self, task, tier=None, machine=None, foreground_model_id=None):
        self.aux_calls.append({"task": task, "tier": tier, "machine": machine,
                               "foreground_model_id": foreground_model_id})
        if task not in self.known_tasks:
            return selection(status="unavailable",
                             reason=f"unknown aux task {task!r}: declared tasks are "
                                    f"{sorted(self.known_tasks)}")
        if self.grade == "cloud":
            return selection(model_id="openai/gpt-5", provider=self.provider)
        return selection()

    def select_model(self, *args, **kwargs):  # pragma: no cover - 호출되면 계약 위반
        self.foreground_calls.append((args, kwargs))
        raise AssertionError("foreground selector must never be consulted")


class MissingAuxRegistry:
    """``select_aux_model`` 자체가 없는 레지스트리(조용한 재역할 금지 확인용)."""

    def __init__(self):
        self.foreground_calls = []

    def select_model(self, *args, **kwargs):  # pragma: no cover - 호출되면 계약 위반
        self.foreground_calls.append((args, kwargs))
        raise AssertionError("foreground selector must never be consulted")


class HallucinatingRunner:
    """타임라인에 없는 파일과 건수를 지어내는 가짜 러너."""

    def __init__(self, lines, model_id="local/fake-hallucinator"):
        self.lines = tuple(lines)
        self.model_id = model_id
        self.requests = []

    def phrase(self, request):
        from engine.session_timeline import PhraseOutcome

        self.requests.append(request)
        return PhraseOutcome(lines=self.lines, raw="\n".join(self.lines),
                             model_id=self.model_id, cost_usd=0.0, provider="local",
                             role="compactor", role_note=PENDING_ROLE_NOTE)


class FixedRunner(HallucinatingRunner):
    """주어진 문장을 그대로 돌려주는 러너(모델 provenance 를 흉내낸다)."""


# --------------------------------------------------------------------------- #
# Events
# --------------------------------------------------------------------------- #
def event(event_id, ts, kind="tool_result", tool="write_file", target=None, status=None,
          **extra):
    payload = {"event_id": event_id, "timestamp": ts, "kind": kind, "tool": tool}
    if target is not None:
        payload["target"] = target
    if status is not None:
        payload["status"] = status
    payload.update(extra)
    return payload


def ok(event_id, ts, tool="edit", target="src/app.py", **extra):
    return event(event_id, ts, tool=tool, target=target, status="ok", **extra)


# --------------------------------------------------------------------------- #
# 분류
# --------------------------------------------------------------------------- #
class ClassificationCase(unittest.TestCase):
    def test_created_true_is_addition(self):
        result = classify_event(ok("e1", "2026-11-06T00:00:00Z", tool="write_file",
                                   created=True))
        self.assertEqual(result.category, ADD)
        self.assertEqual(result.evidence, "created")
        self.assertEqual(result.evidence_value, "true")
        self.assertIn("src/app.py", result.description)
        self.assertIn("write_file", result.description)

    def test_existed_before_false_is_addition(self):
        result = classify_event(ok("e1", "2026-11-06T00:00:00Z",
                                   existed_before=False))
        self.assertEqual(result.category, ADD)
        self.assertEqual(result.evidence, "existed_before")
        self.assertEqual(result.evidence_value, "false")

    def test_create_tool_is_addition(self):
        result = classify_event(ok("e1", "2026-11-06T00:00:00Z", tool="create_file"))
        self.assertEqual(result.category, ADD)
        self.assertEqual(result.evidence, "tool")

    def test_op_create_in_nested_details_is_addition(self):
        result = classify_event({
            "id": "e1", "ts": 1.0, "type": "tool_execution_end", "toolName": "apply_patch",
            "result": {"details": {"perFileResults": [
                {"path": "new/module.py", "op": "create", "diff": "+x = 1"},
            ]}},
        })
        self.assertEqual(result.category, ADD)
        self.assertEqual(result.evidence, "result.details.perFileResults[0].op")
        self.assertEqual(result.evidence_value, "create")

    def test_edit_tool_is_modification(self):
        result = classify_event(ok("e1", "2026-11-06T00:00:00Z", tool="edit"))
        self.assertEqual(result.category, MODIFY)
        self.assertEqual(result.evidence, "tool")

    def test_existed_before_true_is_modification(self):
        result = classify_event(ok("e1", "2026-11-06T00:00:00Z", tool="write_file",
                                   existed_before=True))
        self.assertEqual(result.category, MODIFY)
        self.assertEqual(result.evidence, "existed_before")

    def test_created_false_is_modification(self):
        result = classify_event(ok("e1", "2026-11-06T00:00:00Z", created=False))
        self.assertEqual(result.category, MODIFY)
        self.assertEqual(result.evidence, "created")

    def test_deleted_flag_is_deletion(self):
        result = classify_event(ok("e1", "2026-11-06T00:00:00Z", tool="write_file",
                                   deleted=True))
        self.assertEqual(result.category, DELETE)
        self.assertEqual(result.evidence, "deleted")

    def test_delete_tool_is_deletion(self):
        result = classify_event(ok("e1", "2026-11-06T00:00:00Z", tool="delete_file"))
        self.assertEqual(result.category, DELETE)
        self.assertEqual(result.evidence, "tool")

    def test_remove_op_is_deletion(self):
        result = classify_event({
            "id": "e2", "ts": "2026-11-06T00:00:00+00:00", "tool": "apply_patch",
            "details": {"files": [{"path": "old.py", "op": "remove"}]},
        })
        self.assertEqual(result.category, DELETE)
        self.assertEqual(result.evidence_value, "remove")

    def test_write_without_creation_status_is_unclassified(self):
        result = classify_event(ok("e1", "2026-11-06T00:00:00Z", tool="write_file"))
        self.assertEqual(result.category, UNCLASSIFIED)
        self.assertEqual(result.evidence, "creation_status")
        self.assertEqual(result.evidence_value, "absent")

    def test_failed_write_is_unclassified(self):
        result = classify_event(event("e1", "2026-11-06T00:00:00Z", tool="edit",
                                      target="src/app.py", status="error",
                                      created=True))
        self.assertEqual(result.category, UNCLASSIFIED)
        self.assertIn("실패", result.description)

    def test_denied_approval_does_not_create_change(self):
        result = classify_event({
            "id": "e9", "ts": "2026-11-06T00:00:00Z", "kind": "approval",
            "tool": "bash", "status": "denied", "target": "deploy.sh",
        })
        self.assertEqual(result.category, UNCLASSIFIED)

    def test_prior_appearance_does_not_make_a_write_an_addition(self):
        events = [
            event("e1", "2026-11-06T00:00:00Z", kind="tool_result", tool="read_file",
                  target="src/app.py", status="ok"),
            event("e2", "2026-11-06T00:01:00Z", kind="tool_result", tool="write_file",
                  target="src/app.py", status="ok"),
        ]
        timeline = build_timeline(events)
        self.assertEqual([entry.category for entry in timeline.entries], [UNCLASSIFIED])
        self.assertEqual(classify(events[1]), UNCLASSIFIED)

    def test_classify_accepts_enum_strings_for_all_four_categories(self):
        cases = {
            ADD: event("a", "2026-11-06T00:00:00Z", created_new=True),
            MODIFY: event("b", "2026-11-06T00:00:00Z", existed_before=True),
            DELETE: event("c", "2026-11-06T00:00:00Z", removed=True),
            UNCLASSIFIED: event("d", "2026-11-06T00:00:00Z", tool="write_file"),
        }
        for expected, payload in cases.items():
            with self.subTest(expected=expected):
                self.assertEqual(classify(payload), expected)


# --------------------------------------------------------------------------- #
# 타임라인 구성
# --------------------------------------------------------------------------- #
class TimelineBuildCase(unittest.TestCase):
    def test_chronological_order_with_stable_tie_on_event_id(self):
        events = [
            event("e3", "2026-11-06T00:02:00Z", tool="edit", target="c.py",
                  existed_before=True),
            event("e2", "2026-11-06T00:01:00Z", tool="edit", target="b.py",
                  existed_before=True),
            event("e1", "2026-11-06T00:01:00Z", tool="edit", target="a.py",
                  existed_before=True),
            event("e0", "2026-11-06T00:00:30Z", tool="create_file", target="z.py"),
        ]
        timeline = build_timeline(events)
        self.assertEqual([entry.event_id for entry in timeline.entries],
                         ["e0", "e1", "e2", "e3"])
        self.assertEqual(timeline.start, "2026-11-06T00:00:30+00:00")
        self.assertEqual(timeline.end, "2026-11-06T00:02:00+00:00")

    def test_events_without_timestamp_sort_last_and_are_reported(self):
        events = [
            event("no-ts", None, tool="edit", target="q.py", existed_before=True),
            event("with-ts", "2026-11-06T00:00:00Z", tool="edit", target="p.py",
                  existed_before=True),
        ]
        timeline = build_timeline(events)
        self.assertEqual([entry.event_id for entry in timeline.entries], ["with-ts", "no-ts"])
        self.assertIn("missing_timestamp",
                      [issue["problem"] for issue in timeline.degraded])

    def test_per_category_counts_and_unclassified_list(self):
        events = [
            event("a", "2026-11-06T00:00:00Z", tool="create_file", target="new.py"),
            event("b", "2026-11-06T00:01:00Z", tool="edit", target="old.py"),
            event("c", "2026-11-06T00:02:00Z", tool="delete_file", target="gone.py"),
            event("d", "2026-11-06T00:03:00Z", tool="write_file", target="maybe.py"),
            event("e", "2026-11-06T00:04:00Z", tool="write_file", target="maybe2.py"),
        ]
        timeline = build_timeline(events)
        self.assertEqual(timeline.counts, {ADD: 1, MODIFY: 1, DELETE: 1, UNCLASSIFIED: 2})
        self.assertEqual([entry.target for entry in timeline.unclassified],
                         ["maybe.py", "maybe2.py"])
        self.assertEqual([entry.event_id for entry in timeline.entries],
                         ["a", "b", "c", "d", "e"])

    def test_empty_session_is_a_valid_empty_timeline(self):
        timeline = build_timeline([])
        self.assertEqual(timeline.entries, ())
        self.assertEqual(timeline.unclassified, ())
        self.assertEqual(timeline.counts, {name: 0 for name in CATEGORIES})
        self.assertIsNone(timeline.start)
        self.assertIsNone(timeline.end)
        self.assertEqual(timeline.event_count, 0)
        data = timeline.to_dict()
        self.assertEqual(data["entries"], [])
        self.assertEqual(data["unclassified"], [])
        self.assertEqual(data["counts"], {name: 0 for name in CATEGORIES})
        self.assertEqual([block["category"] for block in data["categories"]],
                         list(CATEGORIES))
        self.assertTrue(all(block["count"] == 0 for block in data["categories"]))

    def test_read_only_events_are_not_timeline_entries(self):
        events = [
            event("r1", "2026-11-06T00:00:00Z", tool="read_file", target="a.py", status="ok"),
            event("m1", "2026-11-06T00:00:01Z", kind="message", tool=None, status="ok"),
        ]
        timeline = build_timeline(events)
        self.assertEqual(timeline.entries, ())
        self.assertEqual(timeline.event_count, 2)

    def test_entries_carry_auditable_evidence(self):
        timeline = build_timeline([
            event("e1", "2026-11-06T00:00:00Z", tool="write_file", target="dir/x.py",
                  details={"created": True}),
        ])
        entry = timeline.entries[0]
        self.assertEqual(entry.event_id, "e1")
        self.assertEqual(entry.tool, "write_file")
        self.assertEqual(entry.target, "dir/x.py")
        self.assertEqual(entry.timestamp, "2026-11-06T00:00:00+00:00")
        self.assertEqual(entry.evidence, "details.created")
        self.assertEqual(entry.evidence_value, "true")
        payload = entry.to_dict()
        self.assertEqual(payload["evidence"], {"field": "details.created", "value": "true"})
        self.assertEqual(payload["category"], ADD)


# --------------------------------------------------------------------------- #
# 문장화
# --------------------------------------------------------------------------- #
def demo_events():
    return [
        event("e1", "2026-11-06T00:00:00Z", tool="create_file", target="a.py"),
        event("e2", "2026-11-06T00:01:00Z", tool="edit", target="b.py"),
    ]


class StructuralPhrasingCase(unittest.TestCase):
    def test_structural_phrasing_without_runner(self):
        timeline = build_timeline(demo_events())
        result = render_timeline(timeline)
        self.assertEqual(result.source, "structural")
        self.assertEqual(result.cost_usd, 0.0)
        self.assertEqual(result.provider, "none")
        self.assertEqual(result.model_id, "")
        self.assertEqual(result.sentences, tuple(e.description for e in timeline.entries))
        self.assertIn("추가 1건", result.summary)
        self.assertIsNone(result.rejection)

        data = result.to_dict()
        self.assertEqual(data["provenance"]["source"], "structural")
        self.assertEqual(data["provenance"]["role"], "")
        self.assertEqual(data["provenance"]["rejection"], None)
        self.assertEqual([row["category"] for row in data["entries"]], [ADD, MODIFY])
        self.assertEqual([block["count"] for block in data["categories"]], [1, 1, 0, 0])

    def test_empty_timeline_phrases_without_model(self):
        result = render_timeline(build_timeline([]), runner=TimelinePhraser(
            FakeLmClient("절대 호출되지 않아야 함"), FakeRegistry()))
        self.assertEqual(result.source, "structural")
        self.assertEqual(result.sentences, ())

    def test_unavailable_model_degrades_visibly(self):
        client = FakeLmClient("")
        registry = FakeRegistry(known_tasks=())  # 어떤 aux 작업도 배정되지 않는 레지스트리
        runner = TimelinePhraser(client, registry)
        result = render_timeline(build_timeline(demo_events()), runner=runner)
        self.assertEqual(result.source, "structural")
        self.assertEqual(result.rejection["reason"], "aux_model_unavailable")
        self.assertEqual(client.calls, [])
        self.assertEqual(registry.foreground_calls, [])


class ModelPhrasingCase(unittest.TestCase):
    def test_model_phrasing_is_labeled_model_with_zero_cost(self):
        reply = (
            "a.py 파일을 새로 만들었습니다.\n"
            "b.py 파일의 내용을 수정했습니다."
        )
        client = FakeLmClient(reply)
        registry = FakeRegistry(known_tasks=("session_timeline",))
        runner = TimelinePhraser(client, registry)

        result = render_timeline(build_timeline(demo_events()), runner=runner)

        self.assertEqual(result.source, "model")
        self.assertEqual(result.model_id, "local/tiny-timeline-1")
        self.assertEqual(result.cost_usd, 0.0)
        self.assertEqual(result.provider, "local")
        self.assertEqual(result.sentences, ("a.py 파일을 새로 만들었습니다.",
                                            "b.py 파일의 내용을 수정했습니다."))
        self.assertIsNone(result.rejection)
        self.assertEqual([call["task"] for call in registry.aux_calls],
                         [SESSION_TIMELINE_JOB])
        self.assertEqual(registry.foreground_calls, [])
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(client.calls[0]["route"], LOCAL_ROUTE)

    def test_unknown_summarizer_task_falls_back_to_compactor_role(self):
        client = FakeLmClient("a.py 파일을 새로 만들었습니다.\nb.py 파일을 고쳤습니다.")
        registry = FakeRegistry(known_tasks=("compaction",))
        runner = TimelinePhraser(client, registry)

        result = render_timeline(build_timeline(demo_events()), runner=runner)

        self.assertEqual(result.source, "model")
        self.assertEqual(result.role, COMPACTOR_ROLE)
        self.assertEqual(result.role_note, PENDING_ROLE_NOTE)
        self.assertEqual([call["task"] for call in registry.aux_calls],
                         [SESSION_TIMELINE_JOB, "compaction"])
        self.assertEqual(registry.foreground_calls, [])

    def test_hallucinated_target_is_rejected_and_structural_text_returned(self):
        timeline = build_timeline(demo_events())
        runner = FixedRunner([
            "a.py 파일을 새로 만들었습니다.",
            "b.py 파일을 고쳤고 c.py 파일도 삭제했습니다.",
        ])

        result = render_timeline(timeline, runner=runner)

        self.assertEqual(result.source, "structural")
        self.assertEqual(result.sentences, tuple(e.description for e in timeline.entries))
        self.assertIsNotNone(result.rejection)
        self.assertEqual(result.rejection["reason"], "model_output_rejected")
        kinds = {violation["kind"] for violation in result.rejection["violations"]}
        self.assertIn("unknown_target", kinds)
        values = {violation["value"] for violation in result.rejection["violations"]}
        self.assertIn("c.py", values)
        self.assertIn("삭제", values)  # 항목 없는 범주를 변경으로 말했다
        self.assertIn("c.py 파일도 삭제", result.rejection["raw"])

    def test_wrong_line_count_is_rejected(self):
        runner = FixedRunner(["a.py 파일을 새로 만들었습니다."])
        result = render_timeline(build_timeline(demo_events()), runner=runner)
        self.assertEqual(result.source, "structural")
        self.assertIn("line_count",
                      {v["kind"] for v in result.rejection["violations"]})

    def test_line_claiming_the_wrong_change_kind_is_rejected(self):
        timeline = build_timeline([
            event("e1", "2026-11-06T00:00:00Z", tool="create_file", target="a.py"),
            event("e2", "2026-11-06T00:01:00Z", tool="delete_file", target="c.py"),
        ])
        runner = FixedRunner([
            "a.py 파일을 삭제했습니다.",
            "c.py 파일을 삭제했습니다.",
        ])

        result = render_timeline(timeline, runner=runner)

        self.assertEqual(result.source, "structural")
        self.assertIn("category_mismatch",
                      {v["kind"] for v in result.rejection["violations"]})

    def test_unknown_count_is_rejected(self):
        runner = FixedRunner([
            "a.py 파일을 새로 만들었습니다.",
            "b.py 파일을 고쳤습니다. 모두 7건입니다.",
        ])
        result = render_timeline(build_timeline(demo_events()), runner=runner)
        self.assertEqual(result.source, "structural")
        self.assertIn("unknown_count",
                      {v["kind"] for v in result.rejection["violations"]})

    def test_cloud_provider_selection_is_refused_and_recorded(self):
        client = FakeLmClient("a.py 파일을 새로 만들었습니다.\nb.py 파일을 고쳤습니다.")
        registry = FakeRegistry(grade="cloud", provider="openai",
                                known_tasks=("session_timeline",))
        runner = TimelinePhraser(client, registry)

        result = render_timeline(build_timeline(demo_events()), runner=runner)

        self.assertEqual(result.source, "structural")
        self.assertEqual(result.rejection["reason"], "cloud_provider_refused")
        self.assertEqual(client.calls, [])
        self.assertEqual(registry.foreground_calls, [])

    def test_registry_without_aux_selector_is_reported_not_reroled(self):
        registry = MissingAuxRegistry()
        runner = TimelinePhraser(FakeLmClient("a.py 를 만들었습니다."), registry)
        result = render_timeline(build_timeline(demo_events()), runner=runner)
        self.assertEqual(result.source, "structural")
        self.assertEqual(result.rejection["reason"], "aux_task_error")
        self.assertEqual(registry.foreground_calls, [])


class DefectsRegressionCase(unittest.TestCase):
    """결함 1~5 회귀 테스트 모음."""

    # ----------------------------------------------------------------------- #
    # 결함 1: 파일별 근거 판정 및 전체 컨테이너 경로 감사
    # ----------------------------------------------------------------------- #
    def test_per_file_created_is_addition_with_full_evidence_path(self):
        ev = {
            "id": "e1",
            "ts": "2026-11-06T00:00:00Z",
            "tool": "apply_patch",
            "result": {
                "details": {
                    "perFileResults": [
                        {"path": "pkg/new_file.py", "created": True}
                    ]
                }
            },
        }
        res = classify_event(ev)
        self.assertEqual(res.category, ADD)
        self.assertEqual(res.evidence, "result.details.perFileResults[0].created")
        self.assertEqual(res.evidence_value, "true")

    def test_per_file_existed_before_is_modification_with_full_evidence_path(self):
        ev = {
            "id": "e1",
            "ts": "2026-11-06T00:00:00Z",
            "tool": "write_file",
            "per_file_results": [
                {"path": "pkg/old_file.py", "existed_before": True}
            ],
        }
        res = classify_event(ev)
        self.assertEqual(res.category, MODIFY)
        self.assertEqual(res.evidence, "per_file_results[0].existed_before")
        self.assertEqual(res.evidence_value, "true")

    def test_per_file_deleted_on_apply_patch_is_deletion(self):
        ev = {
            "id": "e1",
            "ts": "2026-11-06T00:00:00Z",
            "tool": "apply_patch",
            "result": {
                "details": {
                    "perFileResults": [
                        {"path": "deleted.py", "deleted": True}
                    ]
                }
            },
        }
        res = classify_event(ev)
        self.assertEqual(res.category, DELETE)
        self.assertEqual(res.evidence, "result.details.perFileResults[0].deleted")
        self.assertEqual(res.evidence_value, "true")

    def test_per_file_error_status_is_unclassified(self):
        ev = {
            "id": "e1",
            "ts": "2026-11-06T00:00:00Z",
            "tool": "edit",
            "files": [
                {"path": "failing.py", "status": "error"}
            ],
        }
        res = classify_event(ev)
        self.assertEqual(res.category, UNCLASSIFIED)
        self.assertEqual(res.evidence, "files[0].status")
        self.assertIn("변경 없음", res.description)

    # ----------------------------------------------------------------------- #
    # 결함 2: 애매한 쓰기 동사 및 생성 가능 도구 판정
    # ----------------------------------------------------------------------- #
    def test_op_write_on_write_file_stays_unclassified_without_existence_evidence(self):
        ev = {
            "id": "e1",
            "ts": "2026-11-06T00:00:00Z",
            "tool": "write_file",
            "target": "x.py",
            "op": "write",
        }
        res = classify_event(ev)
        self.assertEqual(res.category, UNCLASSIFIED)
        self.assertEqual(res.evidence, "creation_status")

    def test_create_capable_tool_command_create_reports_addition(self):
        ev = {
            "id": "e1",
            "ts": "2026-11-06T00:00:00Z",
            "tool": "str_replace_editor",
            "target": "new.py",
            "command": "create",
        }
        res = classify_event(ev)
        self.assertEqual(res.category, ADD)
        self.assertEqual(res.evidence, "command")
        self.assertEqual(res.evidence_value, "create")

    def test_create_capable_tool_without_evidence_stays_unclassified(self):
        ev = {
            "id": "e1",
            "ts": "2026-11-06T00:00:00Z",
            "tool": "apply_patch",
            "target": "unknown.py",
        }
        res = classify_event(ev)
        self.assertEqual(res.category, UNCLASSIFIED)

    def test_line_addition_vocabulary_does_not_infer_file_creation(self):
        ev = {
            "id": "e1",
            "ts": "2026-11-06T00:00:00Z",
            "tool": "patch",
            "target": "existing.py",
            "op": "add",
        }
        res = classify_event(ev)
        self.assertEqual(res.category, UNCLASSIFIED)

    # ----------------------------------------------------------------------- #
    # 결함 3: 문장화 검증기 대상 바인딩, 경로 인식 및 동의어/부정문 처리
    # ----------------------------------------------------------------------- #
    def test_two_target_category_swap_rewrite_is_rejected(self):
        timeline = build_timeline([
            event("e1", "2026-11-06T00:00:00Z", tool="create_file", target="a.py"),
            event("e2", "2026-11-06T00:01:00Z", tool="edit", target="b.py",
                  existed_before=True),
        ])
        runner = FixedRunner([
            "b.py 파일을 새로 추가했습니다.",
            "a.py 파일을 수정했습니다.",
        ])
        result = render_timeline(timeline, runner=runner)
        self.assertEqual(result.source, "structural")
        self.assertIsNotNone(result.rejection)
        kinds = {v["kind"] for v in result.rejection["violations"]}
        self.assertTrue("target_pairing" in kinds or "category_mismatch" in kinds)

    def test_invented_backup_prefix_is_rejected(self):
        timeline = build_timeline([
            event("e1", "2026-11-06T00:00:00Z", tool="create_file", target="a.py"),
        ])
        runner = FixedRunner(["backup/a.py 파일을 새로 추가했습니다."])
        result = render_timeline(timeline, runner=runner)
        self.assertEqual(result.source, "structural")
        self.assertIsNotNone(result.rejection)
        kinds = {v["kind"] for v in result.rejection["violations"]}
        self.assertIn("unknown_target", kinds)

    def test_faithful_nginx_conf_echo_is_accepted(self):
        timeline = build_timeline([
            event("e1", "2026-11-06T00:00:00Z", tool="edit", target="nginx.conf",
                  existed_before=True),
        ])
        runner = FixedRunner(["nginx.conf 파일을 수정했습니다."])
        result = render_timeline(timeline, runner=runner)
        self.assertEqual(result.source, "model")
        self.assertIsNone(result.rejection)
        self.assertEqual(result.sentences, ("nginx.conf 파일을 수정했습니다.",))

    def test_invented_makefile_is_rejected(self):
        timeline = build_timeline([
            event("e1", "2026-11-06T00:00:00Z", tool="edit", target="a.py",
                  existed_before=True),
        ])
        runner = FixedRunner(["Makefile 파일을 수정했습니다."])
        result = render_timeline(timeline, runner=runner)
        self.assertEqual(result.source, "structural")
        self.assertIsNotNone(result.rejection)
        kinds = {v["kind"] for v in result.rejection["violations"]}
        self.assertIn("unknown_target", kinds)

    def test_synonym_deletion_claim_is_rejected_when_no_deletions_in_timeline(self):
        timeline = build_timeline([
            event("e1", "2026-11-06T00:00:00Z", tool="create_file", target="a.py"),
        ])
        runner = FixedRunner(["a.py 파일을 지웠습니다."])
        result = render_timeline(timeline, runner=runner)
        self.assertEqual(result.source, "structural")
        self.assertIsNotNone(result.rejection)
        kinds = {v["kind"] for v in result.rejection["violations"]}
        self.assertTrue("category_without_entries" in kinds or "category_mismatch" in kinds)

    def test_faithful_negative_deletion_statement_is_accepted(self):
        timeline = build_timeline([
            event("e1", "2026-11-06T00:00:00Z", tool="create_file", target="a.py"),
        ])
        runner = FixedRunner(["a.py 파일을 새로 만들었으며 삭제된 파일은 없습니다."])
        result = render_timeline(timeline, runner=runner)
        self.assertEqual(result.source, "model")
        self.assertIsNone(result.rejection)

    # ----------------------------------------------------------------------- #
    # 결함 4: 브리지 수명주기 프레임 결합 및 진행 중 호출 상태
    # ----------------------------------------------------------------------- #
    def test_start_and_end_frames_yield_one_entry_with_single_count_increment(self):
        events = [
            {
                "tool_call_id": "call-1",
                "kind": "tool_execution_start",
                "tool": "create_file",
                "target": "out.txt",
                "timestamp": "2026-11-06T00:00:00Z",
            },
            {
                "tool_call_id": "call-1",
                "kind": "tool_execution_end",
                "tool": "create_file",
                "target": "out.txt",
                "timestamp": "2026-11-06T00:00:05Z",
                "status": 200,
                "created": True,
            },
        ]
        timeline = build_timeline(events)
        self.assertEqual(len(timeline.entries), 1)
        self.assertEqual(timeline.counts[ADD], 1)
        entry = timeline.entries[0]
        self.assertEqual(entry.event_id, "call-1")
        self.assertEqual(entry.category, ADD)
        self.assertTrue(entry.confirmed)

    def test_in_progress_call_lands_in_unclassified(self):
        events = [
            {
                "tool_call_id": "call-running",
                "kind": "tool_execution_start",
                "tool": "create_file",
                "target": "work.txt",
                "timestamp": "2026-11-06T00:00:00Z",
            },
        ]
        timeline = build_timeline(events)
        self.assertEqual(len(timeline.entries), 1)
        self.assertEqual(timeline.entries[0].category, UNCLASSIFIED)
        self.assertIn("미확정", timeline.entries[0].description)
        self.assertFalse(timeline.entries[0].confirmed)

    def test_http_200_is_treated_as_success(self):
        ev = {
            "id": "e1",
            "ts": "2026-11-06T00:00:00Z",
            "tool": "create_file",
            "target": "done.txt",
            "status": 200,
            "created": True,
        }
        res = classify_event(ev)
        self.assertEqual(res.category, ADD)

    # ----------------------------------------------------------------------- #
    # 결함 5: 비-로컬 provider 결과의 비용 및 provider 보존
    # ----------------------------------------------------------------------- #
    def test_cost_and_provider_preserved_on_non_local_outcome(self):
        timeline = build_timeline(demo_events())

        class ExternalRunner:
            def phrase(self, request):
                from engine.session_timeline import PhraseOutcome
                return PhraseOutcome(
                    lines=("a.py 새로 추가.", "b.py 수정."),
                    raw="...",
                    model_id="anthropic/claude-3-7-sonnet",
                    cost_usd=0.015,
                    provider="anthropic",
                    role="summarizer",
                )

        result = render_timeline(timeline, runner=ExternalRunner())
        self.assertEqual(result.source, "structural")
        self.assertEqual(result.provider, "anthropic")
        self.assertEqual(result.cost_usd, 0.015)
        self.assertEqual(result.model_id, "anthropic/claude-3-7-sonnet")
        self.assertEqual(result.role, "summarizer")
        self.assertIsNotNone(result.rejection)
        self.assertEqual(result.rejection["reason"], "non_local_provider")
        self.assertEqual(result.sentences, tuple(e.description for e in timeline.entries))


if __name__ == "__main__":
    unittest.main()

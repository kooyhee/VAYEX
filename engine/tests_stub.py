"""Deterministic boundary tests. HTTP responses below are explicit fixture data, not live evidence."""
import asyncio
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from .decision_planner import DAGNode, ExecutionDAGPlan, ExecutionRoute, IntelligencePlanner
from .dsh_payload import PAYLOAD_SCHEMA, build_customization_payload, main as payload_main, render_payload
from .dag_orchestrator import AttemptOutcome, BudgetExhaustedError, DeterministicDAGOrchestrator, FileIsolationWorkspace
from .file_tools import HashMismatchError, InvalidEditError, PathContainmentError, apply_edits, hash_file, resolve_within, run_verification
from .fts5_memory import HybridContextMemoryEngine
from .lm_client import AuthError, BadRequest, LmClient, ProviderNotConfiguredError, ProviderUnavailable, RateLimitError
from .registry import ModelIntelligenceRegistry
from .runner import NodeRunner

MODEL = "openai/gpt-4.1-mini"
USAGE = {"prompt_tokens": 100, "completion_tokens": 20,
         "prompt_tokens_details": {"cached_tokens": 25}}


def temporary_workspace():
    parent = Path.home() / "Desktop" / "_backup"
    parent.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix=f"{date.today().isoformat()}-engine-test-", dir=parent)


@contextmanager
def llm_env(values=None):
    """Set only HARNESS_LLM_* keys; the ambient environment (and TLS config) stays intact."""
    keys = ("HARNESS_LLM_BASE_URL", "HARNESS_LLM_API_KEY", "HARNESS_LLM_MODEL",
            "HARNESS_LLM_ROUTE", "HARNESS_LOCAL_BASE_URL")
    saved = {key: os.environ.pop(key, None) for key in keys}
    overlay = dict(values or {})
    try:
        os.environ.update(overlay)
        yield overlay
    finally:
        for key, value in saved.items():
            os.environ.pop(key, None)
            if value is not None:
                os.environ[key] = value


@contextmanager
def sse_fixture(answer='{"edits":[]}', usage=USAGE, status=200, done=True):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def _respond(self, status, content_type, body):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
            self.close_connection = True

        def do_GET(self):
            if self.path != "/v1/models":
                self._respond(404, "application/json", b'{"error":"not found"}')
                return
            self._respond(200, "application/json", json.dumps({"data": [{"id": MODEL}]}).encode())

        def do_POST(self):
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            payload = json.loads(raw)
            requests.append({"path": self.path, "payload": payload})
            if status != 200:
                self._respond(status, "application/json", b'{"error":{"message":"fixture HTTP failure"}}')
                return
            frames = [b": fixture keepalive\n\n"]
            for index in range(0, len(answer), 17):
                event = {"model": payload["model"], "choices": [
                    {"delta": {"content": answer[index:index + 17]}}]}
                frames.append(("data: " + json.dumps(event) + "\n\n").encode())
            if usage is not None:
                frames.append(("data: " + json.dumps({"model": payload["model"],
                                                      "choices": [], "usage": usage}) + "\n\n").encode())
            if done:
                frames.append(b"data: [DONE]\n\n")
            self._respond(200, "text/event-stream", b"".join(frames))

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        if thread.is_alive():
            raise RuntimeError("fixture server did not shut down")


class EngineFixture(unittest.TestCase):
    def setUp(self):
        temp = temporary_workspace()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.registry = ModelIntelligenceRegistry()
        self.planner = IntelligencePlanner(self.registry)
        self.target = self.root / "app.py"
        self.target.write_bytes(b"value = 1\n")
        self.workspace = FileIsolationWorkspace(root=str(self.root / "backups"), base_dir=str(self.root))

    def node(self, node_id="edit", dependencies=None):
        return DAGNode(node_id, "worker", MODEL, "low", dependencies or [], ["app.py"],
                       "Change value to 2", self.planner._verification_for(["app.py"]))

    def plan(self, nodes=None, route=ExecutionRoute.ZDR_CLOUD):
        # The fixture node names a ZDR cloud model and the fixture server is reached over the
        # cloud endpoint env, so the plan states that route explicitly: an omitted route now
        # means local_only (no consent), which a cloud model may not run under.
        return ExecutionDAGPlan("fixture-plan", 2, True, 0, nodes or [self.node()], route=route)

    def orchestrator(self, budget=1):
        return DeterministicDAGOrchestrator(self.registry, max_budget_usd=budget, workspace=self.workspace)

    def edit_answer(self, content="value = 2\n"):
        return json.dumps({"edits": [{"path": "app.py",
                          "expected_pre_hash": hashlib.sha256(b"value = 1\n").hexdigest(),
                          "new_content": content}], "summary": "fixture edit"})

    @contextmanager
    def endpoint_env(self, url):
        with llm_env({"HARNESS_LLM_BASE_URL": url, "HARNESS_LLM_API_KEY": "fixture-not-a-real-key",
                      "HARNESS_LLM_MODEL": MODEL, "HARNESS_LLM_ROUTE": "zdr_cloud"}):
            yield


class TestEngineSafety(EngineFixture):
    def test_path_containment_and_sensitive_names(self):
        rejected = ["../outside.py", "a/../app.py", str(self.target), "C:\\elsewhere\\a.py",
                    "\\\\server\\share\\a.py", ".git/config", ".env", ".env.production", "key.PEM",
                    "id_rsa.pub", "my_credentials.json", "sub/secret_notes.txt", ".env:stream", ".env."]
        for rel in rejected:
            with self.subTest(path=rel), self.assertRaises(PathContainmentError):
                resolve_within(self.root, rel)
        self.assertEqual(resolve_within(self.root, "sub/new.py"), self.root / "sub" / "new.py")

    def test_link_escape_is_rejected(self):
        with temporary_workspace() as outside:
            link = self.root / "outside-link"
            if os.name == "nt":
                proc = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), outside], capture_output=True)
                self.assertEqual(proc.returncode, 0, proc.stderr.decode(errors="replace"))
            else:
                link.symlink_to(outside, target_is_directory=True)
            try:
                with self.assertRaises(PathContainmentError):
                    resolve_within(self.root, "outside-link/new.py")
            finally:
                if os.name == "nt":
                    link.rmdir()
                else:
                    link.unlink()

    def test_hash_mismatch_aborts_all_edits(self):
        other = self.root / "other.py"
        other.write_bytes(b"other = 1\n")
        with self.assertRaisesRegex(HashMismatchError, "mismatch"):
            apply_edits(self.root, [
                {"path": "app.py", "expected_pre_hash": hashlib.sha256(b"value = 1\n").hexdigest(), "new_content": "value = 2\n"},
                {"path": "other.py", "expected_pre_hash": "0" * 64, "new_content": "other = 2\n"},
            ])
        self.assertEqual(self.target.read_bytes(), b"value = 1\n")
        self.assertEqual(other.read_bytes(), b"other = 1\n")
        self.assertEqual(apply_edits(self.root, [{"path": "new.py", "expected_pre_hash": "", "new_content": "x = 1\n"}]), ["new.py"])
        self.assertEqual((self.root / "new.py").read_bytes(), b"x = 1\n")

    def test_workspace_required_before_runner_executes(self):
        with self.assertRaisesRegex(ValueError, "FileIsolationWorkspace"):
            DeterministicDAGOrchestrator(self.registry).execute_plan(self.plan(), lambda *_: self.fail("runner called"))

    def test_rollback_conflict_preserves_external_work(self):
        node = self.node()
        self.workspace.snapshot(node)
        self.target.write_bytes(b"value = 2\n")
        self.workspace.record_post_hashes(node.node_id)
        entry = self.workspace._index[node.node_id][0]
        self.assertEqual(entry.pre_hash, hashlib.sha256(b"value = 1\n").hexdigest())
        self.assertEqual(entry.post_hash, hashlib.sha256(b"value = 2\n").hexdigest())
        self.target.write_bytes(b"external = 3\n")
        result = self.workspace.restore(node.node_id)
        self.assertEqual(result["status"], "rollback_conflict")
        self.assertEqual(result["conflicts"], ["app.py"])
        self.assertEqual(self.target.read_bytes(), b"external = 3\n")
        self.assertEqual(entry.backup_path.read_bytes(), b"value = 1\n")

    def test_sync_exceptions_rollback_before_propagating(self):
        for error in (asyncio.CancelledError, TimeoutError, BudgetExhaustedError):
            with self.subTest(error=error.__name__):
                def runner(node, attempt):
                    self.target.write_bytes(b"interrupted = True\n")
                    raise error("fixture interruption")
                with self.assertRaises(error):
                    self.orchestrator().execute_plan(self.plan(), runner)
                self.assertEqual(self.target.read_bytes(), b"value = 1\n")

    def test_async_task_cancellation_rolls_back(self):
        async def scenario():
            started = asyncio.Event()
            async def runner(node, attempt):
                self.target.write_bytes(b"interrupted = True\n")
                started.set()
                await asyncio.Future()
            task = asyncio.create_task(self.orchestrator().execute_plan_async(self.plan(), runner))
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        asyncio.run(scenario())
        self.assertEqual(self.target.read_bytes(), b"value = 1\n")

    def test_async_timeout_and_reported_budget_rollback(self):
        for use_timeout in (True, False):
            with self.subTest(timeout=use_timeout):
                async def runner(node, attempt):
                    self.target.write_bytes(b"interrupted = True\n")
                    if use_timeout:
                        raise TimeoutError("fixture timeout")
                    return AttemptOutcome(True, 2, node.model_id)
                expected = TimeoutError if use_timeout else BudgetExhaustedError
                with self.assertRaises(expected):
                    asyncio.run(self.orchestrator().execute_plan_async(self.plan(), runner))
                self.assertEqual(self.target.read_bytes(), b"value = 1\n")

    def test_dependent_node_rollback_restores_original_version(self):
        def runner(node, attempt):
            self.target.write_text("value = 2\n" if node.node_id == "first" else "value = 3\n", encoding="utf-8")
            return AttemptOutcome(node.node_id == "first", None, node.model_id)
        result = self.orchestrator().execute_plan(
            self.plan([self.node("first"), self.node("second", ["first"])]), runner)
        self.assertEqual(result["overall_status"], "rolled_back")
        self.assertEqual(self.target.read_bytes(), b"value = 1\n")

    def test_legacy_outcomes_do_not_invent_cost(self):
        for raw in (True, {"success": True}, (True, None)):
            with self.subTest(raw=raw):
                result = self.orchestrator().execute_plan(self.plan(), lambda *_: raw)
                self.assertIsNone(result["spent_usd"])
                self.assertIsNone(result["node_costs"]["edit"])

    def test_execution_routes_and_safe_verification(self):
        no_consent = self.planner.build_plan("app.py typo fix", hardware_tier="rule_based_only")
        consent = self.planner.build_plan("app.py typo fix", privacy_consent=True, hardware_tier="rule_based_only")
        wide = self.planner.build_plan("app.py typo fix", route="any_cloud", hardware_tier="rule_based_only")
        local = self.planner.build_plan("app.py typo fix", route="local_only", hardware_tier="rule_based_only")
        # No consent never produces a cloud route; consent alone stops at the narrowest
        # cloud route, and only an explicit route request widens it to any_cloud.
        self.assertEqual(no_consent.route, ExecutionRoute.LOCAL_ONLY)
        self.assertEqual(consent.route, ExecutionRoute.ZDR_CLOUD)
        self.assertEqual(wide.route, ExecutionRoute.ANY_CLOUD)
        self.assertEqual(local.route, ExecutionRoute.LOCAL_ONLY)
        self.assertTrue(all(self.registry.get_model(n.model_id).provider == "local" for n in no_consent.nodes))
        self.assertTrue(all(self.registry.get_model(n.model_id).provider == "local" for n in local.nodes))
        self.assertTrue(all(self.registry.get_model(n.model_id).privacy.zero_data_retention
                            and self.registry.get_model(n.model_id).privacy.training_opt_out
                            for n in consent.nodes))
        escalated = self.orchestrator().select_escalation_model(local, local.nodes[0])
        self.assertEqual(escalated.provider, "local")
        self.assertEqual(self.planner._verification_for(["app.py"], "test; rm -rf /"),
                         [sys.executable, "-m", "py_compile", "app.py"])

    def test_memory_restore_containment_integrity_and_current_hash(self):
        mem = HybridContextMemoryEngine()
        self.addCleanup(mem.close)
        with self.assertRaises(PathContainmentError):
            mem.snapshot_filesystem("bad", ["../outside.py"], self.root)
        mem.snapshot_filesystem("safe", ["app.py"], self.root)
        self.target.write_bytes(b"external = 3\n")
        with self.assertRaises(HashMismatchError):
            mem.restore_to_filesystem("safe", self.root)
        self.assertEqual(self.target.read_bytes(), b"external = 3\n")
        mem.conn.execute("UPDATE checkpoints SET files_json=? WHERE checkpoint_id='safe'",
                         (json.dumps({"app.py": "tampered = True\n"}),))
        mem.conn.commit()
        with self.assertRaisesRegex(HashMismatchError, "checkpoint content"):
            mem.restore_to_filesystem("safe", self.root, {"app.py": hash_file(self.target)})
        mem.create_checkpoint("unsafe", {"../outside.py": "bad"})
        with self.assertRaises(PathContainmentError):
            mem.restore_to_filesystem("unsafe", self.root)

    def test_injected_summarizer_and_extractive_fallback(self):
        mem = HybridContextMemoryEngine()
        self.addCleanup(mem.close)
        self.assertEqual(mem.distill_and_summarize("Decision: safe.", summarizer=lambda text: "Injected: " + text),
                         "Injected: Decision: safe.")
        self.assertTrue(mem.distill_and_summarize("Decision: safe.").startswith("[Extractive summary]"))

    def test_verification_scrubs_api_keys_and_uses_project_cwd(self):
        with patch.dict(os.environ, {"HARNESS_LLM_API_KEY": "never-propagate", "OTHER_API_KEY": "also-secret"}):
            record = run_verification([sys.executable, "-c",
                "import os,pathlib; assert 'HARNESS_LLM_API_KEY' not in os.environ; assert 'OTHER_API_KEY' not in os.environ; assert pathlib.Path('app.py').is_file()"], self.root)
        self.assertEqual(record.returncode, 0, record.stderr)
        with self.assertRaisesRegex(InvalidEditError, "argv list"):
            run_verification("python -m py_compile app.py", self.root)


class TestModelExecution(EngineFixture):
    def test_sse_usage_cost_and_health_check(self):
        with sse_fixture(answer="hello world") as (url, requests):
            client = LmClient(url, "fixture-not-a-real-key", MODEL, registry=self.registry)
            self.assertEqual(client.health_check(), [MODEL])
            self.assertEqual("".join(client.chat_stream([{"role": "user", "content": "hello"}])), "hello world")
            self.assertEqual(client.usage.input_tokens, 100)
            self.assertEqual(client.usage.output_tokens, 20)
            self.assertEqual(client.usage.cached_tokens, 25)
            self.assertAlmostEqual(client.cost_usd, 0.0000645, places=10)
            self.assertNotIn("fixture-not-a-real-key", repr(client))
            self.assertEqual(requests[0]["path"], "/v1/chat/completions")
            self.assertTrue(requests[0]["payload"]["stream"])
            self.assertEqual(requests[0]["payload"]["stream_options"], {"include_usage": True})

    def test_missing_or_partial_usage_is_unknown(self):
        for usage in (None, {"prompt_tokens": 100}):
            with self.subTest(usage=usage), sse_fixture(usage=usage) as (url, _):
                client = LmClient(url, "fixture-not-a-real-key", MODEL)
                list(client.chat_stream([{"role": "user", "content": "hello"}]))
                self.assertIsNone(client.usage)
                self.assertIsNone(client.cost_usd)

    def test_http_errors_have_explicit_types(self):
        for status, error in ((401, AuthError), (403, AuthError), (429, RateLimitError), (400, BadRequest), (503, ProviderUnavailable)):
            with self.subTest(status=status), sse_fixture(status=status) as (url, _):
                client = LmClient(url, "fixture-not-a-real-key", MODEL)
                with self.assertRaises(error):
                    list(client.chat_stream([{"role": "user", "content": "hello"}]))

    def test_no_endpoint_fails_without_simulation(self):
        with llm_env(), self.assertRaises(ProviderNotConfiguredError):
            NodeRunner(self.registry, self.planner, self.root)(self.node(), 1)
        self.assertEqual(self.target.read_bytes(), b"value = 1\n")

    def test_truncated_stream_is_not_success(self):
        with sse_fixture(done=False) as (url, _):
            client = LmClient(url, "fixture-not-a-real-key", MODEL)
            with self.assertRaisesRegex(ProviderUnavailable, "before \\[DONE\\]"):
                list(client.chat_stream([{"role": "user", "content": "hello"}]))

    def test_local_only_refuses_nonlocal_endpoint(self):
        client = LmClient("https://example.invalid/v1", None, MODEL)
        with self.assertRaisesRegex(BadRequest, "loopback"):
            list(client.chat_stream([{"role": "user", "content": "hello"}], route="local_only"))

    def test_stub_sse_real_edit_and_py_compile_end_to_end(self):
        tokens = []
        with sse_fixture(answer="```json\n" + self.edit_answer() + "\n```") as (url, requests), self.endpoint_env(url):
            runner = NodeRunner(self.registry, self.planner, self.root, on_token=tokens.append)
            result = self.orchestrator().execute_plan(self.plan(), runner)
        self.assertEqual(result["overall_status"], "completed")
        self.assertEqual(self.target.read_bytes(), b"value = 2\n")
        self.assertTrue((self.root / "__pycache__").is_dir())
        record = result["node_results"]["edit"]["verification"]
        self.assertEqual(record["returncode"], 0)
        self.assertEqual(record["argv"], [sys.executable, "-m", "py_compile", "app.py"])
        self.assertEqual("".join(tokens), "```json\n" + self.edit_answer() + "\n```")
        self.assertAlmostEqual(result["spent_usd"], 0.0000645, places=10)
        supplied = json.loads(requests[0]["payload"]["messages"][1]["content"])
        self.assertEqual(supplied["target_files"][0]["source"], "value = 1\n")

    def test_real_verification_failure_rolls_back(self):
        with sse_fixture(answer=self.edit_answer("def broken(:\n")) as (url, _), self.endpoint_env(url):
            runner = NodeRunner(self.registry, self.planner, self.root)
            records = []
            def tracked(node, attempt):
                outcome = runner(node, attempt)
                if outcome.verification is not None:
                    records.append(outcome.verification)
                return outcome
            result = self.orchestrator().execute_plan(self.plan(), tracked)
        self.assertEqual(result["overall_status"], "rolled_back")
        self.assertEqual(self.target.read_bytes(), b"value = 1\n")
        self.assertEqual(len(records), 1)
        self.assertNotEqual(records[0].returncode, 0)
        self.assertIn("SyntaxError", records[0].stderr)

    def test_free_text_and_out_of_scope_edits_never_succeed(self):
        outside = json.dumps({"edits": [{"path": "unowned.py", "expected_pre_hash": "", "new_content": "x = 1"}]})
        for answer in ("Success! I fixed everything.", outside):
            with self.subTest(answer=answer), sse_fixture(answer=answer) as (url, _), self.endpoint_env(url):
                outcome = NodeRunner(self.registry, self.planner, self.root)(self.node(), 1)
                self.assertFalse(outcome.success)
                self.assertIsNone(outcome.verification)
                self.assertEqual(self.target.read_bytes(), b"value = 1\n")
                self.assertFalse((self.root / "unowned.py").exists())

    def test_success_with_missing_usage_keeps_cost_unknown(self):
        with sse_fixture(answer=self.edit_answer(), usage=None) as (url, _), self.endpoint_env(url):
            result = self.orchestrator().execute_plan(self.plan(), NodeRunner(self.registry, self.planner, self.root))
        self.assertEqual(result["overall_status"], "completed")
        self.assertIsNone(result["spent_usd"])
        self.assertIsNone(result["node_costs"]["edit"])
        self.assertEqual(self.target.read_bytes(), b"value = 2\n")


class TestDshPayload(EngineFixture):
    def test_payload_reports_tier_model_route_and_track(self):
        payload = build_customization_payload(
            prompt="분산 브로커 동시성 결함 원인을 조사하고 재설계 방안 수립",
            route="zdr_cloud", hardware_tier="standard_local", registry=self.registry)
        self.assertEqual(payload["schema"], PAYLOAD_SCHEMA)
        self.assertEqual(payload["route"], "zdr_cloud")
        self.assertFalse(payload["privacy_consent"])
        self.assertEqual(payload["tier"]["name"], "standard_local")
        self.assertEqual(payload["tier"]["local_model_id"], "local/qwen2.5-coder-7b-gguf")
        self.assertTrue(payload["tier"]["uses_local_llm"])
        self.assertEqual(payload["selected_model"], "deepseek/deepseek-v4.1-flash-1017")
        # Background work is Bonsai-only and the registry never substitutes, so this Tier 2
        # machine reports no runnable background model instead of a Qwen fallback.
        self.assertIsNone(payload["background_model_id"])
        self.assertEqual(payload["track"], "survey_and_plan")
        self.assertGreaterEqual(payload["complexity"], 1)
        self.assertEqual(payload["endpoint_env"]["base_url"], "HARNESS_LLM_BASE_URL")

    def test_payload_route_and_tier_change_the_selection(self):
        default = build_customization_payload(hardware_tier="rule_based_only", registry=self.registry)
        local1 = build_customization_payload(route="local_only", hardware_tier="lightweight_local",
                                            registry=self.registry)
        local0 = build_customization_payload(route="local_only", hardware_tier="rule_based_only",
                                             registry=self.registry)
        consent_only = build_customization_payload(privacy_consent=True, registry=self.registry,
                                                   hardware_tier="rule_based_only")
        any_cloud = build_customization_payload(route="any_cloud", privacy_consent=True,
                                                registry=self.registry, hardware_tier="rule_based_only")
        route_only = build_customization_payload(route="any_cloud", registry=self.registry,
                                                 hardware_tier="rule_based_only")
        # No consent and no explicit route: the payload never names a cloud route or model.
        self.assertEqual(default["route"], "local_only")
        self.assertFalse(default["privacy_consent"])
        self.assertIsNone(default["selected_model"])
        self.assertEqual(default["endpoint_env"]["base_url"], "HARNESS_LOCAL_BASE_URL")
        self.assertEqual(local1["selected_model"], "local/qwen2.5-coder-1.5b-gguf")
        self.assertEqual(local1["endpoint_env"]["base_url"], "HARNESS_LOCAL_BASE_URL")
        # Background never follows the tier's SLM: Bonsai or nothing (no Qwen/cloud substitute).
        self.assertIsNone(local1["background_model_id"])
        # Tier 0 cannot serve local_only, so no model is named that the machine cannot run.
        self.assertIsNone(local0["selected_model"])
        self.assertFalse(local0["tier"]["uses_local_llm"])
        self.assertIsNone(local0["background_model_id"])
        # Consent alone selects the narrowest cloud route; only an explicit route widens it.
        self.assertEqual(consent_only["route"], "zdr_cloud")
        self.assertTrue(consent_only["privacy_consent"])
        self.assertTrue(consent_only["selected_model"])
        self.assertEqual(consent_only["endpoint_env"]["base_url"], "HARNESS_LLM_BASE_URL")
        self.assertEqual(any_cloud["route"], "any_cloud")
        self.assertTrue(any_cloud["privacy_consent"])
        self.assertTrue(any_cloud["selected_model"])
        # Consent is reported, never derived back from the route.
        self.assertEqual(route_only["route"], "any_cloud")
        self.assertFalse(route_only["privacy_consent"])

    def test_payload_without_prompt_has_no_track(self):
        payload = build_customization_payload(registry=self.registry, hardware_tier="standard_local")
        self.assertIsNone(payload["track"])
        self.assertIsNone(payload["complexity"])
        self.assertEqual(payload["target_files"], [])
        json.loads(render_payload(payload))

    def test_payload_never_contains_secret_values(self):
        with llm_env({"HARNESS_LLM_API_KEY": "sk-should-not-leak", "HARNESS_LOCAL_API_KEY": "also-secret"}):
            text = render_payload(build_customization_payload(prompt="src/app.py 오타 수정",
                                                              registry=self.registry))
        self.assertNotIn("sk-should-not-leak", text)
        self.assertNotIn("also-secret", text)

    def test_cli_prints_one_json_object(self):
        import io
        from contextlib import redirect_stdout
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = payload_main(["--prompt", "src/app.py 오타 수정", "--route", "zdr_cloud",
                                 "--tier", "standard_local"])
        self.assertEqual(code, 0)
        lines = buffer.getvalue().strip().splitlines()
        self.assertEqual(len(lines), 1)
        parsed = json.loads(lines[0])
        self.assertEqual(parsed["track"], "direct_execute")
        self.assertEqual(parsed["tier"]["name"], "standard_local")

    def test_cli_rejects_conflicting_route_flags(self):
        import io
        from contextlib import redirect_stderr, redirect_stdout
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            payload_main(["--route", "zdr_cloud", "--consent"])

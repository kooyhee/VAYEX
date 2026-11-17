"""Synchronous orchestrator entry points must refuse to own a second event loop."""
import asyncio
import unittest
from unittest.mock import patch

try:
    from .dag_orchestrator import AttemptOutcome
    from .tests_stub import EngineFixture
except ImportError:  # discovery imports this file as a top-level module, not as engine.*
    from engine.dag_orchestrator import AttemptOutcome
    from engine.tests_stub import EngineFixture


class TestSyncEntryPointInsideRunningLoop(EngineFixture):
    def test_sync_entry_points_refuse_a_running_loop(self):
        orchestrator = self.orchestrator()
        calls = []

        def runner(node, attempt):
            calls.append(node.node_id)
            self.target.write_bytes(b"value = 2\n")
            return AttemptOutcome(True, None, node.model_id)

        async def scenario():
            plan = self.plan()
            with patch.object(asyncio, "run", side_effect=AssertionError("a second event loop was started")):
                for call in (lambda: orchestrator.execute_plan(plan, runner),
                             lambda: orchestrator.execute_plan_parallel(plan, runner),
                             lambda: orchestrator.run_node(plan, plan.nodes[0], runner, 0.0)):
                    with self.assertRaisesRegex(RuntimeError, "execute_plan_async"):
                        call()
            # The refusal is decided before the runner, a snapshot or any rollback can run:
            # nothing was executed on a foreign loop while this loop owns the workspace.
            self.assertEqual(calls, [])
            self.assertEqual(self.workspace._index, {})
            self.assertEqual(self.workspace.last_rollback, {})
            self.assertEqual(self.target.read_bytes(), b"value = 1\n")
            # The documented alternative stays a real, working awaitable path.
            return await orchestrator.execute_plan_async(self.plan(), runner)

        result = asyncio.run(scenario())
        self.assertEqual(calls, ["edit"])
        self.assertEqual(result["overall_status"], "completed")
        self.assertEqual(self.target.read_bytes(), b"value = 2\n")

    def test_failed_plan_rolls_back_once_on_the_owning_loop(self):
        orchestrator = self.orchestrator()

        def failing(node, attempt):
            self.target.write_bytes(b"value = 2\n")
            return AttemptOutcome(False, None, node.model_id)

        async def scenario():
            plan = self.plan()
            with patch.object(asyncio, "run", side_effect=AssertionError("a second event loop was started")):
                with self.assertRaisesRegex(RuntimeError, "run_node_async"):
                    orchestrator.run_node(plan, plan.nodes[0], failing, 0.0)
            self.assertEqual(self.target.read_bytes(), b"value = 1\n")
            return await orchestrator.execute_plan_async(self.plan(), failing)

        result = asyncio.run(scenario())
        self.assertEqual(result["overall_status"], "rolled_back")
        self.assertEqual(result["rollback"],
                         {"status": "restored", "restored_paths": ["app.py"], "conflicts": []})
        self.assertEqual(self.target.read_bytes(), b"value = 1\n")


if __name__ == "__main__":
    unittest.main()

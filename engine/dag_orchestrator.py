"""DeepSeek Harness 실행 오케스트레이터 (Single-App Deterministic DAG Orchestrator).

DeepSeek Harness는 OpenCodex 모델 게이트웨이를 내부에 직접 내장한 단일 배포
데스크톱/CLI 애플리케이션이다. 따라서 이 오케스트레이터는 외부 모델 라우터나 원격
모델 마켓에 의존하지 않고, 앱에 동봉된 큐레이션 프리셋(``registry.CURATED_APP_RELEASE_VERSION``)과
기본 모델 ``deepseek/deepseek-v4.1-flash-1017``만으로 2-Track 플래너가 합성한 DAG를
결정론적으로 실행한다. 프리셋은 런타임 스크래핑이 아니라 정기 앱 릴리스로 갱신된다.
"""
import asyncio
import inspect
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Coroutine, Dict, List, Optional, Union

from .decision_planner import ExecutionDAGPlan, DAGNode
from .registry import ModelIntelligenceRegistry, escalation_role

Runner = Callable[[DAGNode, int], Any]
AsyncRunner = Callable[[DAGNode, int], Awaitable[Any]]


class BudgetExhaustedError(RuntimeError):
    """세션 예산(max_budget_usd)을 초과했을 때 발생한다."""


@dataclass
class AttemptOutcome:
    success: bool
    cost_usd: Optional[float]
    model_id: str
    verification: Any = None
    error: Optional[str] = None
    applied_paths: List[str] = field(default_factory=list)


@dataclass
class FileSnapshot:
    target: str
    backup_path: Optional[Path]
    pre_hash: Optional[str]
    post_hash: Optional[str]
    restored: bool = False
    post_error: bool = False


@dataclass
class FileIsolationWorkspace:
    """Hash-guarded recovery store. Backups are retained; external edits are never overwritten."""
    root: Optional[str] = None
    base_dir: str = "."
    _root: Path = field(init=False, repr=False)
    _index: Dict[str, List[FileSnapshot]] = field(default_factory=dict, init=False, repr=False)
    last_rollback: Dict[str, Any] = field(default_factory=dict, init=False)

    def __post_init__(self) -> None:
        if self.root:
            base = Path(self.root)
        else:
            from datetime import date
            parent = Path.home() / "Desktop" / "_backup"
            parent.mkdir(parents=True, exist_ok=True)
            base = Path(tempfile.mkdtemp(prefix=f"{date.today().isoformat()}-dag-", dir=parent))
        base.mkdir(parents=True, exist_ok=True)
        self._root = base.resolve()
        self.base_dir = str(Path(self.base_dir).resolve())

    @property
    def root_path(self) -> Path:
        return self._root

    def snapshot(self, node: DAGNode, base_dir: Optional[Union[str, Path]] = None) -> Dict[str, Optional[Path]]:
        from .file_tools import resolve_within, hash_bytes
        base = base_dir if base_dir is not None else self.base_dir
        backup_dir = Path(tempfile.mkdtemp(prefix="node-", dir=self._root))
        entries = []
        for index, target in enumerate(node.target_files):
            source = resolve_within(base, target)
            payload = source.read_bytes() if source.is_file() else None
            backup_path = None
            pre_hash = None
            if payload is not None:
                backup_dir.mkdir(parents=True, exist_ok=True)
                backup_path = backup_dir / f"{index:03d}.bak"
                backup_path.write_bytes(payload)
                pre_hash = hash_bytes(payload)
            entries.append(FileSnapshot(target, backup_path, pre_hash, pre_hash))
        self._index[node.node_id] = entries
        return {entry.target: entry.backup_path for entry in entries}

    def record_post_hashes(self, node_id: str, base_dir: Optional[Union[str, Path]] = None) -> None:
        from .file_tools import FileToolError, resolve_within, hash_file
        base = base_dir if base_dir is not None else self.base_dir
        for entry in self._index.get(node_id, []):
            try:
                entry.post_hash = hash_file(resolve_within(base, entry.target))
            except (FileToolError, OSError):
                entry.post_error = True

    def restore(self, node_id: str, base_dir: Optional[Union[str, Path]] = None) -> Dict[str, Any]:
        from .file_tools import FileToolError, resolve_within, hash_file, hash_bytes, write_atomic
        base = base_dir if base_dir is not None else self.base_dir
        restored, conflicts = [], []
        for entry in self._index.get(node_id, []):
            if entry.restored:
                continue
            try:
                path = resolve_within(base, entry.target)
                if entry.post_error or hash_file(path) != entry.post_hash:
                    conflicts.append(entry.target)
                    continue
                if entry.backup_path is None:
                    if path.is_file():
                        path.unlink()
                else:
                    payload = entry.backup_path.read_bytes()
                    if hash_bytes(payload) != entry.pre_hash:
                        conflicts.append(entry.target)
                        continue
                    write_atomic(path, payload)
            except (FileToolError, OSError):
                conflicts.append(entry.target)
                continue
            entry.restored = True
            restored.append(entry.target)
        self.last_rollback = {"status": "rollback_conflict" if conflicts else "restored",
                              "restored_paths": restored, "conflicts": conflicts}
        return self.last_rollback

    def restore_all(self, base_dir: Optional[Union[str, Path]] = None) -> Dict[str, Any]:
        restored, conflicts = [], []
        # Reverse execution order preserves intermediate versions shared by dependent nodes.
        for node_id in reversed(list(self._index)):
            record = self.restore(node_id, base_dir)
            restored.extend(record["restored_paths"])
            conflicts.extend(record["conflicts"])
        self.last_rollback = {"status": "rollback_conflict" if conflicts else "restored",
                              "restored_paths": restored, "conflicts": conflicts}
        return self.last_rollback


class DeterministicDAGOrchestrator:
    """
    앱 내장 결정론적 DAG 오케스트레이터 (Embedded Deterministic DAG Orchestrator)
    - 단일 배포 앱(DeepSeek Harness + 내장 OpenCodex 게이트웨이) 안에서만 실행되며,
      외부 모델 마켓/동적 스크래핑 라우터를 조회하지 않는다(프리셋은 정기 앱 릴리스로 갱신).
    - Plan Validator: 순환 참조(Cycle) 검증, 미존재 의존성 검사, 예산 한도 사전 검증
    - DAG Scheduler: 위상 정렬(Topological Sort) 및 동일 레이어 병렬 실행 (asyncio)
    - 3단계 장애 복구 (Local Retry -> Model Escalation -> Local Replanning)
      승격 시에도 큐레이션 프리셋 내 상위 프리셋(예: claude-sonnet-4.5)만 사용한다.
    - 예산: 실행 전 정적 차감 대신, 매 시도의 실제 비용을 실행 후 누적
    """
    def __init__(
        self,
        registry: ModelIntelligenceRegistry,
        max_budget_usd: float = 1.0,
        max_parallelism: int = 4,
        workspace: Optional[FileIsolationWorkspace] = None,
    ):
        self.registry = registry
        self.max_budget_usd = max_budget_usd
        self.max_parallelism = max(1, int(max_parallelism))
        self.workspace = workspace

    # ------------------------------------------------------------------ #
    # Validation & layering
    # ------------------------------------------------------------------ #
    def validate_plan(self, plan: ExecutionDAGPlan) -> None:
        if plan.estimated_budget_usd > self.max_budget_usd:
            raise ValueError(
                f"BudgetExceededError: estimated {plan.estimated_budget_usd} USD > limit {self.max_budget_usd} USD"
            )
        from .file_tools import resolve_within
        if any(node.target_files for node in plan.nodes) and self.workspace is None:
            raise ValueError("FileIsolationWorkspace is required for plans with target_files")
        node_map = {n.node_id: n for n in plan.nodes}
        if len(node_map) != len(plan.nodes):
            raise ValueError("Duplicate node ids are not permitted")
        for node in plan.nodes:
            if self.workspace is not None:
                for rel in node.target_files:
                    resolve_within(self.workspace.base_dir, rel)
            for dep in node.dependencies:
                if dep not in node_map:
                    raise ValueError(f"MissingDependencyError: {node.node_id} depends on unknown {dep}")

        # Cycle detection via topological layering
        self.compute_execution_layers(plan)

    def compute_execution_layers(self, plan: ExecutionDAGPlan) -> List[List[DAGNode]]:
        node_map = {n.node_id: n for n in plan.nodes}
        in_degree: Dict[str, int] = {n.node_id: len(n.dependencies) for n in plan.nodes}
        dependents: Dict[str, List[str]] = {n.node_id: [] for n in plan.nodes}
        for n in plan.nodes:
            for dep in n.dependencies:
                dependents[dep].append(n.node_id)

        layers: List[List[DAGNode]] = []
        ready = [nid for nid, deg in in_degree.items() if deg == 0]
        visited = 0

        while ready:
            current_layer = [node_map[nid] for nid in ready]
            layers.append(current_layer)
            visited += len(ready)
            next_ready = []
            for nid in ready:
                for child in dependents[nid]:
                    in_degree[child] -= 1
                    if in_degree[child] == 0:
                        next_ready.append(child)
            ready = next_ready

        if visited != len(plan.nodes):
            raise ValueError("CyclicDependencyError: DAG contains a cycle")
        return layers

    # ------------------------------------------------------------------ #
    # Escalation / accounting helpers
    # ------------------------------------------------------------------ #
    def select_escalation_model(self, plan: ExecutionDAGPlan, node: DAGNode):
        """세션 프라이버시 동의와 노드 역할을 존중한 승격 모델 선택."""
        return self.registry.select_model(
            escalation_role(node.role),
            mode="quality",
            privacy_consent=plan.privacy_consent,
            route=plan.route,
            input_tokens=max(node.estimated_input_tokens, 1),
            output_tokens=max(node.estimated_output_tokens, 1),
            cache_hit_ratio=node.cache_hit_ratio,
        )

    @staticmethod
    def _coerce_outcome(raw: Any) -> AttemptOutcome:
        """Legacy runner shapes remain accepted, but absent billing is always unknown."""
        import math
        if isinstance(raw, AttemptOutcome):
            outcome = raw
        elif isinstance(raw, dict) and isinstance(raw.get("success"), bool):
            outcome = AttemptOutcome(raw["success"], raw.get("cost_usd"), str(raw.get("model_id", "")))
        elif isinstance(raw, (tuple, list)) and len(raw) >= 2 and isinstance(raw[0], bool):
            outcome = AttemptOutcome(raw[0], raw[1], str(raw[2]) if len(raw) > 2 else "")
        elif isinstance(raw, bool):
            outcome = AttemptOutcome(raw, None, "")
        else:
            raise TypeError("runner must return an AttemptOutcome or explicit boolean outcome")
        if not isinstance(outcome.success, bool):
            raise TypeError("outcome.success must be a boolean")
        if outcome.cost_usd is not None:
            cost = float(outcome.cost_usd)
            if not math.isfinite(cost) or cost < 0:
                raise ValueError("reported cost must be finite and non-negative")
            outcome.cost_usd = cost
        return outcome

    def _prepare_node(self, node: DAGNode, attempt: int, plan: ExecutionDAGPlan) -> None:
        if attempt == 3:
            node.model_id = self.select_escalation_model(plan, node).model_id
            node.reasoning_effort = "high"

    async def _invoke(self, runner, node, attempt):
        if inspect.iscoroutinefunction(runner) or inspect.iscoroutinefunction(getattr(runner, "__call__", None)):
            return await runner(node, attempt)
        task = asyncio.create_task(asyncio.to_thread(runner, node, attempt))
        try:
            raw = await asyncio.shield(task)
        except asyncio.CancelledError:
            # A Python worker thread cannot be cancelled. Join it before recording post-hashes
            # and rolling back, so it cannot write after recovery has completed.
            await task
            raise
        return await raw if inspect.isawaitable(raw) else raw

    async def _run_node_async(self, plan, node, runner, ledger=None):
        ledger = ledger if ledger is not None else {"known": 0.0, "unknown": False}
        node_cost = 0.0
        unknown = False
        if self.workspace is not None:
            self.workspace.snapshot(node)
        for attempt in (1, 2, 3):
            self._prepare_node(node, attempt, plan)
            try:
                raw = await self._invoke(runner, node, attempt)
            finally:
                if self.workspace is not None:
                    self.workspace.record_post_hashes(node.node_id)
            outcome = self._coerce_outcome(raw)
            if outcome.cost_usd is None:
                unknown = ledger["unknown"] = True
            else:
                node_cost += outcome.cost_usd
                ledger["known"] += outcome.cost_usd
            actual_model = outcome.model_id or node.model_id
            if actual_model in {entry.model_id for entry in self.registry.catalog}:
                self.registry.record_outcome(actual_model, node.role, outcome.success)
            if ledger["known"] > self.max_budget_usd:
                raise BudgetExhaustedError(
                    f"reported spend {ledger['known']:.6f} USD exceeds limit {self.max_budget_usd} USD")
            result = {
                "status": "succeeded" if outcome.success else "failed_rollback_triggered",
                "attempts": attempt, "final_model": actual_model, "escalated": attempt == 3,
                "node_cost_usd": None if unknown else round(node_cost, 8),
                "verification": outcome.verification.to_dict() if outcome.verification else None,
                "error": outcome.error, "applied_paths": outcome.applied_paths,
            }
            if outcome.success:
                break
        return result, (None if unknown else node_cost)

    async def run_node_async(self, plan, node, runner, spent_usd):
        """Awaitable single-node run; the entry point to use from inside a running loop."""
        self.validate_plan(plan)
        ledger = {"known": spent_usd or 0.0, "unknown": spent_usd is None}
        committed = False
        try:
            result, _ = await self._run_node_async(plan, node, runner, ledger)
            committed = result["status"] == "succeeded"
            return result, (None if ledger["unknown"] else ledger["known"])
        finally:
            if not committed and self.workspace is not None:
                self.workspace.restore(node.node_id)

    def run_node(self, plan, node, runner, spent_usd):
        """Synchronous single-node run. A caller holding a loop must await run_node_async."""
        return self.run_coroutine(self.run_node_async(plan, node, runner, spent_usd))

    def execute_plan(self, plan: ExecutionDAGPlan, runner: Runner) -> Dict[str, Any]:
        """Synchronous sequential run. A caller holding a loop must await execute_plan_async."""
        return self.run_coroutine(self.execute_plan_async(plan, runner, _parallel=False))

    async def execute_plan_async(self, plan: ExecutionDAGPlan, runner, _parallel=True) -> Dict[str, Any]:
        """All exits except a completed plan recover in finally, including cancellation.

        Known provider spend is budget-checked after every attempt; missing usage makes
        the aggregate unknown, not zero. Parallel calls already in flight may incur cost.
        """
        from contextlib import AsyncExitStack
        from .file_tools import resolve_within
        self.validate_plan(plan)
        if self.workspace is not None and hasattr(runner, "workspace_root"):
            if Path(runner.workspace_root).resolve() != Path(self.workspace.base_dir).resolve():
                raise ValueError("runner workspace_root must match FileIsolationWorkspace.base_dir")
        layers = self.compute_execution_layers(plan)
        ledger = {"known": 0.0, "unknown": False}
        results = {}
        node_costs = {}
        semaphore = asyncio.Semaphore(self.max_parallelism if _parallel else 1)
        path_locks = {}
        completed = False
        response = None
        tasks = []
        if self.workspace is not None:
            # A workspace can be reused, but recovery must never touch a previous plan.
            self.workspace._index.clear()

        async def guarded(node):
            async with semaphore, AsyncExitStack() as stack:
                paths = sorted({str(resolve_within(self.workspace.base_dir, rel))
                                for rel in node.target_files}) if self.workspace else []
                for path in paths:
                    await stack.enter_async_context(path_locks.setdefault(path, asyncio.Lock()))
                result, cost = await self._run_node_async(plan, node, runner, ledger)
                results[node.node_id] = result
                node_costs[node.node_id] = None if cost is None else round(cost, 8)

        try:
            for layer in layers:
                tasks = [asyncio.create_task(guarded(node)) for node in layer]
                await asyncio.gather(*tasks)
                if any(result["status"] != "succeeded" for result in results.values()):
                    break
            completed = len(results) == len(plan.nodes) and all(
                result["status"] == "succeeded" for result in results.values())
            response = {"plan_id": plan.plan_id,
                        "overall_status": "completed" if completed else "rolled_back",
                        "spent_usd": None if ledger["unknown"] else round(ledger["known"], 8),
                        "known_spent_usd": round(ledger["known"], 8),
                        "node_costs": node_costs, "node_results": results}
            return response
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            if not completed and self.workspace is not None:
                rollback = self.workspace.restore_all()
                if response is not None:
                    response["rollback"] = rollback
                    if rollback["status"] == "rollback_conflict":
                        response["overall_status"] = "rollback_conflict"

    def execute_plan_parallel(self, plan, runner):
        """Synchronous parallel run. A caller holding a loop must await execute_plan_async."""
        return self.run_coroutine(self.execute_plan_async(plan, runner))

    def run_coroutine(self, coro: Coroutine[Any, Any, Any]) -> Any:
        """Drive *coro* to completion on a loop owned by a synchronous caller.

        A synchronous entry point cannot await inside the caller's loop, and running the
        same plan on a second loop in another thread would execute nodes, snapshots and
        rollback concurrently with the caller's loop that owns the workspace state. So a
        running loop is refused rather than offloaded: await execute_plan_async or
        run_node_async instead.
        """
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(coro)
        coro.close()
        raise RuntimeError(
            "synchronous orchestrator entry points (run_node, execute_plan, execute_plan_parallel) "
            "cannot run inside a running event loop; await execute_plan_async(...) or "
            "run_node_async(...) instead of starting a second loop")

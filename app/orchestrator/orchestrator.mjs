// 이 파일은 **독립 실행되는 DAG 스케줄러**이며 브리지는 이 모듈을 import하지
// 않는다(실제 import는 `app/test/orchestrator.test.mjs` 하나뿐). 그러므로 아래
// 규칙은 이 클래스를 직접 구동할 때의 계약이고, 실 턴 경로에서 도는 코드가
// 아니다. 미래의 독자가 "여기가 실행된다"고 가정하지 않도록 이유를 적어 둔다.
//
// 실 턴은 의도적으로 단일 모델·단일 프레임이다: 브리지는 한 프레임을 한 코어
// 자식에게 쓰고(`app/server.mjs:852`), 역할 체인 하나를 순차 해석하며
// (`app/server.mjs:856-865`), 추론 표면은 요청당 핸들러 하나를 디스패치한다
// (`app/lib/inference.mjs:255`). 서브에이전트 스케줄링은 코어가 소유한다 —
// omp `TaskTool`의 `WorkPool`이 `task.batch`(기본 true)와 `task.maxConcurrency`
// (기본 32)로 자기 서브에이전트를 돌리고, 그 상태는 허용 명령 `get_subagents`로
// 드러난다. 그래서 이 모듈은 빠진 이음매가 아니라 중복 경로다.
//
// Orchestrator: the main agent plans and delegates, subagents do survey /
// implement / verify, and nothing here calls a provider itself.
//
// Rules this enforces, in order:
//   * dependency   a task starts only when every task it depends on completed.
//   * file conflict two tasks that name the same file never hold it at once.
//   * budget       a run has a USD ceiling; a task that would exceed it is
//                  dropped to `blocked` and the run reports the shortfall.
//   * parallelism  tasks run in parallel only when the estimated gain is
//                  positive: |ready| tasks that each take T run in T instead of
//                  |ready| * T, so concurrency is chosen when
//                  seqMs/parMs >= MIN_PARALLEL_GAIN and never merely because a
//                  queue has more than one entry.
//   * failure      a repeated failure signature is retried selectively, escalates
//                  the model, and after the last attempt triggers a *partial*
//                  replan: the failed task is dropped and its dependents are
//                  blocked, while independent tasks keep going. Whole-run abort
//                  only happens when nothing is left runnable.
//
// Every step emits the documented structured events (run.start / decision /
// task.start / task.delegate / task.file_change / task.verify / task.retry /
// task.done / run.done) through gateway/lib/events.mjs, with the task's model and
// the tokens/cost the executor reported.

import { emitEvent } from '../../gateway/lib/events.mjs';
import { recordOptimization } from '../../gateway/lib/accounting.mjs';
import { localDigest, localProgressSummary, localTitle, skippedExternal } from '../../gateway/lib/local-background.mjs';

export const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
});

export const AGENT_ROLES = Object.freeze({
  ORCHESTRATOR: 'orchestrator',
  SURVEYOR: 'surveyor',
  IMPLEMENTER: 'implementer',
  VERIFIER: 'verifier',
});

// Parallelism is only worth it when it saves at least this share of the
// sequential wall time; below it the coordination cost is the larger number.
export const MIN_PARALLEL_GAIN = 1.15;
export const DEFAULT_ESCALATION = Object.freeze(['tier-1-fast', 'tier-2-medium', 'tier-3-smart']);

export class Orchestrator {
  constructor({
    sessionId = 'session-main',
    runId = null,
    maxParallel = 3,
    maxRetries = 2,
    escalationModels = DEFAULT_ESCALATION,
    budgetUsd = Infinity,
    executor = null,
    estimateMs = { survey: 60, implement: 240, verify: 90 },
  } = {}) {
    this.sessionId = sessionId;
    this.runId = runId ?? `run-${sessionId}`;
    this.maxParallel = Math.max(1, maxParallel);
    this.maxRetries = Math.max(0, maxRetries);
    this.escalationModels = [...escalationModels];
    this.budgetUsd = budgetUsd;
    this.executor = executor ?? (async (task) => ({ status: 'success', task: task.id }));
    this.estimateMs = estimateMs;

    this.tasks = new Map();
    this.fileLocks = new Map();
    this.attempts = new Map();
    this.spentUsd = 0;
    this.tokensUsed = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }

  addTask({ id, description, role = AGENT_ROLES.IMPLEMENTER, files = [], deps = [], model = null }) {
    if (!id || this.tasks.has(id)) throw new Error(`task id ${id} is missing or duplicated`);
    this.tasks.set(id, {
      id,
      description,
      role,
      files: [...files],
      deps: [...deps],
      model: model ?? this.escalationModels[0],
      status: TASK_STATUS.PENDING,
      error: null,
      result: null,
      verification: null,
    });
    return this.tasks.get(id);
  }

  ready() {
    return [...this.tasks.values()].filter((task) => task.status === TASK_STATUS.PENDING
      && task.deps.every((dep) => this.tasks.get(dep)?.status === TASK_STATUS.COMPLETED)
      && !task.files.some((file) => this.fileLocks.has(file)));
  }

  // Sequential vs parallel wall time for a batch of ready tasks. Tasks without
  // a known estimate use the role's default.
  parallelEstimate(tasks) {
    const each = tasks.map((task) => this.estimateMs[task.role] ?? this.estimateMs.implement ?? 120);
    const seqMs = each.reduce((sum, ms) => sum + ms, 0);
    const parMs = Math.max(...each, 0);
    return {
      seqMs,
      parMs,
      gain: parMs > 0 ? seqMs / parMs : 1,
      width: tasks.length,
      parallel: tasks.length > 1 && parMs > 0 && seqMs / parMs >= MIN_PARALLEL_GAIN,
    };
  }

  async run() {
    emitEvent('run.start', {
      session: this.sessionId,
      run: this.runId,
      agent: AGENT_ROLES.ORCHESTRATOR,
      data: {
        taskCount: this.tasks.size,
        maxParallel: this.maxParallel,
        budgetUsd: Number.isFinite(this.budgetUsd) ? this.budgetUsd : null,
        title: localTitle({ prompt: [...this.tasks.values()].map((task) => task.description).join('\n') }),
      },
    });

    while (this.tasks.size > 0) {
      const runnable = this.ready();
      if (runnable.length === 0) {
        if ([...this.tasks.values()].some((task) => task.status === TASK_STATUS.RUNNING)) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          continue;
        }
        break;
      }

      if (this.spentUsd >= this.budgetUsd) {
        const blocked = runnable.filter((task) => task.status === TASK_STATUS.PENDING);
        for (const task of blocked) task.status = TASK_STATUS.BLOCKED;
        emitEvent('decision', {
          session: this.sessionId,
          run: this.runId,
          data: { track: 'partial_replan', reason: 'budget_exhausted', blocked: blocked.map((task) => task.id), spentUsd: this.spentUsd },
        });
        break;
      }

      const plan = this.parallelEstimate(runnable);
      const width = plan.parallel ? Math.min(this.maxParallel, plan.width) : 1;
      // The file-conflict lock is claimed here, while the batch is being
      // chosen — never after it is committed. A second task naming a file an
      // earlier batch member already claimed is left pending for a later round,
      // so two tasks can never hold one file (or run on it) at the same time.
      const claimed = new Set();
      const batch = [];
      for (const task of runnable) {
        if (batch.length >= width) break;
        if (task.files.some((file) => claimed.has(file))) continue;
        for (const file of task.files) claimed.add(file);
        batch.push(task);
      }
      emitEvent('decision', {
        session: this.sessionId,
        run: this.runId,
        data: {
          track: 'delegate',
          reason: batch.length > 1 ? 'parallel_gain_positive' : 'parallel_gain_negative',
          width: batch.length,
          sequentialMs: plan.seqMs,
          parallelMs: plan.parMs,
          gain: Number(plan.gain.toFixed(2)),
          tasks: batch.map((task) => task.id),
        },
      });

      for (const task of batch) {
        for (const file of task.files) this.fileLocks.set(file, task.id);
        emitEvent('task.delegate', {
          session: this.sessionId,
          run: this.runId,
          task: task.id,
          role: task.role,
          model: task.model,
          data: { owner: task.role, files: task.files, deps: task.deps },
        });
      }
      await Promise.all(batch.map((task) => this.execute(task)));
    }

    const all = [...this.tasks.values()];
    const success = all.length > 0 && all.every((task) => task.status === TASK_STATUS.COMPLETED);
    const summary = {
      success,
      totalTasks: all.length,
      completed: all.filter((task) => task.status === TASK_STATUS.COMPLETED).length,
      failed: all.filter((task) => task.status === TASK_STATUS.FAILED).length,
      blocked: all.filter((task) => task.status === TASK_STATUS.BLOCKED).length,
      spentUsd: Number(this.spentUsd.toFixed(6)),
      tokens: { ...this.tokensUsed },
    };
    if (all.length > 0) {
      // The run's progress line is local: no summary model is called for it.
      skippedExternal({ kind: 'progress', session: this.sessionId, run: this.runId, replacedBy: 'localProgressSummary' });
    }
    emitEvent('run.done', {
      session: this.sessionId,
      run: this.runId,
      agent: AGENT_ROLES.ORCHESTRATOR,
      data: {
        ...summary,
        progress: this.tasks.size === 0 ? '' : localDigest({
          text: all.map((task) => `${task.id} ${task.status} ${task.error ?? ''}`).join('\n'),
          maxLines: 6,
        }),
      },
    });
    return { ...summary, tasks: Object.fromEntries(this.tasks) };
  }

  async execute(task) {
    task.status = TASK_STATUS.RUNNING;
    emitEvent('task.start', {
      session: this.sessionId,
      run: this.runId,
      task: task.id,
      role: task.role,
      model: task.model,
      data: { description: task.description, files: task.files, deps: task.deps },
    });

    let attempt = 0;
    const failures = [];
    while (attempt <= this.maxRetries) {
      attempt += 1;
      this.attempts.set(task.id, attempt);
      const startedAt = Date.now();
      try {
        const result = await this.executor(task);
        const elapsedMs = Date.now() - startedAt;
        this.account(task, result);
        task.result = result ?? null;
        task.status = TASK_STATUS.COMPLETED;
        if (Array.isArray(result?.files)) {
          for (const path of result.files) {
            emitEvent('task.file_change', {
              session: this.sessionId,
              run: this.runId,
              task: task.id,
              model: task.model,
              data: { path, change: result.change ?? 'modified' },
            });
          }
        }
        const verification = result?.verified === undefined ? null : result.verified === true;
        task.verification = verification;
        emitEvent('task.verify', {
          session: this.sessionId,
          run: this.runId,
          task: task.id,
          model: task.model,
          elapsedMs,
          data: { ok: verification, checks: result?.checks ?? null },
        });
        emitEvent('task.done', {
          session: this.sessionId,
          run: this.runId,
          task: task.id,
          role: task.role,
          model: task.model,
          tokens: result?.tokens ?? null,
          cost: result?.cost ?? null,
          elapsedMs,
          data: { ok: true, attempts: attempt },
        });
        return result;
      } catch (error) {
        const signature = String(error?.message ?? error);
        failures.push(signature);
        const repeated = failures.filter((other) => other === signature).length >= 2;
        const elapsedMs = Date.now() - startedAt;
        if (attempt <= this.maxRetries) {
          const nextIndex = Math.min(attempt, this.escalationModels.length - 1);
          const escalated = this.escalationModels[nextIndex];
          task.model = escalated;
          emitEvent('task.retry', {
            session: this.sessionId,
            run: this.runId,
            task: task.id,
            role: task.role,
            model: escalated,
            elapsedMs,
            data: { attempt, error: signature, repeated, escalatedModel: escalated, strategy: repeated ? 'escalate_model' : 'retry_same_model' },
          });
          continue;
        }
        // Last attempt failed: partial replan, not a whole-run abort.
        task.status = TASK_STATUS.FAILED;
        task.error = signature;
        const blocked = this.blockDependents(task.id);
        emitEvent('decision', {
          session: this.sessionId,
          run: this.runId,
          task: task.id,
          data: { track: 'partial_replan', reason: 'repeated_failure', error: signature, attempts: attempt, blocked },
        });
        emitEvent('task.done', {
          session: this.sessionId,
          run: this.runId,
          task: task.id,
          role: task.role,
          model: task.model,
          elapsedMs,
          tokens: null,
          cost: null,
          data: { ok: false, error: signature, attempts: attempt },
        });
        return null;
      } finally {
        for (const file of task.files) this.fileLocks.delete(file);
      }
    }
    return null;
  }

  dependentsOf(taskId) {
    return [...this.tasks.values()].filter((task) => task.deps.includes(taskId));
  }

  // Blocking walks the dependency chain transitively: a second-order dependent
  // left pending can never pass ready() (its dep is blocked, not completed) and
  // the run loop then exits with it stuck in `pending` instead of `blocked`.
  blockDependents(taskId) {
    const blocked = [];
    const seen = new Set([taskId]);
    const queue = [taskId];
    while (queue.length > 0) {
      for (const dependent of this.dependentsOf(queue.shift())) {
        if (seen.has(dependent.id)) continue;
        seen.add(dependent.id);
        queue.push(dependent.id);
        if (dependent.status === TASK_STATUS.PENDING) {
          dependent.status = TASK_STATUS.BLOCKED;
          blocked.push(dependent.id);
        }
      }
    }
    return blocked;
  }

  // Token/cost bookkeeping from what the executor reported; unknown stays unknown.
  account(task, result) {
    const tokens = result?.tokens ?? null;
    if (tokens && typeof tokens === 'object') {
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        if (Number.isFinite(tokens[key])) this.tokensUsed[key] += tokens[key];
      }
    }
    const usd = Number.isFinite(result?.cost?.usd) ? result.cost.usd : 0;
    this.spentUsd += usd;
    if (result?.compressed) {
      recordOptimization({
        taskId: task.id,
        strategy: 'tool_output_compression',
        tokensSaved: Number.isFinite(result.compressed.tokensSaved) ? result.compressed.tokensSaved : 0,
        costSavedUsd: Number.isFinite(result.compressed.costSavedUsd) ? result.compressed.costSavedUsd : 0,
        session: this.sessionId,
        run: this.runId,
        model: task.model,
      });
    }
  }
}

export function progressLine(orchestrator) {
  return localProgressSummary({ events: [], run: orchestrator.runId });
}


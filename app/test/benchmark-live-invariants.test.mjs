import test from 'node:test';
import assert from 'node:assert/strict';
import { BENCHMARK_TASKS } from '../../scripts/lib/benchmark-tasks.mjs';
import { LIVE_ENVIRONMENTS, computeLiveCostView, assertEnvironmentRegistry } from '../../scripts/lib/live-environments.mjs';
import { validateTaskSpec, taskSpecFingerprint } from '../../scripts/lib/live-hidden-evaluator.mjs';
import { buildPayload, assertExportInvariants } from '../../scripts/benchmark-live-4env.mjs';

const OPTS = { repetitions: 2, promptMode: 'as_shipped' };
const WRITER = { startedAt: '2026-01-01T00:00:00.000Z', startedMs: Date.parse('2026-01-01T00:00:00.000Z') };

function syntheticRuns() {
  const runs = [];
  for (const envId of Object.keys(LIVE_ENVIRONMENTS)) {
    const blocked = LIVE_ENVIRONMENTS[envId].status === 'unmeasured_blocked_by_provider';
    for (const task of BENCHMARK_TASKS) {
      for (let rep = 1; rep <= OPTS.repetitions; rep++) {
        const cost = computeLiveCostView(envId, blocked ? {} : { promptTokens: 1000, completionTokens: 100, cachedTokens: 100, invocationUsage: [{ prompt: 1000, completion: 100, cached: 100 }] });
        runs.push({
          runId: `${task.id}_${envId}_${rep}`,
          envId,
          taskId: task.id,
          taskName: task.name,
          taskCategory: task.category,
          repetition: rep,
          taskFingerprint: taskSpecFingerprint(task, task.prompt),
          codingTaskSuccess: !blocked,
          success: !blocked,
          testSuccess: { passedCount: blocked ? 0 : task.hiddenTests.length, totalTests: task.hiddenTests.length, passRate: blocked ? 0 : 1 },
          failureKind: blocked ? 'provider_capacity_blocked' : null,
          failureReason: blocked ? 'Selected model is at capacity' : null,
          wallMs: 1000,
          completionTimeMs: 1000,
          ttftMs: null,
          tokens: blocked ? null : { prompt: 1000, completion: 100, cached: 100, total: 1100 },
          billingViews: {
            providerBilledAmount: cost.providerBilledAmount,
            apiUnitPriceConversion: cost.apiUnitPriceConversion,
            subscriptionAssumptionCost: cost.subscriptionAssumptionCost,
          },
          realCost: cost.realCost,
          costs: cost,
          startedAt: '2026-01-01T00:00:00.000Z',
        });
      }
    }
  }
  return runs;
}

test('benchmark runner keeps test success, coding-task success and billing views separate', () => {
  const runs = syntheticRuns();
  const payload = buildPayload(runs, OPTS, 'node scripts/benchmark-live-4env.mjs', runs.length, WRITER, false, null);

  assert.equal(payload.comparison.complete, false);
  assert.deepEqual(payload.comparison.unmeasuredEnvironments, ['codex-cli']);
  assert.equal(payload.claims.costAdvantage, null);
  assert.equal(payload.claims.superiority, null);
  assert.equal(payload.claims.claimAllowed, false);
  assert.match(payload.comparison.caption, /비교는 완전하지 않다/);

  const codex = payload.environmentSummaries['codex-cli'];
  assert.equal(codex.status, 'unmeasured_blocked_by_provider');
  assert.equal(codex.overallSuccessRate, null);
  assert.equal(codex.codingTaskSuccesses, null);
  const claude = payload.environmentSummaries['claude-opus-5-5'];
  assert.equal(claude.codingTaskSuccesses, 8);
  assert.ok(claude.testPassRate > 0);

  for (const run of payload.runs) {
    assert.equal(run.realCost, null);
    assert.equal(run.billingViews.providerBilledAmount.usd, null);
    assert.equal(run.billingViews.subscriptionAssumptionCost.usd, 0);
    if (run.envId !== 'codex-cli') assert.notEqual(run.billingViews.apiUnitPriceConversion.usd, null);
  }

  assertExportInvariants(payload, runs, OPTS);
});

test('runner refuses an export that violates a separation or the incomplete-comparison rule', () => {
  const runs = syntheticRuns();
  const payload = buildPayload(runs, OPTS, 'node scripts/benchmark-live-4env.mjs', runs.length, WRITER, false, null);
  assertExportInvariants(payload, runs, OPTS);

  const noBilling = syntheticRuns();
  noBilling[0].billingViews = null;
  assert.throws(() => assertExportInvariants(buildPayload(noBilling, OPTS, 'x', noBilling.length, WRITER, false, null), noBilling, OPTS), /billing views/);

  const mixedSpec = syntheticRuns();
  mixedSpec[0].taskFingerprint = 'not-the-same-task';
  assert.throws(() => assertExportInvariants(buildPayload(mixedSpec, OPTS, 'x', mixedSpec.length, WRITER, false, null), mixedSpec, OPTS), /mixed task specifications|different initial code/);

  const claimed = buildPayload(syntheticRuns(), OPTS, 'x', 32, WRITER, false, null);
  claimed.claims.costAdvantage = { usd: 1 };
  assert.throws(() => assertExportInvariants(claimed, syntheticRuns(), OPTS), /incomplete comparison/);
});

test('hidden tests are refused when their requirement is absent from the prompt', () => {
  const task = BENCHMARK_TASKS[0];
  assert.throws(() => validateTaskSpec(task, 'Just fix the bug.'), /requirements the prompt never states/);
  assert.equal(validateTaskSpec(task, task.prompt), true);
});

test('environment registry never labels a single gateway call as Claude Code/CLI', () => {
  assert.equal(assertEnvironmentRegistry(), true);
  const claude = LIVE_ENVIRONMENTS['claude-opus-5-5'];
  assert.equal(claude.kind, 'single_model_gateway_call');
  assert.ok(!/Claude Code|Claude CLI|claude code|claude cli/i.test(`${claude.name} ${claude.route} ${claude.note}`));
});
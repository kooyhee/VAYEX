import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTurnPlan, validateTurnPlan, MAX_THINKING, MAX_WORKERS } from '../lib/turn-plan.mjs';

const plan = (overrides = {}) => ({
  track: 'survey_and_plan',
  reason: 'complex_task_multi_file',
  tier: 'high_intelligence',
  thinkingBudget: 4096,
  workers: 3,
  planDirective: 'survey then implement then verify',
  model: null,
  reasoning: null,
  ...overrides,
});

test('turn-plan: a well-formed plan passes without a violation', () => {
  const result = validateTurnPlan(plan());
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.plan.track, 'survey_and_plan');
  assert.equal(result.plan.workers, 3);
});

test('turn-plan: an unknown track falls back to the conservative default', () => {
  const result = validateTurnPlan({ track: 'auto_magic' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.plan, defaultTurnPlan('validator_unknown_track'));
  assert.equal(result.violations[0].rule, 'V-01');
  assert.equal(result.violations[0].action, 'fallback');
});

test('turn-plan: direct execution never carries thinking, workers or a directive', () => {
  const result = validateTurnPlan(plan({ track: 'direct_execute', tier: 'fast', thinkingBudget: 4096, workers: 3 }));
  assert.equal(result.plan.track, 'direct_execute');
  assert.equal(result.plan.thinkingBudget, 0);
  assert.equal(result.plan.workers, 1);
  assert.equal(result.plan.planDirective, null);
  const rules = result.violations.map((violation) => violation.rule);
  assert.deepEqual(rules.sort(), ['V-03', 'V-04', 'V-05']);
});

test('turn-plan: a survey plan without a directive degrades to direct execution', () => {
  const result = validateTurnPlan(plan({ planDirective: '   ' }));
  assert.equal(result.plan.track, 'direct_execute');
  assert.equal(result.plan.thinkingBudget, 0);
  assert.equal(result.violations.some((violation) => violation.rule === 'V-05' && violation.action === 'fallback'), true);
});

test('turn-plan: the envelope is clamped, not trusted', () => {
  const result = validateTurnPlan(plan({ thinkingBudget: MAX_THINKING + 1000, workers: MAX_WORKERS + 3, planDirective: 'x'.repeat(5000) }));
  assert.equal(result.plan.thinkingBudget, MAX_THINKING);
  assert.equal(result.plan.workers, MAX_WORKERS);
  assert.equal(result.plan.planDirective.length, 2000);
});

test('turn-plan: a model pin outside the allowlist is dropped and reported', () => {
  const result = validateTurnPlan(plan({ model: 'cloud-model-not-allowed' }), { allowedModels: ['local-model'] });
  assert.equal(result.plan.model, null);
  assert.equal(result.violations[0].rule, 'V-06');
  assert.equal(result.violations[0].action, 'clamp');
});

test('turn-plan: a model pin is kept when the allowlist contains it', () => {
  const result = validateTurnPlan(plan({ model: 'local-model' }), { allowedModels: ['local-model'] });
  assert.equal(result.plan.model, 'local-model');
  assert.deepEqual(result.violations, []);
});

test('turn-plan: an estimate above the budget cap degrades a survey plan to direct', () => {
  const result = validateTurnPlan(plan(), { estimateUsd: 0.42, budgetCapUsd: 0.01 });
  assert.equal(result.plan.track, 'direct_execute');
  assert.equal(result.violations.some((violation) => violation.rule === 'V-08'), true);
});

test('turn-plan: an unbounded budget is reported as an assumption, never silently accepted', () => {
  const result = validateTurnPlan(plan(), {});
  assert.deepEqual(result.assumptions, ['budget_unbounded_plan_accepted']);
});

test('turn-plan: a reasoning grade without a thinking budget is not forwarded', () => {
  const result = validateTurnPlan(plan({ track: 'direct_execute', tier: 'fast', thinkingBudget: 0, reasoning: 'high' }));
  assert.equal(result.plan.reasoning, null);
  assert.deepEqual(result.plan, { ...result.plan });
});

test('turn-plan: strict mode rejects a clamped plan instead of running it', () => {
  const result = validateTurnPlan(plan({ workers: 9 }), { strict: true });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].action, 'clamp');
});

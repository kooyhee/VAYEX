import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMetrics, formatMetrics } from '../metrics.mjs';

const NOW = Date.parse('2026-11-08T07:10:00.000Z');

const turn = (overrides = {}) => ({
  type: 'llm_turn',
  session: 's-1',
  ts: '2026-11-08T07:09:50.000Z',
  promptTokens: 10,
  completionTokens: 5,
  cachedTokens: null,
  elapsedMs: 500,
  data: { reported: true, usage_source: 'openai' },
  ...overrides,
});

test('metrics: speed uses only samples inside the rolling window', () => {
  const events = [
    turn({ ts: '2026-11-08T07:07:00.000Z', completionTokens: 999, elapsedMs: 1000 }),
    turn({ ts: '2026-11-08T07:09:30.000Z', completionTokens: 100, elapsedMs: 250 }),
    turn({ ts: '2026-11-08T07:09:50.000Z', completionTokens: 50, elapsedMs: 250 }),
  ];
  const result = aggregateMetrics({ events, session: 's-1', now: NOW, windowMs: 60000 });
  assert.equal(result.speed.samples, 2);
  assert.equal(result.speed.tokensPerSecond, 300); // (100+50) / ((250+250)/1000)
  assert.equal(result.speed.basis, 'elapsedMs');
  assert.equal(result.speed.reported, true);
});

test('metrics: speed is 미보고 with fewer than two samples', () => {
  const result = aggregateMetrics({ events: [turn()], session: 's-1', now: NOW });
  assert.equal(result.speed.tokensPerSecond, null);
  assert.equal(result.speed.reported, false);
  assert.equal(result.speed.reason, 'too_few_samples');
});

test('metrics: speed falls back to wall-clock when no elapsedMs is reported', () => {
  const events = [
    turn({ ts: '2026-11-08T07:09:55.000Z', completionTokens: 60, elapsedMs: null }),
    turn({ ts: '2026-11-08T07:09:57.000Z', completionTokens: 40, elapsedMs: null }),
  ];
  const result = aggregateMetrics({ events, now: NOW });
  assert.equal(result.speed.basis, 'wallclock');
  assert.equal(result.speed.tokensPerSecond, 20); // 100 tokens over 5 s
  assert.equal(result.speed.reported, true);
});

test('metrics: hit rate denominator is prompt tokens; cacheRead 0 is an honest 0%', () => {
  const events = [
    turn({ promptTokens: 7, completionTokens: 5, cachedTokens: 0 }),
    turn({ promptTokens: 3, completionTokens: 1, cachedTokens: 0 }),
  ];
  const result = aggregateMetrics({ events, session: 's-1', now: NOW });
  assert.equal(result.cache.promptTokens, 10);
  assert.equal(result.cache.cacheRead, 0);
  assert.equal(result.cache.hitRate, 0);
  assert.equal(result.cache.reported, true);
  assert.equal(result.cache.source, 'reported');
});

test('metrics: 5 cached of 10 prompt tokens is 0.5, not 5%', () => {
  const events = [turn({ promptTokens: 10, completionTokens: 1, cachedTokens: 5 })];
  const result = aggregateMetrics({ events, session: 's-1', now: NOW });
  assert.equal(result.cache.hitRate, 0.5);
});

test('metrics: a usage block with no cache field is inferred as zero and says so', () => {
  const stubTurn = {
    type: 'llm_turn', session: 's-1', ts: '2026-11-08T07:09:50.000Z',
    promptTokens: 7, completionTokens: 5, cachedTokens: null,
    data: { reported: true, usage_source: 'openai' },
  };
  const result = aggregateMetrics({ events: [stubTurn], session: 's-1', now: NOW });
  assert.equal(result.cache.hitRate, 0);
  assert.equal(result.cache.reported, true);
  assert.equal(result.cache.cachedReported, false);
  assert.equal(result.cache.source, 'inferred_zero');
});

test('metrics: no usage at all stays unreported, never zero', () => {
  const result = aggregateMetrics({ events: [], session: 's-1', now: NOW });
  assert.equal(result.cache.hitRate, null);
  assert.equal(result.cache.reported, false);
  assert.equal(result.cache.source, 'no_usage');
  assert.equal(result.cumulative.reported, false);
  assert.equal(result.cumulative.prompt, 0);
  assert.equal(result.model.reported, false);
  assert.equal(result.model.id, null);
});

test('metrics: cumulative tokens keep partial fields honest', () => {
  const usageOnly = { type: 'frame', session: 's-1', ts: '2026-11-08T07:09:50.000Z', usage: { total_tokens: 12 } };
  const full = { type: 'frame', session: 's-1', ts: '2026-11-08T07:09:55.000Z', usage: { prompt_tokens: 10, completion_tokens: 5 } };
  const withCache = { type: 'frame', session: 's-1', ts: '2026-11-08T07:09:58.000Z', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 8 } };
  const result = aggregateMetrics({ events: [usageOnly, full, withCache], session: 's-1', now: NOW });
  assert.equal(result.cumulative.prompt, 20); // total-only row has no prompt; anthropic row adds 2+8
  assert.equal(result.cumulative.completion, 6);
  assert.equal(result.cumulative.cached, 8);
  assert.equal(result.cumulative.reported, true);
});

test('metrics: model and reasoning grade come from the gateway headers', () => {
  const frame = {
    type: 'message', session: 's-1', ts: '2026-11-08T07:09:50.000Z',
    headers: {
      'x-gateway-model': 'deepseek/deepseek-v4.1-flash-1017',
      'x-gateway-model-source': 'gateway',
      'x-gateway-model-reason': 'auto:balanced',
      'x-gateway-reasoning-grade': 'medium',
      'x-gateway-thinking-budget': '1600',
    },
  };
  const result = aggregateMetrics({ events: [frame], session: 's-1', now: NOW });
  assert.equal(result.model.id, 'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(result.model.auto, true);
  assert.equal(result.model.reasoningGrade, 'medium');
  assert.equal(result.model.thinkingBudget, 1600);
  assert.equal(result.model.reported, true);
  assert.equal(result.model.reasoningReported, true);
});

test('metrics: selection record wins over a bare model.select event', () => {
  const events = [{
    type: 'model.select', session: 's-1', model: 'qwen3:32b', ts: '2026-11-08T07:09:50.000Z',
    data: { reason: 'auto:local_first', pinned: false },
  }];
  const selection = {
    model: { id: 'qwen2.5:72b', source: 'gateway', reason: 'auto:context_fit' },
    reasoning: { grade: 'high', thinking_budget: 3200 },
  };
  const result = aggregateMetrics({ events, selection, session: 's-1', now: NOW });
  assert.equal(result.model.id, 'qwen2.5:72b');
  assert.equal(result.model.reasoningGrade, 'high');
  assert.equal(result.model.auto, true);
});

test('metrics: formatMetrics uses 미보고 for missing fields', () => {
  const empty = aggregateMetrics({ events: [], now: NOW });
  const labels = formatMetrics(empty);
  assert.equal(labels.speed, '미보고');
  assert.equal(labels.cache, '미보고');
  assert.equal(labels.model, '미보고');
  assert.equal(labels.cumulative, '미보고');
});

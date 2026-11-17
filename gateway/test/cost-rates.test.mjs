import test from 'node:test';
import assert from 'node:assert/strict';
import { getModelRates, calculateUsageCost } from '../lib/cost-rates.mjs';

test('cost-rates: correctly identifies provider rate cards', () => {
  const claudeRates = getModelRates('anthropic/claude-3.5-sonnet');
  assert.equal(claudeRates.input, 3.0);
  assert.equal(claudeRates.cacheRead, 0.3);
  assert.equal(claudeRates.output, 15.0);

  const deepseekRates = getModelRates('deepseek/deepseek-chat');
  assert.equal(deepseekRates.input, 0.14);
  assert.equal(deepseekRates.cacheRead, 0.014);

  const fallbackRates = getModelRates('unknown-model');
  assert.equal(fallbackRates.input, 1.0);
});

test('cost-rates: calculates cache savings and hit rate accurately', () => {
  // 100k prompt tokens total, 80k cached (80% hit rate), 5k output
  const result = calculateUsageCost('anthropic/claude-3.5-sonnet', {
    promptTokens: 100000,
    completionTokens: 5000,
    cachedTokens: 80000,
  });

  // Baseline cost: 100k * $3.0/M + 5k * $15.0/M = $0.30 + $0.075 = $0.375
  assert.equal(result.baselineCost, 0.375);

  // Actual cost: (20k uncached * $3.0/M + 80k cached * $0.3/M) + 5k * $15.0/M
  // = ($0.06 + $0.024) + $0.075 = $0.084 + $0.075 = $0.159
  assert.equal(result.actualCost, 0.159);

  // Saved cost: $0.375 - $0.159 = $0.216
  assert.equal(result.savedCost, 0.216);
  assert.equal(result.cacheHitRate, 80.0);
  assert.equal(result.savingsPercent, 57.6);
});

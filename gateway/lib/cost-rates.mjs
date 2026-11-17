// USD pricing per 1M tokens for popular models and caching calculations.
// Updated for official 2026 provider rate cards.

export const MODEL_RATES = Object.freeze({
  // High-difficulty / Planning & Frontend leaders
  'anthropic/claude-opus-5.5': { input: 5.0, cacheWrite: 6.25, cacheRead: 0.5, output: 25.0 },
  'claude-opus-5.5': { input: 5.0, cacheWrite: 6.25, cacheRead: 0.5, output: 25.0 },
  'anthropic/claude-sonnet-5.5': { input: 3.0, cacheWrite: 3.75, cacheRead: 0.3, output: 15.0 },
  'claude-sonnet-5.5': { input: 3.0, cacheWrite: 3.75, cacheRead: 0.3, output: 15.0 },
  'anthropic/claude-sonnet-4.5': { input: 3.0, cacheWrite: 3.75, cacheRead: 0.3, output: 15.0 },
  'openai/gpt-6-astra': { input: 3.5, cacheWrite: 3.5, cacheRead: 0.35, output: 14.0 },
  'gpt-6-astra': { input: 3.5, cacheWrite: 3.5, cacheRead: 0.35, output: 14.0 },
  'google/gemini-4-carbon': { input: 2.5, cacheWrite: 2.5, cacheRead: 0.25, output: 10.0 },
  'gemini-4-carbon': { input: 2.5, cacheWrite: 2.5, cacheRead: 0.25, output: 10.0 },

  // Cost-effective / Speed
  'openai/gpt-6-luna': { input: 0.20, cacheWrite: 0.20, cacheRead: 0.02, output: 0.80 },
  'gpt-6-luna': { input: 0.20, cacheWrite: 0.20, cacheRead: 0.02, output: 0.80 },
  'google/gemini-2.5-flash': { input: 0.15, cacheWrite: 0.15, cacheRead: 0.015, output: 0.60 },
  'google/gemini-flash': { input: 0.15, cacheWrite: 0.15, cacheRead: 0.015, output: 0.60 },
  'gemini-flash': { input: 0.15, cacheWrite: 0.15, cacheRead: 0.015, output: 0.60 },
  'deepseek/deepseek-v4.1-flash': { input: 0.14, cacheWrite: 0.14, cacheRead: 0.014, output: 0.28 },
  'zhipu/glm-4-flash': { input: 0.10, cacheWrite: 0.10, cacheRead: 0.01, output: 0.20 },
  'glm-flash': { input: 0.10, cacheWrite: 0.10, cacheRead: 0.01, output: 0.20 },

  // Anthropic Claude (legacy / standard)
  'claude-3-5-sonnet': { input: 3.0, cacheWrite: 3.75, cacheRead: 0.3, output: 15.0 },
  'claude-3-5-haiku': { input: 0.8, cacheWrite: 1.0, cacheRead: 0.08, output: 4.0 },
  'anthropic/claude-3.5-sonnet': { input: 3.0, cacheWrite: 3.75, cacheRead: 0.3, output: 15.0 },
  'anthropic/claude-3.5-haiku': { input: 0.8, cacheWrite: 1.0, cacheRead: 0.08, output: 4.0 },

  // DeepSeek
  'deepseek-chat': { input: 0.14, cacheWrite: 0.14, cacheRead: 0.014, output: 0.28 },
  'deepseek-reasoner': { input: 0.55, cacheWrite: 0.55, cacheRead: 0.14, output: 2.19 },
  'deepseek/deepseek-chat': { input: 0.14, cacheWrite: 0.14, cacheRead: 0.014, output: 0.28 },
  'deepseek/deepseek-v4.1-flash-1017': { input: 0.14, cacheWrite: 0.14, cacheRead: 0.014, output: 0.28 },

  // OpenAI
  'gpt-4o': { input: 2.5, cacheWrite: 2.5, cacheRead: 1.25, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, cacheWrite: 0.15, cacheRead: 0.075, output: 0.6 },
  'openai/gpt-4o': { input: 2.5, cacheWrite: 2.5, cacheRead: 1.25, output: 10.0 },
  'openai/gpt-4o-mini': { input: 0.15, cacheWrite: 0.15, cacheRead: 0.075, output: 0.6 },

  // Qwen & Open Source
  'qwen/qwen-2.5-coder-32b-instruct': { input: 0.18, cacheWrite: 0.18, cacheRead: 0.09, output: 0.18 },
  'qwen2.5:72b': { input: 0.0, cacheWrite: 0.0, cacheRead: 0.0, output: 0.0 },
  'qwen3:32b': { input: 0.0, cacheWrite: 0.0, cacheRead: 0.0, output: 0.0 },
  'server/qwen3-coder-30b': { input: 0.0, cacheWrite: 0.0, cacheRead: 0.0, output: 0.0 },

  // Demo / local stub
  'demo-chat': { input: 0.0, cacheWrite: 0.0, cacheRead: 0.0, output: 0.0 },
  'stub-7b': { input: 0.0, cacheWrite: 0.0, cacheRead: 0.0, output: 0.0 },
  'default': { input: 1.0, cacheWrite: 1.0, cacheRead: 0.2, output: 3.0 },
});

export function getModelRates(modelId) {
  if (!modelId || typeof modelId !== 'string') return MODEL_RATES['default'];
  const lower = modelId.toLowerCase().trim();
  if (MODEL_RATES[lower]) return MODEL_RATES[lower];
  for (const [key, rates] of Object.entries(MODEL_RATES)) {
    if (lower.includes(key) || key.includes(lower)) return rates;
  }
  return MODEL_RATES['default'];
}

/**
 * Calculates cost and savings from token usage metrics.
 * @param {string} modelId
 * @param {{ promptTokens: number, completionTokens: number, cachedTokens?: number }} usage
 * @returns {{ actualCost: number, baselineCost: number, savedCost: number, savingsPercent: number, cacheHitRate: number }}
 */
export function calculateUsageCost(modelId, { promptTokens = 0, completionTokens = 0, cachedTokens = 0 } = {}) {
  const rates = getModelRates(modelId);
  const uncachedPrompt = Math.max(0, promptTokens - cachedTokens);

  // Baseline: all prompt tokens charged at full input rate
  const baselineCost = (promptTokens * rates.input + completionTokens * rates.output) / 1_000_000;

  // Actual: cached prompt tokens charged at cacheRead rate, rest at input rate
  const actualPromptCost = (uncachedPrompt * rates.input + cachedTokens * rates.cacheRead) / 1_000_000;
  const actualCompletionCost = (completionTokens * rates.output) / 1_000_000;
  const actualCost = actualPromptCost + actualCompletionCost;

  const savedCost = Math.max(0, baselineCost - actualCost);
  const savingsPercent = baselineCost > 0 ? (savedCost / baselineCost) * 100 : 0;
  const cacheHitRate = promptTokens > 0 ? (cachedTokens / promptTokens) * 100 : 0;

  return {
    actualCost: Number(actualCost.toFixed(6)),
    baselineCost: Number(baselineCost.toFixed(6)),
    savedCost: Number(savedCost.toFixed(6)),
    savingsPercent: Number(savingsPercent.toFixed(2)),
    cacheHitRate: Number(cacheHitRate.toFixed(2)),
  };
}

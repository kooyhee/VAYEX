// Cost Normalization & Rate Cards for 4-Environment Benchmark
// Complies with Section 5: Subscription cost normalization formula with explicit user assumption labeling.

export const ASSUMPTION_LABEL = '사용자 지정 비교 가정 (User-Specified Comparison Assumption)';

export const ENVIRONMENTS = Object.freeze({
  'chatgpt-codex': {
    id: 'chatgpt-codex',
    name: 'ChatGPT Plus + Codex CLI',
    category: 'subscription_baseline',
    description: 'OpenAI GPT-4o based Codex CLI environment under ChatGPT Plus subscription',
    modelId: 'openai/gpt-4o',
    rates: {
      input: 2.50,       // $ per 1M tokens
      output: 10.00,
      cacheRead: 1.25,
      cacheWrite: 2.50,
    },
    // User-specified normalization coefficient
    subscriptionMultiplier: 0.10,
    subscriptionMultiplierLabel: ASSUMPTION_LABEL,
    // Amortized flat subscription nominal out-of-pocket rate estimate per run (USD 20 / ~200 coding sessions)
    outOfPocketMode: 'subscription_quota',
    flatMonthlyFeeUsd: 20.0,
  },
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Pro + Claude Code',
    category: 'subscription_baseline',
    description: 'Anthropic Claude 3.5/3.7 Sonnet based Claude Code CLI under Claude Pro subscription',
    modelId: 'anthropic/claude-3.5-sonnet',
    rates: {
      input: 3.00,       // $ per 1M tokens
      output: 15.00,
      cacheRead: 0.30,
      cacheWrite: 3.75,
    },
    // User-specified normalization coefficient
    subscriptionMultiplier: 0.02,
    subscriptionMultiplierLabel: ASSUMPTION_LABEL,
    outOfPocketMode: 'subscription_quota',
    flatMonthlyFeeUsd: 20.0,
  },
  'vayex-openrouter-zdr': {
    id: 'vayex-openrouter-zdr',
    name: 'VAYEX + OpenRouter ZDR',
    category: 'our_platform_privacy',
    description: 'VAYEX platform running over OpenRouter Zero Data Retention (ZDR) privacy route',
    modelId: 'deepseek/deepseek-chat',
    rates: {
      input: 0.14,       // $ per 1M tokens (DeepSeek V3 / V4.1 flash via OpenRouter ZDR)
      output: 0.28,
      cacheRead: 0.014,
      cacheWrite: 0.14,
    },
    subscriptionMultiplier: 1.00,
    subscriptionMultiplierLabel: '종량제 실청구 (Actual Pay-per-token)',
    outOfPocketMode: 'pay_per_token',
    flatMonthlyFeeUsd: 0.0,
  },
  'vayex-a6api': {
    id: 'vayex-a6api',
    name: 'VAYEX + A6API',
    category: 'our_platform_proxy',
    description: 'VAYEX platform running over A6API ultra-high efficiency proxy route',
    modelId: 'deepseek/deepseek-v4.1-flash-1017',
    rates: {
      input: 0.14,       // $ per 1M tokens (A6API proxy route)
      output: 0.28,
      cacheRead: 0.014,
      cacheWrite: 0.14,
    },
    subscriptionMultiplier: 1.00,
    subscriptionMultiplierLabel: '종량제 실청구 (Actual Pay-per-token)',
    outOfPocketMode: 'pay_per_token',
    flatMonthlyFeeUsd: 0.0,
  },
});

/**
 * Calculates all three required cost metrics side-by-side:
 * (1) 실제 발생 비용 (Actual Out-of-pocket Cost)
 * (2) API 공시 환산 비용 (Catalog API Cost)
 * (3) 보정 환산 비용 (Adjusted Subscription Cost)
 *
 * @param {string} envId
 * @param {{ promptTokens: number, completionTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number }} tokens
 * @returns {{
 *   catalogCostUsd: number,
 *   adjustedCostUsd: number,
 *   actualCostUsd: number,
 *   savedVsCatalogUsd: number,
 *   cacheHitRatePercent: number,
 *   multiplierUsed: number,
 *   multiplierLabel: string
 * }}
 */
export function calculateThreeCosts(envId, {
  promptTokens = 0,
  completionTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
} = {}) {
  const env = ENVIRONMENTS[envId] || ENVIRONMENTS['vayex-openrouter-zdr'];
  const { rates, subscriptionMultiplier, subscriptionMultiplierLabel } = env;

  const uncachedPrompt = Math.max(0, promptTokens - cacheReadTokens);

  // (2) API 공시 환산 비용 (Catalog API Cost): Full public token rate card with prompt caching discount
  const catalogPromptCost = (uncachedPrompt * rates.input + cacheReadTokens * rates.cacheRead) / 1_000_000;
  const catalogCompletionCost = (completionTokens * rates.output) / 1_000_000;
  const catalogCostUsd = Number((catalogPromptCost + catalogCompletionCost).toFixed(6));

  // (3) 보정 환산 비용 (Adjusted Subscription Cost):
  // User-specified formula: Codex = Catalog * 0.1, Claude = Catalog * 0.02, VAYEX = Catalog * 1.0
  const adjustedCostUsd = Number((catalogCostUsd * subscriptionMultiplier).toFixed(6));

  // (1) 실제 발생 비용 (Actual Out-of-pocket Cost):
  // For pay-per-token API routes (VAYEX), actual out-of-pocket equals the token-based
  // catalog billing — the user is charged per token, so actual = catalog.
  // For flat-rate subscription tools (ChatGPT Plus / Claude Pro), the marginal out-of-pocket
  // cost of a single API call is $0.00: the user already paid the fixed monthly fee, and
  // no incremental usage bill is issued. This column must NOT be conflated with (3), which
  // is the amortized comparison estimate derived from the user-specified normalization.
  const actualCostUsd = env.outOfPocketMode === 'pay_per_token' ? catalogCostUsd : 0.0;

  const cacheHitRatePercent = promptTokens > 0
    ? Number(((cacheReadTokens / promptTokens) * 100).toFixed(2))
    : 0;

  return {
    catalogCostUsd,
    adjustedCostUsd,
    actualCostUsd,
    savedVsCatalogUsd: Number(Math.max(0, catalogCostUsd - adjustedCostUsd).toFixed(6)),
    cacheHitRatePercent,
    multiplierUsed: subscriptionMultiplier,
    multiplierLabel: subscriptionMultiplierLabel,
    assumptionDisclaimer: ASSUMPTION_LABEL,
  };
}

/**
 * Calculates the core cost efficiency metric: 성공 작업당 비용 (Cost per Successful Task)
 * @param {number} totalCostUsd
 * @param {number} successfulTasksCount
 * @returns {number}
 */
export function calculateCostPerSuccessfulTask(totalCostUsd, successfulTasksCount) {
  if (!successfulTasksCount || successfulTasksCount <= 0) {
    return 0;
  }
  return Number((totalCostUsd / successfulTasksCount).toFixed(6));
}

// Per-request token accounting.
//
// Every figure here comes from a field the provider actually reported. A provider
// that reports nothing leaves every field null and `reported: false`; nothing is
// coerced to zero, because "unknown" and "free" are different facts and a
// benchmark that confuses them is worthless.
//
// Recognised shapes, in the order they are read:
//   Anthropic  usage.input_tokens / output_tokens, plus
//              cache_read_input_tokens (cache hit) and
//              cache_creation_input_tokens (cache write)
//   OpenAI     usage.prompt_tokens / completion_tokens, plus
//              prompt_tokens_details.cached_tokens (cache hit)
//   DeepSeek   usage.prompt_cache_hit_tokens (hit) / prompt_cache_miss_tokens
//   generic    usage.input_tokens / output_tokens, cached_tokens
//
// Cost uses the gateway's own rate card (cost-rates.mjs): a cache-read token is
// billed at the cache-read rate, a cache-write token at the cache-write rate, the
// remaining prompt tokens at the input rate, output at the output rate, and the
// baseline is what the same request would have cost with no cache at all.

import { getModelRates } from './cost-rates.mjs';
import { emitEvent } from './events.mjs';

function positive(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function add(a, b) {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

export function usageBreakdown(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, reported: false, source: 'none' };
  }

  const anthropic = positive(usage.input_tokens);
  const anthropicOut = positive(usage.output_tokens);
  const anthropicRead = positive(usage.cache_read_input_tokens);
  const anthropicWrite = positive(usage.cache_creation_input_tokens);

  const openaiIn = positive(usage.prompt_tokens);
  const openaiOut = positive(usage.completion_tokens);
  const openaiDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? usage.prompt_tokens_details : null;
  const openaiCached = positive(openaiDetails?.cached_tokens ?? usage.cached_tokens);

  const deepseekRead = positive(usage.prompt_cache_hit_tokens);
  const deepseekMiss = positive(usage.prompt_cache_miss_tokens);

  // Anthropic's input_tokens excludes the cached portions; OpenAI's prompt_tokens
  // includes them. Keeping the two apart is the difference between a cache saving
  // and a phantom one.
  if (anthropic !== null || anthropicRead !== null || anthropicWrite !== null) {
    const total = add(add(anthropic, anthropicRead), anthropicWrite);
    return {
      input: anthropic === null && total === null ? null : add(anthropic, anthropicRead === null && anthropicWrite === null ? null : 0),
      output: anthropicOut,
      cacheRead: anthropicRead,
      cacheWrite: anthropicWrite,
      total: total === null && anthropicOut === null ? null : add(total, anthropicOut),
      reported: true,
      source: 'anthropic',
    };
  }

  // DeepSeek's own shape is checked before the OpenAI one: it also reports
  // completion_tokens, so the generic OpenAI branch would otherwise swallow it
  // and lose the cache-hit figure.
  if (deepseekRead !== null || deepseekMiss !== null) {
    return {
      input: deepseekMiss,
      output: positive(usage.completion_tokens),
      cacheRead: deepseekRead,
      cacheWrite: null,
      total: add(add(deepseekMiss, deepseekRead), positive(usage.completion_tokens)),
      reported: true,
      source: 'deepseek',
    };
  }

  if (openaiIn !== null || openaiOut !== null) {
    const cacheRead = openaiCached;
    return {
      // OpenAI's prompt_tokens already counts the cached ones, so the uncached
      // figure is prompt_tokens minus cached_tokens (never negative).
      input: openaiIn === null ? null : openaiIn - (cacheRead ?? 0),
      output: openaiOut,
      cacheRead,
      cacheWrite: null,
      total: usage.total_tokens !== undefined ? positive(usage.total_tokens) ?? add(openaiIn, openaiOut) : add(openaiIn, openaiOut),
      reported: true,
      source: 'openai',
    };
  }

  if (deepseekRead !== null || deepseekMiss !== null) {
    return {
      input: deepseekMiss,
      output: positive(usage.completion_tokens),
      cacheRead: deepseekRead,
      cacheWrite: null,
      total: add(add(deepseekMiss, deepseekRead), positive(usage.completion_tokens)),
      reported: true,
      source: 'deepseek',
    };
  }

  if (positive(usage.total_tokens) !== null) {
    return {
      input: positive(usage.total_tokens),
      output: null,
      cacheRead: null,
      cacheWrite: null,
      total: positive(usage.total_tokens),
      reported: true,
      source: 'total_only',
    };
  }

  return { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, reported: false, source: 'none' };
}

export function costOf(modelId, tokens) {
  const rates = getModelRates(modelId);
  const input = tokens?.input ?? 0;
  const output = tokens?.output ?? 0;
  const cacheRead = tokens?.cacheRead ?? 0;
  const cacheWrite = tokens?.cacheWrite ?? 0;
  const usd = (input * rates.input + cacheRead * rates.cacheRead + cacheWrite * rates.cacheWrite + output * rates.output) / 1_000_000;
  const baselineUsd = ((input + cacheRead + cacheWrite) * rates.input + output * rates.output) / 1_000_000;
  return {
    usd: Number(usd.toFixed(6)),
    baselineUsd: Number(baselineUsd.toFixed(6)),
    savedUsd: Number(Math.max(0, baselineUsd - usd).toFixed(6)),
    rates: { input: rates.input, output: rates.output, cacheRead: rates.cacheRead, cacheWrite: rates.cacheWrite },
  };
}

// The single place a request's accounting is reported. `usage` is the raw
// provider block (non-streaming payload or the last SSE frame that carried one).
// The record is `llm_turn`, flat as app/dx/cost-analytics.mjs reads it: taskId,
// route, promptTokens, completionTokens, cachedTokens, model, provider.
export function accountRequest({
  model, usage, tokens = null, elapsedMs = null, session = null, turn = null, taskId = null,
  run = null, agent = null, role = null, stream = false, route = null, provider = null,
}) {
  const breakdown = tokens ?? usageBreakdown(usage);
  const cost = breakdown.reported ? costOf(model, breakdown) : null;
  emitEvent('llm_turn', {
    session,
    turn,
    task: taskId,
    run,
    agent,
    role,
    model,
    tokens: breakdown.reported ? breakdown : null,
    cost,
    elapsedMs,
    taskId,
    route,
    provider,
    promptTokens: breakdown.input,
    completionTokens: breakdown.output,
    cachedTokens: breakdown.cacheRead,
    data: { stream, usage_source: breakdown.source, reported: breakdown.reported, cacheWriteTokens: breakdown.cacheWrite },
  });
  return { tokens: breakdown, cost };
}

// A saving that has no provider usage behind it — a compressed tool result, a
// prefix cache hit, a locally answered background job — still belongs in the cost
// roll-up, so it is reported as an `optimization` event rather than folded into
// an llm_turn. `strategy` names the optimisation that produced it.
export function recordOptimization({ taskId = null, strategy, tokensSaved = 0, costSavedUsd = 0, session = null, run = null, model = null, detail = null }) {
  if (typeof strategy !== 'string' || strategy.length === 0) throw new Error('optimization needs a strategy');
  return emitEvent('optimization', {
    session,
    run,
    task: taskId,
    model,
    taskId,
    strategy,
    tokensSaved: Math.max(0, Math.trunc(tokensSaved)),
    costSavedUsd: Number(Math.max(0, costSavedUsd).toFixed(6)),
    data: detail ? { detail } : null,
  });
}

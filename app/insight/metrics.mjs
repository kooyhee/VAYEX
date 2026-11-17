// Session metrics for the harness UI: token speed, cache hit rate, cumulative
// tokens and the model the decision layer actually picked.
//
// Every number comes from a field the provider or the decision layer reported.
// A missing field is `null` with `reported: false` — never zero, never a guess.
// The one documented exception is a provider that reports usage but no cache
// field at all: `cacheRead` is then 0 for the hit-rate numerator and the cache
// object says `cachedReported: false`, source `inferred_zero`. That is the
// offline stub's real state (prompt 7 / completion 5 / no cache field), so the
// meter shows an honest 0% rather than "미보고" for a completed turn.

const EMPTY_USAGE = Object.freeze({
  prompt: null, completion: null, cached: null,
  cachedReported: false, promptExcludesCache: false,
  ts: null, elapsedMs: null, reported: false,
});

function count(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function stamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function eventTs(event) {
  const value = event.ts ?? event.timestamp ?? event.time ?? event.data?.ts ?? null;
  const parsed = stamp(value);
  return parsed;
}

function eventSession(event) {
  const value = event.session ?? event.data?.session ?? event.payload?.session ?? null;
  return typeof value === 'string' ? value : null;
}

/** Usage fields one event carries, already normalized. Unknown stays null. */
export function usageOf(event) {
  if (!event || typeof event !== 'object') return null;

  if (event.type === 'llm_turn' || event.promptTokens !== undefined || event.completionTokens !== undefined) {
    const prompt = count(event.promptTokens) ?? count(event.tokens?.input);
    const completion = count(event.completionTokens) ?? count(event.tokens?.output);
    const cached = count(event.cachedTokens) ?? count(event.tokens?.cacheRead);
    const reported = event.data?.reported !== false
      && (prompt !== null || completion !== null || cached !== null || count(event.tokens?.total) !== null);
    if (!reported) return null;
    const source = String(event.data?.usage_source ?? 'llm_turn');
    return {
      prompt, completion, cached,
      cachedReported: cached !== null,
      promptExcludesCache: source === 'anthropic' || source === 'deepseek',
      ts: eventTs(event),
      elapsedMs: count(event.elapsedMs ?? event.data?.elapsedMs),
      reported: true,
    };
  }

  const usage = event.usage ?? event.data?.usage ?? event.payload?.usage ?? null;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? usage.prompt_tokens_details : null;
  const prompt = count(usage.prompt_tokens) ?? count(usage.input_tokens) ?? count(usage.prompt_cache_miss_tokens);
  const completion = count(usage.completion_tokens) ?? count(usage.output_tokens);
  const cached = count(details?.cached_tokens)
    ?? count(usage.cached_tokens)
    ?? count(usage.cache_read_input_tokens)
    ?? count(usage.prompt_cache_hit_tokens);
  if (prompt === null && completion === null && cached === null) return null;
  return {
    prompt, completion, cached,
    cachedReported: cached !== null,
    promptExcludesCache: usage.input_tokens !== undefined
      || usage.cache_read_input_tokens !== undefined
      || usage.prompt_cache_hit_tokens !== undefined,
    ts: eventTs(event),
    elapsedMs: count(event.elapsedMs ?? event.data?.elapsedMs),
    reported: true,
  };
}

function headerOf(event) {
  const headers = event.headers ?? event.header ?? event.data?.headers ?? event.payload?.headers ?? null;
  if (!headers || typeof headers !== 'object') return null;
  const lower = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return lower;
}

function selectionShape(value) {
  if (!value || typeof value !== 'object') return null;
  const model = value.model && typeof value.model === 'object' ? value.model : value;
  const reasoning = value.reasoning && typeof value.reasoning === 'object' ? value.reasoning : null;
  const id = typeof model.id === 'string' && model.id ? model.id : null;
  const source = typeof model.source === 'string' ? model.source : null;
  const reason = typeof model.reason === 'string' && model.reason ? model.reason : null;
  const grade = reasoning && (reasoning.grade === null || typeof reasoning.grade === 'string')
    ? reasoning.grade : null;
  const budget = reasoning && Number.isInteger(reasoning.thinking_budget) ? reasoning.thinking_budget : null;
  if (!id && !grade && !budget && !reason && !source) return null;
  return { id, source, reason, grade, budget };
}

function modelFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'model.select' && typeof event.model === 'string' && event.model) {
    return {
      id: event.model,
      source: 'gateway',
      reason: typeof event.data?.reason === 'string' ? event.data.reason : null,
      grade: null,
      budget: null,
      auto: true,
    };
  }
  const explicit = selectionShape(event.selection ?? event.payload?.selection ?? event.data?.selection);
  if (explicit) {
    return { ...explicit, auto: explicit.source === 'gateway' ? true : explicit.source === 'caller' ? false : null };
  }
  const headers = headerOf(event);
  if (!headers) return null;
  const id = headers['x-gateway-model'] ?? headers['x-gateway-model-id'] ?? null;
  const reason = headers['x-gateway-model-reason'] ?? null;
  const source = headers['x-gateway-model-source'] ?? null;
  const grade = headers['x-gateway-reasoning-grade'] ?? null;
  const budgetText = headers['x-gateway-thinking-budget'] ?? null;
  const budget = budgetText !== null && Number.isFinite(Number(budgetText)) ? Number(budgetText) : null;
  if (!id && !reason && !grade) return null;
  const auto = source === 'gateway' ? true
    : source === 'caller' ? false
      : typeof reason === 'string' && reason.startsWith('auto:') ? true : null;
  return { id: typeof id === 'string' ? id : null, source, reason, grade, budget, auto };
}

function mergeModel(base, next) {
  if (!next) return base;
  const merged = {
    id: next.id ?? base?.id ?? null,
    source: next.source ?? base?.source ?? null,
    reason: next.reason ?? base?.reason ?? null,
    grade: next.grade ?? base?.grade ?? null,
    budget: next.budget ?? base?.budget ?? null,
    auto: next.auto ?? base?.auto ?? null,
  };
  return merged;
}

/**
 * Aggregate one session.
 *
 * @param {object} input
 * @param {object[]} input.events Event records/frames.
 * @param {string} [input.session]
 * @param {number} [input.windowMs] Rolling speed window, default 60s.
 * @param {number} [input.now] Injectable clock for deterministic tests.
 * @param {object} [input.selection] The decision layer's record (GET /v1/selection shape).
 */
export function aggregateMetrics({ events = [], session = null, windowMs = 60000, now = Date.now(), selection = null } = {}) {
  const records = [];
  let modelFromEvents = null;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (session && eventSession(event) !== session) continue;
    const usage = usageOf(event);
    if (usage) records.push(usage);
    const eventModel = modelFromEvent(event);
    if (eventModel) modelFromEvents = mergeModel(modelFromEvents, eventModel);
  }

  const explicitSelection = selectionShape(selection);
  const selectionModel = explicitSelection
    ? { ...explicitSelection, auto: explicitSelection.source === 'gateway' ? true : explicitSelection.source === 'caller' ? false : null }
    : null;
  const model = selectionModel ? mergeModel(modelFromEvents, selectionModel) : modelFromEvents;

  // --- cumulative -----------------------------------------------------------
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let promptReported = false;
  let completionReported = false;
  let cachedReported = false;
  for (const record of records) {
    if (record.prompt !== null) {
      promptReported = true;
      prompt += record.prompt + (record.promptExcludesCache ? (record.cached ?? 0) : 0);
    }
    if (record.completion !== null) {
      completionReported = true;
      completion += record.completion;
    }
    if (record.cached !== null) {
      cachedReported = true;
      cached += record.cached;
    }
  }
  const cumulative = {
    prompt, completion, cached, total: prompt + completion,
    reported: promptReported || completionReported,
    promptReported, completionReported, cachedReported,
    events: records.length,
  };

  // --- cache hit rate -------------------------------------------------------
  let cache;
  if (!promptReported || prompt <= 0) {
    cache = { hitRate: null, reported: false, cacheRead: cached, promptTokens: prompt, cachedReported, source: records.length ? 'no_prompt_tokens' : 'no_usage' };
  } else {
    cache = {
      hitRate: Number(Math.min(1, cached / prompt).toFixed(4)),
      reported: true,
      cacheRead: cached,
      promptTokens: prompt,
      cachedReported,
      source: cachedReported ? 'reported' : 'inferred_zero',
    };
  }

  // --- rolling token speed --------------------------------------------------
  const cutoff = now - windowMs;
  const samples = records
    .map((record) => ({ ...record, ts: record.ts ?? now }))
    .filter((record) => record.ts >= cutoff && record.ts <= now && record.completion !== null);
  let speed;
  if (samples.length < 2) {
    speed = { tokensPerSecond: null, reported: false, samples: samples.length, windowMs, basis: null, reason: 'too_few_samples' };
  } else {
    const tokens = samples.reduce((sum, record) => sum + record.completion, 0);
    const elapsed = samples.reduce((sum, record) => sum + (record.elapsedMs ?? 0), 0);
    if (elapsed > 0) {
      speed = {
        tokensPerSecond: Number((tokens / (elapsed / 1000)).toFixed(2)),
        reported: true, samples: samples.length, windowMs, basis: 'elapsedMs', reason: null,
      };
    } else {
      const span = (now - Math.min(...samples.map((record) => record.ts))) / 1000;
      speed = span >= 1
        ? { tokensPerSecond: Number((tokens / span).toFixed(2)), reported: true, samples: samples.length, windowMs, basis: 'wallclock', reason: null }
        : { tokensPerSecond: null, reported: false, samples: samples.length, windowMs, basis: 'wallclock', reason: 'window_too_short' };
    }
  }

  // --- selected model + reasoning grade ------------------------------------
  const grade = model?.grade ?? null;
  const modelBlock = {
    auto: model?.auto ?? null,
    id: model?.id ?? null,
    reasoningGrade: grade,
    thinkingBudget: model?.budget ?? null,
    reason: model?.reason ?? null,
    reported: Boolean(model?.id),
    reasoningReported: grade !== null,
    source: model?.source ?? null,
  };

  return {
    session,
    windowMs,
    speed,
    cache,
    cumulative,
    model: modelBlock,
  };
}

/** UI-ready Korean labels; the numbers above stay authoritative. */
export function formatMetrics(metrics) {
  const speed = metrics.speed.reported && metrics.speed.tokensPerSecond !== null
    ? `${metrics.speed.tokensPerSecond} 토큰/초` : '미보고';
  const cache = metrics.cache.reported && metrics.cache.hitRate !== null
    ? `${Math.round(metrics.cache.hitRate * 100)}%` : '미보고';
  const total = metrics.cumulative.reported
    ? `누적 ${metrics.cumulative.total} 토큰 (프롬프트 ${metrics.cumulative.prompt} / 완성 ${metrics.cumulative.completion} / 캐시 ${metrics.cumulative.cached})`
    : '미보고';
  const model = metrics.model.reported
    ? `${metrics.model.auto ? '자동 선택' : '직접 선택'} · ${metrics.model.id}${metrics.model.reasoningGrade ? ` · 등급 ${metrics.model.reasoningGrade}` : ' · 등급 미보고'}`
    : '미보고';
  return { speed, cache, cumulative: total, model };
}

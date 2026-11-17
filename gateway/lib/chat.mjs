import { CHAT_FIELDS, pickFields } from './allowlist.mjs';
import { GatewayError } from './errors.mjs';
import { enforceRoute, resolveRoute } from './policy.mjs';
import { preflightAuth, keyForUpstream } from './authz.mjs';
import { readBody, requestUpstream, translateUpstreamFailure } from './upstream.mjs';
import { usageTokens } from './upstream-usage.mjs';
import { SseUsageParser } from './sse.mjs';
import { sendJson } from './http-util.mjs';
import { completionBudget, validateReasoning } from './reasoning.mjs';
import {
  createServabilityCheck,
  declaredOutputTokens,
  pinTurn,
  resolveRequestModel,
  selectionHeaders,
  selectionReport,
} from './selection.mjs';
import {
  callerChoseReasoning,
  callerReasoningReport,
  GRADE_BUDGETS,
  selectReasoningGrade,
} from './grade.mjs';
import { canonicalizeTools, cacheDirectives, prefixDigest, promptCacheKeyAccepted } from './prompt-cache.mjs';
import { accountRequest, costOf, recordOptimization, usageBreakdown } from './accounting.mjs';
import { emitEvent } from './events.mjs';
import { segmentKey } from './session-pin.mjs';

const DEFAULT_RESERVED_TOKENS = 4096;

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GatewayError(400, 'invalid_messages',
      'messages must be a non-empty array', { type: 'invalid_request_error', param: 'messages' });
  }
  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new GatewayError(400, 'invalid_messages',
        `messages[${index}] must be an object`, { type: 'invalid_request_error', param: 'messages' });
    }
    if (typeof message.role !== 'string' || !message.role) {
      throw new GatewayError(400, 'invalid_messages',
        `messages[${index}].role is required`, { type: 'invalid_request_error', param: 'messages' });
    }
  });
}

// max_completion_tokens is the total budget for the response (completion plus
// thinking, per OpenAI conventions), so the reservation is the larger of the
// two, never their sum. A request that specifies neither defaults to DEFAULT_RESERVED_TOKENS,
// clamped to the user's available token budget or configured token limit so a tight
// daily cap (e.g. 1000 tokens/day) is not refused simply by omitting max_tokens.
function reservedTokensFor(completion, thinking, availableTokens) {
  let target;
  if (completion !== null && thinking > 0) target = Math.max(completion, thinking);
  else if (completion !== null) target = completion;
  else if (thinking > 0) target = Math.max(DEFAULT_RESERVED_TOKENS, thinking);
  else target = Math.min(DEFAULT_RESERVED_TOKENS, availableTokens > 0 ? availableTokens : DEFAULT_RESERVED_TOKENS);
  return target;
}

function reservedTokens(body, reasoning, availableTokens) {
  return reservedTokensFor(completionBudget(body), reasoning.reserved, availableTokens);
}

export function createChatHandler({ modelResolver = resolveRequestModel, routePolicy = enforceRoute } = {}) {
  return (context) => handleChat({ ...context, modelResolver, routePolicy });
}

export async function handleChat({ req, res, body, identity, helmet, config, modelResolver = resolveRequestModel, routePolicy = enforceRoute }) {
  const route = resolveRoute({
    headerValue: req.headers['x-route'],
    bodyValue: body.route,
    config,
  });
  // The resolver and policy share the embedding process's host boundary.
  const { entry, selection } = modelResolver({
    body,
    route,
    capability: 'chat',
    config,
    isServable: createServabilityCheck({ req, keys: helmet.keys }),
    requireReasoning: callerChoseReasoning(body),
    // The conversation identity the session pin is keyed on. Without it every
    // request would look like a new segment and no cache tree could be protected.
    session: req.headers['x-app-session'] || body.user || null,
    role: req.headers['x-agent-role'] || req.headers['x-omp-role'] || body.role || body.agent_role || null,
  });
  // Route policy runs here, before any upstream socket is opened.
  routePolicy({ route, entry, capability: 'chat' });
  validateMessages(body.messages);

  // The grade is chosen from the request as the caller wrote it, before any
  // gateway-chosen reasoning field is merged in, so "the gateway picked this" and
  // "the caller picked this" can never be confused.
  const availableTokens = helmet.ledger.tokensPerDay
    - helmet.ledger.bucket(identity).tokens
    - helmet.ledger.bucket(identity).reserved_tokens;
  const optimization = config.optimization ?? {};
  // A reasoning grade pinned for this work segment protects the provider's cache
  // of the request envelope: the grade decides which thinking budget is sent, and
  // a changed budget is a changed request. It only ever applies when the caller
  // did not choose one itself.
  const pinnedGrade = selection.reasoning_pinned ?? null;
  const reasoningChoice = selectReasoningGrade({
    body,
    model: entry.model,
    route,
    promptTokens: selection.prompt_tokens_estimate,
    outputTokens: declaredOutputTokens(body),
    availableTokens,
    // The ledger's own reservation rule, reused rather than re-derived: a grade
    // is only chosen when the reservation it implies would be accepted.
    reserveFor: (budget) => reservedTokensFor(declaredOutputTokens(body), budget, availableTokens),
  });
  // Keep the segment's pinned grade when the automatic pick drifted: the pin is
  // what the cache of the previous turn was built under.
  if (pinnedGrade !== null && !callerChoseReasoning(body)
    && optimization.pinSessions !== false
    && Number.isInteger(entry.model.thinkingLimit)
    && GRADE_BUDGETS[pinnedGrade] !== undefined) {
    const pinnedBudget = Math.min(GRADE_BUDGETS[pinnedGrade], entry.model.thinkingLimit);
    reasoningChoice.fields = { reasoning_effort: pinnedGrade, thinking_budget: pinnedBudget };
    reasoningChoice.report = {
      ...reasoningChoice.report,
      source: 'gateway',
      reason: 'pin:reasoning_grade_kept',
      grade: pinnedGrade,
      reasoning_effort: pinnedGrade,
      thinking_budget: pinnedBudget,
      pinned_from: reasoningChoice.report.grade,
    };
  }

  const reasoningBody = Object.keys(reasoningChoice.fields).length > 0
    ? { ...body, ...reasoningChoice.fields }
    : body;  // Reasoning controls are strictly validated against the model's declared
  // thinking_limit before any quota reservation or upstream call. A
  // gateway-chosen grade goes through the same validation as a caller's.
  const reasoning = validateReasoning({ body: reasoningBody, model: entry.model });
  const reasoningReport = callerChoseReasoning(body)
    ? callerReasoningReport({ body, model: entry.model })
    : reasoningChoice.report;

  // A caller-supplied prompt cache key is accepted only on a model that declares
  // one. The previous hard 400 was this gateway's own guard, not a provider
  // refusal; the model declaration is what decides now.
  const cacheKeyCheck = promptCacheKeyAccepted({ body, entry });
  if (!cacheKeyCheck.accepted) {
    throw new GatewayError(400, 'unsupported_parameter', cacheKeyCheck.reason,
      { type: 'invalid_request_error', param: 'prompt_cache_key' });
  }

  const upstreamKey = keyForUpstream(entry.upstream, helmet.keys);
  const forwardedAuthorization = preflightAuth({ upstream: entry.upstream, key: upstreamKey, headers: req.headers });
  const wantStream = body.stream === true;
  const startedAt = Date.now();
  const sessionId = req.headers['x-app-session'] || body.user || null;
  const explicitSegment = body.segment || body.subagent || null;
  const segment = segmentKey({ session: sessionId, route, capability: 'chat', segment: explicitSegment });
  const payload = pickFields(body, CHAT_FIELDS);
  payload.model = entry.model.id;
  payload.stream = wantStream;
  // `provider` is the upstream's own routing/retention control (OpenRouter's
  // `data_collection`, `order`, `allow_fallbacks`). Forwarding it on zdr_cloud
  // would let the caller contradict the very promise that route makes: the
  // gateway would certify a zero-retention model while the body asks the provider
  // to allow data collection or to fall back to providers the gateway never
  // vetted. The field is refused by name rather than stripped, for the same
  // reason a caller's reasoning field is refused instead of dropped — silently
  // changing their request would change the answer they get without telling them.
  if (route === 'zdr_cloud' && payload.provider !== undefined && payload.provider !== null) {
    throw new GatewayError(400, 'parameter_conflict',
      `provider cannot be sent on route zdr_cloud: it would let this request override the zero-data-retention routing that route requires (data_collection, order, allow_fallbacks). Remove it, or send route any_cloud and accept the caller-chosen provider`,
      { type: 'invalid_request_error', param: 'provider', detail: { route, field: 'provider' } });
  }
  Object.assign(payload, reasoning.fields);
  // A survey_and_plan turn carries the four-stage directive (survey, plan,
  // implement, verify). Reporting it in the selection record is not the same as
  // sending it: without this it never reached a provider, so the "the model was
  // given the plan instruction" reading of the record was false.
  if (typeof selection.plan_directive === 'string' && selection.plan_directive.trim().length > 0) {
    payload.messages = [{ role: 'system', content: selection.plan_directive }, ...payload.messages];
  }
  // Level 1 (system + tools) must be byte-repeatable across turns or the provider
  // caches nothing: the tool list is canonicalised (deep key sort) before the
  // digest is taken, and the digest is what the cache breakpoints are placed
  // against.
  if (optimization.prefixStable !== false) {
    const tools = canonicalizeTools(payload.tools);
    if (tools) payload.tools = tools;
  }
  const prefix = prefixDigest(payload);
  const directives = cacheDirectives({
    body: payload,
    entry,
    sessionKey: segment ?? prefix.prefix,
    providerCache: optimization.providerCache !== false,
  });
  // A caller's own cache key always wins over the one the gateway would supply.
  if (!directives.fields.prompt_cache_key || !payload.prompt_cache_key) {
    Object.assign(payload, directives.fields);
  } else if (directives.fields.messages) {
    payload.messages = directives.fields.messages;
  }
  if (wantStream && payload.stream_options === undefined) {
    // The ledger can only record what the provider reports, so usage is asked
    // for explicitly. If the provider still omits it, the ledger records
    // "unknown" rather than zero.
    payload.stream_options = { include_usage: true };
  }

  const cacheContext = { sessionId, segment, prefix, directives, startedAt, route };
  pinTurn({
    session: sessionId,
    route,
    capability: 'chat',
    segment: explicitSegment,
    model: entry.model.id,
    reasoning: reasoningReport.grade ?? null,
    role: selection.role ?? null,
    config,
  });

  const reservation = helmet.ledger.reserve(identity, { tokens: reservedTokens(body, reasoning, availableTokens) });
  const requestLog = helmet.logger.child({ identity, model: entry.model.id, upstream: entry.upstream.id, route });
  requestLog.info('chat_request', {
    stream: wantStream,
    message_count: payload.messages.length,
    max_tokens: payload.max_tokens ?? payload.max_completion_tokens ?? null,
    model_source: selection.source,
    model_reason: selection.reason,
    reasoning_source: reasoningReport.source,
    reasoning_reason: reasoningReport.reason,
    reasoning_grade: reasoningReport.grade,
    plan_mode: selection.plan_mode,
    plan_tier: selection.plan_tier,
    plan_violations: (selection.plan_violations || []).map((violation) => violation.rule),
    prefix_digest: prefix.prefix,
    prefix_stable: prefix.stable,
    cache_family: directives.family,
    cache_applied: directives.applied,
  });
  if (config.logging.logRequestBodies) {
    // Enabled only by the config switch, and announced at startup.
    requestLog.warn('request_body_development', { body: payload });
  }

  // The decision is retained in memory for GET /v1/selection, from here on: the
  // reservation is accepted and the request is going to this model, so a refusal
  // above never leaves a record behind. The record holds identifiers and the
  // reason strings already logged below — never message content, headers or keys.
  // The relay itself is untouched: the SSE bytes still come from the provider
  // verbatim, so nothing is injected into the OpenAI-compatible stream.
  helmet.selectionRecord.record({
    identity,
    route,
    capability: 'chat',
    entry,
    selection,
    reasoning: reasoningReport,
  });

  let upstreamResponse;
  try {
    upstreamResponse = await requestUpstream({
      upstream: entry.upstream,
      path: entry.upstream.paths.chat,
      method: 'POST',
      body: payload,
      headers: {
        accept: wantStream ? 'text/event-stream' : 'application/json',
        ...(route ? { 'x-route': route } : {}),
      },
      timeoutMs: config.timeouts.upstreamMs,
      key: upstreamKey,
      clientAuthorization: forwardedAuthorization,
    });
  } catch (error) {
    helmet.ledger.settle(reservation, { outcome: 'none' });
    requestLog.error('chat_upstream_failed', { code: error.code || 'unknown', message: error.message });
    throw error;
  }

  const { res: upstreamRes } = upstreamResponse;
  const status = upstreamRes.statusCode;
  const upstreamRequestId = typeof upstreamRes.headers?.['x-opencodex-request-id'] === 'string'
    ? upstreamRes.headers['x-opencodex-request-id'].trim() || null
    : null;
  if (upstreamRequestId) {
    helmet.selectionRecord.record({
      identity,
      route,
      capability: 'chat',
      entry,
      selection,
      reasoning: reasoningReport,
      requestId: upstreamRequestId,
    });
  }

  if (status >= 400) {
    const text = await readBody(upstreamRes).catch(() => '');
    helmet.ledger.settle(reservation, { outcome: 'none' });
    const translated = translateUpstreamFailure({
      upstream: entry.upstream,
      status,
      text,
      redactor: helmet.redactor,
    });
    requestLog.error('chat_upstream_error', {
      upstream_status: status,
      code: translated.code,
      detail: translated.detail,
    });
    throw translated;
  }

  if (wantStream) {
    return relayStream({ res, upstreamRes, entry, helmet, reservation, requestLog, selection, reasoning: reasoningReport, cacheContext, upstreamRequestId });
  }
  return relayJson({ res, upstreamRes, entry, helmet, reservation, requestLog, selection, reasoning: reasoningReport, cacheContext, upstreamRequestId });
}

// One cache report per completed request: what the prefix hierarchy looked like,
// what the provider reported about the cache, and what the gateway did about it.
// The optimisation event is only emitted when a cache hit actually happened.
function reportCache({ cacheContext, entry, breakdown, stream }) {
  const cacheRead = breakdown?.cacheRead ?? null;
  const cacheWrite = breakdown?.cacheWrite ?? null;
  emitEvent('cache.report', {
    session: cacheContext.sessionId,
    model: entry.model.id,
    data: {
      stream,
      family: cacheContext.directives.family,
      applied: cacheContext.directives.applied,
      notes: cacheContext.directives.notes,
      prefix: cacheContext.prefix.prefix,
      level1: cacheContext.prefix.level1,
      level2: cacheContext.prefix.level2,
      level3: cacheContext.prefix.level3,
      levels: cacheContext.prefix.levels,
      stable: cacheContext.prefix.stable,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      hit: cacheRead !== null && cacheRead > 0,
    },
  });
  if (cacheRead !== null && cacheRead > 0) {
    const { savedUsd } = costOf(entry.model.id, { input: 0, output: 0, cacheRead, cacheWrite: 0 });
    recordOptimization({
      strategy: 'prompt_cache_hit',
      tokensSaved: cacheRead,
      costSavedUsd: savedUsd,
      session: cacheContext.sessionId,
      model: entry.model.id,
    });
  }
}

function taskIdFor(cacheContext) {
  return cacheContext?.segment ?? null;
}

async function relayJson({ res, upstreamRes, entry, helmet, reservation, requestLog, selection, reasoning, cacheContext, upstreamRequestId = null }) {
  let text;
  try {
    text = await readBody(upstreamRes);
  } catch (error) {
    helmet.ledger.settle(reservation, { outcome: 'none' });
    requestLog.error('chat_upstream_stream_failed', { code: error.code || 'unknown' });
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    helmet.ledger.settle(reservation, { outcome: 'unknown' });
    // A body that is not JSON is not something to invent a completion for.
    throw new GatewayError(502, 'upstream_bad_response',
      `upstream ${entry.upstream.id} returned a body that is not valid JSON for a non-streaming completion`,
      { type: 'upstream_error', detail: { upstream: entry.upstream.id, bytes: text.length } });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    helmet.ledger.settle(reservation, { outcome: 'unknown' });
    throw new GatewayError(502, 'upstream_bad_response',
      `upstream ${entry.upstream.id} returned JSON that is not an object`,
      { type: 'upstream_error' });
  }
  if (payload.error) {
    const error = translateUpstreamFailure({
      upstream: entry.upstream,
      status: 502,
      text,
      redactor: helmet.redactor,
    });
    error.code = 'upstream_error';
    helmet.ledger.settle(reservation, { outcome: 'none' });
    throw error;
  }
  const breakdown = usageBreakdown(payload.usage);
  const tokens = breakdown.total;
  helmet.ledger.settle(reservation, {
    outcome: breakdown.reported ? 'reported' : 'unknown',
    tokens,
  });
  const accounting = accountRequest({
    model: entry.model.id,
    tokens: breakdown,
    elapsedMs: Date.now() - cacheContext.startedAt,
    session: cacheContext.sessionId,
    taskId: taskIdFor(cacheContext),
    route: cacheContext.route,
    provider: entry.upstream.id,
    stream: false,
  });
  reportCache({ cacheContext, entry, breakdown, stream: false });
  const counters = helmet.ledger.snapshot(reservation.identity);
  requestLog.info('chat_completed', {
    upstream_status: 200,
    stream: false,
    tokens: tokens === null ? 'unknown' : tokens,
    cache_read_tokens: breakdown.cacheRead,
    cache_write_tokens: breakdown.cacheWrite,
    cost_usd: accounting.cost?.usd ?? null,
    requests_used_today: counters.used.requests,
    tokens_used_today: counters.used.tokens,
    unknown_usage_today: counters.used.unknown_usage,
  });
  const responseHeaders = {
    ...selectionHeaders({ entry, selection, reasoning }),
    ...(upstreamRequestId ? { 'x-opencodex-request-id': upstreamRequestId } : {}),
  };
  sendJson(res, 200, helmet.redactor.value({ ...payload, gateway: selectionReport({ entry, selection, reasoning }) }),
    responseHeaders);
}

async function relayStream({ res, upstreamRes, entry, helmet, reservation, requestLog, selection, reasoning, cacheContext, upstreamRequestId = null }) {
  const parser = new SseUsageParser();
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-gateway-prefix': cacheContext.prefix.prefix,
    'x-gateway-prefix-stable': cacheContext.prefix.stable ? 'true' : 'false',
    'x-gateway-cache-family': cacheContext.directives.family,
    'x-gateway-cache-applied': cacheContext.directives.applied ? 'true' : 'false',
    ...selectionHeaders({ entry, selection, reasoning }),
    ...(upstreamRequestId ? { 'x-opencodex-request-id': upstreamRequestId } : {}),
  });
  res.flushHeaders?.();

  let clientGone = false;
  let redactions = 0;
  const onClientClose = () => {
    clientGone = true;
    upstreamRes.destroy();
  };
  res.on('close', onClientClose);

  return new Promise((resolve) => {
    const finish = (aborted, failure) => {
      res.off('close', onClientClose);
      const breakdown = parser.breakdown;
      const tokens = breakdown.total;
      const outcome = aborted && parser.frames === 0 ? 'none' : breakdown.reported ? 'reported' : 'unknown';
      helmet.ledger.settle(reservation, { outcome, tokens });
      if (breakdown.reported) {
        accountRequest({
          model: entry.model.id,
          tokens: breakdown,
          elapsedMs: Date.now() - cacheContext.startedAt,
          session: cacheContext.sessionId,
          taskId: taskIdFor(cacheContext),
          route: cacheContext.route,
          provider: entry.upstream.id,
          stream: true,
        });
        reportCache({ cacheContext, entry, breakdown, stream: true });
      }
      const counters = helmet.ledger.snapshot(reservation.identity);
      requestLog.info(aborted ? 'chat_stream_aborted' : 'chat_completed', {
        stream: true,
        aborted,
        sse_frames: parser.frames,
        malformed_frames: parser.malformedFrames,
        upstream_error_frames: parser.errorFrames,
        saw_done: parser.sawDone,
        redacted_chunks: redactions,
        tokens: tokens === null ? 'unknown' : tokens,
        cache_read_tokens: breakdown.cacheRead,
        cache_write_tokens: breakdown.cacheWrite,
        requests_used_today: counters.used.requests,
        tokens_used_today: counters.used.tokens,
        unknown_usage_today: counters.used.unknown_usage,
        failure: failure || null,
      });
      if (!res.writableEnded && !res.destroyed) res.end();
      resolve();
    };

    upstreamRes.on('data', (chunk) => {
      // The provider's bytes are forwarded verbatim: no re-framing, no buffering
      // of a whole completion, no synthesised deltas. The single exception is a
      // chunk carrying one of our own registered secrets, which is redacted
      // before it can reach a client.
      if (res.destroyed) return;
      if (helmet.redactor.bufferContains(chunk)) {
        res.write(helmet.redactor.text(chunk.toString('utf8')));
        redactions += 1;
      } else {
        res.write(chunk);
      }
      parser.push(chunk);
    });
    upstreamRes.on('end', () => {
      if (!parser.sawDone) {
        requestLog.warn('chat_stream_incomplete', { saw_done: false });
      }
      finish(clientGone, null);
    });
    upstreamRes.on('error', (error) => {
      requestLog.error('chat_stream_error', { message: error.message });
      finish(true, error.message);
    });
    upstreamRes.on('aborted', () => finish(true, 'upstream aborted'));
  });
}

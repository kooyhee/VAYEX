import { IMAGE_FIELDS, pickFields } from './allowlist.mjs';
import { GatewayError } from './errors.mjs';
import { enforceRoute, resolveRoute } from './policy.mjs';
import { preflightAuth, keyForUpstream } from './authz.mjs';
import { readBody, requestUpstream, translateUpstreamFailure } from './upstream.mjs';
import { usageTokens } from './upstream-usage.mjs';
import { sendJson } from './http-util.mjs';
import { createServabilityCheck, resolveRequestModel, selectionHeaders, selectionReport } from './selection.mjs';

// Image generation does not stream, but it is metered on the same ledger: one
// request against the request cap, and whatever tokens the provider reports.
export async function handleImageGeneration({ req, res, body, identity, helmet, config, privacyGate = null }) {
  const route = resolveRoute({
    headerValue: req.headers['x-route'],
    bodyValue: body.route,
    config,
  });
  const { entry, selection } = resolveRequestModel({
    body,
    route,
    capability: 'images',
    config,
    isServable: createServabilityCheck({ req, keys: helmet.keys }),
  });
  enforceRoute({ route, entry, capability: 'images' });

  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw new GatewayError(400, 'invalid_prompt',
      'prompt is required and must be a non-empty string',
      { type: 'invalid_request_error', param: 'prompt' });
  }

  // Pre-send privacy gate: screen prompt, block secrets, pseudonymize, and re-check wire payload
  let effectiveBody = body;
  if (privacyGate) {
    const sessionId = req.headers['x-app-session'] || null;
    const gateResult = await privacyGate({ body, sessionId, route, purpose: 'images' });
    if (gateResult.action === 'blocked') {
      throw new GatewayError(gateResult.status || 422, gateResult.code || 'privacy_guard_blocked',
        `Privacy Guard refused image prompt: ${gateResult.reason}`,
        { type: 'privacy_guard_error', code: gateResult.code, fingerprint: gateResult.report?.fingerprint });
    }
    effectiveBody = gateResult.body;
  }

  const upstreamKey = keyForUpstream(entry.upstream, helmet.keys);
  const forwardedAuthorization = preflightAuth({ upstream: entry.upstream, key: upstreamKey, headers: req.headers });

  const payload = pickFields(effectiveBody, IMAGE_FIELDS);
  payload.model = entry.model.id;

  const reservation = helmet.ledger.reserve(identity, { tokens: 0 });
  const requestLog = helmet.logger.child({ identity, model: entry.model.id, upstream: entry.upstream.id, route });
  requestLog.info('image_request', { prompt_chars: payload.prompt.length, n: payload.n ?? 1 });
  if (config.logging.logRequestBodies) {
    requestLog.warn('request_body_development', { body: payload });
  }

  let upstreamResponse;
  try {
    upstreamResponse = await requestUpstream({
      upstream: entry.upstream,
      path: entry.upstream.paths.images,
      method: 'POST',
      body: payload,
      headers: { accept: 'application/json' },
      timeoutMs: config.timeouts.upstreamMs,
      key: upstreamKey,
      clientAuthorization: forwardedAuthorization,
    });
  } catch (error) {
    helmet.ledger.settle(reservation, { outcome: 'none', kind: 'images' });
    requestLog.error('image_upstream_failed', { code: error.code || 'unknown', message: error.message });
    throw error;
  }

  const { res: upstreamRes } = upstreamResponse;
  const text = await readBody(upstreamRes).catch(() => '');

  if (upstreamRes.statusCode >= 400) {
    helmet.ledger.settle(reservation, { outcome: 'none', kind: 'images' });
    const translated = translateUpstreamFailure({
      upstream: entry.upstream,
      status: upstreamRes.statusCode,
      text,
      redactor: helmet.redactor,
    });
    requestLog.error('image_upstream_error', { upstream_status: upstreamRes.statusCode, code: translated.code });
    throw translated;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    helmet.ledger.settle(reservation, { outcome: 'none', kind: 'images' });
    throw new GatewayError(502, 'upstream_bad_response',
      `upstream ${entry.upstream.id} returned a body that is not valid JSON for image generation`,
      { type: 'upstream_error', detail: { upstream: entry.upstream.id, bytes: text.length } });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    helmet.ledger.settle(reservation, { outcome: 'none', kind: 'images' });
    throw new GatewayError(502, 'upstream_bad_response',
      `upstream ${entry.upstream.id} returned JSON that is not an object`, { type: 'upstream_error' });
  }

  const tokens = usageTokens(parsed.usage);
  helmet.ledger.settle(reservation, {
    outcome: tokens === null ? 'none' : 'reported',
    tokens,
    kind: 'images',
  });
  const counters = helmet.ledger.snapshot(reservation.identity);
  requestLog.info('image_completed', {
    images_returned: Array.isArray(parsed.data) ? parsed.data.length : 0,
    tokens: tokens === null ? null : tokens,
    images_today: counters.used.images,
  });
  sendJson(res, 200,
    helmet.redactor.value({ ...parsed, gateway: selectionReport({ entry, selection }) }),
    selectionHeaders({ entry, selection }));
}

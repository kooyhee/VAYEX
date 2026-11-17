import { VIDEO_FIELDS, pickFields } from './allowlist.mjs';
import { GatewayError } from './errors.mjs';
import { enforceRoute, resolveRoute } from './policy.mjs';
import { preflightAuth, keyForUpstream } from './authz.mjs';
import { readBody, requestUpstream, translateUpstreamFailure } from './upstream.mjs';
import { pollUpstreamJob, videoPollPath } from './video.mjs';
import { sendJson } from './http-util.mjs';
import { createServabilityCheck, resolveRequestModel, selectionHeaders, selectionReport } from './selection.mjs';

function requireVideoUpstream(config) {
  if (!config.videoUpstream) {
    throw new GatewayError(503, 'video_not_configured',
      'no video upstream is configured: this gateway has no allowlisted model with the video capability, so it cannot submit or track video jobs',
      {
        type: 'configuration_error',
        detail: { configured_video_models: [], hint: 'add a model with capabilities ["video"] and a video path block to the config' },
      });
  }
  return config.videoUpstream;
}

export async function handleVideoSubmit({ req, res, body, identity, helmet, config, privacyGate = null }) {
  requireVideoUpstream(config);
  const route = resolveRoute({
    headerValue: req.headers['x-route'],
    bodyValue: body.route,
    config,
  });
  const { entry, selection } = resolveRequestModel({
    body,
    route,
    capability: 'video',
    config,
    isServable: createServabilityCheck({ req, keys: helmet.keys }),
  });
  enforceRoute({ route, entry, capability: 'video' });
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw new GatewayError(400, 'invalid_prompt',
      'prompt is required and must be a non-empty string',
      { type: 'invalid_request_error', param: 'prompt' });
  }

  // Pre-send privacy gate: screen prompt, block secrets, pseudonymize, and re-check wire payload
  let effectiveBody = body;
  if (privacyGate) {
    const sessionId = req.headers['x-app-session'] || null;
    const gateResult = await privacyGate({ body, sessionId, route, purpose: 'video' });
    if (gateResult.action === 'blocked') {
      throw new GatewayError(gateResult.status || 422, gateResult.code || 'privacy_guard_blocked',
        `Privacy Guard refused video prompt: ${gateResult.reason}`,
        { type: 'privacy_guard_error', code: gateResult.code, fingerprint: gateResult.report?.fingerprint });
    }
    effectiveBody = gateResult.body;
  }

  const upstreamKey = keyForUpstream(entry.upstream, helmet.keys);
  const forwardedAuthorization = preflightAuth({ upstream: entry.upstream, key: upstreamKey, headers: req.headers });

  const payload = pickFields(effectiveBody, VIDEO_FIELDS);
  payload.model = entry.model.id;

  // Submission is metered on the same ledger as a chat request.
  const reservation = helmet.ledger.reserve(identity, { tokens: 0 });
  const requestLog = helmet.logger.child({ identity, model: entry.model.id, upstream: entry.upstream.id, route });
  requestLog.info('video_submit', { prompt_chars: payload.prompt.length });

  let upstreamResponse;
  try {
    upstreamResponse = await requestUpstream({
      upstream: entry.upstream,
      path: entry.upstream.video.createPath,
      method: 'POST',
      body: payload,
      headers: { accept: 'application/json' },
      timeoutMs: config.timeouts.videoMs,
      key: upstreamKey,
      clientAuthorization: forwardedAuthorization,
    });
  } catch (error) {
    helmet.ledger.settle(reservation, { outcome: 'none', kind: 'video_submit' });
    requestLog.error('video_submit_failed', { code: error.code || 'unknown', message: error.message });
    throw error;
  }

  const text = await readBody(upstreamResponse.res).catch(() => '');
  if (upstreamResponse.res.statusCode >= 400) {
    helmet.ledger.settle(reservation, { outcome: 'none', kind: 'video_submit' });
    throw translateUpstreamFailure({
      upstream: entry.upstream,
      status: upstreamResponse.res.statusCode,
      text,
      redactor: helmet.redactor,
    });
  }

  let submitted;
  try {
    submitted = JSON.parse(text);
  } catch {
    helmet.ledger.settle(reservation, { outcome: 'none', kind: 'video_submit' });
    throw new GatewayError(502, 'upstream_bad_response',
      `video upstream ${entry.upstream.id} returned a body that is not valid JSON for a submission`,
      { type: 'upstream_error', detail: { upstream: entry.upstream.id, bytes: text.length } });
  }
  const upstreamJobId = submitted && typeof submitted === 'object'
    ? submitted.id ?? submitted.job_id ?? submitted.task_id ?? null
    : null;
  if (!upstreamJobId) {
    helmet.ledger.settle(reservation, { outcome: 'none', kind: 'video_submit' });
    throw new GatewayError(502, 'upstream_bad_response',
      `video upstream ${entry.upstream.id} accepted the submission but returned no job id`,
      { type: 'upstream_error' });
  }

  helmet.ledger.settle(reservation, { outcome: 'none', kind: 'video_submit' });
  const job = helmet.videoJobs.create({
    identity,
    model: entry.model.id,
    upstream: entry.upstream,
    upstreamId: String(upstreamJobId),
    submission: { created_at: new Date().toISOString() },
  });
  if (typeof submitted.status === 'string') helmet.videoJobs.applyUpstream(job, submitted);
  requestLog.info('video_submitted', { job: job.id, upstream_job_id: job.upstreamJobId, status: job.status });
  sendJson(res, 202,
    { ...helmet.videoJobs.toWire(job, '/v1/videos'), gateway: selectionReport({ entry, selection }) },
    { location: `/v1/videos/${job.id}`, ...selectionHeaders({ entry, selection }) });
}

// Poll and content are GETs, so they carry no body. The route still arrives on
// the x-route header and is enforced before the upstream is touched: a caller
// who asked for local_only must not read a job back through the gateway either.
// A job whose model is no longer in the config keeps the local_only refusal and
// fails closed on zdr_cloud, because retention flags can no longer be proven.
function enforceGetRoute({ req, config, modelId, upstream }) {
  // A GET has no body, so the body source supplied nothing: `undefined`, not
  // `null`, which resolveRoute reads as "present and not a valid route".
  const route = resolveRoute({ headerValue: req.headers['x-route'], bodyValue: undefined, config });
  const model = config.modelIndex.get(modelId)?.model;
  if (route === 'zdr_cloud' && !model) {
    throw new GatewayError(403, 'route_policy_violation',
      `model ${modelId} is no longer in this gateway's allowlist, so its retention flags cannot be proven for route zdr_cloud; the gateway will not downgrade the route for you`,
      { type: 'permission_error', param: 'route', detail: { route, model: modelId, upstream: upstream.id } });
  }
  enforceRoute({ route, entry: model ? { model, upstream } : null, capability: 'video' });
  return route;
}

export async function handleVideoPoll({ req, res, id, identity, helmet, config }) {
  requireVideoUpstream(config);
  const job = helmet.videoJobs.owned(id, identity);
  const upstream = config.upstreams.find((item) => item.id === job.upstream);
  if (!upstream) {
    throw new GatewayError(503, 'video_upstream_missing',
      `video job ${job.id} names upstream ${job.upstream}, which the current config no longer defines`,
      { type: 'configuration_error' });
  }
  enforceGetRoute({ req, config, modelId: job.model, upstream });
  if (!helmet.videoJobs.isTerminal(job)) {
    const payload = await pollUpstreamJob({
      job,
      upstream,
      config,
      key: keyForUpstream(upstream, helmet.keys),
    });
    const wasTerminal = helmet.videoJobs.isTerminal(job);
    helmet.videoJobs.applyUpstream(job, payload);
    if (!wasTerminal && helmet.videoJobs.isTerminal(job) && !job.completionCharged) {
      // Completion is metered once, on the poll that first sees a terminal
      // state. A repeat poll returns the same job without charging again.
      job.completionCharged = true;
      helmet.ledger.charge(identity, { kind: 'video_complete', tokens: null });
      helmet.logger.info('video_terminal', { job: job.id, status: job.status, upstream: upstream.id });
    }
  }
  sendJson(res, 200, helmet.videoJobs.toWire(job, '/v1/videos'));
}

export async function handleVideoFetch({ req, res, id, identity, helmet, config }) {
  requireVideoUpstream(config);
  const job = helmet.videoJobs.owned(id, identity);
  const upstream = config.upstreams.find((item) => item.id === job.upstream);
  if (!upstream) {
    throw new GatewayError(503, 'video_upstream_missing',
      `video job ${job.id} names upstream ${job.upstream}, which the current config no longer defines`,
      { type: 'configuration_error' });
  }
  // Route is checked before readiness so a refused route is refused for the
  // same reason on every GET, regardless of job state.
  enforceGetRoute({ req, config, modelId: job.model, upstream });
  if (job.status !== 'succeeded' || !job.artifact?.url) {
    throw new GatewayError(409, 'video_not_ready',
      `video job ${job.id} is ${job.status} and has no artifact yet; poll /v1/videos/${job.id} until it reports succeeded`,
      { type: 'invalid_request_error', detail: { job: job.id, status: job.status, progress: job.progress } });
  }
  // The artifact is fetched server-side and handed to the caller, so the
  // upstream credential never has to leave the gateway.
  const path = videoPollPath(upstream.video.contentPath, job.upstreamJobId);
  const { res: upstreamRes } = await requestUpstream({
    upstream,
    path,
    method: 'GET',
    timeoutMs: config.timeouts.videoMs,
    key: keyForUpstream(upstream, helmet.keys),
  });
  if (upstreamRes.statusCode >= 400) {
    const text = await readBody(upstreamRes).catch(() => '');
    throw translateUpstreamFailure({
      upstream,
      status: upstreamRes.statusCode,
      text,
      redactor: helmet.redactor,
    });
  }
  res.writeHead(200, {
    'content-type': upstreamRes.headers['content-type'] || 'application/octet-stream',
    'cache-control': 'no-store',
    'x-gateway-job': job.id,
    'x-gateway-upstream': upstream.id,
  });
  upstreamRes.pipe(res);
  upstreamRes.on('error', () => res.destroy());
}

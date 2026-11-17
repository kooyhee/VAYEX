import http from 'node:http';
import { createRequire } from 'node:module';
import { GatewayError } from './errors.mjs';
import { createLogger } from './log.mjs';
import { createRedactor } from './redact.mjs';
import { createUpstreamKeys } from './upstream.mjs';
import { QuotaLedger } from './quota.mjs';
import { HealthProbe } from './health.mjs';
import { VideoJobs } from './video.mjs';
import { resolveIdentity } from './identity.mjs';
import { resolveRoute } from './policy.mjs';
import { createSelectionRecord } from './selection-record.mjs';
import { SESSION_PINS } from './session-pin.mjs';
import { publicCatalogue } from './config.mjs';
import { readJsonBody, sendError, sendJson } from './http-util.mjs';
import { handleChat } from './chat.mjs';
import { handleImageGeneration } from './images.mjs';
import { handleVideoFetch, handleVideoPoll, handleVideoSubmit } from './video-routes.mjs';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const GATEWAY_VERSION = pkg.version;

function isJsonPost(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  return type.includes('application/json');
}

// A handler owns policy state but no listener; the standalone adapter below is optional.
export function createGatewayHandler({ config, env = process.env, clock = () => new Date(), logger = null, stdout = process.stdout, chatHandler = handleChat, privacyGate = null, authorize = () => {} }) {
  const keys = createUpstreamKeys(config, env);
  const redactor = createRedactor([...keys.values()].map((k) => k.value));
  const log = logger || createLogger({
    level: config.logging.level,
    filePath: config.logging.file,
    redactor,
    stdout,
  });

  const ledger = new QuotaLedger({
    ledgerPath: config.quota.ledgerPath,
    requestsPerDay: config.quota.requestsPerDay,
    tokensPerDay: config.quota.tokensPerDay,
    clock,
  });
  ledger.prune();
  ledger.persist();

  const healthProbe = new HealthProbe({ config, logger: log, keys });
  const videoJobs = new VideoJobs();
  // In-memory only, and bounded: see lib/selection-record.mjs. The ledger stays
  // the only thing this gateway writes to disk.
  const selectionRecord = createSelectionRecord({ clock });

  // The operator's `optimization.pin_cache_ttl_ms` is the pin window the chat path
  // uses; parsing it and never applying it would leave every pin on the built-in
  // default no matter what the config said.
  if (Number.isInteger(config.optimization?.pinCacheTtlMs)) {
    SESSION_PINS.setTtlMs(config.optimization.pinCacheTtlMs);
  }

  const helmet = { keys, redactor, ledger, logger: log, healthProbe, videoJobs, selectionRecord };
  const startedAt = Date.now();

  async function route(req, res) {
    const url = new URL(req.url, 'http://gateway.invalid');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';

    if (path === '/healthz' && method === 'GET') {
      return handleHealth({ res, helmet, config, startedAt });
    }
    if (path === '/v1/models' && method === 'GET') {
      return handleModels({ res, helmet, config });
    }
    if (path === '/v1/selection' && method === 'GET') {
      return handleSelection({ req, res, helmet, config });
    }
    if (path === '/v1/chat/completions' && method === 'POST') {
      return withJsonBody({ req, res, helmet, config }, (body, identity) =>
        chatHandler({ req, res, body, identity, helmet, config }));
    }
    if (path === '/v1/images/generations' && method === 'POST') {
      return withJsonBody({ req, res, helmet, config }, (body, identity) =>
        handleImageGeneration({ req, res, body, identity, helmet, config, privacyGate }));
    }
    if (path === '/v1/videos' && method === 'POST') {
      return withJsonBody({ req, res, helmet, config }, (body, identity) =>
        handleVideoSubmit({ req, res, body, identity, helmet, config, privacyGate }));
    }
    const videoMatch = /^\/v1\/videos\/([A-Za-z0-9_-]+)(\/content)?$/.exec(path);
    if (videoMatch) {
      const id = videoMatch[1];
      const identity = resolveIdentity(config.quota.identityHeader, req.headers);
      if (videoMatch[2] && method === 'GET') {
        return handleVideoFetch({ req, res, id, identity, helmet, config });
      }
      if (!videoMatch[2] && method === 'GET') {
        return handleVideoPoll({ req, res, id, identity, helmet, config });
      }
      throw new GatewayError(405, 'method_not_allowed',
        `${method} is not allowed on ${path}`, { type: 'invalid_request_error' });
    }

    throw new GatewayError(404, 'not_found',
      `no route for ${method} ${path}; this gateway serves GET /healthz, GET /v1/models, GET /v1/selection, POST /v1/chat/completions, POST /v1/images/generations, POST /v1/videos, GET /v1/videos/{id}, GET /v1/videos/{id}/content`,
      { type: 'invalid_request_error' });
  }

  async function withJsonBody({ req, res, helmet: h, config: c }, handler) {
    if (!isJsonPost(req)) {
      throw new GatewayError(415, 'unsupported_media_type',
        'send the request body as application/json',
        { type: 'invalid_request_error' });
    }
    const identity = resolveIdentity(c.quota.identityHeader, req.headers);
    const body = await readJsonBody(req, c.maxBodyBytes);
    authorize({ req, body, identity });
    return handler(body, identity);
  }

  async function handleModels({ res, helmet: h, config: c }) {
    // The catalogue is the allowlist itself, not what an upstream happens to
    // advertise: a client cannot discover a model this gateway would refuse.
    const catalogue = publicCatalogue(c, Math.floor(startedAt / 1000));
    sendJson(res, 200, h.redactor.value(catalogue));
  }

  async function handleSelection({ req, res, helmet: h, config: c }) {
    // The same identity header chat uses, and the same route resolution: only the
    // header can carry a route here because this endpoint reads no body, so a
    // route the chat path would refuse is refused with the same error, and an
    // absent header falls back to the configured default rather than guessing.
    // Route policy itself is not re-evaluated: no model is chosen and no socket is
    // opened, so `local_only` (which no chat request can be served on) simply has
    // no decision to report.
    const identity = resolveIdentity(c.quota.identityHeader, req.headers);
    const route = resolveRoute({ headerValue: req.headers['x-route'], bodyValue: undefined, config: c });
    // Read-only: no prompt, no message content, no headers and no credentials are
    // ever part of a record, and none is added here. `null` is a real answer — a
    // fresh process, or an identity+route that has sent nothing yet.
    sendJson(res, 200, h.redactor.value({ selection: h.selectionRecord.get(identity, route) }));
  }

  async function handleHealth({ res, helmet: h, config: c, startedAt: bootedAt }) {
    const probe = await h.healthProbe.probeAll();
    const gpuStates = probe.upstreams
      .map((u) => u.gpu?.state)
      .filter((state) => state !== undefined);
    const body = {
      ok: probe.ok,
      status: probe.ok ? 'ok' : 'degraded',
      version: GATEWAY_VERSION,
      uptime_seconds: Math.floor((Date.now() - bootedAt) / 1000),
      upstream_reachable: probe.ok,
      key_configured: [...h.keys.values()].some((k) => k.configured && k.usable),
      keys: [...h.keys.entries()].map(([upstream, k]) => ({
        upstream,
        env: k.envName,
        configured: k.configured,
        usable: k.usable,
      })),
      gpu: {
        // Never derived from nvidia-smi: it is broken on the deployment host.
        // "unknown" is a real answer here, and it is never rendered as zero.
        state: gpuStates.every((s) => s === 'unknown') ? 'unknown' : 'reported',
        states: gpuStates,
        sources: probe.upstreams
          .filter((u) => u.gpu?.source)
          .map((u) => ({ upstream: u.id, source: u.gpu.source, note: u.gpu.note ?? null })),
      },
      mode: {
        default_route: c.route.default,
        auth_modes: [...new Set(c.upstreams.map((u) => u.authMode))].sort(),
        pass_through_upstreams: c.upstreams.filter((u) => u.authMode === 'pass_through').map((u) => u.id),
        body_logging: c.logging.logRequestBodies,
      },
      upstreams: probe.upstreams,
      unreachable_upstreams: probe.unreachable,
      quota: {
        identity_header: c.quota.identityHeader,
        requests_per_day: c.quota.requestsPerDay,
        tokens_per_day: c.quota.tokensPerDay,
        ledger_path: c.quota.ledgerPath,
      },
      video: {
        configured: Boolean(c.videoUpstream),
        upstreams: c.videoUpstream ? [c.videoUpstream.id] : [],
      },
    };
    // 503 when an upstream is down: a load balancer must not read "ok" from a
    // gateway that cannot serve the models it advertises.
    sendJson(res, probe.ok ? 200 : 503, h.redactor.value(body), {
      'x-gateway-version': GATEWAY_VERSION,
    });
  }

  async function handle(req, res) {
    try {
      await route(req, res);
    } catch (error) {
      const gatewayError = sendError(res, error, redactor);
      const fields = {
        method: req.method,
        path: new URL(req.url, 'http://gateway.invalid').pathname,
        status: gatewayError.status,
        code: gatewayError.code,
        type: gatewayError.type,
      };
      // A refusal carries its own code and needs no further explanation. Anything
      // else is a defect, and a 500 that keeps no exception leaves nothing to
      // diagnose it from, so its redacted message and throwing frame are recorded.
      if (!(error instanceof GatewayError)) {
        fields.message = error?.message ?? String(error);
        fields.at = String(error?.stack || '').split('\n')[1]?.trim() ?? null;
      }
      log.warn('request_refused', fields);
    }
  }

  return { handle, helmet, logger: log, keys, ledger, healthProbe };
}

export function createGateway(options) {
  const handler = createGatewayHandler(options);
  const { config } = options;
  const server = http.createServer(handler.handle);
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return {
    ...handler,
    server,
    listen(port = config.listen.port, host = config.listen.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
    },
  };
}

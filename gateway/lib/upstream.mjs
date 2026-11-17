import http from 'node:http';
import https from 'node:https';
import { GatewayError } from './errors.mjs';

// Anything longer than this in a provider body is truncated before it can reach
// a log line or an error message. Provider error bodies are kept as evidence,
// but the gateway does not relay unbounded bodies into its own log.
const MAX_MESSAGE_BYTES = 1200;

export function createUpstreamKey(env, envName) {
  const value = typeof env[envName] === 'string' ? env[envName].trim() : '';
  return {
    envName,
    value,
    configured: value.length > 0,
    usable: value.length >= 8,
  };
}

// One key object per upstream, keyed by upstream id. Only the environment
// variable name and a boolean ever leave this object.
export function createUpstreamKeys(config, env) {
  const keys = new Map();
  for (const upstream of config.upstreams) {
    if (upstream.authMode !== 'gateway_key') continue;
    keys.set(upstream.id, createUpstreamKey(env, upstream.keyEnv));
  }
  return keys;
}

// One HTTP round trip to an upstream. The response stream is handed back
// untouched so a chat body can be piped to the client byte for byte.
export function requestUpstream(options) {
  const {
    upstream,
    path,
    method = 'POST',
    body = null,
    headers = {},
    timeoutMs,
    key = null,
    clientAuthorization = null,
    // Health probes of a pass-through upstream carry no client key; they are
    // allowed to go out anonymously so reachability can still be measured.
    allowAnonymousPassThrough = false,
  } = options;

  const url = new URL(`${upstream.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const outbound = { ...headers };
  if (payload) {
    outbound['content-type'] = 'application/json';
    outbound['content-length'] = String(payload.length);
  }

  if (upstream.authMode === 'gateway_key') {
    if (!key || !key.value) {
      return Promise.reject(new GatewayError(503, 'gateway_key_missing',
        `upstream ${upstream.id} requires a gateway key: set ${key ? key.envName : 'the configured environment variable'}`,
        { type: 'configuration_error' }));
    }
    outbound.authorization = `Bearer ${key.value}`;
  } else if (upstream.authMode === 'pass_through') {
    if (clientAuthorization) {
      outbound.authorization = clientAuthorization;
    } else if (!allowAnonymousPassThrough) {
      return Promise.reject(new GatewayError(401, 'client_key_required',
        `upstream ${upstream.id} uses pass-through auth: send the provider key in the Authorization header`,
        { type: 'authentication_error' }));
    }
  }

  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers: outbound,
      timeout: timeoutMs,
    });

    const timer = setTimeout(() => {
      req.destroy(new GatewayError(504, 'upstream_timeout',
        `upstream ${upstream.id} did not answer within ${timeoutMs} ms`,
        { type: 'upstream_error' }));
    }, timeoutMs);
    timer.unref?.();

    req.on('response', (res) => {
      clearTimeout(timer);
      resolve({ res, upstream });
    });
    req.on('timeout', () => {
      req.destroy(new GatewayError(504, 'upstream_timeout',
        `upstream ${upstream.id} did not answer within ${timeoutMs} ms`,
        { type: 'upstream_error' }));
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      if (error instanceof GatewayError) return reject(error);
      const code = error.code ? ` (${error.code})` : '';
      reject(new GatewayError(502, 'upstream_unreachable',
        `upstream ${upstream.id} is unreachable at ${upstream.baseUrl}${code}`,
        { type: 'upstream_error' }));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export function readBody(res, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        res.destroy(new GatewayError(502, 'upstream_body_too_large',
          `upstream response exceeded ${limitBytes} bytes`, { type: 'upstream_error' }));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', (error) => {
      reject(error instanceof GatewayError ? error : new GatewayError(502, 'upstream_stream_failed',
        `upstream stream failed: ${error.message}`, { type: 'upstream_error' }));
    });
  });
}

export function snippet(text) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  return compact.length > MAX_MESSAGE_BYTES ? `${compact.slice(0, MAX_MESSAGE_BYTES)}...` : compact;
}

// Provider failures are relayed, not smoothed over: the upstream status code and
// the provider's own error code/message are preserved so a client can act on
// them. The body is redacted by the caller's redactor before it is returned.
export function translateUpstreamFailure({ upstream, status, text, redactor }) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  let providerMessage = null;
  let providerCode = null;
  if (parsed && typeof parsed === 'object' && parsed.error) {
    const error = parsed.error;
    if (typeof error === 'string') {
      providerMessage = error;
    } else if (error && typeof error === 'object') {
      providerMessage = typeof error.message === 'string' ? error.message : null;
      providerCode = typeof error.code === 'string' || typeof error.code === 'number'
        ? (redactor ? redactor.value(error.code) : error.code)
        : null;
    }
  }
  const fallback = snippet(text) || `upstream ${upstream.id} returned HTTP ${status}`;
  const message = redactor ? redactor.text(providerMessage || fallback) : providerMessage || fallback;
  return new GatewayError(status >= 400 && status <= 599 ? status : 502, 'upstream_error',
    `${upstream.id}: ${message}`,
    {
      type: 'upstream_error',
      detail: {
        upstream: upstream.id,
        upstream_status: status,
        upstream_code: providerCode,
      },
    });
}

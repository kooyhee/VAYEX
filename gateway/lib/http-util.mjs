import { GatewayError } from './errors.mjs';

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body, null, 2), 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendError(res, error, redactor) {
  const gatewayError = error instanceof GatewayError
    ? error
    : new GatewayError(500, 'internal_error', 'internal gateway error',
      { type: 'gateway_error', detail: { reason: redactor ? redactor.text(error?.message || String(error)) : undefined } });
  const body = gatewayError.toBody();
  sendJson(res, gatewayError.status, redactor ? redactor.value(body) : body, gatewayError.headers || {});
  return gatewayError;
}

export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        req.pause();
        reject(new GatewayError(413, 'body_too_large',
          `request body exceeds ${maxBytes} bytes`, { type: 'invalid_request_error' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        reject(new GatewayError(400, 'body_required',
          'request body must be a JSON object', { type: 'invalid_request_error' }));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        reject(new GatewayError(400, 'invalid_json',
          `request body is not valid JSON: ${error.message}`, { type: 'invalid_request_error' }));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new GatewayError(400, 'invalid_body',
          'request body must be a JSON object', { type: 'invalid_request_error' }));
        return;
      }
      resolve(parsed);
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new GatewayError(400, 'request_aborted',
        `request stream failed: ${error.message}`, { type: 'invalid_request_error' }));
    });
  });
}

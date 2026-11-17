// The live HTTP surface of the pre-send gate.
//
// Three things the audit found without a caller now answer here, from the same
// catalogue the chat wire uses — never a second detector:
//   * `slmStatus()`            what the optional stage-3 model actually has,
//   * `scanText()`             every rule a string trips, as ids and offsets only,
//   * `screenOutbound()`       what the gate would do with that string.
// The consent decision is also recorded here. Consent used to live only as a field
// on the WebSocket session (`app/server.mjs`), so nothing persisted that a person
// had switched cloud transport on; it is written to the one event stream the rest of
// the product reports through, as its own value, separate from masking.

import {
  DATA_CLASSES,
  DETECTOR_RULES,
  PRIVACY_CODES,
  PRIVACY_STATUS,
  RULE_META,
  getVault,
  isCloudRoute,
  scanText,
  screenOutbound,
} from './index.mjs';
import { slmStatus } from './slm.mjs';
import { emitEvent, events } from '../../gateway/lib/events.mjs';

const MAX_SCAN_BYTES = 32 * 1024;
const DEFAULT_BASE_PATH = '/api/privacy';

/**
 * The consent + masking decision as one recorded value.
 *
 * Consent and masking stay two fields: consent never disables masking, and a
 * conversation can mask with consent off. Only ids, the decision and an 8-hex
 * fingerprint are recorded — there is no place here for content.
 *
 * @param {{sessionId?:string|null, consent?:boolean, privacyState?:string,
 *          route?:string, requested?:string|null, fallback?:string|null,
 *          purpose?:string}} input
 */
export function recordConsentDecision({
  sessionId = null,
  consent = false,
  privacyState = 'mask',
  route = 'local_only',
  requested = null,
  fallback = null,
  purpose = 'privacy.status',
} = {}) {
  const masking = privacyState === 'strict' ? 'strict' : 'mask';
  const record = {
    consent: consent === true,
    masking,
    maskingEnabled: true,
    route: String(route ?? 'local_only'),
    cloud: isCloudRoute(route),
    requested: requested ?? null,
    fallback: fallback ?? null,
    purpose,
    sessionId: sessionId ?? null,
    at: new Date().toISOString(),
    fingerprint: sessionId
      ? getVault(sessionId).fingerprint('consent', consent === true ? '1' : '0', masking, String(route ?? 'local_only'))
      : null,
  };
  try {
    emitEvent('decision', {
      session: record.sessionId,
      data: {
        track: 'privacy_consent',
        purpose: record.purpose,
        consent: record.consent,
        masking: record.masking,
        route: record.route,
        cloud: record.cloud,
        requested: record.requested,
        fallback: record.fallback,
        fingerprint: record.fingerprint,
      },
    });
  } catch {
    // Telemetry must never fail the decision it describes.
  }
  return record;
}

/** Only ids, offsets and scores leave the detector; the matched value never does. */
function publicFinding(finding) {
  return {
    rule: finding.rule,
    class: finding.class,
    risk: finding.risk,
    score: finding.score,
    start: finding.start,
    end: finding.end,
    variant: finding.variant ?? null,
  };
}

function summarizeFindings(findings) {
  const rules = [...new Set(findings.map((finding) => finding.rule))].sort();
  const counts = {};
  for (const finding of findings) counts[finding.rule] = (counts[finding.rule] ?? 0) + 1;
  return {
    total: findings.length,
    rules,
    counts,
    classes: [...new Set(findings.map((finding) => finding.class))].sort(),
    findings: findings.map(publicFinding),
  };
}

/** The status payload: the catalogue, the SLM, and this conversation's decision. */
export function privacyStatus({ url = new URL('http://localhost/api/privacy/status'), resolveConversation = null } = {}) {
  const sessionId = url.searchParams.get('session');
  const privacyState = url.searchParams.get('privacy') === 'strict' ? 'strict' : 'mask';
  const conversation = typeof resolveConversation === 'function' ? resolveConversation(url.searchParams) : null;
  const consent = recordConsentDecision({
    sessionId,
    consent: conversation?.consent === true,
    privacyState,
    route: conversation?.route ?? 'local_only',
    requested: conversation?.requested ?? null,
    fallback: conversation?.fallback ?? null,
    purpose: 'privacy.status',
  });
  return {
    ok: true,
    gate: {
      codes: PRIVACY_CODES,
      status: PRIVACY_STATUS,
      basePath: DEFAULT_BASE_PATH,
      endpoints: ['/api/privacy/status', '/api/privacy/scan', '/api/privacy/findings'],
      masking: privacyState,
      consentRequiredForCloud: true,
    },
    catalog: {
      rules: DETECTOR_RULES,
      classes: DATA_CLASSES,
      byRule: RULE_META,
      size: DETECTOR_RULES.length,
    },
    slm: slmStatus(),
    consent,
  };
}

/**
 * Scan one string through the gate: which rules it trips (ids and offsets), and what
 * the gate would do with it. `masked` is the gate's own output for a sent request —
 * it is the masked text, so no original value is returned by this endpoint either.
 */
export async function scanInput({ text, sessionId = null, privacyState = 'mask', route = 'local_only', purpose = 'privacy.scan' } = {}) {
  const source = String(text ?? '').slice(0, MAX_SCAN_BYTES);
  const findings = scanText(source, { path: 'api:privacy/scan', hint: 'scan' });
  const outcome = await screenOutbound({
    body: { messages: [{ role: 'user', content: source }] },
    sessionId,
    route,
    purpose,
    privacyState,
  });
  const masked = outcome.action === 'sent' ? outcome.body?.messages?.[0]?.content ?? null : null;
  return {
    ok: true,
    bytes: Buffer.byteLength(source, 'utf8'),
    truncated: String(text ?? '').length > source.length,
    scanned: summarizeFindings(findings),
    decision: {
      action: outcome.action,
      sent: outcome.action === 'sent',
      code: outcome.code,
      reason: outcome.reason,
      latencyMs: outcome.report?.latencyMs ?? null,
      fingerprint: outcome.report?.fingerprint ?? null,
    },
    masked,
  };
}

/**
 * The finding counts the gate has already recorded, read back from the one event
 * stream it reports through. Aggregation only: `privacy.masked` and `privacy.blocked`
 * records carry rule ids, counts and an 8-hex fingerprint — never a matched value —
 * so totalling them here exposes nothing the stream does not already hold.
 *
 * @param {{session?:string|null, type?:string}} [filter]
 */
export function privacyFindings({ session = null, type = null } = {}) {
  const wanted = type ? [type] : ['privacy.masked', 'privacy.blocked'];
  const byRule = {};
  const byType = {};
  const bySession = {};
  let total = 0;
  for (const record of events()) {
    if (!wanted.includes(record.type)) continue;
    if (session && record.session !== session) continue;
    const counts = record.data?.counts ?? {};
    byType[record.type] = (byType[record.type] ?? 0) + 1;
    if (record.session) bySession[record.session] = (bySession[record.session] ?? 0) + 1;
    for (const [rule, count] of Object.entries(counts)) {
      byRule[rule] = (byRule[rule] ?? 0) + Number(count ?? 0);
      total += Number(count ?? 0);
    }
  }
  return {
    ok: true,
    scope: { session, type: type ?? 'privacy.*' },
    records: byType,
    total,
    byRule,
    bySession,
    classes: [...new Set(Object.keys(byRule).map((rule) => RULE_META[rule]?.class ?? 'unknown'))].sort(),
  };
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`${JSON.stringify(payload)}\n`);
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_SCAN_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

/**
 * `/api/privacy/*` handler. Returns `true` when it owned the request, so it composes
 * with the `/healthz`, `/v1/*`, `/api/*` and asset branches in `app/server.mjs`.
 */
export function createPrivacyRoutes({ basePath = DEFAULT_BASE_PATH, resolveConversation = null } = {}) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(basePath)) return false;
    const path = url.pathname.slice(basePath.length) || '/';
    try {
      if (path === '/status' && req.method === 'GET') {
        return send(res, 200, privacyStatus({ url, resolveConversation }));
      }
      if (path === '/findings' && req.method === 'GET') {
        return send(res, 200, privacyFindings({
          session: url.searchParams.get('session'),
          type: url.searchParams.get('type'),
        }));
      }
      if (path === '/scan' && req.method === 'GET') {
        const conversation = typeof resolveConversation === 'function' ? resolveConversation(url.searchParams) : null;
        const text = url.searchParams.get('text') ?? '';
        return send(res, 200, await scanInput({
          text,
          sessionId: url.searchParams.get('session'),
          privacyState: url.searchParams.get('privacy') === 'strict' ? 'strict' : 'mask',
          route: conversation?.route ?? 'local_only',
        }));
      }
      if (path === '/scan' && req.method === 'POST') {
        const body = await readJson(req);
        const conversation = typeof resolveConversation === 'function' ? resolveConversation(url.searchParams) : null;
        if (typeof body?.text !== 'string') return send(res, 400, { ok: false, error: 'text_required' });
        return send(res, 200, await scanInput({
          text: body.text,
          sessionId: body.session ?? url.searchParams.get('session'),
          privacyState: (body.privacy ?? url.searchParams.get('privacy')) === 'strict' ? 'strict' : 'mask',
          route: conversation?.route ?? 'local_only',
        }));
      }
      if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' });
      return send(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      return send(res, 500, { ok: false, error: 'privacy_route_failed', message: error.message });
    }
  };
}

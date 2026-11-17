// `/api/privacy/*` is the live surface of the pre-send gate. Before this route the
// gate's status (`slmStatus`) and its scanner (`scanText`) had zero callers, so the
// gate was only observable from inside a request that already used it, and the
// consent decision lived solely as a WebSocket session field with no record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPrivacyRoutes, recordConsentDecision } from '../privacy/routes.mjs';
import { screenOutbound } from '../privacy/gate.mjs';
import { events, resetEvents } from '../../gateway/lib/events.mjs';

const PHONE = '010-1234-5678';
const RRN = '900101-1234568';

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, headers = {}) { this.statusCode = code; Object.assign(this.headers, headers); },
    end(chunk = '') { this.body += chunk; },
  };
}

function mockReq(url, method = 'GET', payload = null) {
  const raw = Buffer.from(payload === null ? '' : JSON.stringify(payload));
  const stream = new Readable({
    read() {
      if (raw.length) this.push(raw);
      this.push(null);
    },
  });
  stream.url = url;
  stream.method = method;
  stream.headers = { host: 'localhost' };
  return stream;
}

const conversation = (params) => ({
  route: params.get('route') ?? 'local_only',
  consent: params.get('consent') === '1',
  requested: params.get('route') ?? null,
  fallback: null,
});

test('GET /api/privacy/status reports the catalogue, the SLM state and the consent record', async () => {
  resetEvents();
  const handle = createPrivacyRoutes({ resolveConversation: conversation });
  const res = mockRes();
  const handled = await handle(mockReq('/api/privacy/status?consent=1&route=any_cloud&session=s-1'), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.ok(body.catalog.rules.length > 0, 'the live catalogue is the one the gate screens with');
  assert.equal(typeof body.catalog.size, 'number');
  assert.equal(typeof body.slm.available, 'boolean');
  assert.ok(body.slm.candidates.length > 0, 'SLM selection state is exposed');
  assert.equal(body.consent.consent, true);
  assert.equal(body.consent.masking, 'mask');
  assert.equal(body.consent.cloud, true);
  assert.match(body.consent.fingerprint, /^[0-9a-f]{8}$/);

  const recorded = events({ type: 'decision' }).filter((record) => record.data?.track === 'privacy_consent');
  assert.equal(recorded.length, 1, 'the consent+masking decision is persisted as its own recorded value');
  assert.equal(recorded[0].data.consent, true);
  assert.equal(recorded[0].data.masking, 'mask');
  assert.equal(recorded[0].session, 's-1');
});

test('consent off and masking on stay two separate recorded facts', () => {
  resetEvents();
  recordConsentDecision({ sessionId: 's-2', consent: false, privacyState: 'strict', route: 'local_only' });
  const [record] = events({ type: 'decision' });
  assert.equal(record.data.consent, false);
  assert.equal(record.data.masking, 'strict');
  assert.equal(record.data.cloud, false);
});

test('GET /api/privacy/scan finds personal data without returning it', async () => {
  resetEvents();
  const handle = createPrivacyRoutes({ resolveConversation: conversation });
  const res = mockRes();
  await handle(mockReq(`/api/privacy/scan?text=${encodeURIComponent(`전화 ${PHONE} / 주민 ${RRN}`)}&session=s-3`), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.scanned.rules, ['korean_rrn', 'phone_number']);
  assert.equal(body.scanned.total, 2);
  assert.equal(body.decision.action, 'sent');
  assert.equal(body.masked, '전화 [PHONE_1] / 주민 [RRN_1]');
  assert.equal(res.body.includes(PHONE), false, 'the scan endpoint must not echo the original value');
  assert.equal(res.body.includes(RRN), false);
  // Offsets and ids only: no matched text in the finding list.
  assert.deepEqual(Object.keys(body.scanned.findings[0]).sort(), ['class', 'end', 'risk', 'rule', 'score', 'start', 'variant']);
});

test('POST /api/privacy/scan refuses a confirmed secret and requires text', async () => {
  resetEvents();
  const handle = createPrivacyRoutes({ resolveConversation: conversation });
  const secret = mockRes();
  await handle(mockReq('/api/privacy/scan', 'POST', { text: 'key sk-proj-abcdefghijklmnopqrstuvwx' }), secret);
  const body = JSON.parse(secret.body);
  assert.equal(body.decision.action, 'blocked');
  assert.equal(body.decision.code, 'privacy_guard_blocked');
  assert.equal(body.masked, null, 'a blocked scan returns no masked payload to send');

  const missing = mockRes();
  await handle(mockReq('/api/privacy/scan', 'POST', {}), missing);
  assert.equal(missing.statusCode, 400);
});

test('GET /api/privacy/findings totals the records the gate already emitted', async () => {
  resetEvents();
  const handle = createPrivacyRoutes({ resolveConversation: conversation });
  await handle(mockReq(`/api/privacy/scan?text=${encodeURIComponent(`전화 ${PHONE} / 주민 ${RRN}`)}&session=s-4`), mockRes());
  // A real chat payload through the same gate records the same way.
  await screenOutbound({ body: { messages: [{ role: 'user', content: `주민 ${RRN}` }] }, sessionId: 's-4', route: 'local_only' });
  const res = mockRes();
  const handled = await handle(mockReq('/api/privacy/findings?session=s-4'), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.records['privacy.masked'], 2, 'both masked sends are counted');
  assert.equal(body.byRule.phone_number, 1);
  assert.equal(body.byRule.korean_rrn, 2);
  assert.equal(body.total, 3);
  assert.deepEqual(body.classes, ['personal']);
  assert.equal(res.body.includes(PHONE), false, 'aggregated findings never carry a value');
  assert.equal(res.body.includes(RRN), false);
});

test('unknown privacy paths answer 404 instead of falling through to the asset branch', async () => {
  const handle = createPrivacyRoutes();
  const res = mockRes();
  const handled = await handle(mockReq('/api/privacy/nope'), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
  const outside = await handle(mockReq('/api/memory/status'), mockRes());
  assert.equal(outside, false, 'the privacy handler only owns its own prefix');
});

// The handler being correct is not the same as the route being mounted: this one
// goes through the real server, the real host check and the real GET-only gate.
test('the live server mount answers /api/privacy/status and /api/privacy/scan', { timeout: 20000 }, async (t) => {
  const { createBridge } = await import('../server.mjs');
  const app = await createBridge({ mock: true });
  t.after(() => app.close());
  const url = await app.start(0);

  const status = await fetch(`${url}/api/privacy/status?consent=1&route=any_cloud&session=live-1`);
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.ok, true);
  assert.ok(body.catalog.rules.length > 0);
  assert.equal(body.consent.consent, true);
  assert.equal(body.consent.masking, 'mask');

  const scan = await fetch(`${url}/api/privacy/scan?text=${encodeURIComponent(`전화 ${PHONE} / 주민 ${RRN}`)}&session=live-1`);
  assert.equal(scan.status, 200);
  const text = await scan.text();
  assert.deepEqual(JSON.parse(text).scanned.rules, ['korean_rrn', 'phone_number']);
  assert.equal(text.includes(PHONE), false, 'the live route must not echo the original value');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionPlane, decisionPlaneSummary } from '../lib/decision-plane.mjs';

test('createDecisionPlane: returns expected snapshot before probing', () => {
  const plane = createDecisionPlane({
    upstreamId: 'remote-gw',
    baseUrl: 'http://127.0.0.1:10100/v1',
    modelsPath: '/models',
    keyValue: 'secret-token-12345678',
  });
  assert.equal(plane.configured, true);
  assert.equal(plane.upstream, 'remote-gw');
  const snap = plane.snapshot();
  assert.equal(snap.configured, true);
  assert.equal(snap.upstream, 'remote-gw');
  assert.equal(snap.available, null);
  assert.equal(snap.reason, 'decision_plane_unchecked');
  assert.equal(JSON.stringify(snap).includes('secret-token-12345678'), false, 'snapshot must not leak key');
});

test('createDecisionPlane: unconfigured plane reports not_configured', async () => {
  const plane = createDecisionPlane();
  assert.equal(plane.configured, false);
  const snap = await plane.check();
  assert.equal(snap.configured, false);
  assert.equal(snap.available, null);
  assert.equal(snap.reason, 'decision_plane_not_configured');
  const summary = decisionPlaneSummary(plane);
  assert.equal(summary.source, 'local');
  assert.equal(summary.reason, 'decision_plane_not_configured');
});

test('createDecisionPlane: 200 HTTP response marks plane ready', async () => {
  let callCount = 0;
  let sentAuth = null;
  const fakeFetch = async (url, options) => {
    callCount += 1;
    sentAuth = options.headers?.authorization;
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };

  const plane = createDecisionPlane({
    upstreamId: 'remote-gw',
    baseUrl: 'http://127.0.0.1:10100/v1',
    keyValue: 'my-bearer-secret',
    fetchImpl: fakeFetch,
  });

  const snap = await plane.check();
  assert.equal(callCount, 1);
  assert.equal(snap.available, true);
  assert.equal(snap.reason, 'decision_plane_ready');
  assert.equal(sentAuth, 'Bearer my-bearer-secret');
  assert.ok(snap.checked_at !== null);

  const summary = decisionPlaneSummary(plane);
  assert.equal(summary.source, 'remote');
  assert.equal(summary.available, true);
  assert.equal(summary.upstream, 'remote-gw');
});

test('createDecisionPlane: network error marks plane unreachable', async () => {
  const fakeFetch = async () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:10100');
    err.code = 'ECONNREFUSED';
    throw err;
  };

  const plane = createDecisionPlane({
    upstreamId: 'remote-gw',
    baseUrl: 'http://127.0.0.1:10100/v1',
    fetchImpl: fakeFetch,
  });

  const snap = await plane.check();
  assert.equal(snap.available, false);
  assert.equal(snap.reason, 'decision_plane_unreachable');
  assert.ok(snap.detail.includes('ECONNREFUSED'));
});

test('createDecisionPlane: 503 HTTP status marks plane unreachable_status', async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 503,
  });

  const plane = createDecisionPlane({
    upstreamId: 'remote-gw',
    baseUrl: 'http://127.0.0.1:10100/v1',
    fetchImpl: fakeFetch,
  });

  const snap = await plane.check();
  assert.equal(snap.available, false);
  assert.equal(snap.reason, 'decision_plane_unreachable_status');
  assert.equal(snap.detail, 'http_503');
});

test('createDecisionPlane: caches result within TTL without repeat fetches', async () => {
  let callCount = 0;
  let virtualTime = 1000;
  const fakeFetch = async () => {
    callCount += 1;
    return { ok: true, status: 200 };
  };

  const plane = createDecisionPlane({
    upstreamId: 'remote-gw',
    baseUrl: 'http://127.0.0.1:10100/v1',
    ttlMs: 5000,
    fetchImpl: fakeFetch,
    now: () => virtualTime,
  });

  await plane.check();
  assert.equal(callCount, 1);

  // Still within TTL: no second call
  virtualTime += 2000;
  await plane.check();
  assert.equal(callCount, 1);

  // TTL lapsed: triggers new fetch
  virtualTime += 4000;
  await plane.check();
  assert.equal(callCount, 2);
});

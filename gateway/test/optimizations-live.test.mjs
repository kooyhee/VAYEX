// The live path: these tests go through the real gateway HTTP handler with the
// loopback stub upstream, so they prove the optimisations are wired into the
// request path rather than merely unit-tested in isolation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, call } from './helpers.mjs';
import { events, resetEvents } from '../lib/events.mjs';

const ID = { 'x-user-id': 'user-a' };
const CHAT = '/v1/chat/completions';
const SESSION = 'session-abc';

test('live: a second turn in the same session is served by the pinned model and reports it', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  resetEvents();

  const first = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-app-session': SESSION },
    body: { messages: [{ role: 'system', content: 'You are the platform agent.' }, { role: 'user', content: 'hello' }] },
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.headers.get('x-gateway-session-pinned'), 'false');
  assert.equal(first.headers.get('x-gateway-plan-mode'), 'direct_execute');

  const second = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-app-session': SESSION },
    body: {
      messages: [
        { role: 'system', content: 'You are the platform agent.' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'now do something else' },
      ],
    },
  });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.headers.get('x-gateway-session-pinned'), 'true');
  assert.equal(second.json.gateway.model.session_pinned, true, 'the pin is reported, not just used');
  assert.equal(second.json.gateway.model.id, first.json.gateway.model.id);

  const pins = events({ type: 'pin.set', session: SESSION });
  assert.equal(pins.length, 1, 'the first turn installed exactly one pin');
  const decisions = events({ type: 'decision', session: SESSION });
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].data.track, 'direct_execute');
  const selects = events({ type: 'model.select', session: SESSION });
  assert.equal(selects.length, 2);
  assert.equal(selects[1].data.pinned, true);
});

test('live: the prefix digest is stable across turns and only level 3 grows', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  resetEvents();

  const system = 'You are the platform agent. Follow the project rules exactly.';
  const one = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-app-session': 'prefix-session' },
    body: { messages: [{ role: 'system', content: system }, { role: 'user', content: 'first' }] },
  });
  const two = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-app-session': 'prefix-session' },
    body: { messages: [{ role: 'system', content: system }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'second' }] },
  });
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);

  const reports = events({ type: 'cache.report', session: 'prefix-session' });
  assert.equal(reports.length, 2);
  assert.equal(reports[0].data.level1, reports[1].data.level1, 'level 1 is byte-stable across turns');
  assert.equal(reports[0].data.prefix, reports[1].data.prefix, 'the cached prefix did not change');
  assert.notEqual(reports[0].data.level3, reports[1].data.level3, 'level 3 grew with the history');
  assert.equal(reports[1].data.stable, true);
});

test('live: every completed turn emits a per-request llm_turn with the real usage fields', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  resetEvents();

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-app-session': 'accounting-session' },
    body: { messages: [{ role: 'user', content: 'hello' }] },
  });
  assert.equal(res.status, 200, res.text);
  const turns = events({ type: 'llm_turn' });
  assert.equal(turns.length, 1);
  const [record] = turns;
  assert.equal(record.taskId, 'accounting-session|zdr_cloud|chat|-');
  assert.equal(record.route, 'zdr_cloud');
  assert.equal(record.provider !== null, true, 'the upstream that served the turn is named');
  assert.equal(record.model, res.json.gateway.model.id);
  assert.equal(typeof record.promptTokens, 'number');
  assert.equal(typeof record.completionTokens, 'number');
  assert.ok(record.cost.usd >= 0);
});

test('live: a streamed turn is accounted from the last usage frame', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  resetEvents();

  const res = await fetch(`${h.baseUrl}${CHAT}`, {
    method: 'POST',
    headers: { ...ID, 'content-type': 'application/json', 'x-app-session': 'stream-session' },
    body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'stream please' }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-prefix-stable'), 'true');
  await res.text();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const turns = events({ type: 'llm_turn' });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].data.stream, true);
  const reports = events({ type: 'cache.report' });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].data.stream, true);
});

test('live: the baseline profile turns pinning and provider cache off', async (t) => {
  const h = await startHarness({
    mutateConfig: (raw) => { raw.optimization = { profile: 'baseline' }; },
  });
  t.after(() => h.stop());
  resetEvents();

  const first = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-app-session': 'baseline-session' },
    body: { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'one' }] },
  });
  const second = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-app-session': 'baseline-session' },
    body: { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'one' }, { role: 'user', content: 'two' }] },
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(second.status, 200, second.text);
  assert.equal(first.headers.get('x-gateway-session-pinned'), 'false');
  assert.equal(second.headers.get('x-gateway-session-pinned'), 'false', 'the baseline profile keeps no pin');
  assert.equal(events({ type: 'pin.set' }).length, 0);
  const reports = events({ type: 'cache.report' });
  assert.equal(reports.every((report) => report.data.applied === false), true);
});

test('live: a caller prompt_cache_key is accepted exactly when the model declares support', async (t) => {
  const supported = await startHarness({
    mutateConfig: (raw) => {
      raw.upstreams.find((upstream) => upstream.id === 'ollama').models[0].supports_prompt_cache_key = true;
    },
  });
  t.after(() => supported.stop());
  const accepted = await call(supported.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-app-session': 'key-session' },
    body: { messages: [{ role: 'user', content: 'hello' }], prompt_cache_key: 'caller-key' },
  });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(supported.stub.requests.at(-1).body.prompt_cache_key, 'caller-key');

  const plain = await startHarness();
  t.after(() => plain.stop());
  const refused = await call(plain.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: { messages: [{ role: 'user', content: 'hello' }], prompt_cache_key: 'caller-key' },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, 'unsupported_parameter');
  assert.equal(plain.stub.requests.length, 0, 'a refused cache key reaches no upstream');
});

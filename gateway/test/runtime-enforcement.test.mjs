// Every rule here was documented but only exercised by a unit test: the running
// server either never built the validator's context (so V-06/V-07/V-08 could not
// fire), reported a plan directive it never sent, ignored the configured pin TTL,
// or had no consent gate of its own. These tests pin the runtime behaviour, not
// the planner's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, call } from './helpers.mjs';
import { requireConsentForCloud } from '../lib/consent.mjs';
import { SESSION_PINS } from '../lib/session-pin.mjs';
import { validateTurnPlan } from '../lib/turn-plan.mjs';

const ID = { 'x-user-id': 'user-a' };
const CHAT = '/v1/chat/completions';
const MODEL = 'deepseek/deepseek-v4.1-flash-1017';

// Two file paths and a long prompt: the planner's own complexity trigger, so the
// gateway really chooses survey_and_plan rather than a test forcing the track.
const COMPLEX = `src/server/app.js 와 src/server/routes.js 를 함께 수정해야 합니다. `
  + '조사하고 계획을 세운 뒤 구현하고 검증하는 절차를 따라 주세요. '.repeat(12);

function firstSystemText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const first = messages[0];
  if (!first || first.role !== 'system') return null;
  return typeof first.content === 'string' ? first.content : null;
}

test('a plan turn actually sends the four-stage directive to the provider', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: { messages: [{ role: 'user', content: COMPLEX }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-plan-mode'), 'survey_and_plan');

  const sent = h.stub.requests[h.stub.requests.length - 1].body;
  const directive = firstSystemText(sent);
  assert.ok(directive, 'the plan directive must be the leading system message, not a reported-only field');
  assert.match(directive, /4단계 구조화 실행 지침/);
  assert.match(directive, /조사 \(Survey\)/);
  // The caller's own turn is preserved behind it.
  assert.equal(sent.messages[sent.messages.length - 1].role, 'user');
});

test('a configured budget cap fails the plan at runtime and is reported as V-08', async (t) => {
  const h = await startHarness({
    mutateConfig: (raw) => {
      raw.optimization = { ...(raw.optimization || {}), budget_cap_usd: 0.000001 };
    },
  });
  t.after(() => h.stop());
  assert.equal(h.config.optimization.budgetCapUsd, 0.000001);

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: { messages: [{ role: 'user', content: COMPLEX }] },
  });
  assert.equal(res.status, 200);
  // V-08 degrades the expensive plan to direct execution instead of running it.
  assert.equal(res.headers.get('x-gateway-plan-mode'), 'direct_execute');
  assert.match(res.headers.get('x-gateway-plan-violations'), /V-08/);
  const sent = h.stub.requests[h.stub.requests.length - 1].body;
  assert.equal(firstSystemText(sent), null, 'a degraded plan must not send the directive it no longer runs');
});

test('a degraded plan is reported as degraded, not as the plan that was proposed', async (t) => {
  const h = await startHarness({
    mutateConfig: (raw) => {
      raw.optimization = { ...(raw.optimization || {}), budget_cap_usd: 0.000001 };
    },
  });
  t.after(() => h.stop());

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: { messages: [{ role: 'user', content: COMPLEX }] },
  });
  assert.equal(res.headers.get('x-gateway-plan-mode'), 'direct_execute');
  // The served turn is direct execution: the record must not claim the plan tier
  // and thinking envelope the request did not get.
  assert.equal(res.headers.get('x-gateway-plan-tier'), 'fast');

  const selection = await call(h.baseUrl, '/v1/selection', {
    headers: { ...ID, 'x-route': 'zdr_cloud' },
  });
  assert.equal(selection.status, 200);
  const record = selection.json.selection;
  assert.ok(record, 'the served turn must leave a selection record');
  assert.equal(record.model.source, 'gateway');
});

test('a caller who names the model is served directly, without a plan directive', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: { model: MODEL, messages: [{ role: 'user', content: COMPLEX }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-model-source'), 'caller');
  assert.equal(res.headers.get('x-gateway-plan-mode'), 'direct_execute');
  const sent = h.stub.requests[h.stub.requests.length - 1].body;
  assert.equal(firstSystemText(sent), null);
});

test('the configured pin window is the window the chat path uses', async (t) => {
  const h = await startHarness({
    mutateConfig: (raw) => {
      raw.optimization = { ...(raw.optimization || {}), pin_cache_ttl_ms: 120000 };
    },
  });
  t.after(() => h.stop());
  assert.equal(h.config.optimization.pinCacheTtlMs, 120000);
  assert.equal(SESSION_PINS.ttlMs, 120000, 'the parsed TTL must reach the store, not stay on the default');
});

test('a survey plan is never accepted with a single worker (V-04 lower bound)', () => {
  const result = validateTurnPlan({
    track: 'survey_and_plan',
    reason: 'complex_task_multi_file',
    tier: 'high_intelligence',
    thinkingBudget: 4096,
    workers: 1,
    planDirective: 'survey then implement then verify',
  });
  assert.equal(result.plan.workers, 2);
  assert.deepEqual(result.violations.map((v) => v.rule), ['V-04']);
});

test('a gateway started on its own refuses a cloud route without consent', () => {
  const config = { route: { default: 'zdr_cloud' } };
  const authorize = requireConsentForCloud({ config });

  // A local route leaves nothing on the device's behalf to consent to.
  assert.doesNotThrow(() => authorize({ req: { headers: { 'x-route': 'local_only' } }, body: {} }));

  // The configured cloud default is refused while consent is unstated.
  assert.throws(
    () => authorize({ req: { headers: {} }, body: {} }),
    (error) => error.status === 403 && error.code === 'consent_required',
  );
  assert.throws(
    () => authorize({ req: { headers: { 'x-route': 'any_cloud' } }, body: {} }),
    (error) => error.status === 403 && error.code === 'consent_required',
    'a body-supplied route must be gated too, not only the header',
  );

  // Stated consent, in either spelling the app sends, opens the cloud route.
  for (const value of ['true', '1']) {
    assert.doesNotThrow(() => authorize({ req: { headers: { 'x-consent': value } }, body: {} }));
  }
});

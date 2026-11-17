// Gateway-side reporting of the automatic model + reasoning decision.
//
// The selection and grade resolvers already decide, per request, which model
// serves an automatic call and which reasoning grade goes with it. The SSE relay
// forwards provider bytes verbatim, so a streaming client can only read that
// decision from response headers — after the fact there is nothing. `GET
// /v1/selection` is the read-only answer: the most recent decision for the
// caller's identity and route, or `null` when there is none.
//
// What these tests pin: no decision reads as `null`, a real decision matches the
// resolvers' own output for that request (never a hardcoded guess), records are
// isolated per identity and per route, nothing about the prompt, headers or keys
// is retained, the SSE bytes and quota accounting are exactly what they were, and
// an unreadable route is refused the same way every other endpoint refuses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BYOK_KEY, STUB_KEY, call, startHarness } from './helpers.mjs';
import { createSelectionRecord } from '../lib/selection-record.mjs';
import {
  createServabilityCheck,
  declaredOutputTokens,
  resolveRequestModel,
} from '../lib/selection.mjs';
import { callerChoseReasoning, selectReasoningGrade } from '../lib/grade.mjs';

const ID = { 'x-user-id': 'user-a' };
const CHAT = '/v1/chat/completions';
const SELECTION = '/v1/selection';

function ledgerFor(h, identity = 'user-a') {
  const ledger = JSON.parse(readFileSync(h.config.quota.ledgerPath, 'utf8'));
  const day = Object.values(ledger.users?.[identity] ?? {})[0];
  return { requests: day?.requests ?? 0, tokens: day?.tokens ?? 0 };
}

// The decision the chat path makes for this request, computed with the same
// resolvers it uses and the same inputs it passes them. This is what the record
// must equal; a test that hardcoded a model id would pass while the gateway
// reported something else.
function expectedDecision(h, { body, route, identity = 'user-a' }) {
  const { entry, selection } = resolveRequestModel({
    body,
    route,
    capability: 'chat',
    config: h.config,
    // These requests send no Authorization, so neither does the check below.
    isServable: createServabilityCheck({ req: { headers: {} }, keys: h.gateway.helmet.keys }),
    requireReasoning: callerChoseReasoning(body),
  });
  const { ledger } = h.gateway.helmet;
  const availableTokens = ledger.tokensPerDay
    - ledger.bucket(identity).tokens
    - ledger.bucket(identity).reserved_tokens;
  const outputTokens = declaredOutputTokens(body);
  const reasoning = selectReasoningGrade({
    body,
    model: entry.model,
    route,
    promptTokens: selection.prompt_tokens_estimate,
    outputTokens,
    availableTokens,
    // The ledger's reservation is the larger of the declared output and the
    // thinking budget; only "does it fit" matters to the grade, and with the
    // daily budget these tests use every grade does.
    reserveFor: (budget) => Math.max(outputTokens ?? 0, budget),
  }).report;
  return { entry, selection, reasoning };
}

function assertRecordIs(expected, record, label) {
  assert.ok(record, `${label}: a decision must have been recorded`);
  assert.equal(record.model.id, expected.entry.model.id, `${label}: model id`);
  assert.equal(record.model.upstream, expected.entry.upstream.id, `${label}: upstream id`);
  assert.equal(record.model.source, expected.selection.source, `${label}: model source`);
  assert.equal(record.model.reason, expected.selection.reason, `${label}: model reason`);
  assert.equal(record.reasoning.source, expected.reasoning.source, `${label}: reasoning source`);
  assert.equal(record.reasoning.reason, expected.reasoning.reason, `${label}: reasoning reason`);
  assert.equal(record.reasoning.grade, expected.reasoning.grade ?? null, `${label}: reasoning grade`);
  assert.equal(record.reasoning.thinking_budget, expected.reasoning.thinking_budget ?? null,
    `${label}: thinking budget`);
}

test('no decision yet reads as selection: null, before and after a restart', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const fresh = await call(h.baseUrl, SELECTION, { headers: ID });
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.json, { selection: null }, 'a process that has decided nothing reports null, not a guess');
  assert.equal(fresh.headers.get('cache-control'), 'no-store');

  // A different identity, and a route nothing has been sent on, stay null even
  // once one decision exists.
  const chat = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: { messages: [{ role: 'user', content: 'decide something' }] },
  });
  assert.equal(chat.status, 200);
  const other = await call(h.baseUrl, SELECTION, { headers: { 'x-user-id': 'user-b' } });
  assert.deepEqual(other.json, { selection: null });
  const otherRoute = await call(h.baseUrl, SELECTION, { headers: { ...ID, 'x-route': 'any_cloud' } });
  assert.deepEqual(otherRoute.json, { selection: null });

  // In-memory only: the ledger is the one thing that survives a restart.
  await h.restart();
  const restarted = await call(h.baseUrl, SELECTION, { headers: ID });
  assert.equal(restarted.status, 200);
  assert.deepEqual(restarted.json, { selection: null }, 'no record is persisted across a process restart');
});

test('after an automatic completion the record is the decision the resolvers actually made', async (t) => {
  // Without a server-local model the automatic pick lands on a model that
  // declares thinking support, so the reasoning half of the record is a real
  // gateway choice rather than "no capability".
  const h = await startHarness({
    mutateConfig: (raw) => { raw.upstreams = raw.upstreams.filter((u) => u.class !== 'server_local'); },
  });
  t.after(() => h.stop());

  const body = { messages: [{ role: 'user', content: 'y'.repeat(20000) }] };
  const route = h.config.route.default;
  const expected = expectedDecision(h, { body, route });
  assert.equal(expected.selection.source, 'gateway', 'this request must be an automatic one');
  assert.equal(expected.reasoning.source, 'gateway', 'the grade must be the gateway\'s own choice');
  assert.ok(expected.reasoning.grade, 'the resolver picked a grade for this request');

  const before = ledgerFor(h);
  const chat = await call(h.baseUrl, CHAT, { method: 'POST', headers: ID, body });
  assert.equal(chat.status, 200, chat.text);
  assert.equal(ledgerFor(h).requests, before.requests + 1);

  // The response itself reports the same decision; the record must agree with it
  // as well as with the resolvers, since they are one object in the chat path.
  assert.equal(chat.json.gateway.model.id, expected.entry.model.id);
  assert.equal(chat.json.gateway.reasoning.grade, expected.reasoning.grade);
  assert.equal(chat.json.gateway.reasoning.thinking_budget, expected.reasoning.thinking_budget);

  const res = await call(h.baseUrl, SELECTION, { headers: ID });
  assert.equal(res.status, 200);
  const record = res.json.selection;
  assertRecordIs(expected, record, 'automatic decision');
  assert.equal(record.route, route);
  assert.equal(record.capability, 'chat');
  assert.equal(record.sequence, 1, 'the first decision in a fresh process is sequence 1');
  assert.match(record.decided_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // Same facts the chat headers carried, so a streaming client and this endpoint
  // cannot disagree about which model served the request.
  assert.equal(chat.headers.get('x-gateway-model'), record.model.id);
  assert.equal(chat.headers.get('x-gateway-upstream'), record.model.upstream);
  assert.equal(chat.headers.get('x-gateway-reasoning-grade'), record.reasoning.grade);
});

test('the record is per identity and per route', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const auto = (headers) => call(h.baseUrl, CHAT, {
    method: 'POST',
    headers,
    body: { messages: [{ role: 'user', content: 'hello' }] },
  });

  const first = await auto(ID);
  assert.equal(first.status, 200);
  const seen = await call(h.baseUrl, SELECTION, { headers: ID });
  assert.equal(seen.json.selection.model.id, first.json.gateway.model.id);

  // A different identity does not see it.
  assert.deepEqual((await call(h.baseUrl, SELECTION, { headers: { 'x-user-id': 'user-b' } })).json,
    { selection: null });

  // Nor does the same identity on another route.
  const otherRoute = await call(h.baseUrl, SELECTION, { headers: { ...ID, 'x-route': 'any_cloud' } });
  assert.deepEqual(otherRoute.json, { selection: null });

  // That identity on that route gets its own, and neither previous record moves.
  const second = await auto({ 'x-user-id': 'user-b', 'x-route': 'any_cloud' });
  assert.equal(second.status, 200);
  const bOnAny = await call(h.baseUrl, SELECTION, {
    headers: { 'x-user-id': 'user-b', 'x-route': 'any_cloud' },
  });
  assert.equal(bOnAny.json.selection.model.id, second.json.gateway.model.id);
  assert.equal(bOnAny.json.selection.route, 'any_cloud');

  const aOnZdr = await call(h.baseUrl, SELECTION, { headers: ID });
  assert.equal(aOnZdr.json.selection.sequence, seen.json.selection.sequence,
    'another identity\'s decision must not replace this one');
  assert.equal(aOnZdr.json.selection.model.id, first.json.gateway.model.id);
  assert.deepEqual((await call(h.baseUrl, SELECTION, {
    headers: { 'x-user-id': 'user-b' },
  })).json, { selection: null }, 'user-b has decided nothing on the default route');

  // A later decision for the same identity and route replaces the earlier one and
  // moves the sequence forward, but only for that pair.
  const third = await auto(ID);
  assert.equal(third.status, 200);
  const aAgain = await call(h.baseUrl, SELECTION, { headers: ID });
  assert.ok(aAgain.json.selection.sequence > aOnZdr.json.selection.sequence,
    'the sequence must increase monotonically');
  assert.equal((await call(h.baseUrl, SELECTION, {
    headers: { 'x-user-id': 'user-b', 'x-route': 'any_cloud' },
  })).json.selection.sequence, bOnAny.json.selection.sequence);
});

test('the endpoint carries no prompt, message content, key or header', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const marker = 'PROMPT-MARKER-7f3a9c';
  const chat = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: {
      'x-user-id': 'user-leak-check',
      authorization: `Bearer ${BYOK_KEY}`,
      'x-trace-id': 'trace-must-not-appear',
    },
    body: {
      messages: [
        { role: 'system', content: 'system instruction that must not be retained' },
        { role: 'user', content: `${marker} answer this` },
      ],
    },
  });
  assert.equal(chat.status, 200, chat.text);

  const res = await call(h.baseUrl, SELECTION, {
    headers: { 'x-user-id': 'user-leak-check', authorization: `Bearer ${BYOK_KEY}` },
  });
  assert.equal(res.status, 200);
  const text = res.text;
  for (const forbidden of [
    marker,
    'system instruction that must not be retained',
    'answer this',
    BYOK_KEY,
    STUB_KEY,
    'Bearer',
    'user-leak-check',
    'trace-must-not-appear',
    'authorization',
    'messages',
    'prompt',
  ]) {
    assert.equal(text.includes(forbidden), false, `${JSON.stringify(forbidden)} must not appear in ${text}`);
  }

  // An exact shape, so a future field cannot be added here without a test that
  // says what it is: nothing is echoed "for convenience".
  assert.deepEqual(Object.keys(res.json), ['selection']);
  assert.deepEqual(Object.keys(res.json.selection).sort(),
    ['capability', 'decided_at', 'model', 'reasoning', 'role', 'route', 'sequence']);
  assert.deepEqual(Object.keys(res.json.selection.model).sort(),
    ['decision_detail', 'decision_plane_available', 'decision_reason', 'decision_source', 'decision_upstream', 'fallback_chain', 'id', 'primary', 'reason', 'role', 'role_reason', 'source', 'upstream']);
  // The decision fields are reason codes and identifiers, never prompt text.
  assert.equal(res.json.selection.model.decision_source, 'local');
  assert.equal(res.json.selection.model.decision_upstream, null);
  assert.match(res.json.selection.model.role_reason, /^role:/);
  assert.deepEqual(Object.keys(res.json.selection.reasoning).sort(),
    ['grade', 'reason', 'source', 'thinking_budget']);
});

test('6-role routing exposes resolved role, selected model, fallback chain and reasoning grade in x-gateway-* headers and /v1/selection', async (t) => {
  const h = await startHarness({
    mutateConfig: (raw) => {
      raw.upstreams = raw.upstreams.filter((u) => u.class !== 'server_local');
      const or = raw.upstreams.find((u) => u.id === 'openrouter');
      // The ids the six roles are curated onto: `combo/*` entries whose concrete
      // worker the remote decision model resolves. `metadata.decision_model` marks
      // them, which is what makes the selection report a remote decision.
      or.models.push(
        { id: 'combo/lead', capabilities: ['chat'], zero_data_retention: true, training_opt_out: true, thinking_limit: 8192, context_window: 200000, metadata: { decision_model: true } },
        { id: 'combo/advisor', capabilities: ['chat'], zero_data_retention: true, training_opt_out: true, thinking_limit: 16384, context_window: 200000, metadata: { decision_model: true } },
        { id: 'combo/front-worker', capabilities: ['chat'], zero_data_retention: true, training_opt_out: true, thinking_limit: 8192, context_window: 200000, metadata: { decision_model: true } },
        { id: 'combo/worker', capabilities: ['chat'], zero_data_retention: true, training_opt_out: true, thinking_limit: 16384, context_window: 400000, metadata: { decision_model: true } },
        { id: 'combo/heavy-worker', capabilities: ['chat'], zero_data_retention: true, training_opt_out: true, thinking_limit: 16384, context_window: 1048576, metadata: { decision_model: true } },
        { id: 'combo/reviewer', capabilities: ['chat'], zero_data_retention: true, training_opt_out: true, thinking_limit: 8192, context_window: 200000, metadata: { decision_model: true } },
      );
    },
  });
  t.after(() => h.stop());

  const roleCases = [
    { role: 'main', prompt: '서브에이전트 작업을 조율하고 결과를 통합해줘', expectedModel: 'combo/lead' },
    { role: 'planner', prompt: '전체 시스템 아키텍처 설계와 마이그레이션 계획을 수립해줘', expectedModel: 'combo/advisor' },
    { role: 'frontend', prompt: '반응형 웹 프론트엔드 UI 컴포넌트와 다크모드 CSS 레이아웃을 구현해줘', expectedModel: 'combo/front-worker' },
    { role: 'backend', prompt: 'REST API 서버 엔드포인트와 데이터베이스 트랜잭션 비즈니스 로직을 구현해줘', expectedModel: 'combo/worker' },
    { role: 'research', prompt: '메모리 누수 에러 원인을 규명하고 관련 기술 문서를 조사·분석해줘', expectedModel: 'combo/advisor' },
    { role: 'verifier', prompt: '단위 테스트를 실행하고 코드 리뷰 및 정합성 검증을 수행해줘', expectedModel: 'combo/reviewer' },
  ];

  for (const item of roleCases) {
    const res = await call(h.baseUrl, CHAT, {
      method: 'POST',
      headers: ID,
      body: { messages: [{ role: 'user', content: item.prompt }] },
    });
    assert.equal(res.status, 200, `${item.role}: ${res.text}`);
    assert.equal(res.headers.get('x-gateway-role'), item.role);
    assert.equal(res.headers.get('x-gateway-model'), item.expectedModel);
    assert.equal(res.headers.get('x-gateway-model-primary'), item.expectedModel);
    assert.ok(res.headers.get('x-gateway-model-fallback').includes(item.expectedModel));
    assert.ok(res.headers.get('x-gateway-reasoning-grade'));
    // No decision plane was supplied to this harness, so the choice is reported as
    // remote-decision-unchecked: the router never claims a probe it did not make.
    assert.equal(res.headers.get('x-gateway-decision-source'), 'remote_decision');
    assert.equal(res.headers.get('x-gateway-decision-reason'), 'decision_plane_unchecked');
    assert.equal(res.headers.get('x-gateway-decision-plane'), 'unknown');

    const sel = await call(h.baseUrl, SELECTION, { headers: ID });
    assert.equal(sel.status, 200);
    assert.equal(sel.json.selection.role, item.role);
    assert.equal(sel.json.selection.model.id, item.expectedModel);
    assert.equal(sel.json.selection.model.role, item.role);
    assert.equal(sel.json.selection.model.primary, item.expectedModel);
    assert.equal(sel.json.selection.model.decision_source, 'remote_decision');
    assert.ok(Array.isArray(sel.json.selection.model.fallback_chain));
  }
});

test('the SSE stream and quota accounting are exactly as before', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const identity = 'user-a';
  const before = ledgerFor(h, identity);
  const response = await fetch(`${h.baseUrl}${CHAT}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ID },
    // No model: this is the automatic path, whose decision the endpoint reports.
    body: JSON.stringify({ messages: [{ role: 'user', content: 'stream this' }], stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const raw = await response.text();
  const frames = raw.split('\n\n').filter((f) => f.trim());
  assert.ok(frames.length >= 6, `expected several SSE frames, got ${frames.length}: ${raw}`);
  assert.ok(raw.endsWith('data: [DONE]\n\n'), `stream must end with [DONE], got ${JSON.stringify(raw.slice(-40))}`);
  const deltas = frames
    .filter((f) => f.startsWith('data: {'))
    .map((f) => JSON.parse(f.slice(6)))
    .filter((e) => e.choices?.[0]?.delta?.content)
    .map((e) => e.choices[0].delta.content);
  assert.equal(deltas.join(''), 'Hello from the stub');
  const usageFrame = frames.map((f) => (f.startsWith('data: {') ? JSON.parse(f.slice(6)) : null))
    .find((e) => e && e.usage);
  assert.equal(usageFrame.usage.total_tokens, 12);

  // Nothing was injected into the OpenAI-compatible stream: the record is served
  // only by the new endpoint, never by the relay.
  assert.equal(/gateway/i.test(raw), false, `the relay must not inject gateway fields: ${raw}`);
  assert.equal(raw.includes('"selection"'), false);

  const after = ledgerFor(h, identity);
  assert.equal(after.requests, before.requests + 1);
  assert.equal(after.tokens, before.tokens + 12);

  const upstream = h.stub.lastRequest((r) => r.path.endsWith('/chat/completions'));
  const record = (await call(h.baseUrl, SELECTION, { headers: ID })).json.selection;
  assert.equal(upstream.body.model, record.model.id, 'the upstream was asked for the model the record reports');
  assert.equal(record.model.id, response.headers.get('x-gateway-model'));
  assert.equal(record.reasoning.source, 'none');
  assert.equal(record.reasoning.reason, 'auto:no_reasoning_capability');
  assert.equal(record.reasoning.grade, null);
  assert.equal(record.reasoning.thinking_budget, null);
});

test('an unknown route is refused with the same error the other endpoints give', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const chat = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'local_and_cloud' },
    body: { messages: [{ role: 'user', content: 'hello' }] },
  });
  const selection = await call(h.baseUrl, SELECTION, { headers: { ...ID, 'x-route': 'local_and_cloud' } });
  assert.equal(selection.status, chat.status);
  assert.equal(selection.json.error.code, chat.json.error.code);
  assert.equal(selection.json.error.type, 'invalid_request_error');
  assert.equal(selection.json.error.param, 'route');
  assert.equal(selection.json.error.detail.route, 'local_and_cloud');
  assert.equal(selection.json.error.detail.source, 'header');
  assert.deepEqual(selection.json.error.detail.accepted, ['local_only', 'zdr_cloud', 'any_cloud']);
  assert.match(selection.json.error.message, /local_and_cloud/);

  // A known route is not an error even when no request can ever be served on it:
  // no model is chosen and no socket is opened, so there is simply nothing to
  // report. The refusal for actually sending one stays where it was.
  const local = await call(h.baseUrl, SELECTION, { headers: { ...ID, 'x-route': 'local_only' } });
  assert.equal(local.status, 200);
  assert.deepEqual(local.json, { selection: null });
  assert.equal(ledgerFor(h).requests, 0, 'reading a selection costs no quota');

  // The route is only read from the header: this endpoint takes no body, and a
  // POST is not one of the routes it serves.
  const wrongMethod = await call(h.baseUrl, SELECTION, { method: 'POST', headers: ID, body: {} });
  assert.equal(wrongMethod.status, 404);
  assert.equal(wrongMethod.json.error.code, 'not_found');

  // Identity is authenticated the same way chat authenticates it.
  const anonymous = await call(h.baseUrl, SELECTION);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error.code, 'identity_required');
});

test('the retained decision is bounded and evicts the least recently decided pair', () => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const store = createSelectionRecord({ capacity: 2, clock: () => new Date(now) });
  const entry = { model: { id: 'model/one' }, upstream: { id: 'upstream-one' } };
  const selection = { route: 'zdr_cloud', source: 'gateway', reason: 'auto:server_local' };
  const reasoning = { source: 'gateway', reason: 'auto:threshold_low', grade: 'low', thinking_budget: 1024 };

  const first = store.record({ identity: 'a', route: 'zdr_cloud', entry, selection, reasoning });
  now += 1000;
  const second = store.record({ identity: 'b', route: 'zdr_cloud', entry, selection, reasoning });
  assert.equal(first.sequence + 1, second.sequence);
  assert.notEqual(first.decided_at, second.decided_at);

  // Touching an existing pair replaces it in place rather than adding an entry.
  const again = store.record({ identity: 'b', route: 'zdr_cloud', entry, selection, reasoning });
  assert.equal(store.size(), 2, `the store must stay bounded, size=${store.size()}`);
  assert.equal(store.get('b', 'zdr_cloud').sequence, again.sequence);

  // A third pair pushes out the least recently decided one, which then reads as
  // no decision rather than as a stale record.
  now += 1000;
  store.record({ identity: 'c', route: 'zdr_cloud', entry, selection, reasoning });
  assert.equal(store.size(), 2);
  assert.equal(store.get('a', 'zdr_cloud'), null, 'the least recent identity+route is evicted');
  assert.ok(store.get('b', 'zdr_cloud'));
  assert.ok(store.get('c', 'zdr_cloud'));
  assert.equal(store.get('c', 'any_cloud'), null, 'the route is part of the key');
  assert.equal(store.capacity, 2);
});

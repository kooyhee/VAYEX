// Automatic model selection and automatic reasoning grade.
//
// The gateway, not the client, picks both when the request leaves them open. What
// these tests pin: the pick is deterministic and stays in the allowlist, a
// zdr_cloud request can only ever receive a model declaring both retention flags,
// an explicit model is never overridden, a model with no declared thinking
// capability receives no thinking parameter at all, and the grade is always one
// the model supports with a budget inside its declared limit. The `x-route`
// contract itself is covered by route-contract.test.mjs and is unchanged here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BYOK_KEY, call, startHarness } from './helpers.mjs';
import { callerReasoningReport, selectReasoningGrade } from '../lib/grade.mjs';

const ID = { 'x-user-id': 'user-a' };
const CHAT = '/v1/chat/completions';

function ledgerRequests(h) {
  const ledger = JSON.parse(readFileSync(h.config.quota.ledgerPath, 'utf8'));
  const day = Object.values(ledger.users?.['user-a'] ?? {})[0];
  return day?.requests ?? 0;
}

function chatRequest(h) {
  return h.stub.lastRequest((r) => r.path.endsWith('/chat/completions'));
}

async function allowlist(h) {
  const res = await call(h.baseUrl, '/v1/models');
  return new Map(res.json.data.map((m) => [m.id, m.gateway]));
}

test('an omitted model is chosen deterministically from the allowlist and reported', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const models = await allowlist(h);

  const picks = [];
  for (let i = 0; i < 3; i += 1) {
    const res = await call(h.baseUrl, CHAT, {
      method: 'POST',
      headers: ID,
      body: { messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.equal(res.status, 200);
    const chosen = res.json.gateway.model;
    assert.equal(chosen.source, 'gateway', 'the gateway must say it made the choice');
    assert.equal(chosen.reason, 'auto:server_local');
    assert.equal(chosen.route, 'zdr_cloud');
    assert.ok(models.has(chosen.id), `chosen model ${chosen.id} must be in the allowlist`);
    assert.equal(res.headers.get('x-gateway-model'), chosen.id);
    assert.equal(res.headers.get('x-gateway-model-source'), 'gateway');
    assert.equal(res.headers.get('x-gateway-model-reason'), 'auto:server_local');
    picks.push(chosen.id);

    const upstream = chatRequest(h);
    assert.equal(upstream.body.model, chosen.id, 'the upstream must be asked for the model the gateway reported');
    assert.equal(upstream.body.route, undefined, 'route never leaves the process');
  }
  assert.deepEqual(picks, [picks[0], picks[0], picks[0]], 'identical inputs must produce the identical model');

  // The same pick, whatever order the config listed the upstreams in.
  const reversed = await startHarness({
    mutateConfig: (raw) => { raw.upstreams.reverse(); },
  });
  t.after(() => reversed.stop());
  const other = await call(reversed.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: { messages: [{ role: 'user', content: 'hello' }] },
  });
  assert.equal(other.status, 200);
  assert.equal(other.json.gateway.model.id, picks[0], 'config order must not decide the pick');
  assert.equal(other.json.gateway.model.reason, 'auto:server_local');
});

test('an omitted model under zdr_cloud only ever receives a model declaring both ZDR flags', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const models = await allowlist(h);

  for (const route of ['zdr_cloud', 'any_cloud']) {
    for (const content of ['short', 'x'.repeat(20000)]) {
      const res = await call(h.baseUrl, CHAT, {
        method: 'POST',
        headers: { ...ID, 'x-route': route },
        body: { messages: [{ role: 'user', content }], max_tokens: 64 },
      });
      // any_cloud may legitimately reach a non-ZDR model only if the rule chose
      // one; zdr_cloud must never. Both are checked against the catalogue entry.
      assert.equal(res.status, 200, `${route} / ${content.length} chars: ${res.text}`);
      const chosen = res.json.gateway.model;
      if (route === 'zdr_cloud') {
        const entry = models.get(chosen.id);
        assert.equal(entry.zero_data_retention, true, `${chosen.id} must declare ZDR`);
        assert.equal(entry.training_opt_out, true, `${chosen.id} must declare training opt-out`);
        assert.equal(res.headers.get('x-gateway-model-route'), 'zdr_cloud');
      }
    }
  }

  // A catalogue with no conforming model refuses rather than falling back.
  const noZdr = await startHarness({
    mutateConfig: (raw) => { raw.upstreams = raw.upstreams.filter((u) => u.id === 'a6api'); },
  });
  t.after(() => noZdr.stop());
  const before = noZdr.stub.requests.length;
  const refused = await call(noZdr.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'zdr_cloud' },
    body: { messages: [{ role: 'user', content: 'nobody conforms' }] },
  });
  assert.equal(refused.status, 503);
  assert.equal(refused.json.error.code, 'no_model_available_for_route');
  assert.deepEqual(refused.json.error.detail.allowlisted, ['a6api/deepseek-chat-v3.1']);
  assert.deepEqual(refused.json.error.detail.required, { zero_data_retention: true, training_opt_out: true });
  assert.equal(noZdr.stub.requests.length, before, 'a non-conforming model must not be reached');
  assert.equal(ledgerRequests(noZdr), 0, 'a selection refusal costs no quota');

  // local_only keeps its existing refusal even with no model named.
  const local = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'local_only' },
    body: { messages: [{ role: 'user', content: 'local please' }] },
  });
  assert.equal(local.status, 400);
  assert.equal(local.json.error.code, 'local_only_not_served');
});

test('an explicit model is never overridden and is reported as the caller\'s choice', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'any_cloud', authorization: `Bearer ${BYOK_KEY}` },
    body: {
      model: 'a6api/deepseek-chat-v3.1',
      messages: [{ role: 'user', content: 'my own model' }],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.gateway.model.id, 'a6api/deepseek-chat-v3.1');
  assert.equal(res.json.gateway.model.source, 'caller');
  assert.equal(res.json.gateway.model.reason, 'caller_explicit');
  assert.equal(res.json.gateway.model.candidate_pool, null, 'no gateway selection happened');
  assert.equal(res.headers.get('x-gateway-model'), 'a6api/deepseek-chat-v3.1');
  assert.equal(res.headers.get('x-gateway-model-source'), 'caller');
  assert.equal(chatRequest(h).body.model, 'a6api/deepseek-chat-v3.1');
  assert.equal(chatRequest(h).body.reasoning_effort, undefined,
    'a model with no thinking_limit gets no auto reasoning either');

  // An explicit model that the route forbids is still refused, with the same code.
  const forbidden = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'zdr_cloud' },
    body: { model: 'baseten/mammoth-1', messages: [{ role: 'user', content: 'no' }] },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error.code, 'route_policy_violation');

  // An unreadable model value is still refused rather than treated as absent.
  for (const value of [null, '', '   ', 7]) {
    const bad = await call(h.baseUrl, CHAT, {
      method: 'POST',
      headers: ID,
      body: { model: value, messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(bad.status, 400, `model ${JSON.stringify(value)} must be refused`);
    assert.equal(bad.json.error.code, 'model_required');
  }
});

test('a model without thinking capability receives no thinking parameter, and the response says so', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: {
      model: 'server/qwen3-coder-30b',
      messages: [{ role: 'user', content: 'x'.repeat(20000) }],
      max_completion_tokens: 4096,
      tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
    },
  });
  assert.equal(res.status, 200);
  const upstream = chatRequest(h);
  assert.equal(upstream.body.thinking, undefined);
  assert.equal(upstream.body.thinking_budget, undefined);
  assert.equal(upstream.body.reasoning_effort, undefined, 'no unsupported thinking value may be forwarded');

  const report = res.json.gateway.reasoning;
  assert.equal(report.source, 'none');
  assert.equal(report.reason, 'auto:no_reasoning_capability');
  assert.equal(report.grade, null);
  assert.deepEqual(report.supported_grades, []);
  assert.match(report.detail, /no thinking_limit/);
  assert.equal(res.headers.get('x-gateway-reasoning-grade'), 'none');
  assert.equal(res.headers.get('x-gateway-reasoning-source'), 'none');
  assert.equal(res.headers.get('x-gateway-thinking-budget'), 'none');
});

test('the automatic grade is bounded to what the model supports and to the declared limit', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const bigPrompt = 'x'.repeat(20000);
  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'any_cloud' },
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: bigPrompt }],
      max_tokens: 4096,
      tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
    },
  });
  assert.equal(res.status, 200);
  const report = res.json.gateway.reasoning;
  assert.equal(report.source, 'gateway');
  assert.equal(report.grade, 'high');
  assert.equal(report.reason, 'auto:threshold_high');
  assert.equal(report.thinking_budget, 8192);
  assert.equal(report.thinking_limit, 8192);
  assert.ok(report.supported_grades.every((g) => ['low', 'medium', 'high'].includes(g)));

  const upstream = chatRequest(h);
  assert.equal(upstream.body.reasoning_effort, 'high');
  assert.equal(upstream.body.thinking_budget, 8192);
  assert.equal(res.headers.get('x-gateway-reasoning-grade'), 'high');
  assert.equal(res.headers.get('x-gateway-thinking-budget'), '8192');

  // Same request, a model whose declared limit only supports the low grade: the
  // grade is clamped, never sent above the limit.
  const narrow = await startHarness({
    mutateConfig: (raw) => {
      const or = raw.upstreams.find((u) => u.id === 'openrouter');
      or.models.find((m) => m.id === 'deepseek/deepseek-v4.1-flash-1017').thinking_limit = 2048;
    },
  });
  t.after(() => narrow.stop());
  const clamped = await call(narrow.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'any_cloud' },
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: bigPrompt }],
      max_tokens: 512,
      tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
    },
  });
  assert.equal(clamped.status, 200);
  const narrowReport = clamped.json.gateway.reasoning;
  assert.deepEqual(narrowReport.supported_grades, ['low']);
  assert.equal(narrowReport.grade, 'low');
  assert.equal(narrowReport.clamped_from, 'high');
  assert.equal(narrowReport.thinking_budget, 1024);
  assert.ok(narrowReport.thinking_budget <= narrowReport.thinking_limit);
  assert.equal(chatRequest(narrow).body.reasoning_effort, 'low');
  assert.equal(chatRequest(narrow).body.thinking_budget, 1024);
});

test('a grade that the remaining daily tokens cannot back is lowered, then dropped, and both are reported', async (t) => {
  const tight = await startHarness({ configOverrides: { quota: { tokens_per_day: 5000 } } });
  t.after(() => tight.stop());
  const lowered = await call(tight.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'x'.repeat(20000) }],
      max_tokens: 1024,
      tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
    },
  });
  assert.equal(lowered.status, 200);
  const loweredReport = lowered.json.gateway.reasoning;
  assert.equal(loweredReport.reason, 'auto:clamped_to_quota_headroom');
  assert.equal(loweredReport.grade, 'medium', 'high reserves 8192, which exceeds the 5000-token day');
  assert.equal(chatRequest(tight).body.reasoning_effort, 'medium');

  const tiny = await startHarness({ configOverrides: { quota: { tokens_per_day: 1000 } } });
  t.after(() => tiny.stop());
  const dropped = await call(tiny.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'x'.repeat(20000) }],
      tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
    },
  });
  assert.equal(dropped.status, 200);
  const droppedReport = dropped.json.gateway.reasoning;
  assert.equal(droppedReport.source, 'none');
  assert.equal(droppedReport.reason, 'auto:insufficient_quota_headroom');
  assert.equal(droppedReport.grade, null);
  assert.equal(chatRequest(tiny).body.reasoning_effort, undefined,
    'no thinking parameter is sent when its reservation cannot be backed');
  assert.equal(chatRequest(tiny).body.thinking_budget, undefined);
});

test('a streamed request reports the automatic choice in headers, since the SSE body is relayed verbatim', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const response = await fetch(`${h.baseUrl}${CHAT}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ID, 'x-route': 'any_cloud' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'stream an automatic pick' }], stream: true }),
  });
  assert.equal(response.status, 200);
  const chosen = response.headers.get('x-gateway-model');
  assert.ok(chosen);
  assert.equal(response.headers.get('x-gateway-model-source'), 'gateway');
  assert.match(response.headers.get('x-gateway-model-reason'), /^auto:/);
  assert.equal(response.headers.get('x-gateway-model-route'), 'any_cloud');
  const raw = await response.text();
  assert.ok(raw.endsWith('data: [DONE]\n\n'), 'the stream is not re-framed to inject selection metadata');
  const frames = raw.split('\n\n').filter((f) => f.startsWith('data: {')).map((f) => JSON.parse(f.slice(6)));
  assert.equal(frames[0].model, chosen, 'the upstream was asked for the model the headers report');
  assert.equal(chatRequest(h).body.model, chosen);
});

test('caller-supplied reasoning is reported as the caller\'s, not re-chosen by the gateway', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'reason carefully' }],
      reasoning_effort: 'medium',
      thinking_budget: 2048,
    },
  });
  assert.equal(res.status, 200);
  const report = res.json.gateway.reasoning;
  assert.equal(report.source, 'caller');
  assert.equal(report.reason, 'caller_explicit');
  assert.equal(report.grade, 'medium');
  assert.equal(report.thinking_budget, 2048);
  assert.equal(res.headers.get('x-gateway-reasoning-source'), 'caller');
  const upstream = chatRequest(h);
  assert.equal(upstream.body.reasoning_effort, 'medium');
  assert.equal(upstream.body.thinking_budget, 2048);

  // The existing conflict check still applies to a caller's own fields.
  const conflict = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'conflict' }],
      thinking_budget: 1024,
      thinking: { type: 'disabled' },
    },
  });
  assert.equal(conflict.status, 400);
  assert.equal(conflict.json.error.code, 'parameter_conflict');
});

test('a caller who leaves the model open and asks for reasoning is served by a model that declares thinking support', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: {
      messages: [{ role: 'user', content: 'reason about this, you choose the model' }],
      reasoning_effort: 'medium',
    },
  });
  // The catalogue's only chat model declaring thinking_limit is this one, and it
  // declares both retention flags, so it is the only answer zdr_cloud can give
  // without refusing the caller's own field.
  assert.equal(res.status, 200, res.text);
  const model = res.json.gateway.model;
  assert.equal(model.source, 'gateway');
  assert.equal(model.id, 'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(model.reasoning_required, true, 'the response must say the caller\'s field narrowed the pool');
  const reasoning = res.json.gateway.reasoning;
  assert.equal(reasoning.source, 'caller');
  assert.equal(reasoning.supported_grades_basis, 'derived_from_thinking_limit',
    'the grade set is derived from the declared limit, not presented as declared');

  const upstream = chatRequest(h);
  assert.equal(upstream.body.model, 'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(upstream.body.reasoning_effort, 'medium');
  assert.equal(res.headers.get('x-gateway-model-reasoning-required'), 'true');
});

test('a catalogue field the decision needed but the config omits is reported, never assumed', async (t) => {
  const h = await startHarness({
    mutateConfig: (raw) => {
      raw.upstreams.find((u) => u.id === 'ollama').models[0].context_window = undefined;
      raw.upstreams.find((u) => u.id === 'server_gpu').models[0].context_window = undefined;
    },
  });
  t.after(() => h.stop());

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: { messages: [{ role: 'user', content: 'hello without a declared window' }] },
  });
  assert.equal(res.status, 200, res.text);
  const model = res.json.gateway.model;
  assert.equal(model.source, 'gateway');
  assert.equal(model.context_fit, null, 'an undeclared window is unchecked, not a claimed fit');
  assert.deepEqual(model.assumptions, ['context_window_not_declared']);
  assert.equal(res.headers.get('x-gateway-model-assumptions'), 'context_window_not_declared');

  // The opposite case is stated just as plainly: nothing was assumed.
  const declared = await startHarness();
  t.after(() => declared.stop());
  const clean = await call(declared.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: { messages: [{ role: 'user', content: 'hello' }] },
  });
  assert.deepEqual(clean.json.gateway.model.assumptions, []);
  assert.equal(clean.headers.get('x-gateway-model-assumptions'), 'none');
  assert.equal(clean.json.gateway.reasoning.supported_grades_basis, 'no_thinking_limit_declared');
  assert.equal(clean.headers.get('x-gateway-reasoning-assumptions'), 'model_declares_no_thinking_limit');
});

test('an explicitly disabled thinking request is not a reasoning request and stays on the local model', async (t) => {
  const h = await startHarness({
    // The local entry accepts the caller's own `thinking` field only when it
    // declares a limit to bound it; this test is about selection, so it does.
    mutateConfig: (raw) => {
      raw.upstreams.find((u) => u.id === 'ollama').models[0].thinking_limit = 4096;
    },
  });
  t.after(() => h.stop());

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: {
      messages: [{ role: 'user', content: 'no thinking please, you choose the model' }],
      thinking: { type: 'disabled' },
    },
  });
  assert.equal(res.status, 200, res.text);
  const model = res.json.gateway.model;
  assert.equal(model.source, 'gateway');
  assert.equal(model.id, 'qwen3:32b', 'a request asking for no thinking must not be pushed off the local model');
  assert.equal(model.upstream, 'ollama');
  assert.equal(model.reason, 'auto:server_local');
  assert.equal(model.route, 'zdr_cloud');
  assert.equal(model.reasoning_required, false, 'an explicitly disabled request is not a reasoning request');
  assert.equal(res.headers.get('x-gateway-model-reasoning-required'), 'false');

  const upstream = chatRequest(h);
  assert.equal(upstream.body.model, 'qwen3:32b');
  assert.deepEqual(upstream.body.thinking, { type: 'disabled' }, 'the caller\'s own directive is forwarded untouched');
  assert.equal(upstream.body.reasoning_effort, undefined);
  assert.equal(res.json.gateway.reasoning.source, 'caller');

  // With the shipped catalogue the local pick declares no thinking_limit, so the
  // caller's own field is still refused by validateReasoning — against the local
  // model, named, with no cloud fallback and no upstream call.
  const shipped = await startHarness();
  t.after(() => shipped.stop());
  const refused = await call(shipped.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: {
      messages: [{ role: 'user', content: 'no thinking please, you choose the model' }],
      thinking: { type: 'disabled' },
    },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, 'unsupported_parameter');
  assert.match(refused.json.error.message, /model qwen3:32b does not declare reasoning support/,
    'the refusal names the local model, not a cloud one the gateway moved to');
  assert.equal(shipped.stub.requests.length, 0, 'a refused request reaches no upstream');
});

test('a positive reasoning_effort still selects the thinking-capable model', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: {
      messages: [{ role: 'user', content: 'no thinking please, you choose the model' }],
      reasoning_effort: 'medium',
    },
  });
  assert.equal(res.status, 200, res.text);
  const model = res.json.gateway.model;
  assert.equal(model.source, 'gateway');
  assert.equal(model.id, 'deepseek/deepseek-v4.1-flash-1017',
    'a request for actual reasoning still needs a model that declares thinking support');
  assert.equal(model.reasoning_required, true);
  assert.equal(chatRequest(h).body.reasoning_effort, 'medium');
});

test('a caller report pairs its basis with the matching assumption', () => {
  const noLimit = { id: 'server/plain', thinkingLimit: null };
  const report = callerReasoningReport({ body: { thinking: { type: 'disabled' } }, model: noLimit });
  assert.equal(report.source, 'caller');
  assert.equal(report.supported_grades_basis, 'no_thinking_limit_declared');
  assert.deepEqual(report.assumptions, ['model_declares_no_thinking_limit'],
    'a basis that says the model declares no capability carries the matching assumption');
  assert.deepEqual(report.supported_grades, []);
  assert.equal(report.thinking_limit, null);

  // The same pair, through the function a direct caller would use.
  const { fields, report: selected } = selectReasoningGrade({
    body: { thinking: { type: 'disabled' } },
    model: noLimit,
    route: 'zdr_cloud',
    promptTokens: 10,
    outputTokens: null,
    availableTokens: 100000,
    reserveFor: (budget) => budget,
  });
  assert.deepEqual(fields, {}, 'the caller\'s own directive is never replaced');
  assert.equal(selected.supported_grades_basis, 'no_thinking_limit_declared');
  assert.deepEqual(selected.assumptions, ['model_declares_no_thinking_limit']);

  // A declared limit is the other, consistent pair: a derived basis and nothing
  // assumed, because the capability the decision needed was declared.
  const declared = callerReasoningReport({
    body: { reasoning_effort: 'low' }, model: { id: 'deepseek/deepseek-v4.1-flash-1017', thinkingLimit: 8192 },
  });
  assert.equal(declared.supported_grades_basis, 'derived_from_thinking_limit');
  assert.deepEqual(declared.assumptions, []);
  assert.equal(declared.grade, 'low');
});

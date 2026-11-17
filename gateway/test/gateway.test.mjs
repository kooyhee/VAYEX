import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  STUB_KEY,
  BYOK_KEY,
  call,
  readLog,
  startHarness,
} from './helpers.mjs';

const ID = { 'x-user-id': 'user-a' };

test('streaming passthrough relays the upstream SSE byte stream unchanged', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const response = await fetch(`${h.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ID, 'x-route': 'zdr_cloud' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'stream this' }],
      stream: true,
    }),
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

  const upstream = h.stub.lastRequest((r) => r.path.endsWith('/chat/completions'));
  assert.equal(upstream.body.stream_options.include_usage, true);
  assert.equal(upstream.headers.authorization, `Bearer ${STUB_KEY}`);
  const ledger = JSON.parse(readFileSync(h.config.quota.ledgerPath, 'utf8'));
  assert.equal(ledger.users['user-a'][Object.keys(ledger.users['user-a'])[0]].tokens, 12);
});

test('non-streaming completion is proxied and metered', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'answer plainly' }],
      temperature: 0.2,
      unsupported_field: 'must be dropped',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.object, 'chat.completion');
  assert.equal(res.json.choices[0].message.content, 'stub reply to: answer plainly');
  assert.equal(res.headers.get('x-gateway-upstream'), 'openrouter');

  const upstream = h.stub.lastRequest((r) => r.path.endsWith('/chat/completions'));
  assert.equal(upstream.body.temperature, 0.2);
  assert.equal(upstream.body.unsupported_field, undefined);
  assert.equal(upstream.body.stream, false);
  assert.equal(upstream.body.route, undefined);
});

test('reasoning and thinking fields are passed through for chat completions', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'solve with reasoning' }],
      reasoning_effort: 'high',
      thinking: { type: 'enabled', budget_tokens: 8192 },
      thinking_budget: 8192,
      unsupported_extra: 'drop-me',
    },
  });
  assert.equal(res.status, 200);
  const upstream = h.stub.lastRequest((r) => r.path.endsWith('/chat/completions'));
  assert.equal(upstream.body.reasoning_effort, 'high');
  assert.deepEqual(upstream.body.thinking, { type: 'enabled', budget_tokens: 8192 });
  assert.equal(upstream.body.thinking_budget, 8192);
  assert.equal(upstream.body.unsupported_extra, undefined);
});

test('reasoning validation rejects over-limit, malformed, unsupported and conflicting forms with zero upstream calls', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const count = () => h.stub.requests.length;

  const base = {
    model: 'deepseek/deepseek-v4.1-flash-1017',
    messages: [{ role: 'user', content: 'check my reasoning params' }],
  };

  // 1. Valid exact boundary: 8192 thinking_limit allows 8192
  const boundary = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { ...base, thinking_budget: 8192 },
  });
  assert.equal(boundary.status, 200);
  const beforeFailures = count();

  // 2. Over limit by 1: 8193
  const overLimit = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { ...base, thinking_budget: 8193 },
  });
  assert.equal(overLimit.status, 400);
  assert.equal(overLimit.json.error.code, 'invalid_parameter');
  assert.match(overLimit.json.error.message, /exceeds this model's thinking_limit/);

  // 3. Negative thinking_budget
  const negative = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { ...base, thinking_budget: -10 },
  });
  assert.equal(negative.status, 400);
  assert.equal(negative.json.error.code, 'invalid_parameter');

  // 4. Fractional thinking_budget
  const fractional = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { ...base, thinking_budget: 512.5 },
  });
  assert.equal(fractional.status, 400);
  assert.equal(fractional.json.error.code, 'invalid_parameter');

  // 5. String thinking_budget
  const stringBudget = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { ...base, thinking_budget: '8192' },
  });
  assert.equal(stringBudget.status, 400);
  assert.equal(stringBudget.json.error.code, 'invalid_parameter');

  // 6. Boolean thinking_budget
  const boolBudget = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { ...base, thinking_budget: true },
  });
  assert.equal(boolBudget.status, 400);
  assert.equal(boolBudget.json.error.code, 'invalid_parameter');

  // 7. Null thinking_budget
  const nullBudget = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { ...base, thinking_budget: null },
  });
  assert.equal(nullBudget.status, 400);
  assert.equal(nullBudget.json.error.code, 'invalid_parameter');

  // 8. Object thinking_budget
  const objBudget = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { ...base, thinking_budget: { tokens: 100 } },
  });
  assert.equal(objBudget.status, 400);
  assert.equal(objBudget.json.error.code, 'invalid_parameter');

  // 9. Object reasoning_effort
  const objEffort = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { ...base, reasoning_effort: { effort: 'high' } },
  });
  assert.equal(objEffort.status, 400);
  assert.equal(objEffort.json.error.code, 'invalid_parameter');

  // 10. Invalid reasoning_effort enum
  const invalidEffort = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { ...base, reasoning_effort: 'maximum' },
  });
  assert.equal(invalidEffort.status, 400);
  assert.equal(invalidEffort.json.error.code, 'invalid_parameter');

  // 11. Conflicting thinking_budget and thinking.budget_tokens
  const conflictBudget = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      ...base,
      thinking_budget: 4096,
      thinking: { type: 'enabled', budget_tokens: 8192 },
    },
  });
  assert.equal(conflictBudget.status, 400);
  assert.equal(conflictBudget.json.error.code, 'parameter_conflict');

  // 12. Conflicting disabled thinking with thinking_budget
  const conflictDisabled = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      ...base,
      thinking_budget: 2048,
      thinking: { type: 'disabled' },
    },
  });
  assert.equal(conflictDisabled.status, 400);
  assert.equal(conflictDisabled.json.error.code, 'parameter_conflict');

  // 12b. Conflicting disabled thinking with thinking.budget_tokens present
  const conflictDisabledBudgetTokens = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      ...base,
      thinking: { type: 'disabled', budget_tokens: 1024 },
    },
  });
  assert.equal(conflictDisabledBudgetTokens.status, 400);
  assert.equal(conflictDisabledBudgetTokens.json.error.code, 'parameter_conflict');
  assert.match(conflictDisabledBudgetTokens.json.error.message, /thinking\.budget_tokens was provided/);

  // 13. Conflicting max_tokens and max_completion_tokens
  const conflictMax = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      ...base,
      max_tokens: 100,
      max_completion_tokens: 200,
    },
  });
  assert.equal(conflictMax.status, 400);
  assert.equal(conflictMax.json.error.code, 'parameter_conflict');

  // 14. Unsupported model: qwen3:32b has no declared thinking_limit
  const unsupportedModel = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      model: 'qwen3:32b',
      messages: [{ role: 'user', content: 'hi' }],
      thinking_budget: 1024,
    },
  });
  assert.equal(unsupportedModel.status, 400);
  assert.equal(unsupportedModel.json.error.code, 'unsupported_parameter');
  assert.match(unsupportedModel.json.error.message, /does not declare reasoning support/);

  // Critical assertion: none of the invalid requests above touched the upstream stub!
  assert.equal(count(), beforeFailures, 'every invalid/over-limit/conflicting reasoning request must be rejected with ZERO upstream calls');
});

test('quota reservation reserves upper bound including thinking budget without double counting', async (t) => {
  // Harness configured with tokens_per_day: 10000.
  const h = await startHarness({
    configOverrides: { quota: { requests_per_day: 10, tokens_per_day: 10000 } },
  });
  t.after(() => h.stop());

  // Hold the upstream so we can inspect actual in-flight reservation counters
  // in the persistent ledger before the upstream settles.
  let releaseUpstream = null;
  h.stub.hold((proceed) => {
    releaseUpstream = proceed;
  });

  // 1. Submit in-flight request: max_tokens: 16, thinking_budget: 8192.
  // Upper bound is max(16, 8192) = 8192 (not 16).
  const inFlightPromise = call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'hold me upstream' }],
      max_tokens: 16,
      thinking_budget: 8192,
    },
  });

  // Wait until the first request actually reaches the stub and is held.
  while (h.stub.requests.length === 0) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // Verify the ledger holds exactly 8192 reserved tokens while in flight!
  const ledgerInFlight = JSON.parse(readFileSync(h.config.quota.ledgerPath, 'utf8'));
  const userCounters = Object.values(ledgerInFlight.users['user-a'])[0];
  assert.equal(userCounters.reserved_tokens, 8192, 'must reserve admitted thinking upper bound of 8192 tokens while in flight');

  // 2. Insufficient headroom rejection:
  // Total daily limit is 10000, 8192 is reserved, so remaining headroom is 10000 - 8192 = 1808.
  // A second request asking for thinking_budget: 4096 needs 4096 > 1808 remaining.
  // Under P1, the gateway must reject immediately with 429 quota_exceeded before touching upstream,
  // rather than clamping the reservation to 1808 and forwarding an unbacked 4096 budget.
  const requestsBefore = h.stub.requests.length;
  const rejected = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'insufficient headroom request' }],
      max_tokens: 16,
      thinking_budget: 4096,
    },
  });
  assert.equal(rejected.status, 429);
  assert.equal(rejected.json.error.code, 'quota_exceeded');
  assert.match(rejected.json.error.message, /daily token cap reached/);
  assert.equal(h.stub.requests.length, requestsBefore, 'insufficient headroom request must be rejected with ZERO upstream calls');

  // 3. Now release the first request and let it complete.
  releaseUpstream();
  const firstRes = await inFlightPromise;
  assert.equal(firstRes.status, 200);

  // 4. Verify that completion budget and thinking budget do NOT double count when max_tokens > thinking_budget:
  // max_tokens = 6000, thinking_budget = 4000 -> upper bound is max(6000, 4000) = 6000 (not 10000).
  const doubleCountHarness = await startHarness({
    configOverrides: { quota: { requests_per_day: 10, tokens_per_day: 7000 } },
  });
  t.after(() => doubleCountHarness.stop());

  // With tokens_per_day: 7000, if it double-counted (6000 + 4000 = 10000), 10000 > 7000 would cause 429.
  // Because it does not double count, max(6000, 4000) = 6000 <= 7000, so it succeeds cleanly.
  h.stub.unhold();
  const req2 = await call(doubleCountHarness.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'test no double count' }],
      max_tokens: 6000,
      thinking_budget: 4000,
    },
  });
  assert.equal(req2.status, 200);
});

test('a model outside the allowlist is refused before any upstream call', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  const res = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { model: 'openai/gpt-5-not-configured', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'model_not_allowed');
  assert.match(res.json.error.message, /not in this gateway's allowlist/);
  assert.ok(Array.isArray(res.json.error.detail.permitted));
  assert.equal(h.stub.requests.length, before, 'no upstream request may be made for a refused model');
});

test('local_only is refused by the gateway itself', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  const res = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: { ...ID, 'x-route': 'local_only' },
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'route me locally' }],
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'local_only_not_served');
  assert.match(res.json.error.message, /local plane/);
  assert.equal(h.stub.requests.length, before);
});

test('zdr_cloud refuses a non-ZDR model and never downgrades it', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  const a6 = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: { ...ID, 'x-route': 'zdr_cloud' },
    body: { model: 'a6api/deepseek-chat-v3.1', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(a6.status, 403);
  assert.equal(a6.json.error.code, 'route_policy_violation');
  assert.equal(a6.json.error.detail.upstream, 'a6api');
  assert.equal(a6.json.error.detail.upstream_class, 'proxy');
  assert.equal(a6.json.error.detail.zero_data_retention, false);
  assert.equal(a6.json.error.detail.training_opt_out, false);

  const direct = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: { ...ID, 'x-route': 'zdr_cloud' },
    body: { model: 'baseten/mammoth-1', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(direct.status, 403);
  assert.equal(direct.json.error.code, 'route_policy_violation');
  assert.equal(direct.json.error.detail.upstream_class, 'direct');

  assert.equal(h.stub.requests.length, before, 'a policy refusal must not reach an upstream');

  // The same A6API model is reachable when the caller explicitly accepts
  // training opt-out; the gateway forwards the caller's own key.
  const allowed = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: { ...ID, 'x-route': 'any_cloud', authorization: `Bearer ${BYOK_KEY}` },
    body: { model: 'a6api/deepseek-chat-v3.1', messages: [{ role: 'user', content: 'explicit consent' }] },
  });
  assert.equal(allowed.status, 200);
  const forwarded = h.stub.lastRequest((r) => r.path.startsWith('/a6api/'));
  assert.equal(forwarded.headers.authorization, `Bearer ${BYOK_KEY}`);
});

test('quota exhaustion returns 429 and counters survive a restart', async (t) => {
  const h = await startHarness({
    configOverrides: { quota: { requests_per_day: 3, tokens_per_day: 1000 } },
  });
  t.after(() => h.stop());

  const body = {
    model: 'deepseek/deepseek-v4.1-flash-1017',
    messages: [{ role: 'user', content: 'count me' }],
  };
  for (let i = 0; i < 3; i += 1) {
    const ok = await call(h.baseUrl, '/v1/chat/completions', { method: 'POST', headers: ID, body });
    assert.equal(ok.status, 200, `request ${i + 1} should be allowed`);
  }
  const blocked = await call(h.baseUrl, '/v1/chat/completions', { method: 'POST', headers: ID, body });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, 'quota_exceeded');
  assert.equal(blocked.json.error.detail.used.requests, 3);
  assert.equal(blocked.json.error.detail.limits.requests_per_day, 3);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal(blocked.json.error.detail.used.tokens, 36, 'three replies of 12 reported tokens');

  // A different identity still has its own budget.
  const other = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-user-id': 'user-b' },
    body,
  });
  assert.equal(other.status, 200);

  const before = JSON.parse(readFileSync(h.config.quota.ledgerPath, 'utf8'));
  assert.equal(Object.values(before.users['user-a'])[0].requests, 3);

  // Restart: a brand new gateway object over the same ledger file.
  await h.restart();

  const afterRestart = await call(h.baseUrl, '/v1/chat/completions', { method: 'POST', headers: ID, body });
  assert.equal(afterRestart.status, 429, 'the cap must still hold after a restart');
  assert.equal(afterRestart.json.error.detail.used.requests, 3);
  assert.equal(afterRestart.json.error.detail.used.tokens, 36);

  const userB = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-user-id': 'user-b' },
    body,
  });
  assert.equal(userB.status, 200, 'another identity keeps its own counters across the restart');
  const ledger = JSON.parse(readFileSync(h.config.quota.ledgerPath, 'utf8'));
  assert.equal(Object.values(ledger.users['user-b'])[0].requests, 2);
});

test('an uncapped gateway reports null caps and admits usage beyond the old 200k default', async (t) => {
  const h = await startHarness({
    configOverrides: { quota: { requests_per_day: null, tokens_per_day: null } },
  });
  t.after(() => h.stop());

  const health = await call(h.baseUrl, '/healthz');
  assert.equal(health.json.quota.requests_per_day, null);
  assert.equal(health.json.quota.tokens_per_day, null);

  // Seed persisted usage past the old defaults, then restart so the new process
  // reads those counters. A bounded ledger would refuse this request outright.
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(h.config.quota.ledgerPath, JSON.stringify({
    version: 1,
    users: {
      'user-a': {
        [day]: {
          requests: 200,
          tokens: 200001,
          unknown_usage: 0,
          reserved_requests: 0,
          reserved_tokens: 0,
          images: 0,
          video_submissions: 0,
          video_completions: 0,
        },
      },
    },
  }));
  await h.restart();

  const res = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'beyond the old daily total' }],
      max_tokens: 100000,
    },
  });
  assert.equal(res.status, 200, 'an uncapped ledger must not refuse at the old 200k boundary');

  const ledger = JSON.parse(readFileSync(h.config.quota.ledgerPath, 'utf8'));
  const counters = ledger.users['user-a'][day];
  assert.equal(counters.requests, 201);
  assert.equal(counters.tokens, 200013, 'the reported 12 tokens were counted on top of the seeded usage');
  assert.equal(counters.reserved_tokens, 0, 'the uncapped reservation was still released on settle');
});

test('usage the provider never reports is recorded as unknown, not zero', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'NO_USAGE please' }],
    },
  });
  assert.equal(res.status, 200);
  const ledger = JSON.parse(readFileSync(h.config.quota.ledgerPath, 'utf8'));
  const day = Object.values(ledger.users['user-a'])[0];
  assert.equal(day.unknown_usage, 1);
  assert.equal(day.tokens, 0);
});

test('provider errors are relayed faithfully, not masked', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'FAIL_500' }],
    },
  });
  assert.equal(res.status, 429, 'the provider status code is preserved');
  assert.equal(res.json.error.code, 'upstream_error');
  assert.equal(res.json.error.detail.upstream_status, 429);
  assert.equal(res.json.error.detail.upstream_code, 'stub_rate_limited');
  assert.match(res.json.error.message, /stub upstream is rate limiting you/);
});

test('malformed upstream responses are handled without crashing the gateway', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const nonStream = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { model: 'deepseek/deepseek-v4.1-flash-1017', messages: [{ role: 'user', content: 'MALFORMED' }] },
  });
  assert.equal(nonStream.status, 502);
  assert.equal(nonStream.json.error.code, 'upstream_bad_response');

  const streamed = await fetch(`${h.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ID },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'MALFORMED' }],
      stream: true,
    }),
  });
  assert.equal(streamed.status, 200);
  const text = await streamed.text();
  assert.match(text, /partial/, 'the usable part of the stream still reaches the client');

  // The gateway is still alive and serving after both failures.
  const alive = await call(h.baseUrl, '/healthz');
  assert.ok([200, 503].includes(alive.status));
});

test('/v1/models lists exactly the allowlist', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, '/v1/models');
  assert.equal(res.status, 200);
  const ids = res.json.data.map((m) => m.id);
  const expected = [...h.config.modelIndex.keys()].sort();
  assert.deepEqual(ids, expected);
  assert.ok(ids.includes('a6api/deepseek-chat-v3.1'));
  const a6 = res.json.data.find((m) => m.id === 'a6api/deepseek-chat-v3.1');
  assert.equal(a6.gateway.zero_data_retention, false);
  assert.equal(a6.gateway.upstream_class, 'proxy');
  assert.equal(res.json.data.find((m) => m.id === 'server/qwen3-coder-30b').gateway.upstream_class, 'server_local');
});

test('/healthz reports ok while every upstream answers', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, '/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.version, /^\d+\.\d+\.\d+$/);
  assert.equal(res.headers.get('x-gateway-version'), res.json.version);
  assert.equal(res.json.key_configured, true);
  assert.equal(res.json.upstreams.length, h.config.upstreams.length);
  assert.deepEqual(res.json.unreachable_upstreams, []);
  // Every key is reported as an env-var name and two booleans, never a value.
  assert.equal(res.json.keys.every((k) => typeof k.env === 'string' && typeof k.configured === 'boolean'), true);
  assert.equal(JSON.stringify(res.json).includes(STUB_KEY), false);
});

test('/healthz reports an unreachable upstream and still lists its models', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  await h.stub.close();
  h.gateway.healthProbe.invalidate();

  const health = await call(h.baseUrl, '/healthz');
  assert.equal(health.status, 503);
  assert.equal(health.json.ok, false);
  assert.equal(health.json.upstream_reachable, false);
  assert.equal(health.json.unreachable_upstreams.length, h.config.upstreams.length);
  assert.match(health.json.upstreams[0].error, /unreachable/i);

  const models = await call(h.baseUrl, '/v1/models');
  assert.equal(models.status, 200, 'the configured catalogue is still listed while upstreams are down');
  assert.equal(models.json.data.length, h.config.modelIndex.size);

  const refused = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { model: 'deepseek/deepseek-v4.1-flash-1017', messages: [{ role: 'user', content: 'anyone there' }] },
  });
  assert.equal(refused.status, 502);
  assert.equal(refused.json.error.code, 'upstream_unreachable');
});

test('the configured key never appears in a log line or an error body', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const ok = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { model: 'deepseek/deepseek-v4.1-flash-1017', messages: [{ role: 'user', content: 'normal call' }] },
  });
  assert.equal(ok.status, 200);
  const failed = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { model: 'deepseek/deepseek-v4.1-flash-1017', messages: [{ role: 'user', content: 'FAIL_500' }] },
  });
  assert.equal(failed.status, 429);
  await call(h.baseUrl, '/healthz');

  const log = readLog(h.logPath);
  assert.ok(log.length > 0, 'the gateway must have written a log');
  assert.equal(log.includes(STUB_KEY), false, 'the provider key must not appear in the log');
  assert.equal(log.includes('baseten-provider-key-fedcba9876543210'), false);
  assert.equal(ok.text.includes(STUB_KEY), false);
  assert.equal(failed.text.includes(STUB_KEY), false);
  assert.match(log, /"event":"chat_completed"/);
});

test('pass-through auth refuses a missing client key without spending quota', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: { ...ID, 'x-route': 'any_cloud' },
    body: { model: 'a6api/deepseek-chat-v3.1', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'client_key_required');
  const ledger = JSON.parse(readFileSync(h.config.quota.ledgerPath, 'utf8'));
  assert.equal(ledger.users['user-a']?.[Object.keys(ledger.users['user-a'] || {})[0]]?.requests ?? 0, 0);
});

test('a route header and body that disagree are refused', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: { ...ID, 'x-route': 'zdr_cloud' },
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      route: 'any_cloud',
      messages: [{ role: 'user', content: 'hi' }],
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'route_conflict');
});

test('prompt bodies are not logged unless the config switch turns it on', async (t) => {
  const quiet = await startHarness();
  t.after(() => quiet.stop());
  await call(quiet.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'SECRET-PROMPT-TEXT-must-not-be-logged' }],
    },
  });
  const quietLog = readLog(quiet.logPath);
  assert.equal(quietLog.includes('SECRET-PROMPT-TEXT'), false, 'prompt content must be off by default');
  assert.match(quietLog, /"message_count":1/);

  const loud = await startHarness({ configOverrides: { logRequestBodies: true } });
  t.after(() => loud.stop());
  assert.equal(loud.config.logging.logRequestBodies, true);
  await call(loud.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: {
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'dev-mode-body' }],
    },
  });
  const loudLog = readLog(loud.logPath);
  assert.match(loudLog, /request_body_development/);
  assert.equal(loudLog.includes('dev-mode-body'), true, 'the switch really does log bodies when enabled');
  // Even with body logging on, the provider key stays out of the log.
  assert.equal(loudLog.includes(STUB_KEY), false);
});

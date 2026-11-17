// The route/consent contract the app bridge relies on. The bridge resolves a
// conversation's route and refuses to open a socket for a cloud route without
// explicit consent; the gateway only ever sees the resulting `x-route` value.
// These tests pin the gateway half: absent header unchanged, an unreadable value
// refused by name rather than defaulted, local_only still refused with the
// existing code, and a cloud route served only by a model whose catalogue entry
// actually satisfies it. Consent itself is unattested here and no test claims
// otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BYOK_KEY, call, startHarness } from './helpers.mjs';

const ID = { 'x-user-id': 'user-a' };
const CHAT = '/v1/chat/completions';

function chatBody(model, content = 'hello') {
  return { model, messages: [{ role: 'user', content }] };
}

test('an absent x-route still behaves exactly as before: the configured default applies', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  assert.equal(h.config.route.default, 'zdr_cloud');

  const before = h.stub.requests.length;
  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: chatBody('deepseek/deepseek-v4.1-flash-1017', 'no route header'),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.choices[0].message.content, 'stub reply to: no route header');
  assert.equal(h.stub.requests.length, before + 1);
  // The default is a real decision, not a free pass: it is the ZDR route, and
  // the request reaches an upstream that declares ZDR.
  assert.equal(res.headers.get('x-gateway-upstream'), 'openrouter');
});

test('an unknown x-route value is refused with 400 and the offending value named', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'local_and_cloud' },
    body: chatBody('deepseek/deepseek-v4.1-flash-1017'),
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'invalid_route');
  assert.match(res.json.error.message, /local_and_cloud/, 'the message must name the value that was refused');
  assert.equal(res.json.error.detail.route, 'local_and_cloud');
  assert.equal(res.json.error.detail.source, 'header');
  assert.deepEqual(res.json.error.detail.accepted, ['local_only', 'zdr_cloud', 'any_cloud']);
  assert.equal(res.json.error.detail.consent, 'unattested');
  assert.equal(h.stub.requests.length, before, 'an unreadable route must not reach an upstream');

  // The refusal is not a quiet fallback: the ledger shows no request was spent.
  const ledger = JSON.parse(readFileSync(h.config.quota.ledgerPath, 'utf8'));
  const day = Object.values(ledger.users?.['user-a'] ?? {})[0];
  assert.equal(day?.requests ?? 0, 0);
});

test('an unknown route field in the body is refused with the same 400', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: { ...chatBody('deepseek/deepseek-v4.1-flash-1017'), route: 'eu_only' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'invalid_route');
  assert.match(res.json.error.message, /eu_only/);
  assert.equal(res.json.error.detail.source, 'body');
  assert.equal(h.stub.requests.length, before);
});

test('a route that was supplied but is empty or blank is refused, never read as absent', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  // A whitespace-only header. Node's HTTP layer trims an invalid header value,
  // so what arrives is the empty string — still a value the caller sent, and
  // therefore still not "no route".
  const blankHeader = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': '   ' },
    body: chatBody('deepseek/deepseek-v4.1-flash-1017'),
  });
  assert.equal(blankHeader.status, 400);
  assert.equal(blankHeader.json.error.code, 'invalid_route');
  assert.equal(blankHeader.json.error.detail.source, 'header');
  assert.equal(blankHeader.json.error.detail.route, '');
  assert.match(blankHeader.json.error.message, /route header value/);

  // An explicit empty string in the body.
  const emptyBody = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: { ...chatBody('deepseek/deepseek-v4.1-flash-1017'), route: '' },
  });
  assert.equal(emptyBody.status, 400);
  assert.equal(emptyBody.json.error.code, 'invalid_route');
  assert.equal(emptyBody.json.error.detail.source, 'body');
  assert.equal(emptyBody.json.error.detail.route, '');

  // The same value with surrounding whitespace in the body is not a route either.
  const blankBody = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: { ...chatBody('deepseek/deepseek-v4.1-flash-1017'), route: '   ' },
  });
  assert.equal(blankBody.status, 400);
  assert.equal(blankBody.json.error.code, 'invalid_route');
  assert.equal(blankBody.json.error.detail.source, 'body');

  assert.equal(h.stub.requests.length, before, 'no blank route reached an upstream');

  // Tightening "present" must not reject a value that was only padded: a valid
  // route with surrounding whitespace is still that route, as it always was.
  const padded = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': '  zdr_cloud  ' },
    body: chatBody('deepseek/deepseek-v4.1-flash-1017', 'padded route'),
  });
  assert.equal(padded.status, 200);
  assert.equal(h.stub.requests.length, before + 1);
});

test('a non-string route in the body is refused and its type is named, not coerced or ignored', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  const cases = [
    { route: false, shown: 'false', type: 'boolean' },
    { route: [], shown: '[]', type: 'array' },
    { route: 0, shown: '0', type: 'number' },
    { route: null, shown: 'null', type: 'null' },
  ];
  for (const item of cases) {
    const res = await call(h.baseUrl, CHAT, {
      method: 'POST',
      headers: ID,
      body: { ...chatBody('deepseek/deepseek-v4.1-flash-1017'), route: item.route },
    });
    assert.equal(res.status, 400, `route ${JSON.stringify(item.route)} must be refused`);
    assert.equal(res.json.error.code, 'invalid_route');
    assert.equal(res.json.error.detail.source, 'body');
    assert.equal(res.json.error.detail.route, item.shown);
    assert.match(res.json.error.message, new RegExp(`\\(${item.type}\\)`), 'the offending type must be named');
  }

  assert.equal(h.stub.requests.length, before, 'no invalid route reached an upstream');
  const ledger = JSON.parse(readFileSync(h.config.quota.ledgerPath, 'utf8'));
  const day = Object.values(ledger.users?.['user-a'] ?? {})[0];
  assert.equal(day?.requests ?? 0, 0, 'a refused route costs no quota');
});

test('an absent route really is the configured default: it refuses when the default does', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  assert.equal(h.config.route.default, 'zdr_cloud');
  const before = h.stub.requests.length;

  // The default is zdr_cloud and this model is not ZDR, so an honest default
  // enforcement refuses it. A gateway that skipped the default (or fell back to
  // any_cloud) would answer 200 here.
  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: chatBody('baseten/mammoth-1', 'no route, non-ZDR model'),
  });
  assert.equal(res.status, 403);
  assert.equal(res.json.error.code, 'route_policy_violation');
  assert.equal(res.json.error.detail.route, 'zdr_cloud');
  assert.equal(res.json.error.detail.model, 'baseten/mammoth-1');
  assert.equal(h.stub.requests.length, before);

  // The same absent-route request under an any_cloud default is served: the
  // default is read from config, not assumed.
  const open = await startHarness({ configOverrides: { route: { default: 'any_cloud' } } });
  t.after(() => open.stop());
  assert.equal(open.config.route.default, 'any_cloud');
  const served = await call(open.baseUrl, CHAT, {
    method: 'POST',
    headers: ID,
    body: chatBody('baseten/mammoth-1', 'no route, any_cloud default'),
  });
  assert.equal(served.status, 200);
  assert.equal(open.stub.requests.length, 1);
});


test('local_only is still refused with the existing local_only_not_served status and code', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'local_only' },
    body: chatBody('deepseek/deepseek-v4.1-flash-1017'),
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'local_only_not_served');
  assert.equal(res.json.error.param, 'route');
  assert.equal(h.stub.requests.length, before);
});

test('zdr_cloud is served only by a model that declares zero-data-retention and training opt-out', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  // A model with both flags declared is served.
  const zdr = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'zdr_cloud' },
    body: chatBody('deepseek/deepseek-v4.1-flash-1017', 'zdr ok'),
  });
  assert.equal(zdr.status, 200);
  assert.equal(h.stub.requests.length, before + 1);

  // zero_data_retention: false, training_opt_out: true — refused, never relabelled.
  const optOutOnly = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'zdr_cloud' },
    body: chatBody('baseten/mammoth-1'),
  });
  assert.equal(optOutOnly.status, 403);
  assert.equal(optOutOnly.json.error.code, 'route_policy_violation');
  assert.equal(optOutOnly.json.error.detail.route, 'zdr_cloud');
  assert.equal(optOutOnly.json.error.detail.model, 'baseten/mammoth-1');
  assert.equal(optOutOnly.json.error.detail.zero_data_retention, false);
  assert.equal(optOutOnly.json.error.detail.training_opt_out, true);

  // zero_data_retention: true, training_opt_out: false — both flags are required
  // independently, so no-retention alone is not enough to reach zdr_cloud.
  const zdrNoOptOut = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'zdr_cloud' },
    body: chatBody('baseten/zdr-no-training-optout'),
  });
  assert.equal(zdrNoOptOut.status, 403);
  assert.equal(zdrNoOptOut.json.error.code, 'route_policy_violation');
  assert.equal(zdrNoOptOut.json.error.detail.model, 'baseten/zdr-no-training-optout');
  assert.equal(zdrNoOptOut.json.error.detail.zero_data_retention, true);
  assert.equal(zdrNoOptOut.json.error.detail.training_opt_out, false);
  assert.match(zdrNoOptOut.json.error.message, /training_opt_out=false/);

  // Neither flag set: refused as well.
  const neither = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'zdr_cloud' },
    body: chatBody('a6api/deepseek-chat-v3.1'),
  });
  assert.equal(neither.status, 403);
  assert.equal(neither.json.error.code, 'route_policy_violation');
  assert.equal(neither.json.error.detail.zero_data_retention, false);

  assert.equal(h.stub.requests.length, before + 1, 'no refused zdr_cloud request reached an upstream');
});

test('zdr_cloud refuses a caller-supplied provider block instead of certifying it', async (t) => {
  // `provider` is the upstream's own routing/retention control. Forwarding it on
  // zdr_cloud let the body contradict the route: the gateway reported a
  // zero-retention model while the provider was told `data_collection: allow`.
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  const res = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'zdr_cloud' },
    body: {
      ...chatBody('deepseek/deepseek-v4.1-flash-1017'),
      provider: { data_collection: 'allow', allow_fallbacks: true },
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'parameter_conflict');
  assert.equal(res.json.error.param, 'provider');
  assert.match(res.json.error.message, /zdr_cloud/);
  assert.equal(h.stub.requests.length, before, 'a refused provider block must not reach an upstream');

  // any_cloud makes no retention claim, so the caller's own provider controls
  // stay theirs: the field is still forwarded there.
  const anyCloud = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'any_cloud', authorization: `Bearer ${BYOK_KEY}` },
    body: { ...chatBody('a6api/deepseek-chat-v3.1'), provider: { sort: 'throughput' } },
  });
  assert.equal(anyCloud.status, 200);
  assert.deepEqual(h.stub.lastRequest((r) => r.path.startsWith('/a6api/')).body.provider, { sort: 'throughput' });
});

test('any_cloud serves any allowlisted model and still refuses a model outside the allowlist', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  // A non-ZDR allowlisted model is reachable on any_cloud (its own provider key).
  const a6 = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'any_cloud', authorization: `Bearer ${BYOK_KEY}` },
    body: chatBody('a6api/deepseek-chat-v3.1', 'any cloud ok'),
  });
  assert.equal(a6.status, 200);
  assert.equal(h.stub.lastRequest((r) => r.path.startsWith('/a6api/')).headers.authorization, `Bearer ${BYOK_KEY}`);

  // A ZDR allowlisted model is equally reachable on any_cloud.
  const zdrModel = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'any_cloud' },
    body: chatBody('server/qwen3-coder-30b', 'any cloud local model'),
  });
  assert.equal(zdrModel.status, 200);
  assert.equal(h.stub.requests.length, before + 2);

  // The route never widens the allowlist: the same any_cloud route refuses a
  // model the catalogue does not carry.
  const notListed = await call(h.baseUrl, CHAT, {
    method: 'POST',
    headers: { ...ID, 'x-route': 'any_cloud' },
    body: chatBody('some-vendor/unlisted-model'),
  });
  assert.equal(notListed.status, 404);
  assert.equal(notListed.json.error.code, 'model_not_allowed');
  assert.equal(h.stub.requests.length, before + 2);
});

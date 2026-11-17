// The pre-send gate masks a request and records `privacy.masked` on the gateway
// event stream, but the page draws its per-turn privacy line from a websocket
// frame (protocol.js `privacyRecord` -> `privacyLine` -> `app.js . privacy-line`).
// Nothing used to relay those records, so masking happened invisibly. These tests
// drive the real bridge, the real gate and the real render contract: one line for a
// masked request, none for a clean one, and a "not sent" line for a blocked one —
// with the original value in neither the frame nor the rendered line.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, sanitizeDiagnostics } from '../server.mjs';
import { sanitizeText } from '../privacy/index.mjs';
import { applyFrame, command, createViewModel, privacyLine, promptCommand, transcriptEntries } from '../public/protocol.js';
import { events, resetEvents } from '../../gateway/lib/events.mjs';

const PHONE = '010-1234-5678';
const SECRET = 'sk-proj-abcdefghijklmnopqrstuvwx';

// One OpenAI-compatible stub: it records every body it is handed, so a test can
// assert on the bytes the gate actually sent, not on what the gate reported.
// `holds` keeps matching requests in flight long enough for a test to place another
// call inside the same request window: `{ match, ms }` delays the stub reply for any
// body containing `match`. The gate has already recorded its decision before the
// request is dispatched, so this reproduces the overlap a real concurrent send has.
async function startStub({ holds = [] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      requests.push({ path: req.url, body, raw });
      const reply = () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'stub-completion',
          object: 'chat.completion',
          model: body?.model ?? 'stub-7b',
          choices: [{ index: 0, message: { role: 'assistant', content: '스텁 응답입니다.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        }));
      };
      const hold = holds.find(entry => raw.includes(entry.match));
      if (hold) setTimeout(reply, hold.ms); else reply();
    });
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() { server.closeAllConnections?.(); await new Promise(ok => server.close(ok)); },
  };
}

async function startBridge(t, stubOptions = {}) {
  const stub = await startStub(stubOptions);
  const stateDir = await mkdtemp(join(tmpdir(), 'privacy-line-'));
  const app = await createBridge({
    mock: true,
    config: {
      coreArgs: [],
      stateDir,
      inference: {
        quota: { ledger_path: join(stateDir, 'quota.json'), requests_per_day: 100, tokens_per_day: 1000000 },
        logging: { level: 'warn', file: null, log_request_bodies: false },
        upstreams: [{
          id: 'fixture', class: 'server_local', kind: 'openai', base_url: `${stub.url}/v1`, auth_mode: 'none',
          models: [{ id: 'stub-7b', capabilities: ['chat'], zero_data_retention: true, training_opt_out: true, context_window: 32768, thinking_limit: 8192 }],
        }],
      },
      local: { label: '테스트 스텁', provider: 'harness-local', model: 'auto' },
    },
  });
  t.after(async () => { await app.close(); await stub.close(); await rm(stateDir, { recursive: true, force: true }); });
  const url = await app.start(0);
  return { app, url, stub };
}

function attach(url) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  const frames = [], waiters = [];
  socket.addEventListener('message', event => { const frame = JSON.parse(event.data); frames.push(frame); for (const wake of [...waiters]) wake(); });
  const until = predicate => {
    const found = frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise(resolve => {
      const wake = () => { const frame = frames.find(predicate); if (frame) { waiters.splice(waiters.indexOf(wake), 1); resolve(frame); } };
      waiters.push(wake);
    });
  };
  return { socket, frames, until };
}

// The bridge publishes the decision on the first byte of the request's own response,
// so it is in the transcript before the answer it describes. This probe command is
// how a test drains the socket and proves no second line follows either.
async function nextCoreFrame(client, sessionId) {
  const probe = command('get_state');
  client.socket.send(JSON.stringify(probe));
  await client.until(frame => frame.type === 'response' && frame.command === 'get_state' && frame.id === probe.id);
  return sessionId;
}

async function chat(bridgeUrl, session, content) {
  return chatBody(bridgeUrl, session, { messages: [{ role: 'user', content }] });
}

async function chatBody(bridgeUrl, session, body) {
  const response = await fetch(`${bridgeUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'local-user', 'x-route': 'local_only', 'x-app-session': session.token },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function connected(t, stubOptions = {}) {
  const bridge = await startBridge(t, stubOptions);
  const client = attach(bridge.url);
  const hello = await client.until(frame => frame.type === 'bridge_connected');
  await client.until(frame => frame.type === 'bridge_ready');
  return { ...bridge, client, session: bridge.app.sessions.get(hello.sessionId) };
}

test('a masked request produces exactly one privacy line with the masked categories and no original value', { timeout: 30000 }, async t => {
  const { url, stub, client, session } = await connected(t);
  const sent = await chat(url, session, `${PHONE}로 연락해 주세요`);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.choices[0].message.content, '스텁 응답입니다.');
  assert.doesNotMatch(stub.requests[0].raw, /010-1234-5678/, 'the gate must mask the wire payload before the request is sent');

  await nextCoreFrame(client, session.id);
  const masked = client.frames.filter(frame => frame.type === 'privacy.masked');
  assert.equal(masked.length, 1, 'one masked send, one line');
  assert.deepEqual(masked[0].data.rules, ['phone_number']);
  assert.deepEqual(masked[0].data.counts, { phone_number: 1 });
  assert.deepEqual(masked[0].data.fields, ['messages[0].content']);
  assert.equal(JSON.stringify(masked[0]).includes('010-1234-5678'), false, 'the privacy frame may not carry the original value');

  const vm = createViewModel();
  for (const frame of client.frames) applyFrame(vm, frame);
  const lines = transcriptEntries(vm).filter(entry => entry.privacy);
  assert.equal(lines.length, 1, 'the transcript renders exactly one privacy line');
  assert.equal(privacyLine(lines[0].privacy).text, '개인정보 보호 · 전화번호 1건 · 가명화 · 요청 전송됨');
  assert.equal(lines[0].privacy.action, 'masked');
  assert.equal(lines[0].privacy.sent, true);
  assert.equal(JSON.stringify(vm.privacy).includes('010-1234-5678'), false);

  // The same decision is not repeated on every later frame of the session.
  await nextCoreFrame(client, session.id);
  assert.equal(client.frames.filter(frame => frame.type === 'privacy.masked').length, 1, 'a decision is relayed once, not per frame');
});

test('an unmasked request produces no privacy line and the user keeps their own bubble', { timeout: 30000 }, async t => {
  const { url, client, session } = await connected(t);
  const sent = await chat(url, session, '코드를 정리해 주세요');
  assert.equal(sent.status, 200);
  await nextCoreFrame(client, session.id);
  assert.equal(client.frames.some(frame => frame.type === 'privacy.masked' || frame.type === 'privacy.blocked'), false, 'nothing was masked, so no line appears');

  const prompt = promptCommand(`${PHONE}로 연락해 주세요`);
  client.socket.send(JSON.stringify(prompt));
  await client.until(frame => frame.type === 'prompt_result' && frame.id === prompt.id);
  const vm = createViewModel();
  for (const frame of client.frames) applyFrame(vm, frame);
  assert.match(vm.messages.find(message => message.role === 'user').text, /010-1234-5678/, 'the user typed it, so their own bubble keeps it');
  assert.equal(transcriptEntries(vm).some(entry => entry.privacy), false);
});

test('a blocked request reports that nothing was sent', { timeout: 30000 }, async t => {
  const { url, stub, client, session } = await connected(t);
  const before = stub.requests.length;
  const blocked = await chat(url, session, `키 ${SECRET} 로 호출해 주세요`);
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error.code, 'privacy_guard_blocked');
  assert.equal(stub.requests.length, before, 'a blocked request never reaches the upstream');

  await nextCoreFrame(client, session.id);
  const frames = client.frames.filter(frame => frame.type === 'privacy.blocked');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].data.rules, ['provider_key']);
  assert.equal(frames[0].data.code, 'privacy_guard_blocked');
  assert.equal(JSON.stringify(frames[0]).includes(SECRET), false, 'the refusal frame may not echo the secret');

  const vm = createViewModel();
  for (const frame of client.frames) applyFrame(vm, frame);
  const line = transcriptEntries(vm).find(entry => entry.privacy);
  assert.equal(privacyLine(line.privacy).text, '개인정보 보호 · API 키 1건 · 차단 · 요청 보내지 않음');
  assert.equal(line.privacy.sent, false);
  assert.equal(client.frames.some(frame => frame.type === 'privacy.masked'), false, 'a blocked request never claims it was sent');
});

test('a scan that is not a transmission never claims the request was sent', { timeout: 30000 }, async t => {
  const { url, client, session } = await connected(t);
  // Same conversation id, same gate, same record type — but no request left the app.
  const scan = await fetch(`${url}/api/privacy/scan?session=${session.id}&text=${encodeURIComponent(`${PHONE}로 연락`)}`);
  assert.equal(scan.status, 200);
  assert.equal((await scan.json()).decision.action, 'sent');
  const inquiry = await (await fetch(`${url}/api/privacy/findings?session=${session.id}`)).json();
  assert.equal(inquiry.records['privacy.masked'], 1, 'the gate did record the finding');

  await nextCoreFrame(client, session.id);
  assert.equal(client.frames.some(frame => frame.type === 'privacy.masked'), false, 'a scan is not a sent request, so no privacy line');

  // The trap is the next request: a clean one must not inherit the earlier scan's
  // record and advertise a mask it never performed.
  const sent = await chat(url, session, '코드를 정리해 주세요');
  assert.equal(sent.status, 200);
  await nextCoreFrame(client, session.id);
  assert.equal(client.frames.some(frame => frame.type === 'privacy.masked'), false, 'a clean request never claims the scan findings as its own');
  const vm = createViewModel();
  for (const frame of client.frames) applyFrame(vm, frame);
  assert.equal(transcriptEntries(vm).some(entry => entry.privacy), false);
});

// A field path is published — on the frame and on the gateway record — so no part of
// it may be user text. A tool-argument key is as much user data as a value is, and a
// phone number is a legal JSON key, so the raw key put the original value straight
// back into the payload the gate promises never carries it.
test('a tool-argument KEY carrying the value never reaches the frame or the event record', { timeout: 30000 }, async t => {
  resetEvents();
  const { url, stub, client, session } = await connected(t);
  const sent = await chatBody(url, session, {
    messages: [
      { role: 'user', content: '도구로 조회해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ [PHONE]: { note: '연락처 010-9999-8888' } }) } }] },
    ],
  });
  assert.equal(sent.status, 422, 'a value the walker cannot reach is refused, not sent');
  assert.equal(stub.requests.length, 0, 'nothing reached the upstream');

  await nextCoreFrame(client, session.id);
  const frame = client.frames.find(entry => entry.type === 'privacy.blocked');
  assert.ok(frame, 'the refusal is relayed like any other decision');

  const record = events().filter(entry => entry.type === 'privacy.blocked' && entry.session === session.id).pop();
  assert.ok(record, 'the gateway recorded the decision');

  // The serialized payloads themselves must carry no digit sequence of the key.
  for (const [label, payload] of [['frame', JSON.stringify(frame)], ['event record', JSON.stringify(record)]]) {
    assert.equal(payload.includes(PHONE), false, `the ${label} still carries the original key`);
    assert.doesNotMatch(payload, /010-?1234-?5678/, `the ${label} still carries a form of the original key`);
    assert.doesNotMatch(payload, /9999-?8888/, `the ${label} still carries the value found under that key`);
  }
  assert.deepEqual(frame.data.fields, ['messages[1].tool_calls[0].function.arguments.*.note'], 'the key segment is a placeholder, not the key');
  assert.deepEqual(record.data.fields, frame.data.fields, 'the record and the frame report the same sanitized paths');
});

test('a non-identifier key keeps the path locatable without quoting the key', { timeout: 30000 }, async t => {
  const { url, client, session } = await connected(t);
  const sent = await chatBody(url, session, {
    messages: [
      { role: 'user', content: '도구로 저장해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ '담당자 연락처': PHONE, memo: 'clean' }) } }] },
    ],
  });
  assert.equal(sent.status, 200);
  await nextCoreFrame(client, session.id);
  const frames = client.frames.filter(frame => frame.type === 'privacy.masked');
  assert.equal(frames.length, 1, 'a masked send makes one line');
  assert.deepEqual(frames[0].data.fields, ['messages[1].tool_calls[0].function.arguments.*']);
  assert.deepEqual(frames[0].data.rules, ['phone_number']);
  assert.equal(JSON.stringify(frames[0]).includes(PHONE), false);
});

// A timestamp watermark cannot say *which* request a record belongs to: every
// `privacy.*` record appended for the session during the window was claimed by the
// request being answered, and a scan's session id is caller-supplied, so a local
// client could mint a line on any conversation.
test('a clean chat running beside a scan relays no privacy frame', { timeout: 30000 }, async t => {
  resetEvents();
  // The stub holds the clean request open, so the scan lands inside its window.
  const { url, client, session } = await connected(t, { holds: [{ match: '코드를 정리', ms: 400 }] });
  const sending = chat(url, session, '코드를 정리해 주세요');
  await new Promise(ok => setTimeout(ok, 120));

  const scan = await fetch(`${url}/api/privacy/scan?session=${session.id}&text=${encodeURIComponent(`${PHONE}로 연락`)}`);
  assert.equal(scan.status, 200);
  const scanned = await scan.json();
  assert.equal(scanned.decision.action, 'sent');
  assert.deepEqual(scanned.scanned.rules, ['phone_number'], 'the caller still gets its own findings');

  const sent = await sending;
  assert.equal(sent.status, 200, 'the clean request is answered');
  await nextCoreFrame(client, session.id);

  assert.equal(client.frames.some(frame => frame.type === 'privacy.masked' || frame.type === 'privacy.blocked'), false,
    'a clean send never claims a concurrent scan as its own masked transmission');
  const inquiry = await (await fetch(`${url}/api/privacy/findings?session=${session.id}`)).json();
  assert.equal(inquiry.records['privacy.masked'], 1, 'the scan did record its own finding');
});

test('two concurrent chat requests each relay their own decision', { timeout: 30000 }, async t => {
  resetEvents();
  const { url, client, session } = await connected(t, {
    holds: [{ match: '연락 주세요', ms: 250 }, { match: '보내 주세요', ms: 900 }],
  });
  const first = chat(url, session, `${PHONE}로 연락 주세요`);
  await new Promise(ok => setTimeout(ok, 120));
  const second = chat(url, session, '메일 dev@example.co.kr 로 보내 주세요');

  const a = await first;
  assert.equal(a.status, 200);
  await new Promise(ok => setTimeout(ok, 200));
  // The slower request is still in flight, so only the finished one may have spoken.
  const early = client.frames.filter(frame => frame.type === 'privacy.masked');
  assert.equal(early.length, 1, 'the finished request relays its own line only, not the one still in flight');
  assert.deepEqual(early[0].data.rules, ['phone_number']);

  const b = await second;
  assert.equal(b.status, 200);
  await new Promise(ok => setTimeout(ok, 200));
  await nextCoreFrame(client, session.id);
  const frames = client.frames.filter(frame => frame.type === 'privacy.masked');
  assert.equal(frames.length, 2, 'two masked sends, two lines — neither request steals the other’s');
  assert.deepEqual(frames.map(frame => frame.data.rules.join(',')), ['phone_number', 'email_address'],
    'each line names the categories of its own request');
  for (const frame of frames) assert.deepEqual(frame.data.fields, ['messages[0].content']);
});

// The published path is sanitized, which strips a non-identifier key to `*` — but a
// Korean key is also the only place a value's context lives ("계좌번호": an account
// number, "학번": a student id). Detection must read the raw key while publication
// must not, or the sanitizer silently stops masking the values it describes.
test('a Korean context key still masks its value while staying out of every published structure', { timeout: 30000 }, async t => {
  const cases = [
    { key: '계좌번호', value: '110-123-456789', rule: 'account_digit_run' },
    { key: '학번', value: '20231234', rule: 'account_digit_run' },
    { key: '주소', value: '경기도 성남시 분당구 판교로 256번길 12', rule: 'korean_address' },
    { key: '배송지', value: '서울시 강남구 테헤란로 123', rule: 'korean_address' },
  ];
  for (const { key, value, rule } of cases) {
    resetEvents();
    const { url, stub, client, session } = await connected(t);
    const before = stub.requests.length;
    const sent = await chatBody(url, session, {
      messages: [
        { role: 'user', content: '도구로 저장해 주세요' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ [key]: value }) } }] },
      ],
    });
    assert.equal(sent.status, 200, `${key}: the masked request is sent, not refused`);

    // What actually left the app carries a pseudonym, never the value or the key.
    const upstream = stub.requests[before];
    assert.ok(upstream, `${key}: the request reached the upstream`);
    assert.equal(upstream.raw.includes(value), false, `${key}: the value never reaches the upstream`);
    assert.match(upstream.raw, /\[[A-Z]+_\d+\]/, `${key}: the value was replaced by a pseudonym`);
    if (rule === 'korean_address') {
      // One placeholder for the whole road address: the road number, the `번길 N`
      // branch and the building number all belong to the same address, and any of
      // them left behind is a fragment of the original value still on the wire.
      const sentArguments = JSON.parse(upstream.body.messages[1].tool_calls[0].function.arguments);
      assert.match(sentArguments[key], /^\[ADDRESS_\d+\]$/, `${key}: the whole address is one placeholder, got ${sentArguments[key]}`);
      assert.doesNotMatch(upstream.raw, /번길/, `${key}: no branch fragment survives the mask`);
    }

    await nextCoreFrame(client, session.id);
    const frames = client.frames.filter(frame => frame.type === 'privacy.masked');
    assert.equal(frames.length, 1, `${key}: one masked send, one line`);
    assert.ok(frames[0].data.rules.includes(rule), `${key}: the line names ${rule}, not ${JSON.stringify(frames[0].data.rules)}`);
    assert.deepEqual(frames[0].data.fields, ['messages[1].tool_calls[0].function.arguments.*'], `${key}: the published path keeps the placeholder`);

    const record = events().filter(entry => entry.type === 'privacy.masked' && entry.session === session.id).pop();
    assert.ok(record, `${key}: the gateway recorded the decision`);
    for (const [label, payload] of [['frame', JSON.stringify(frames[0])], ['event record', JSON.stringify(record)]]) {
      assert.equal(payload.includes(value), false, `${key}: the ${label} still carries the value`);
      assert.equal(payload.includes(key), false, `${key}: the ${label} still carries the raw key`);
    }
  }
});

// The detection hint carries the raw key so a Korean key can supply context. A key
// is caller text, so it may only ADD context — never switch a rule off. The `.env`
// sample-file exemption used to read that hint, so a request whose key was
// `example.env` sent two live passwords upstream with no privacy record while the
// same body under `payload` was refused.
test('a sample-file word in the key cannot switch the .env rule off', { timeout: 60000 }, async t => {
  const ENV_BODY = 'MYSQL_ROOT=rootpass1234\nREDIS_AUTH=redispass5678';
  const keys = ['payload', 'notes', 'example.env', 'report.template', 'bundle.dist', 'data.sample'];
  for (const key of keys) {
    resetEvents();
    const { url, stub, client, session } = await connected(t);
    const before = stub.requests.length;
    const sent = await chatBody(url, session, {
      messages: [
        { role: 'user', content: '설정 파일을 정리해 주세요' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ [key]: ENV_BODY }) } }] },
      ],
    });
    assert.equal(sent.status, 422, `${key}: an .env body is refused exactly as under a neutral key`);
    assert.equal(sent.body.error.code, 'privacy_guard_blocked', `${key}: the refusal names the guard`);
    assert.equal(stub.requests.length, before, `${key}: a refused body never reaches the upstream`);
    for (const request of stub.requests) {
      assert.equal(request.raw.includes('rootpass1234'), false, `${key}: no password left the app`);
      assert.equal(request.raw.includes('redispass5678'), false, `${key}: no password left the app`);
    }

    await nextCoreFrame(client, session.id);
    const frame = client.frames.find(entry => entry.type === 'privacy.blocked');
    assert.ok(frame, `${key}: the refusal is relayed like any other decision`);
    assert.deepEqual(frame.data.rules, ['env_file_body'], `${key}: the .env rule fired, not ${JSON.stringify(frame.data.rules)}`);
    const relayed = JSON.stringify(frame);
    assert.equal(relayed.includes('rootpass1234'), false, `${key}: the refusal may not echo a password`);
    assert.equal(relayed.includes('redispass5678'), false, `${key}: the refusal may not echo a password`);
  }
});

// A placeholder line must not be able to talk the gate out of a body that also
// holds a live password. This is the regression the unit tests cannot see: the
// request leaves the app, and only the stub knows what bytes reached the upstream.
test('a placeholder line beside a real secret is still a refused .env body', { timeout: 60000 }, async t => {
  const BODIES = [
    'MYSQL_ROOT=rootpass1234\nREDIS_AUTH=your_redis_password',
    'DB_PASS=Sup3rS3cretP@ssw0rd\nREDIS_AUTH=your_redis_password',
    'MYSQL_ROOT=rootpass1234\nREDIS_AUTH=your_redis_password\nAPP_ENV=production',
  ];
  for (const body of BODIES) {
    resetEvents();
    const { url, stub, client, session } = await connected(t);
    const before = stub.requests.length;
    const sent = await chatBody(url, session, {
      messages: [
        { role: 'user', content: '설정 파일을 정리해 주세요' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: body }) } }] },
      ],
    });
    assert.equal(sent.status, 422, `${JSON.stringify(body)}: the body is refused`);
    assert.equal(sent.body.error.code, 'privacy_guard_blocked', 'the refusal names the guard');
    assert.equal(stub.requests.length, before, 'nothing reached the upstream');
    for (const password of ['rootpass1234', 'Sup3rS3cretP@ssw0rd', 'redispass5678']) {
      for (const request of stub.requests) assert.equal(request.raw.includes(password), false, `${password} must not reach the wire`);
    }
    assert.equal(JSON.stringify(sent.body).includes('rootpass1234'), false, 'the refusal may not echo the secret');

    await nextCoreFrame(client, session.id);
    const frame = client.frames.find(entry => entry.type === 'privacy.blocked');
    assert.ok(frame, 'the refusal is relayed');
    assert.deepEqual(frame.data.rules, ['env_file_body'], `the .env rule fired, not ${JSON.stringify(frame.data.rules)}`);
    assert.equal(JSON.stringify(frame).includes('rootpass1234'), false, 'the frame may not echo the secret');
  }
});

// A neutral key names no secret word, and a flat 4.3-bit entropy floor is
// unreachable below ~22 characters, so a short password under `MYSQL_ROOT` used
// to reach the upstream in cleartext. Assert on the forwarded bytes: a block is
// the only acceptable outcome, and the value must appear in no request at all.
test('a short secret under a neutral key never reaches the wire', { timeout: 60000 }, async t => {
  const CASES = [
    { body: 'MYSQL_ROOT=hunter22\nREDIS_HOST=cache1', secret: 'hunter22' },
    { body: 'SERVICE_ACCOUNT=Kq7Rt2Xz9Lm4Np8Q\nAPP_ENV=production', secret: 'Kq7Rt2Xz9Lm4Np8Q' },
    { body: 'MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4\nREDIS_HOST=cache1', secret: 'Zx9!Kq2@Lm7#Pz4' },
    { body: 'MYSQL_ROOT=Kq7Rt2Xz9Lm4Np8Q2Wv3', secret: 'Kq7Rt2Xz9Lm4Np8Q2Wv3' },
  ];
  for (const { body, secret } of CASES) {
    resetEvents();
    const { url, stub, client, session } = await connected(t);
    const before = stub.requests.length;
    const sent = await chatBody(url, session, {
      messages: [
        { role: 'user', content: '설정 파일을 정리해 주세요' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: body }) } }] },
      ],
    });
    assert.equal(sent.status, 422, `${JSON.stringify(body)}: the request is refused`);
    assert.equal(stub.requests.length, before, `${secret}: nothing reached the upstream`);
    for (const request of stub.requests) assert.equal(request.raw.includes(secret), false, `${secret} must not be on the wire`);
    assert.equal(JSON.stringify(sent.body).includes(secret), false, `${secret}: the refusal may not echo it`);

    await nextCoreFrame(client, session.id);
    const frame = client.frames.find(entry => entry.type === 'privacy.blocked');
    assert.ok(frame, `${secret}: the refusal is relayed`);
    assert.equal(JSON.stringify(frame).includes(secret), false, `${secret}: the frame may not echo it`);
  }
});

// A placeholder carrying a digit is documentation, not a credential. The gate used
// to refuse `DB_PASS=changeme1234` and stop the session on a `.env.example`.
test('a digit-bearing placeholder is sent, not refused', { timeout: 60000 }, async t => {
  for (const body of ['DB_PASS=changeme1234\nNODE_ENV=production', 'DB_PASS=your_password1234']) {
    resetEvents();
    const { url, stub, client, session } = await connected(t);
    const before = stub.requests.length;
    const sent = await chatBody(url, session, {
      messages: [
        { role: 'user', content: '예시 파일을 확인해 주세요' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: body }) } }] },
      ],
    });
    assert.equal(sent.status, 200, `${JSON.stringify(body)}: a placeholder is not a credential`);
    assert.ok(stub.requests[before], 'the request reached the upstream');
    await nextCoreFrame(client, session.id);
    assert.equal(client.frames.some(frame => frame.type === 'privacy.blocked'), false);
  }
});

// In dotenv syntax a `#` needs whitespace in front of it to start a comment; one
// attached to value characters is part of the value. Cutting at every `#` masked
// `Zx9!Kq2@Lm7` and left `#Pz4` — the rest of the same password — on the wire.
test('a `#` inside a password is masked with it, never split off', { timeout: 60000 }, async t => {
  for (const body of ['MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4', 'MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4\nREDIS_HOST=cache1']) {
    resetEvents();
    const { url, stub, client, session } = await connected(t);
    const before = stub.requests.length;
    const sent = await chatBody(url, session, {
      messages: [
        { role: 'user', content: '설정 파일을 정리해 주세요' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: body }) } }] },
      ],
    });
    assert.equal(sent.status, 422, `${JSON.stringify(body)}: the request is refused`);
    assert.equal(stub.requests.length, before, 'nothing reached the upstream');
    // Not just the whole password: no fragment of it either.
    for (const request of stub.requests) {
      for (const fragment of ['Pz4', 'Lm7', 'Zx9', 'Zx9!Kq2@Lm7']) {
        assert.equal(request.raw.includes(fragment), false, `${fragment} must not be on the wire`);
      }
    }
    for (const payload of [JSON.stringify(sent.body), JSON.stringify(client.frames)]) {
      for (const fragment of ['Pz4', 'Lm7']) assert.equal(payload.includes(fragment), false, `${fragment} must not be relayed`);
    }

    await nextCoreFrame(client, session.id);
    assert.ok(client.frames.some(frame => frame.type === 'privacy.blocked'), 'the refusal is relayed');
  }
});

// A whitespace-preceded `#` is a comment, not part of the value: a key that is
// masked for its value keeps the comment readable and the comment never becomes
// part of the matched value.
test('an inline comment stays out of the value', { timeout: 30000 }, async t => {
  const { url, stub, client, session } = await connected(t);
  const before = stub.requests.length;
  const sent = await chatBody(url, session, {
    messages: [
      { role: 'user', content: '설정 파일을 정리해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: 'MYSQL_ROOT=Zx9!Kq2@Lm7#Pz4 # rotated 2026-11' }) } }] },
    ],
  });
  assert.equal(sent.status, 422, 'the password is refused');
  assert.equal(stub.requests.length, before, 'nothing reached the upstream');
  for (const request of stub.requests) assert.equal(request.raw.includes('Pz4'), false, 'no fragment on the wire');
});

// A body's mask span runs to end of line, so a comment that quotes the secret it
// describes (`PASS=hunter22 # hunter22`) is masked with it. The comment must not
// survive as a fragment of the password — not on the wire, not in a relayed frame,
// and not in the payload the masker produces for a send.
test('a comment quoting its own secret leaves no fragment anywhere', { timeout: 60000 }, async t => {
  const body = 'MYSQL_ROOT=hunter22 # hunter22\nREDIS_HOST=cache1';
  resetEvents();
  const { url, stub, client, session } = await connected(t);
  const before = stub.requests.length;
  const sent = await chatBody(url, session, {
    messages: [
      { role: 'user', content: '설정 파일을 정리해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: body }) } }] },
    ],
  });
  assert.equal(sent.status, 422, 'the body is refused');
  assert.equal(stub.requests.length, before, 'nothing reached the upstream');
  for (const request of stub.requests) assert.equal(request.raw.includes('hunter22'), false, 'no fragment on the wire');

  await nextCoreFrame(client, session.id);
  for (const [label, payload] of [['refusal body', JSON.stringify(sent.body)], ['frames', JSON.stringify(client.frames)]]) {
    assert.equal(payload.includes('hunter22'), false, `the ${label} still carry the secret`);
  }

  // The payload a mask would produce (the same masker the gate applies) carries
  // the whole span — value and the comment that quotes it — as one pseudonym.
  const masked = sanitizeText(body).text;
  assert.doesNotMatch(masked, /hunter22/, `the masked payload still carries the secret: ${masked}`);
  assert.match(masked, /^\[SECRET_\d+\]$/, `the whole body is one pseudonym, got ${masked}`);
});

// A comment is not evidence. An unrelated short comment on a configuration line is
// not a secret, and `KEY=value # note` on its own is not even an assignment body.
test('an unrelated comment on a config line is not a secret', { timeout: 30000 }, async t => {
  const { url, stub, client, session } = await connected(t);
  const before = stub.requests.length;
  const sent = await chatBody(url, session, {
    messages: [
      { role: 'user', content: '예시 파일을 확인해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: 'LOG_LEVEL=debug # short note\nNODE_ENV=production\nCACHE_TTL=300 # seconds' }) } }] },
    ],
  });
  assert.equal(sent.status, 200, 'configuration with comments is not a credential');
  assert.ok(stub.requests[before], 'the request reached the upstream');
  await nextCoreFrame(client, session.id);
  assert.equal(client.frames.some(frame => frame.type === 'privacy.blocked'), false);
});

// A placeholder word used to be a bare prefix match, so a live password that merely
// started with its letters reached the wire: `yourSup3rS3cret99!`, `YOURS3cret99`,
// `changemeKq7Rt2Xz`, `exampleS3cret99`, `todoKq7Rt2Xz9`, `<Sup3rS3cret!x>`.
test('a placeholder word glued to a password never reaches the wire', { timeout: 90000 }, async t => {
  const glued = [
    'DB_PASS=yourSup3rS3cret99!',
    'DB_PASS=YOURS3cret99',
    'DB_PASS=changemeKq7Rt2Xz',
    'DB_PASS=exampleS3cret99',
    'DB_PASS=todoKq7Rt2Xz9',
    'DB_PASS=<Sup3rS3cret!x>',
    'DB_PASS=yourSup3rS3cret99!\nREDIS_HOST=cache1',
  ];
  for (const body of glued) {
    resetEvents();
    const { url, stub, client, session } = await connected(t);
    const before = stub.requests.length;
    const sent = await chatBody(url, session, {
      messages: [
        { role: 'user', content: '설정 파일을 정리해 주세요' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: body }) } }] },
      ],
    });
    assert.equal(sent.status, 422, `${JSON.stringify(body)}: the request is refused`);
    assert.equal(stub.requests.length, before, `${JSON.stringify(body)}: nothing reached the upstream`);
    for (const request of stub.requests) {
      for (const fragment of ['Sal9', 'Sup3rS3cret99', 'S3cret99', 'Kq7Rt2Xz']) {
        assert.equal(request.raw.includes(fragment), false, `${fragment} must not be on the wire`);
      }
    }
    for (const payload of [JSON.stringify(sent.body), JSON.stringify(client.frames)]) {
      for (const fragment of ['Sup3rS3cret99', 'Kq7Rt2Xz', 'S3cret99']) assert.equal(payload.includes(fragment), false, `${fragment} must not be relayed`);
    }
    await nextCoreFrame(client, session.id);
    assert.ok(client.frames.some(frame => frame.type === 'privacy.blocked'), `${JSON.stringify(body)}: the refusal is relayed`);
  }
});

// The same placeholder shapes as a sample file still pass: a `.env.example` must
// never stop a session, which is what the placeholder exemption exists for.
test('placeholder documentation still passes the gate', { timeout: 60000 }, async t => {
  const { url, stub, client, session } = await connected(t);
  const before = stub.requests.length;
  const sent = await chatBody(url, session, {
    messages: [
      { role: 'user', content: '예시 파일을 확인해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: 'DB_PASS=your_api_key_here\nREDIS_AUTH=changeme1234\n<your_token_here>' }) } }] },
    ],
  });
  assert.equal(sent.status, 200, 'a file of placeholders is not a credential');
  assert.ok(stub.requests[before], 'the request reached the upstream');
  await nextCoreFrame(client, session.id);
  assert.equal(client.frames.some(frame => frame.type === 'privacy.blocked'), false);
});

// A classic-Mac body separates lines with `\r` alone. Splitting on `\n` made the
// whole body one line, so `env_file_body` never fired and the first password was
// forwarded in cleartext.
test('a CR-only body is refused and none of it reaches the wire', { timeout: 60000 }, async t => {
  const { url, stub, client, session } = await connected(t);
  const before = stub.requests.length;
  const sent = await chatBody(url, session, {
    messages: [
      { role: 'user', content: '설정 파일을 정리해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: 'MYSQL_ROOT=hunter22\rREDIS_HOST=cache1\rAPP_ENV=production' }) } }] },
    ],
  });
  assert.equal(sent.status, 422, 'a CR-only body is a body');
  assert.equal(stub.requests.length, before, 'nothing reached the upstream');
  for (const request of stub.requests) assert.equal(request.raw.includes('hunter22'), false, 'the password is not on the wire');
  await nextCoreFrame(client, session.id);
  assert.ok(client.frames.some(frame => frame.type === 'privacy.blocked'));
});

// The colon is structural: `user:pass` is a credential whether or not its halves
// carry digits. The old rule read every alphabetic pair as host/port or a label
// pair, so the classic pair reached the wire.
test('an alphabetic user:password pair never reaches the wire', { timeout: 90000 }, async t => {
  const bodies = [
    'DB_PASS=admin:letmein',
    'DB_PASS=root:toor',
    'DB_PASS=sa:sa',
    'DB_PASS=postgres:postgres',
    'DB_PASS=admin:admin\nREDIS_HOST=cache1',
  ];
  for (const body of bodies) {
    resetEvents();
    const { url, stub, client, session } = await connected(t);
    const before = stub.requests.length;
    const sent = await chatBody(url, session, {
      messages: [
        { role: 'user', content: '설정 파일을 정리해 주세요' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: body }) } }] },
      ],
    });
    assert.equal(sent.status, 422, `${JSON.stringify(body)}: the request is refused`);
    assert.equal(stub.requests.length, before, `${JSON.stringify(body)}: nothing reached the upstream`);
    for (const request of stub.requests) {
      for (const fragment of ['letmein', 'toor', 'postgres', 'admin']) {
        assert.equal(request.raw.includes(fragment), false, `${fragment} must not be on the wire`);
      }
    }
    for (const payload of [JSON.stringify(sent.body), JSON.stringify(client.frames)]) {
      for (const fragment of ['letmein', 'toor']) assert.equal(payload.includes(fragment), false, `${fragment} must not be relayed`);
    }
    await nextCoreFrame(client, session.id);
    assert.ok(client.frames.some(frame => frame.type === 'privacy.blocked'), `${JSON.stringify(body)}: the refusal is relayed`);
  }
});

// A mode word, port or dotted host is a setting, not a credential: it must still
// pass the gate, or ordinary configuration stops the session. A `*_PASS` key
// holding `basic:digest` is the authentication mode — the key word alone must not
// outrank the explicit mode word on the value side — and a bare scheme word with
// no colon is not a pair at all.
test('colon settings and bare scheme words still pass the gate', { timeout: 60000 }, async t => {
  const { url, stub, client, session } = await connected(t);
  const before = stub.requests.length;
  const sent = await chatBody(url, session, {
    messages: [
      { role: 'user', content: '예시 파일을 확인해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: 'AUTH_MODE=basic:digest\nAUTH_SCHEME=bearer:jwt\nLOG_LEVEL=info:debug\nDB_PASS=localhost:5432\nDB_PASSWORD=basic:digest\nDB_PASS=vault:file\nDB_PASSWORD=ldap\nPASSWORD=oauth\nDB_PASS=mysql' }) } }] },
    ],
  });
  assert.equal(sent.status, 200, 'a mode word, a scheme word or a port is not a credential');
  assert.ok(stub.requests[before], 'the request reached the upstream');
  await nextCoreFrame(client, session.id);
  assert.equal(client.frames.some(frame => frame.type === 'privacy.blocked'), false);
});

// A bracketed password is a password: brackets are punctuation, not a template.
test('a bracketed password never reaches the wire', { timeout: 60000 }, async t => {
  const { url, stub, client, session } = await connected(t);
  const before = stub.requests.length;
  const sent = await chatBody(url, session, {
    messages: [
      { role: 'user', content: '설정 파일을 정리해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: 'DB_PASS=Kq7[Rt2]Xz9' }) } }] },
    ],
  });
  assert.equal(sent.status, 422, 'a bracketed password is refused');
  assert.equal(stub.requests.length, before, 'nothing reached the upstream');
  for (const request of stub.requests) assert.equal(request.raw.includes('Rt2'), false, 'no fragment on the wire');
  await nextCoreFrame(client, session.id);
  assert.ok(client.frames.some(frame => frame.type === 'privacy.blocked'));
});

// The legitimate exemption is the one the body itself carries: a real sample file
// holds placeholders, not secrets. That signal is in the values, not in key text,
// so it still applies — and it is the only one left.
test('a sample file of placeholder values is still not a secret', { timeout: 30000 }, async t => {
  const SAMPLE = 'MYSQL_ROOT=your_root_password\nREDIS_AUTH=changeme\nAPI_KEY=<insert-key>';
  const { url, stub, client, session } = await connected(t);
  const before = stub.requests.length;
  const sent = await chatBody(url, session, {
    messages: [
      { role: 'user', content: '예시 파일을 확인해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ 'example.env': SAMPLE }) } }] },
    ],
  });
  assert.equal(sent.status, 200, 'placeholder values are an example, not a credential');
  assert.ok(stub.requests[before], 'the request reached the upstream');
  await nextCoreFrame(client, session.id);
  assert.equal(client.frames.some(frame => frame.type === 'privacy.blocked'), false);
});

// A CRLF body used to drift: each later line start advanced by the `\r` it never
// consumed, so the body span ended short of its last line and the masker (and
// `redactForLog`, which feeds `bridge_error.stderr`) left `ecret99` behind.
test('a CRLF body is refused whole, with no fragment on the wire, in a frame or in the log', { timeout: 60000 }, async t => {
  const body = [
    'DB_PASS=Sup3rS3cret!x',
    'REDIS_HOST=cache1',
    'NODE_ENV=production',
    'APP_PORT=8080',
    'LOG_LEVEL=debug',
    'CACHE_TTL=300',
    'API_BASE=/api/v1',
    'MAIL_FROM=ops',
  ].join('\r\n');
  resetEvents();
  const { url, stub, client, session } = await connected(t);
  const before = stub.requests.length;
  const sent = await chatBody(url, session, {
    messages: [
      { role: 'user', content: '설정 파일을 정리해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: body }) } }] },
    ],
  });
  assert.equal(sent.status, 422, 'a CRLF .env body is refused like an LF one');
  assert.equal(stub.requests.length, before, 'nothing reached the upstream');
  for (const request of stub.requests) assert.equal(request.raw.includes('ecret99'), false, 'no fragment on the wire');

  await nextCoreFrame(client, session.id);
  const frame = client.frames.find(entry => entry.type === 'privacy.blocked');
  assert.ok(frame, 'the refusal is relayed');
  assert.deepEqual(frame.data.rules, ['env_file_body']);
  for (const [label, payload] of [['refusal body', JSON.stringify(sent.body)], ['frames', JSON.stringify(client.frames)]]) {
    assert.equal(payload.includes('ecret99'), false, `the ${label} still carry the fragment`);
    assert.equal(payload.includes('MAIL_FROM'), false, `the ${label} still carry the tail of the body`);
  }

  // The log surface: the same sanitizer `bridge_error.stderr` frames are built from.
  const logged = sanitizeDiagnostics(body);
  assert.equal(logged.includes('ecret99'), false, `the log still carries the fragment: ${logged}`);
  assert.equal(logged, '[REDACTED:env_file_body]');
});

// The same body with LF endings was always clean; the CRLF and LF forms must not
// differ, because the line terminator is the only difference between them.
test('the CRLF and LF forms of one body produce the same refusal', { timeout: 60000 }, async t => {
  const lines = ['DB_PASS=Sup3rS3cret!x', 'REDIS_HOST=cache1', 'NODE_ENV=production', 'MAIL_FROM=ops'];
  const results = [];
  for (const terminator of ['\r\n', '\n']) {
    resetEvents();
    const { url, stub, client, session } = await connected(t);
    const sent = await chatBody(url, session, {
      messages: [
        { role: 'user', content: '설정 파일을 정리해 주세요' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: lines.join(terminator) }) } }] },
      ],
    });
    await nextCoreFrame(client, session.id);
    const frame = client.frames.find(entry => entry.type === 'privacy.blocked');
    results.push({ status: sent.status, rules: frame?.data.rules ?? null, stubCount: stub.requests.length });
  }
  assert.deepEqual(results[0], results[1], 'the terminator does not change the decision');
  assert.equal(results[0].status, 422);
  assert.deepEqual(results[0].rules, ['env_file_body']);
  assert.equal(results[0].stubCount, 0);
});

// A quoted value is one token even when it contains spaces. `DB_PASS="correct
// horse battery"` used to be forwarded verbatim because the value had spaces; a
// bare unquoted value with spaces is still config prose.
test('a quoted passphrase with spaces is refused, an unquoted sentence is sent', { timeout: 60000 }, async t => {
  resetEvents();
  const blocked = await connected(t);
  const before = blocked.stub.requests.length;
  const refused = await chatBody(blocked.url, blocked.session, {
    messages: [
      { role: 'user', content: '설정 파일을 정리해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: 'DB_PASS="correct horse battery"\nREDIS_HOST=cache1' }) } }] },
    ],
  });
  assert.equal(refused.status, 422, 'the quoted passphrase is a credential');
  assert.equal(blocked.stub.requests.length, before, 'nothing reached the upstream');
  for (const fragment of ['correct', 'horse', 'battery']) {
    assert.equal(blocked.stub.requests.some(request => request.raw.includes(fragment)), false, `${fragment} must not be on the wire`);
    assert.equal(JSON.stringify(blocked.client.frames).includes(fragment), false, `${fragment} must not be relayed`);
  }

  resetEvents();
  const sent = await connected(t);
  const beforeConfig = sent.stub.requests.length;
  const prose = await chatBody(sent.url, sent.session, {
    messages: [
      { role: 'user', content: '설정 파일을 정리해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: 'NOTE=this is a config note\nNODE_ENV=production' }) } }] },
    ],
  });
  assert.equal(prose.status, 200, 'an unquoted sentence is configuration, not a secret');
  assert.ok(sent.stub.requests[beforeConfig], 'the request reached the upstream');
  await nextCoreFrame(sent.client, sent.session.id);
  assert.equal(sent.client.frames.some(frame => frame.type === 'privacy.blocked'), false);
});

// Base64 padding is part of the literal, not an assignment operator. A 17-byte
// random key was refused unpadded and sent once padded.
test('a base64-padded key is refused exactly like its unpadded form', { timeout: 60000 }, async t => {
  const statuses = [];
  for (const key of ['Kq7Rt2Xz9Lm4Np8Q2Wv3Ao', 'Kq7Rt2Xz9Lm4Np8Q2Wv3Ao=']) {
    resetEvents();
    const { url, stub, client, session } = await connected(t);
    const before = stub.requests.length;
    const sent = await chatBody(url, session, {
      messages: [
        { role: 'user', content: '환경 변수를 확인해 주세요' },
        { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: `API_KEY=${key}` }) } }] },
      ],
    });
    assert.equal(stub.requests.length, before, `${key}: nothing reached the upstream`);
    await nextCoreFrame(client, session.id);
    statuses.push(sent.status);
  }
  assert.deepEqual(statuses, [422, 422], 'padded and unpadded are the same secret');
});

// A placeholder word inside a real password used to exempt it: `pw_change_2026`
// was sent. The word counts only when the whole value is placeholder-shaped.
test('a placeholder word inside a password does not exempt it', { timeout: 60000 }, async t => {
  resetEvents();
  const blocked = await connected(t);
  const before = blocked.stub.requests.length;
  const refused = await chatBody(blocked.url, blocked.session, {
    messages: [
      { role: 'user', content: '환경 변수를 확인해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: 'DB_PASS=pw_change_2026' }) } }] },
    ],
  });
  assert.equal(refused.status, 422, 'pw_change_2026 is a password');
  assert.equal(blocked.stub.requests.length, before, 'nothing reached the upstream');

  resetEvents();
  const sent = await connected(t);
  const beforePlaceholder = sent.stub.requests.length;
  const placeholder = await chatBody(sent.url, sent.session, {
    messages: [
      { role: 'user', content: '예시 파일을 확인해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: 'DB_PASS=change_me_2026\nNODE_ENV=production' }) } }] },
    ],
  });
  assert.equal(placeholder.status, 200, 'change_me_2026 is documentation');
  assert.ok(sent.stub.requests[beforePlaceholder], 'the request reached the upstream');
});

// The body window ran `[first assignment, last assignment]`, so a comment line
// above the first assignment that quotes the secret survived the mask.
test('a leading comment quoting the secret leaves no fragment anywhere', { timeout: 60000 }, async t => {
  const body = '# DB_PASS=Sup3rS3cret!x\nMYSQL_ROOT=hunter22\nREDIS_HOST=cache1';
  resetEvents();
  const { url, stub, client, session } = await connected(t);
  const before = stub.requests.length;
  const sent = await chatBody(url, session, {
    messages: [
      { role: 'user', content: '설정 파일을 정리해 주세요' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save', arguments: JSON.stringify({ payload: body }) } }] },
    ],
  });
  assert.equal(sent.status, 422, 'the body is refused');
  assert.equal(stub.requests.length, before, 'nothing reached the upstream');
  for (const request of stub.requests) {
    for (const fragment of ['Sup3rS3cret', 'hunter22']) assert.equal(request.raw.includes(fragment), false, `${fragment} must not be on the wire`);
  }
  await nextCoreFrame(client, session.id);
  for (const [label, payload] of [['refusal body', JSON.stringify(sent.body)], ['frames', JSON.stringify(client.frames)]]) {
    for (const fragment of ['Sup3rS3cret', 'hunter22']) assert.equal(payload.includes(fragment), false, `the ${label} still carry ${fragment}`);
  }
  const masked = sanitizeText(body).text;
  assert.equal(masked, '[SECRET_1]', `the whole block is one pseudonym, got ${masked}`);
  for (const fragment of ['Sup3rS3cret', 'hunter22']) assert.equal(sanitizeDiagnostics(body).includes(fragment), false, `the log still carries ${fragment}`);
});

// A path identifies a field, not an occurrence: two findings in one field are one
// line with a count of two, not two lines and not two field entries.
test('repeated findings in one field collapse to one line', { timeout: 30000 }, async t => {
  const { url, client, session } = await connected(t);
  const sent = await chat(url, session, `${PHONE} 그리고 ${PHONE} 로 연락 주세요`);
  assert.equal(sent.status, 200);

  await nextCoreFrame(client, session.id);
  const frames = client.frames.filter(frame => frame.type === 'privacy.masked');
  assert.equal(frames.length, 1, 'one send, one frame');
  assert.deepEqual(frames[0].data.fields, ['messages[0].content'], 'one field entry for one field');
  assert.deepEqual(frames[0].data.counts, { phone_number: 2 }, 'both occurrences are counted on that one entry');
  assert.equal(frames[0].data.rules.length, 1);

  const vm = createViewModel();
  for (const frame of client.frames) applyFrame(vm, frame);
  const lines = transcriptEntries(vm).filter(entry => entry.privacy);
  assert.equal(lines.length, 1, 'exactly one privacy line, not one per occurrence');
  assert.equal(privacyLine(lines[0].privacy).text, '개인정보 보호 · 전화번호 2건 · 가명화 · 요청 전송됨');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import {
  screenOutbound,
  createVault,
  maskString,
  restoreString,
  createStreamRestorer,
  restoreJsonPayload,
  redactForLog,
  detectAll,
  validateKoreanRRN,
  isSecretAssignment,
  PRIVACY_CODES,
} from '../privacy/index.mjs';
import { sanitizeDiagnostics } from '../server.mjs';
import { createGatewayHandler } from '../../gateway/lib/gateway.mjs';
import { call, startHarness } from '../../gateway/test/helpers.mjs';

const ID = { 'x-user-id': 'user-a' };

/** A real gateway over the shared stub upstream, with the privacy gate wired in. */
async function startGatedHarness(t) {
  const h = await startHarness();
  const handler = createGatewayHandler({
    config: h.config,
    env: h.env,
    logger: h.logger,
    privacyGate: screenOutbound,
  });
  const server = http.createServer(handler.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await h.stop();
  });
  return { base, stub: h.stub };
}

test('B1: image and video routes run the same pre-send gate as chat', async (t) => {
  const { base, stub } = await startGatedHarness(t);

  // 1. A card number in an image prompt is pseudonymized before dispatch.
  const image = await call(base, '/v1/images/generations', {
    method: 'POST',
    headers: ID,
    body: { model: 'server/flux-schnell', prompt: 'Poster featuring card 4532-0151-1283-0366 on a table' },
  });
  assert.equal(image.status, 200);
  const imageUpstream = stub.lastRequest((r) => r.path.endsWith('/images/generations'));
  assert.ok(imageUpstream, 'the clean prompt must reach the upstream');
  assert.doesNotMatch(imageUpstream.body.prompt, /4532-0151-1283-0366/, 'the raw card must never reach the upstream');
  assert.match(imageUpstream.body.prompt, /\[CARD_\d+\]/);

  // 2. A live API key in an image prompt is refused (422) and the upstream is never called.
  const before = stub.requests.length;
  const blocked = await call(base, '/v1/images/generations', {
    method: 'POST',
    headers: ID,
    body: { model: 'server/flux-schnell', prompt: 'image with sk-proj-superSecretLiveKey123456789012345' },
  });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.json.error.code, PRIVACY_CODES.blocked);
  assert.equal(stub.requests.length, before, 'a blocked image request must not reach the upstream');

  // 3. A phone number in a video prompt is pseudonymized before dispatch.
  const video = await call(base, '/v1/videos', {
    method: 'POST',
    headers: ID,
    body: { model: 'server/wan-2.2-t2v', prompt: 'Animate a person calling 010-9876-5432', duration_s: 2 },
  });
  assert.equal(video.status, 202);
  const videoUpstream = stub.lastRequest((r) => r.path.endsWith('/videos'));
  assert.ok(videoUpstream);
  assert.doesNotMatch(videoUpstream.body.prompt, /010-9876-5432/);
  assert.match(videoUpstream.body.prompt, /\[PHONE_\d+\]/);

  // 4. A live API key in a video prompt is refused too.
  const videoBlocked = await call(base, '/v1/videos', {
    method: 'POST',
    headers: ID,
    body: { model: 'server/wan-2.2-t2v', prompt: 'key sk-ant-api03-abcdefghijklmnopqrstuvwx', duration_s: 2 },
  });
  assert.equal(videoBlocked.status, 422);
});

test('B2: diagnostics sanitizer removes every secret shape from core stderr', () => {
  const dirty = [
    'Worker crashed with RRN: 900101-1234568',
    'Payment card rejected: 4532-0151-1283-0366',
    'Contact admin at sec-alert@internal-domain.org',
    'AWS credentials in env: AKIA234567890ABCDEFG',
    'OpenAI auth failure: sk-proj-liveProductionKey1234567890abcdef',
    'JWT signature: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2VjcmV0X3NpZ25hdHVyZV8xMjM0NTY',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0mockKeyData\n-----END RSA PRIVATE KEY-----',
    'DATABASE_URL=postgres://app_admin:superSecretP%40ssw0rd@10.0.0.5:5432/prod_db',
  ].join('\n');
  const sanitized = sanitizeDiagnostics(dirty);
  for (const raw of ['900101-1234568', '4532-0151-1283-0366', 'sec-alert@internal-domain.org',
    'AKIA234567890ABCDEFG', 'sk-proj-liveProductionKey', 'eyJhbGciOiJIUzI1NiJ9',
    'BEGIN RSA PRIVATE KEY', 'superSecretP%40ssw0rd']) {
    assert.equal(sanitized.includes(raw), false, `stderr still carries ${raw}`);
  }
});

test('B4: fail-closed branch is reachable — absent and timed-out SLM block high risk, low risk is masked', async () => {
  // Ambiguous high risk: a post-2020 RRN shape (random tail, no check digit) with
  // only weak context — it cannot be verified without the stage-3 model.
  const highRiskBody = { messages: [{ role: 'user', content: '문서 확인: 030501-5829104' }] };

  const absent = await screenOutbound({ body: highRiskBody, sessionId: 'b4-absent', route: 'openrouter-zdr' });
  assert.equal(absent.action, 'blocked');
  assert.equal(absent.status, 422);
  assert.equal(absent.code, PRIVACY_CODES.unverifiable);

  const timedOut = await screenOutbound({
    body: highRiskBody, sessionId: 'b4-timeout', route: 'openrouter-zdr',
    slmVerifier: async () => { await new Promise((r) => setTimeout(r, 400)); return true; },
  });
  assert.equal(timedOut.action, 'blocked');
  assert.equal(timedOut.status, 422);
  assert.equal(timedOut.code, PRIVACY_CODES.unverifiable);

  // An ambiguous low-risk span is pseudonymized and sent, not blocked.
  const lowRisk = await screenOutbound({
    body: { messages: [{ role: 'user', content: '오늘 회의에 이준호 참석 예정입니다.' }] },
    sessionId: 'b4-lowrisk', route: 'openrouter-zdr',
  });
  assert.equal(lowRisk.action, 'sent');
});

test('A1: envelope walker covers tools definitions and body.user', async () => {
  const body = {
    user: 'client-user-010-1234-5678',
    tools: [{
      type: 'function',
      function: {
        name: 'query_db',
        description: 'Search for card 4532-0151-1283-0366 or email admin@secretcorp.kr',
        parameters: { type: 'object', properties: { account: { type: 'string', description: '신한은행 계좌번호 110-310-456789' } } },
      },
    }],
    messages: [{ role: 'user', content: 'hello' }],
  };
  const screened = await screenOutbound({ body, sessionId: 'a1-test', route: 'openrouter-zdr' });
  assert.equal(screened.action, 'sent');
  assert.doesNotMatch(screened.body.user, /010-1234-5678/);
  assert.doesNotMatch(screened.body.tools[0].function.description, /4532-0151-1283-0366/);
  assert.doesNotMatch(screened.body.tools[0].function.description, /admin@secretcorp\.kr/);
  assert.doesNotMatch(screened.body.tools[0].function.parameters.properties.account.description, /110-310-456789/);
});

test('A2: Amex 4-6-5 grouping is detected', () => {
  const findings = detectAll('Amex card is 3782-822463-10005');
  assert.ok(findings.some((f) => f.rule === 'credit_card_luhn' && f.variant === 'amex'));
});

test('A3: role and honorific nouns are never masked as names', () => {
  const prose = '친절하신 선생님과 고객님, 그리고 원장님께 안내 말씀 드립니다.';
  const masked = maskString(prose, createVault('a3-test')).text;
  assert.equal(masked, prose);
});

test('A4: literal pseudonyms do not leak zero-width spaces when nothing is masked', () => {
  const input = 'Sample text containing literal [USER_1] placeholder.';
  const result = maskString(input, createVault('a4-test'));
  assert.equal(result.hits.length, 0);
  assert.equal(result.text, input);
  assert.equal(result.text.includes('\u200b'), false);
});

test('A5: parentheses in prose do not make a span look like code', () => {
  const res = maskString('카드 번호 (4532-0151-1283-0366) 등록 완료.', createVault('a5-test'));
  assert.match(res.text, /\[CARD_\d+\]/);
});

test('SEC-01: envelope walker traverses tool_calls, multimodal arrays, prompts and tool payloads', async () => {
  const body = {
    model: 'gpt-4o',
    prompt: 'phone 010-1234-5678 and card 4532-0151-1283-0366',
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'email secret-admin@corp-domain.kr' },
        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
      ] },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save_user', arguments: JSON.stringify({ user_email: 'target@corp-domain.kr', phone: '010-9876-5432', address: '서울특별시 강남구 테헤란로 152' }) } }] },
      { role: 'tool', name: 'save_user', content: 'Saved user 010-9876-5432 with RRN 900101-1234568' },
    ],
  };
  const screened = await screenOutbound({ body, sessionId: 'sec01-session', route: 'openrouter-zdr' });
  assert.equal(screened.action, 'sent');
  const masked = screened.body;
  assert.doesNotMatch(masked.prompt, /010-1234-5678/);
  assert.doesNotMatch(masked.prompt, /4532-0151-1283-0366/);
  assert.doesNotMatch(masked.messages[0].content[0].text, /secret-admin@corp-domain\.kr/);
  const args = JSON.parse(masked.messages[1].tool_calls[0].function.arguments);
  assert.doesNotMatch(args.user_email, /target@corp-domain\.kr/);
  assert.doesNotMatch(args.phone, /010-9876-5432/);
  assert.doesNotMatch(masked.messages[2].content, /010-9876-5432/);
  assert.doesNotMatch(masked.messages[2].content, /900101-1234568/);

  const restored = JSON.parse(restoreJsonPayload({ choices: [{ message: masked.messages[1] }] }, screened.vault)
    .choices[0].message.tool_calls[0].function.arguments);
  assert.equal(restored.user_email, 'target@corp-domain.kr');
  assert.equal(restored.phone, '010-9876-5432');
});

test('SEC-02: a confirmed secret is blocked and the report carries no raw value', async () => {
  const bodies = [
    { messages: [{ role: 'user', content: 'key sk-proj-abcdefghijklmnopqrstuvwx123456' }] },
    { messages: [{ role: 'user', content: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----' }] },
    { messages: [{ role: 'user', content: 'AWS token AKIAIOSFODNN7ABCD123' }] },
    { messages: [{ role: 'user', content: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz1234' }] },
    { messages: [{ role: 'user', content: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSig12' }] },
  ];
  for (const body of bodies) {
    const outcome = await screenOutbound({ body, sessionId: 'sec02-gate', route: 'a6api' });
    assert.equal(outcome.action, 'blocked');
    assert.equal(outcome.status, 422);
    assert.equal(outcome.code, PRIVACY_CODES.blocked);
    const reportStr = JSON.stringify(outcome.report);
    assert.doesNotMatch(reportStr, /sk-proj|BEGIN RSA|AKIA|ghp_|doNotLeak/);
  }
});

test('SEC-03: env-assignment needs a secret keyword or entropy plus low token efficiency', () => {
  assert.equal(isSecretAssignment('RULE_CARD', 'credit_card_luhn'), false);
  assert.equal(isSecretAssignment('DEFAULT_PROVIDER', 'harness-local'), false);
  assert.equal(isSecretAssignment('MAX_BUFFER_SIZE', '1048576'), false);
  assert.equal(isSecretAssignment('FILE_PATH', 'src/app/index.mjs'), false);
  assert.equal(isSecretAssignment('API_KEY', 'sk-ant-api03-abcdefghijklmnopqrstuvwx'), true);
  assert.equal(isSecretAssignment('SECRET_TOKEN', 'xoxb-1234567890-abcdefghij'), true);
  assert.equal(isSecretAssignment('DATABASE_PASSWORD', 'p@ssw0rd1234!LongComplex'), true);
  assert.equal(isSecretAssignment('OPAQUE_CONFIG', 'q7Zr4Kp9Lm2Nx8Tv5Wc1Ha6Jb3Gd0Fs7Yu4Ie9Oa2Rd5Tk8'), true);
});

test('SEC-04: loopback, timestamps and post-2020 RRNs are handled correctly', () => {
  const vault = createVault('sec04-session');
  const loopback = 'Harness listening on 127.0.0.1:8080 and bind 0.0.0.0 or localhost';
  assert.equal(maskString(loopback, vault).text, loopback);
  const stamp = `Logged at timestamp ${Date.now()} by process 12345`;
  assert.equal(maskString(stamp, vault).text, stamp);
  const bank = '국민은행 계좌 123-456789-0123 로 입금 부탁드립니다';
  assert.doesNotMatch(maskString(bank, vault).text, /123-456789-0123/);
  assert.equal(validateKoreanRRN('900101-1234568'), true);
  assert.equal(validateKoreanRRN('900101-1234567'), false);
  assert.ok(detectAll('주민등록번호 030501-3829104 제출').length > 0);
});

test('SEC-05: documents and logs are sanitized', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const emptyModelRoot = mkdtempSync(join(tmpdir(), 'sec05-nomodel-'));
  t.after(() => {
    try { rmSync(emptyModelRoot, { recursive: true, force: true }); } catch {}
  });
  const { buildDocumentModel } = await import('../insight/document.mjs');
  const events = [
    { type: 'prompt', message: '목표: 사용자 010-1234-5678 및 주민번호 900101-1234568 정리', ts: Date.now() - 5000 },
    { type: 'tool_execution_end', result: { details: { path: 'src/config.js', diff: '@@ -1 +1 @@\n-const apiKey = "sk-proj-rawKey1234567890abcdef";\n+const apiKey = process.env.API_KEY;' } }, ts: Date.now() - 1000 },
  ];
  const model = await buildDocumentModel({ type: 'report', events, meta: { sessionId: 'sec05-test', title: '보고서' }, modelRoot: emptyModelRoot, env: {} });
  assert.doesNotMatch(model.goal.text, /010-1234-5678/);
  assert.doesNotMatch(model.goal.text, /900101-1234568/);
  assert.doesNotMatch(model.deliverables.snippets[0].code, /sk-proj-rawKey1234567890abcdef/);
  const redacted = redactForLog('failed with API key sk-proj-1234567890abcdefghijkl at 192.168.1.1');
  assert.doesNotMatch(redacted, /sk-proj-1234567890abcdefghijkl/);
});

test('coding preservation: masked JS still parses and runs, and restores exactly', () => {
  const vault = createVault('coding-preservation');
  const original = `
const userCard = "4532-0151-1283-0366";
const userPhone = "010-1234-5678";
const userEmail = "dev@example.co.kr";
function getRefundInfo() {
  return { card: userCard, phone: userPhone, email: userEmail, valid: true };
}
getRefundInfo();
`;
  const masked = maskString(original, vault, { kind: 'code' }).text;
  const sandbox = {};
  vm.createContext(sandbox);
  const script = new vm.Script(masked);
  assert.equal(script.runInContext(sandbox).valid, true);
  assert.equal(restoreString(masked, vault), original);
});

test('restoration survives arbitrary SSE chunk splits', () => {
  const vault = createVault('sse-arbitrary');
  const email = 'developer.test@company.co.kr';
  const placeholder = vault.allocate('email_address', email, { form: 'prose' });
  const streamText = `event: message\ndata: {"content": "Sending notification to ${placeholder} now."}\n\n`;
  for (let split = 1; split < streamText.length; split++) {
    const restorer = createStreamRestorer(vault);
    const out = Buffer.concat([
      restorer.processChunk(streamText.slice(0, split)),
      restorer.processChunk(streamText.slice(split)),
      restorer.flush(),
    ]).toString('utf8');
    assert.doesNotMatch(out, /\[EMAIL_\d+\]/, `failed at split ${split}`);
    assert.match(out, /developer\.test@company\.co\.kr/);
  }
});

test('gate parity across openrouter-zdr, a6api and opencodex-nace', async () => {
  for (const route of ['openrouter-zdr', 'a6api', 'opencodex-nace']) {
    const blocked = await screenOutbound({
      body: { messages: [{ role: 'user', content: 'key sk-proj-0987654321fedcba0987654321fedcba' }] },
      sessionId: `route-${route}`, route,
    });
    assert.equal(blocked.action, 'blocked');
    assert.equal(blocked.status, 422);
    const sent = await screenOutbound({
      body: { messages: [{ role: 'user', content: '연락처: 010-5555-7777' }] },
      sessionId: `route-pii-${route}`, route,
    });
    assert.equal(sent.action, 'sent');
    assert.doesNotMatch(sent.body.messages[0].content, /010-5555-7777/);
  }
});

test('audit regression: video negative_prompt is screened and pseudonymized by envelope walker', async () => {
  const out = await screenOutbound({
    body: { model: 'server/wan-2.2-t2v', prompt: 'a calm street scene', negative_prompt: '김민수님 제외' },
    sessionId: 'audit-neg-prompt',
    route: 'openrouter-zdr',
  });
  assert.equal(out.action, 'sent');
  assert.doesNotMatch(out.body.negative_prompt, /김민수/);
  assert.match(out.body.negative_prompt, /\[PERSON_\d+\]/);
});

test('audit regression: allowStages:false fails closed on unverifiable high-risk spans', async () => {
  const out = await screenOutbound({
    body: { messages: [{ role: 'user', content: '문서 확인: 030501-5829104' }] },
    sessionId: 'audit-stages-off',
    route: 'openrouter-zdr',
    allowStages: false,
  });
  assert.equal(out.action, 'blocked');
  assert.equal(out.status, 422);
  assert.equal(out.code, PRIVACY_CODES.unverifiable);
});

test('audit regression: vault eviction preserves counters without throwing and avoids token reuse', async () => {
  const { getVault, resetVaults } = await import('../privacy/vault.mjs');
  resetVaults();
  const first = getVault('audit-evict-0');
  const firstToken = first.allocate('phone_number', '010-1000-0001', { form: 'prose' });
  assert.equal(firstToken, '[PHONE_1]');
  for (let i = 1; i <= 70; i += 1) {
    getVault(`audit-evict-${i}`).allocate('phone_number', `010-2000-${String(i).padStart(4, '0')}`, { form: 'prose' });
  }
  const resumed = getVault('audit-evict-0');
  const nextToken = resumed.allocate('phone_number', '010-1000-0002', { form: 'prose' });
  assert.equal(nextToken, '[PHONE_2]');
  resetVaults();
});

test('audit regression: user-typed code-form pseudonyms do not collide with newly allocated tokens', () => {
  const vault = createVault('audit-code-literal');
  const input = 'const x = __PII_PHONE_1__; const y = "010-1234-5678";';
  const masked = maskString(input, vault, { kind: 'code' }).text;
  assert.ok(masked.startsWith('const x = __PII_PHONE_1__;'));
  assert.doesNotMatch(masked, /010-1234-5678/);
  assert.equal(restoreString(masked, vault), input);
});

test('audit regression: quoted credential assignments keep closing quotes and round-trip cleanly', () => {
  for (const input of [
    'const password = "Sup3rS3cret!x";',
    'API_TOKEN="abc123def456ghi789"',
    "DB_PASS='Sup3rS3cret!x'",
    'export PGPASSWORD="Kq7Rt2Xz9Lm4Np8Q"',
  ]) {
    const vault = createVault('audit-quote-preserve');
    const masked = maskString(input, vault, { kind: 'code' }).text;
    assert.equal(restoreString(masked, vault), input, `round-trip failed for ${input}`);
    assert.doesNotMatch(masked, /Sup3rS3cret|abc123def456|Kq7Rt2Xz9/);
  }
});

test('audit regression: SSH/git userinfo addresses are not over-masked as emails', async () => {
  for (const input of [
    'git remote add origin git@github.com:acme/app.git',
    'ssh://deploy@host.acme.io/repo',
    'https://user@github.com/acme/app.git',
  ]) {
    const out = await screenOutbound({
      body: { messages: [{ role: 'user', content: input }] },
      sessionId: 'audit-addr',
      route: 'openrouter-zdr',
    });
    assert.equal(out.action, 'sent');
    assert.equal(out.body.messages[0].content, input);
  }
});

test('audit regression: adversarial long key:value and unbalanced bracket lines finish in bounded time', () => {
  const kvLine = 'a: b '.repeat(4000);
  const t0 = performance.now();
  const kvFindings = detectAll(kvLine);
  const kvMs = performance.now() - t0;
  assert.deepEqual(kvFindings, []);
  assert.ok(kvMs < 500, `20KB key:value line took ${kvMs.toFixed(1)}ms`);

  const bracketLine = 'DB_PASS=' + '[a'.repeat(8000);
  const t1 = performance.now();
  const bracketFindings = detectAll(bracketLine);
  const bracketMs = performance.now() - t1;
  assert.deepEqual(bracketFindings, []);
  assert.ok(bracketMs < 1500, `16KB unbalanced [ line took ${bracketMs.toFixed(1)}ms`);
});

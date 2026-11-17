// The audit measured memory storage bypassing the privacy gate: personal data was
// stored in the clear because `screen` only ever masked `class === 'credential'`.
// These tests prove the whole path — write, storage, injection — carries pseudonyms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createMemoryLayer } from '../index.mjs';
import { addMemory, memoryStatus } from '../api.mjs';
import { createMemoryRoutes } from '../routes.mjs';
import { withMemoryBlock } from '../extension.mjs';
import { screen } from '../guard.mjs';
import { tempDir } from './helpers.mjs';

const PHONE = '010-1234-5678';
const RRN = '900101-1234568';
const BODY = `전화 ${PHONE} / 주민 ${RRN}`;

test('personal data never lands in the database or the injected prompt', async () => {
  const tmp = tempDir('privacy');
  const layer = await createMemoryLayer({ dbPath: tmp.dbPath, project: 'demo', embedModel: 'local-hash-3gram-v1' });
  try {
    const written = layer.capture.write({
      type: 'user-preference',
      title: '연락처',
      body: BODY,
      sessionId: 'session-privacy',
      sourceEvent: 'prompt:remember',
      sourceKind: 'user',
      createdAt: '2026-11-18T09:00:00.000Z',
    });
    assert.ok(written.id, JSON.stringify(written));
    const stored = layer.store.get(written.id);
    assert.ok(!stored.body.includes(PHONE), `stored body kept the phone: ${stored.body}`);
    assert.ok(!stored.body.includes(RRN), `stored body kept the resident number: ${stored.body}`);
    assert.match(stored.body, /\[PHONE_1\]/);
    assert.match(stored.body, /\[RRN_1\]/);
    assert.equal(stored.secretsRedacted, true, 'the row records that masking happened');

    // The file, not just the read path: nothing on disk carries the original.
    const bytes = readFileSync(tmp.dbPath);
    assert.equal(bytes.includes(PHONE), false, 'the raw phone number reached the SQLite file');
    assert.equal(bytes.includes(RRN), false, 'the raw resident number reached the SQLite file');

    // A row that escaped the write gate still cannot reach the prompt raw.
    const prompt = withMemoryBlock(['you are a coding agent'], `- (선호) 연락처 — 전화 ${PHONE} / 주민 ${RRN}`);
    assert.equal(prompt.length, 2);
    assert.ok(!prompt[1].includes(PHONE) && !prompt[1].includes(RRN), prompt[1]);
    assert.equal(prompt[1].includes('you are a coding agent'), false);
  } finally {
    await layer.close();
    tmp.cleanup();
  }
});

test('the HTTP add path screens exactly like the capture path', async () => {
  const tmp = tempDir('privacy-api');
  const layer = await createMemoryLayer({ dbPath: tmp.dbPath, project: 'demo', embedModel: 'local-hash-3gram-v1' });
  try {
    const added = addMemory(layer, { type: 'user-preference', title: '연락처', body: BODY });
    assert.equal(added.ok, true);
    const stored = layer.store.get(added.id);
    assert.ok(!stored.body.includes(PHONE) && !stored.body.includes(RRN), stored.body);
    const verdict = screen({ sessionId: 's', sourceEvent: 'e', createdAt: '2026-11-18T09:00:00.000Z', title: 't', body: BODY });
    assert.deepEqual(verdict.rules, ['korean_rrn', 'phone_number']);
  } finally {
    await layer.close();
    tmp.cleanup();
  }
});

test('a refused write answers 422 and stores nothing', async () => {
  const tmp = tempDir('privacy-refusal');
  const layer = await createMemoryLayer({ dbPath: tmp.dbPath, project: 'demo', embedModel: 'local-hash-3gram-v1' });
  try {
    const handle = createMemoryRoutes({ layer });
    const secret = 'key sk-proj-abcdefghijklmnopqrstuvwx';
    const res = mockRes();
    await handle(mockReq('/api/memory/add', 'POST', { type: 'past-task', title: '키 보관', body: secret }), res);
    assert.equal(res.statusCode, 422, 'the gate refusal must reach the caller as the gate status');
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'privacy_guard_blocked');
    assert.equal(res.body.includes(secret), false, 'the refusal must not echo the secret');
    assert.equal(layer.store.count({ status: 'active' }), 0, 'a refused write stores nothing');
    assert.ok(layer.store.auditLog(5).some((row) => row.action === 'reject'), 'the refusal is audited');
  } finally {
    await layer.close();
    tmp.cleanup();
  }
});

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(code, headers = {}) { this.statusCode = code; Object.assign(this.headers, headers); },
    end(chunk = '') { this.body += chunk; },
  };
}

function mockReq(url, method, bodyObj) {
  const raw = Buffer.from(JSON.stringify(bodyObj));
  const stream = new Readable({
    read() {
      this.push(raw);
      this.push(null);
    },
  });
  stream.url = url;
  stream.method = method;
  stream.headers = { host: 'localhost' };
  return stream;
}

test('status reports a genuine per-type count while keeping the types array', async () => {
  const tmp = tempDir('privacy-status');
  const layer = await createMemoryLayer({ dbPath: tmp.dbPath, project: 'demo', embedModel: 'local-hash-3gram-v1' });
  try {
    addMemory(layer, { type: 'project-rule', title: '빌드는 bun run build', body: 'bun run build 를 쓴다.' });
    addMemory(layer, { type: 'project-rule', title: '테스트는 bun test', body: 'bun test 를 쓴다.' });
    addMemory(layer, { type: 'error-fix', title: '포트 충돌 해결', body: '이전 프로세스를 종료한다.' });
    const status = memoryStatus(layer);
    assert.ok(Array.isArray(status.types), 'the existing types shape must stay an array of names');
    assert.equal(status.types.length, 6);
    assert.deepEqual(status.typeCounts, {
      'user-preference': 0,
      'project-rule': 2,
      'past-task': 0,
      'error-fix': 1,
      'exploration-finding': 0,
      'failure-analysis': 0,
    });
    assert.equal(status.typeBreakdown.length, 6);
    assert.equal(status.typeBreakdown.reduce((sum, bar) => sum + bar.count, 0), status.active);
    // A real aggregate, not a fabricated 1 per bar: the counts differ from each other.
    assert.ok(new Set(status.typeBreakdown.map((bar) => bar.count)).size > 1);
  } finally {
    await layer.close();
    tmp.cleanup();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryCapture } from '../capture.mjs';
import { classifyText, errorSignature, explicitMemories, wantsRemember } from '../extract.mjs';
import { MemoryStore } from '../store.mjs';
import { tempDir } from './helpers.mjs';

test('detects an explicit remember request in Korean and English', () => {
  assert.equal(wantsRemember('기억해줘: 빌드는 bun run build 를 쓴다'), true);
  assert.equal(wantsRemember('remember that the stub runs on 8799'), true);
  assert.equal(wantsRemember('그냥 질문이야'), false);
});

test('explicit memories are typed by their wording', () => {
  assert.equal(classifyText('항상 한국어 존댓말로 답한다'), 'user-preference');
  assert.equal(classifyText('오류는 포트 충돌 때문이었고 이전 프로세스를 종료해서 해결했다'), 'error-fix');
  assert.equal(classifyText('반드시 커밋 전에 테스트를 실행한다'), 'project-rule');
});

test('extracts saveable candidates with provenance from a prompt', () => {
  const candidates = explicitMemories({
    prompt: '기억해줘: 빌드는 bun run build 이다. 항상 한국어로 답한다.',
    sessionId: 'session-a',
    at: '2026-11-18T09:00:00.000Z',
  });
  assert.ok(candidates.length >= 1);
  for (const item of candidates) {
    assert.equal(item.sessionId, 'session-a');
    assert.equal(item.sourceEvent, 'prompt:remember');
    assert.ok(item.createdAt);
    assert.ok(item.title.length >= 8);
  }
});

test('error signatures ignore stacks, paths and line numbers', () => {
  const a = errorSignature('bash', { content: [{ type: 'text', text: 'Error: listen EADDRINUSE 127.0.0.1:8799\n    at Server._listen2 (/x/y.js:12:3)' }] }, { command: 'node stub.mjs' });
  const b = errorSignature('bash', { content: [{ type: 'text', text: 'Error: listen EADDRINUSE 127.0.0.1:8799\n    at other (/z.js:99:9)' }] }, { command: 'node stub.mjs' });
  assert.equal(a.key, b.key);
  assert.match(a.message, /EADDRINUSE/);
});

test('a failure followed by a success becomes one error-fix memory', async () => {
  const tmp = tempDir('capture');
  const store = await MemoryStore.open({ dbPath: tmp.dbPath });
  const capture = new MemoryCapture(store);
  try {
    const failed = capture.onToolEnd({
      toolName: 'bash',
      args: { command: 'node stub.mjs' },
      result: { content: [{ type: 'text', text: 'Error: listen EADDRINUSE 127.0.0.1:8799' }] },
      isError: true,
      sessionId: 'session-a',
      at: '2026-11-18T09:00:00.000Z',
    });
    assert.equal(failed.length, 1);
    assert.equal(store.list({ status: 'active' })[0].type, 'failure-analysis');
    const fixed = capture.onToolEnd({
      toolName: 'bash',
      args: { command: 'node stub.mjs --port 8800' },
      result: { content: [{ type: 'text', text: 'stub upstream listening on http://127.0.0.1:8800' }] },
      isError: false,
      sessionId: 'session-a',
      at: '2026-11-18T09:01:00.000Z',
    });
    assert.equal(fixed.length, 1);
    assert.equal(fixed[0].action, 'inserted');
    const memory = store.get(fixed[0].id);
    assert.equal(memory.type, 'error-fix');
    assert.match(memory.body, /EADDRINUSE/);
    assert.match(memory.body, /성공/);
    assert.equal(memory.sourceKind, 'tool');
  } finally {
    store.close();
    tmp.cleanup();
  }
});

test('a tool-derived memory enters at the low trust tier', async () => {
  const tmp = tempDir('trust');
  const store = await MemoryStore.open({ dbPath: tmp.dbPath });
  const capture = new MemoryCapture(store);
  try {
    const writes = capture.onToolEnd({
      toolName: 'grep',
      args: { pattern: 'launchArguments' },
      result: { content: [{ type: 'text', text: 'app/public/protocol.js:77:export function launchArguments(extra)' }] },
      isError: false,
      sessionId: 'session-b',
      at: '2026-11-18T09:00:00.000Z',
    });
    assert.equal(writes.length, 1);
    const memory = store.get(writes[0].id);
    assert.equal(memory.type, 'exploration-finding');
    assert.equal(memory.trust, 'low');
    assert.equal(memory.sourceKind, 'tool');
  } finally {
    store.close();
    tmp.cleanup();
  }
});

test('a secret inside a captured prompt is never written', async () => {
  const tmp = tempDir('secret');
  const store = await MemoryStore.open({ dbPath: tmp.dbPath });
  const capture = new MemoryCapture(store);
  try {
    const writes = capture.onPrompt({
      prompt: '기억해줘: API 키 sk-proj-abcdefghijklmnopqrstuvwx 를 사용한다',
      sessionId: 'session-a',
      at: '2026-11-18T09:00:00.000Z',
    });
    const stored = store.list({ status: 'active' });
    assert.equal(stored.some((row) => /sk-proj-abcdefghijklmnopqrstuvwx/.test(row.body)), false);
    assert.ok(store.auditLog(20).some((row) => row.action === 'guard' || row.action === 'reject'));
    assert.ok(writes.length >= 0);
  } finally {
    store.close();
    tmp.cleanup();
  }
});

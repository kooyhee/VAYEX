import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store.mjs';
import { candidate, NOW, tempDir } from './helpers.mjs';

test('stores, lists and reads back a memory with full provenance', async () => {
  const tmp = tempDir('store');
  const store = await MemoryStore.open({ dbPath: tmp.dbPath, project: 'demo' });
  try {
    const result = store.add(candidate());
    assert.equal(result.action, 'inserted');
    const memory = store.get(result.id);
    assert.equal(memory.sessionId, 'session-a');
    assert.equal(memory.sourceEvent, 'prompt:remember');
    assert.equal(memory.createdAt, NOW);
    assert.equal(memory.status, 'active');
    assert.equal(memory.type, 'project-rule');
    assert.match(memory.tags, /bun/);
    assert.equal(store.stats().active, 1);
  } finally {
    store.close();
    tmp.cleanup();
  }
});

// `|| true` used to defeat both filters: a project-scoped call returned every project.
test('project scope really filters candidates and keyword ranks', async () => {
  const tmp = tempDir('scope');
  const store = await MemoryStore.open({ dbPath: tmp.dbPath, project: 'demo' });
  try {
    const mine = store.add(candidate({ project: 'demo', title: '빌드는 bun run build', body: '빌드 명령은 bun run build 이다.' })).id;
    const other = store.add(candidate({ project: 'other', title: '테스트는 bun test', body: '테스트 명령은 bun test 이다.' })).id;
    const all = store.candidates();
    assert.equal(all.length, 2, 'an unscoped read still sees every project');
    const scoped = store.candidates({ project: 'demo' });
    assert.deepEqual(scoped.map((row) => row.id), [mine]);
    const ranked = store.keywordRank('bun', { project: 'demo' });
    assert.deepEqual(ranked.map((hit) => hit.id), [mine], 'the other project must not out-rank the scope');
    assert.ok(store.keywordRank('bun', { project: 'other' }).some((hit) => hit.id === other));
    assert.equal(store.keywordRank('bun', { project: 'nobody' }).length, 0);
  } finally {
    store.close();
    tmp.cleanup();
  }
});

test('survives a process restart: a second open sees the same rows', async () => {
  const tmp = tempDir('restart');
  const first = await MemoryStore.open({ dbPath: tmp.dbPath });
  const id = first.add(candidate()).id;
  first.close();
  const second = await MemoryStore.open({ dbPath: tmp.dbPath });
  try {
    const memory = second.get(id);
    assert.ok(memory, 'memory must persist across process restarts');
    assert.equal(memory.title, '빌드는 bun run build로 실행한다');
    assert.equal(second.count({ status: 'active' }), 1);
  } finally {
    second.close();
    tmp.cleanup();
  }
});

test('merges a near-duplicate instead of storing it twice', async () => {
  const tmp = tempDir('merge');
  const store = await MemoryStore.open({ dbPath: tmp.dbPath });
  try {
    const first = store.add(candidate());
    const second = store.add(candidate({ sourceEvent: 'prompt:again', sessionId: 'session-b' }));
    assert.equal(second.action, 'merged');
    assert.equal(second.id, first.id);
    const memory = store.get(first.id);
    assert.equal(memory.version, 2);
    assert.equal(memory.dedupeHits, 1);
    assert.equal(store.count({ status: 'active' }), 1);
  } finally {
    store.close();
    tmp.cleanup();
  }
});

test('a newer value supersedes a stale one without deleting it', async () => {
  const tmp = tempDir('supersede');
  const store = await MemoryStore.open({ dbPath: tmp.dbPath });
  try {
    const stale = store.add(candidate({ title: '빌드는 npm run build', body: '예전에는 npm run build 를 썼다', subjectKey: 'build-command' }));
    const fresh = store.add(candidate({ title: '빌드는 bun run build', body: '이제 bun run build 를 쓴다', subjectKey: 'build-command', createdAt: '2026-11-18T10:00:00.000Z' }));
    assert.equal(fresh.action, 'inserted');
    const old = store.get(stale.id);
    assert.equal(old.status, 'superseded');
    assert.equal(old.supersededBy, fresh.id);
    const current = store.get(fresh.id);
    assert.equal(current.supersedes, stale.id);
    assert.equal(store.count({ status: 'active' }), 1, 'only the current value is active');
    assert.equal(store.count({ status: 'superseded' }), 1, 'the stale row is kept, not deleted');
  } finally {
    store.close();
    tmp.cleanup();
  }
});

test('edit bumps the version and re-indexes the keyword text', async () => {
  const tmp = tempDir('edit');
  const store = await MemoryStore.open({ dbPath: tmp.dbPath });
  try {
    const id = store.add(candidate({ title: 'flake8 규칙', body: 'python 검사는 ruff 를 사용한다' })).id;
    assert.ok(store.keywordRank('ruff').length > 0);
    store.update(id, { body: 'python 타입 검사는 mypy 를 사용한다' });
    assert.equal(store.get(id).version, 2);
    assert.equal(store.keywordRank('ruff').length, 0, 'the old text must leave the FTS index');
    assert.ok(store.keywordRank('mypy').length > 0, 'the new text must enter the FTS index');
  } finally {
    store.close();
    tmp.cleanup();
  }
});

test('delete is a soft deprecation; purge removes the row', async () => {
  const tmp = tempDir('delete');
  const store = await MemoryStore.open({ dbPath: tmp.dbPath });
  try {
    const id = store.add(candidate()).id;
    assert.equal(store.remove(id), true);
    assert.equal(store.get(id).status, 'deleted');
    assert.equal(store.count({ status: 'active' }), 0);
    assert.equal(store.remove(id, { hard: true }), true);
    assert.equal(store.get(id), null);
  } finally {
    store.close();
    tmp.cleanup();
  }
});

test('keyword search sanitizes punctuation-heavy queries', async () => {
  const tmp = tempDir('fts');
  const store = await MemoryStore.open({ dbPath: tmp.dbPath });
  try {
    store.add(candidate({ title: 'launchArguments가 RPC 인자를 만든다', body: "protocol.js:77 'launchArguments' 가 ['--mode','rpc'] 를 만든다" }));
    const rows = store.keywordRank('launchArguments() -> ["--mode","rpc"]');
    assert.ok(rows.length > 0, 'operators and punctuation must not raise an fts5 syntax error');
  } finally {
    store.close();
    tmp.cleanup();
  }
});

test('audit log records rejected, merged and superseded writes', async () => {
  const tmp = tempDir('audit');
  const store = await MemoryStore.open({ dbPath: tmp.dbPath });
  try {
    store.add(candidate());
    store.add(candidate());
    const actions = store.auditLog(10).map((row) => row.action);
    assert.ok(actions.includes('insert'));
    assert.ok(actions.includes('merge'));
  } finally {
    store.close();
    tmp.cleanup();
  }
});

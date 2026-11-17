import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createMemoryLayer } from '../index.mjs';
import { addMemory, deleteMemory, getMemory, listMemories, memoryStatus, updateMemory } from '../api.mjs';
import { createMemoryRoutes } from '../routes.mjs';
import { memoryResumeState } from '../resume.mjs';
import { tempDir } from './helpers.mjs';

async function testLayer() {
  const tmp = tempDir('api');
  const layer = await createMemoryLayer({ dbPath: tmp.dbPath, project: 'demo', embedModel: 'local-hash-3gram-v1' });
  return { layer, cleanup: async () => { await layer.close(); tmp.cleanup(); } };
}

test('API surface: list / view / edit / delete', async () => {
  const { layer, cleanup } = await testLayer();
  try {
    const created = addMemory(layer, {
      type: 'project-rule',
      title: '빌드는 bun run build',
      body: '이 프로젝트는 bun run build 로 실행한다.',
    });
    assert.equal(created.ok, true);
    assert.ok(created.id);

    const memory = getMemory(layer, created.id);
    assert.equal(memory.title, '빌드는 bun run build');

    const listed = listMemories(layer, { limit: 10 });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].id, created.id);

    const updated = updateMemory(layer, created.id, { body: '이제 make build 로 바뀜' });
    assert.equal(updated.ok, true);
    assert.equal(getMemory(layer, created.id).body, '이제 make build 로 바뀜');

    const deleted = deleteMemory(layer, created.id);
    assert.equal(deleted.ok, true);
    assert.equal(listMemories(layer).total, 0, 'soft delete drops from active list');

    const status = memoryStatus(layer);
    assert.equal(status.active, 0);
    assert.equal(status.project, 'demo');
  } finally {
    await cleanup();
  }
});

test('HTTP route handler serves status, list, search and mutations', async () => {
  const { layer, cleanup } = await testLayer();
  try {
    const handle = createMemoryRoutes({ layer });
    addMemory(layer, { type: 'project-rule', title: '스텁 포트는 8799', body: '스텁 포트 8799' });

    const getRes = mockRes();
    const handled = await handle({ url: '/api/memory/list', method: 'GET' }, getRes);
    assert.equal(handled, true);
    assert.equal(getRes.statusCode, 200);
    const body = JSON.parse(getRes.body);
    assert.equal(body.total, 1);

    const statusRes = mockRes();
    await handle({ url: '/api/memory/status', method: 'GET' }, statusRes);
    assert.equal(statusRes.statusCode, 200);

    const postRes = mockRes();
    await handle(mockReq('/api/memory/add', 'POST', {
      type: 'user-preference',
      title: '한국어 존댓말',
      body: '한국어로 정중하게 답한다.',
    }), postRes);
    assert.equal(postRes.statusCode, 200);
    assert.equal(listMemories(layer).total, 2);

    const searchRes = mockRes();
    await handle({ url: '/api/memory/search?q=스텁', method: 'GET' }, searchRes);
    assert.equal(searchRes.statusCode, 200);
    assert.ok(JSON.parse(searchRes.body).items.length >= 1);
  } finally {
    await cleanup();
  }
});

test('resume hook returns bounded, task-relevant memories for app/dx/task-resume', async () => {
  const { layer, cleanup } = await testLayer();
  try {
    addMemory(layer, { type: 'project-rule', title: '빌드는 bun run build', body: 'bun 빌드' });
    addMemory(layer, { type: 'error-fix', title: '포트 충돌 8799 해결', body: '이전 프로세스 kill' });
    const state = await memoryResumeState(layer, 'session-resume-1', { query: '포트 충돌' });
    assert.equal(state.sessionKey, 'session-resume-1');
    assert.ok(state.count >= 1);
    assert.ok(state.text.length <= 900);
    assert.match(state.text, /포트 충돌/);
    assert.equal(state.source, 'app/memory');
  } finally {
    await cleanup();
  }
});

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
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

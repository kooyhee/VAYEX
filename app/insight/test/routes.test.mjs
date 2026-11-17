import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInsightRouter } from '../routes.mjs';

function start(router) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const handled = await router.handle(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end('not handled');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function call(port, path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json() };
}

const events = [
  { type: 'task.file_change', task: 't-1', data: { path: 'app/insight/metrics.mjs', change: 'modified' } },
];

test('routes: POST /api/insight/summarize returns per-task Korean lines in rules tier when weights absent', async () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), 'insight-routes-empty-'));
  const { server, port } = await start(createInsightRouter({
    loadEvents: () => ({ events: [], reported: false, path: null }),
    modelRoot: emptyRoot,
    modelEnv: {},
  }));
  try {
    const { status, json } = await call(port, '/api/insight/summarize', { method: 'POST', body: { events } });
    assert.equal(status, 200);
    assert.equal(json.tasks.length, 1);
    assert.equal(json.tasks[0].taskId, 't-1');
    assert.equal(json.tier, 'rules');
    assert.match(json.tasks[0].modified[0], /수정했습니다/);
    assert.equal(json.source.reported, true);
  } finally {
    server.close();
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test('routes: POST /api/insight/summarize supports frontend { tasks } payload for both rules and local-model', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'insight-routes-tasks-'));
  const emptyRoot = join(scratch, 'empty');
  const modelRoot = join(scratch, 'with-model');
  mkdirSync(emptyRoot, { recursive: true });
  const runtime = join(modelRoot, 'node_modules', '@huggingface', 'transformers');
  const modelDir = join(modelRoot, 'models', 'Qwen2.5-0.5B-Instruct');
  mkdirSync(runtime, { recursive: true });
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, 'config.json'), '{}');
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }));
  writeFileSync(join(runtime, 'index.cjs'), 'exports.env = {}; exports.pipeline = async () => async () => [];');

  const tasksPayload = {
    tasks: [
      {
        taskId: 't-1',
        taskName: '라우터 정리',
        changes: [
          { path: 'app/insight/routes.mjs', category: '수정', subject: '라우터', added: 12, removed: 3 },
        ],
      },
    ],
  };

  const rulesServer = await start(createInsightRouter({
    modelRoot: emptyRoot,
    modelEnv: {},
  }));
  const modelServer = await start(createInsightRouter({
    modelRoot,
    modelEnv: {},
    generator: async () => [{
      generated_text: JSON.stringify({
        tasks: [{ taskId: 't-1', rows: [{ category: '수정', text: '인사이트 라우터의 요청 처리 흐름을 정리했습니다.' }] }],
      }),
    }],
  }));
  try {
    const rulesRes = await call(rulesServer.port, '/api/insight/summarize', { method: 'POST', body: tasksPayload });
    assert.equal(rulesRes.status, 200);
    assert.equal(rulesRes.json.tier, 'rules');
    assert.equal(rulesRes.json.source, 'rules');
    assert.deepEqual(rulesRes.json.tasks, []);
    assert.equal(rulesRes.json.fallbackReason, 'weights_not_installed');

    const modelRes = await call(modelServer.port, '/api/insight/summarize', { method: 'POST', body: tasksPayload });
    assert.equal(modelRes.status, 200);
    assert.equal(modelRes.json.tier, 'local-model');
    assert.equal(modelRes.json.source, 'model');
    assert.equal(modelRes.json.modelId, 'Qwen2.5-0.5B-Instruct');
    assert.equal(modelRes.json.tasks.length, 1);
    assert.equal(modelRes.json.tasks[0].rows[0].category, '수정');
    assert.equal(modelRes.json.tasks[0].rows[0].text, '인사이트 라우터의 요청 처리 흐름을 정리했습니다.');
  } finally {
    rulesServer.server.close();
    modelServer.server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('routes: POST /api/insight/summarize answers nothing_to_summarize for an empty revision without generating', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'insight-routes-nochange-'));
  const modelRoot = join(scratch, 'with-model');
  const runtime = join(modelRoot, 'node_modules', '@huggingface', 'transformers');
  const modelDir = join(modelRoot, 'models', 'Qwen2.5-0.5B-Instruct');
  mkdirSync(runtime, { recursive: true });
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, 'config.json'), '{}');
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }));
  writeFileSync(join(runtime, 'index.cjs'), 'exports.env = {}; exports.pipeline = async () => async () => [];');

  let generatorCalls = 0;
  const server = await start(createInsightRouter({
    modelRoot,
    modelEnv: {},
    generator: async () => {
      generatorCalls += 1;
      return [{ generated_text: '{}' }];
    },
  }));
  try {
    const startedAt = Date.now();
    const res = await call(server.port, '/api/insight/summarize', {
      method: 'POST',
      body: { tasks: [{ taskId: 't-1', taskName: '빈 개정', changes: [] }] },
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(res.status, 200);
    assert.equal(res.json.tier, 'rules');
    assert.equal(res.json.source, 'rules');
    assert.deepEqual(res.json.tasks, []);
    assert.equal(res.json.fallbackReason, 'nothing_to_summarize');
    assert.equal(res.json.localModel.available, true);
    assert.ok(elapsedMs < 100, `empty revision answered in ${elapsedMs}ms`);
    assert.equal(generatorCalls, 0);
  } finally {
    server.server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('routes: POST /api/insight/title and GET /api/insight/local-model work for rules and local-model', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'insight-routes-title-'));
  const emptyRoot = join(scratch, 'empty');
  const modelRoot = join(scratch, 'with-model');
  mkdirSync(emptyRoot, { recursive: true });
  const runtime = join(modelRoot, 'node_modules', '@huggingface', 'transformers');
  const modelDir = join(modelRoot, 'models', 'Qwen2.5-0.5B-Instruct');
  mkdirSync(runtime, { recursive: true });
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, 'config.json'), '{}');
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }));
  writeFileSync(join(runtime, 'index.cjs'), 'exports.env = {}; exports.pipeline = async () => async () => [];');

  const rulesServer = await start(createInsightRouter({ modelRoot: emptyRoot, modelEnv: {} }));
  const modelServer = await start(createInsightRouter({
    modelRoot,
    modelEnv: {},
    titleGenerator: async () => [{ generated_text: '"로컬 모델 세션 제목 생성기 구현"' }],
  }));
  try {
    const probeRes = await call(modelServer.port, '/api/insight/local-model');
    assert.equal(probeRes.status, 200);
    assert.equal(probeRes.json.available, true);
    assert.equal(probeRes.json.candidate.id, 'Qwen2.5-0.5B-Instruct');

    const fallbackRes = await call(rulesServer.port, '/api/insight/title', {
      method: 'POST',
      body: { prompt: '세션 제목 자동 생성 기능을 app/insight/routes.mjs에 추가해 줘', files: ['app/insight/routes.mjs'] },
    });
    assert.equal(fallbackRes.status, 200);
    assert.equal(fallbackRes.json.tier, 'rules');
    assert.equal(fallbackRes.json.source, 'rules');
    assert.equal(fallbackRes.json.fallbackReason, 'weights_not_installed');
    assert.ok(fallbackRes.json.title.length >= 2 && fallbackRes.json.title.length <= 36);
    assert.ok(!fallbackRes.json.title.includes('.mjs'));

    const modelRes = await call(modelServer.port, '/api/insight/title', {
      method: 'POST',
      body: { prompt: '세션 제목 자동 생성 기능 구현', reply: '완료했습니다.' },
    });
    assert.equal(modelRes.status, 200);
    assert.equal(modelRes.json.tier, 'local-model');
    assert.equal(modelRes.json.source, 'model');
    assert.equal(modelRes.json.modelId, 'Qwen2.5-0.5B-Instruct');
    assert.equal(modelRes.json.title, '로컬 모델 세션 제목 생성기 구현');
  } finally {
    rulesServer.server.close();
    modelServer.server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('routes: GET /api/insight/metrics reports missing fields honestly', async () => {
  const { server, port } = await start(createInsightRouter({
    loadEvents: () => ({ events: [], reported: true, path: 'x.jsonl', skipped: 0 }),
  }));
  try {
    const { status, json } = await call(port, '/api/insight/metrics?session=s-1');
    assert.equal(status, 200);
    assert.equal(json.cache.reported, false);
    assert.equal(json.model.reported, false);
    assert.equal(json.format.cache, '미보고');
  } finally {
    server.close();
  }
});

test('routes: an absent event log is named, not invented', async () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), 'insight-routes-absent-'));
  const { server, port } = await start(createInsightRouter({
    loadEvents: () => ({ events: [], reported: false, path: null, reason: 'no_event_log_path' }),
    modelRoot: emptyRoot,
    modelEnv: {},
  }));
  try {
    const { status, json } = await call(port, '/api/insight/summary');
    assert.equal(status, 200);
    assert.equal(json.tasks.length, 0);
    assert.equal(json.source.reported, false);
    assert.equal(json.source.reason, 'no_event_log_path');
  } finally {
    server.close();
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test('routes: POST /api/insight/title keeps one title per session and never oscillates tiers', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'insight-routes-title-stable-'));
  const modelRoot = join(scratch, 'with-model');
  const runtime = join(modelRoot, 'node_modules', '@huggingface', 'transformers');
  const modelDir = join(modelRoot, 'models', 'Qwen2.5-0.5B-Instruct');
  mkdirSync(runtime, { recursive: true });
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, 'config.json'), '{}');
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }));
  writeFileSync(join(runtime, 'index.cjs'), 'exports.env = {}; exports.pipeline = async () => async () => [];');

  let calls = 0;
  const answers = ['"세션 제목 생성 수정"', '"세션 제목 생성 정리"', '"제목을 정리했습니다"'];
  const { server, port } = await start(createInsightRouter({
    modelRoot,
    modelEnv: {},
    titleGenerator: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      return [{ generated_text: answer }];
    },
  }));
  try {
    const body = { prompt: '세션 제목 자동 생성이 이상해요. 프롬프트랑 fallback을 고쳐 줘.', session: 's-1' };

    const first = await call(port, '/api/insight/title', { method: 'POST', body });
    assert.equal(first.status, 200);
    assert.equal(first.json.tier, 'local-model');
    assert.equal(first.json.title, '세션 제목 생성 수정');
    assert.equal(first.json.session, 's-1');
    assert.equal(first.json.cached, false);
    assert.equal(calls, 1);

    // The same revision answers from the record: the model is not asked twice.
    const again = await call(port, '/api/insight/title', { method: 'POST', body });
    assert.equal(again.json.title, '세션 제목 생성 수정');
    assert.equal(again.json.cached, true);
    assert.equal(calls, 1);

    // A settled revision may refine the title once...
    const settled = await call(port, '/api/insight/title', {
      method: 'POST',
      body: { ...body, reply: '프롬프트를 고쳤습니다.', settled: true },
    });
    assert.equal(settled.json.title, '세션 제목 생성 정리');
    assert.equal(settled.json.settled, true);
    assert.equal(calls, 2);

    // ...and a settled session never runs the model again.
    const after = await call(port, '/api/insight/title', {
      method: 'POST',
      body: { ...body, reply: '다시 고쳤습니다.', settled: true },
    });
    assert.equal(after.json.title, '세션 제목 생성 정리');
    assert.equal(after.json.cached, true);
    assert.equal(calls, 2);

    // A different session is a different title, keyed separately.
    const other = await call(port, '/api/insight/title', { method: 'POST', body: { ...body, session: 's-2' } });
    assert.equal(other.json.session, 's-2');
    assert.equal(calls, 3);
  } finally {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('routes: a refinement that turns unusable never downgrades a model title to a rule one', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'insight-routes-title-downgrade-'));
  const modelRoot = join(scratch, 'with-model');
  const runtime = join(modelRoot, 'node_modules', '@huggingface', 'transformers');
  const modelDir = join(modelRoot, 'models', 'Qwen2.5-0.5B-Instruct');
  mkdirSync(runtime, { recursive: true });
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, 'config.json'), '{}');
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }));
  writeFileSync(join(runtime, 'index.cjs'), 'exports.env = {}; exports.pipeline = async () => async () => [];');

  let calls = 0;
  const { server, port } = await start(createInsightRouter({
    modelRoot,
    modelEnv: {},
    titleGenerator: async () => {
      const answer = calls === 0 ? '"세션 제목 생성 수정"' : '제목을 정리했습니다';
      calls += 1;
      return [{ generated_text: answer }];
    },
  }));
  try {
    const body = { prompt: '세션 제목 자동 생성을 고쳐 줘.', session: 's-9' };
    const first = await call(port, '/api/insight/title', { method: 'POST', body });
    assert.equal(first.json.tier, 'local-model');
    assert.equal(first.json.title, '세션 제목 생성 수정');

    const refined = await call(port, '/api/insight/title', {
      method: 'POST',
      body: { ...body, prompt: '세션 제목 자동 생성을 다시 고쳐 줘.', reply: '고쳤습니다.' },
    });
    assert.equal(refined.json.title, '세션 제목 생성 수정', 'the model title is kept');
    assert.equal(refined.json.tier, 'local-model');
    assert.equal(refined.json.fallbackReason, 'unusable_output', 'the failed refinement is still reported');
    assert.equal(calls, 2);
  } finally {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});


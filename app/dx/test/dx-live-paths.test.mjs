// Regression tests for the DX behaviours that used to exist only in their documentation:
// live turn accounting, cache hit rate, the memory hook on resume, the pre-edit snapshot
// taken by the running bridge, manifest reload after a restart, POST snapshot/diff and
// the documented network-disconnection error category.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { CostAnalytics, SnapshotManager, createDxRouter, explainError, fileModifyingPaths } from '../index.mjs';

async function createTempDir(prefix = 'dx-live-') {
  return await mkdtemp(join(tmpdir(), prefix));
}

/** Run one router behind a real HTTP listener, the way app/server.mjs mounts it. */
async function withRouter(options, run) {
  const router = createDxRouter(options);
  const server = http.createServer(async (req, res) => {
    const handled = await router.handle(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ router, baseUrl });
  } finally {
    await new Promise((done) => server.close(done));
  }
}

// A record with the exact shape gateway/lib/accounting.mjs `accountRequest` emits.
function turn(overrides = {}) {
  return {
    v: 1,
    seq: 1,
    ts: '2026-11-18T09:00:00.000Z',
    type: 'llm_turn',
    session: 's-1',
    taskId: 't-live',
    route: 'zdr_cloud',
    model: 'gpt-4o-mini',
    provider: 'openai',
    promptTokens: 800,
    completionTokens: 200,
    cachedTokens: 600,
    cost: { usd: 0.00042, baselineUsd: 0.0033, savedUsd: 0.00288 },
    ...overrides,
  };
}

// =========================================================================
// 0. The running bridge is the live path: its own router sees real accounting
// =========================================================================
test('the running bridge serves a cost overview built from gateway llm_turn events', async () => {
  const { createBridge } = await import('../../server.mjs');
  const { accountRequest } = await import('../../../gateway/lib/accounting.mjs');
  const stateDir = await createTempDir('dx-bridge-state-');
  const app = await createBridge({ mock: true, config: { stateDir } });
  try {
    const url = await app.start(0);
    const before = await (await fetch(`${url}/api/dx/cost/overview`)).json();
    assert.equal(before.totalTokens, 0, 'a bridge that ran no turn reports no tokens');

    // The one accounting entry point a real turn goes through, on this process's bus.
    const accounted = accountRequest({
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 3_000_000, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 2_000_000 } },
      route: 'zdr_cloud',
      taskId: 't-bridge',
    });

    const after = await (await fetch(`${url}/api/dx/cost/overview`)).json();
    // The gateway reports 1,000,000 uncached prompt + 30 completion tokens, with the
    // 2,000,000 cache-read tokens counted on their own — the overview agrees with that
    // breakdown instead of charging the cached tokens at the full input rate.
    assert.equal(after.totalTokens, 1_000_030, 'the bridge reports the turn it actually accounted');
    assert.equal(after.cachedTokens, 2_000_000);
    assert.equal(after.totalSpendKrw, Math.round(accounted.cost.usd * 1400), 'spend is the measured cost, in KRW');
    assert.ok(after.totalSpendKrw > 0);
    assert.equal(after.cacheHitRateLabel, '66.7%', '2,000,000 cached of the 3,000,000 prompt tokens sent');
  } finally {
    await app.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

// =========================================================================
// 1. Live turn accounting reaches GET /api/dx/cost/overview
// =========================================================================
test('cost overview counts the real llm_turn stream the bridge subscribes to', async () => {
  const root = await createTempDir('dx-cost-root-');
  const state = await createTempDir('dx-cost-state-');
  const records = [];
  try {
    await withRouter({ projectRoot: root, stateDir: state, eventsFrom: () => records }, async ({ baseUrl }) => {
      const before = await (await fetch(`${baseUrl}/api/dx/cost/overview`)).json();
      assert.equal(before.totalTokens, 0, 'no turn has run yet');
      assert.equal(before.cacheHitRateLabel, '미집계', 'nothing measured is not a 0% hit rate');

      // A turn the provider reported in full, plus one that reported no usage at all.
      records.push(turn());
      records.push(turn({
        seq: 2,
        ts: '2026-11-18T09:00:01.000Z',
        taskId: 't-unreported',
        promptTokens: null,
        completionTokens: null,
        cachedTokens: null,
        cost: null,
      }));

      const after = await (await fetch(`${baseUrl}/api/dx/cost/overview`)).json();
      assert.equal(after.totalTokens, 1000, 'measured tokens only: 800 prompt + 200 completion');
      assert.equal(after.totalTasks, 1, 'the turn with no reported usage is not counted at all');
      // 0.00042 USD × 1400 KRW, the platform's own cost for the measured tokens — not
      // the DX default rate card, which would have charged 0.0054 USD (8 KRW).
      assert.equal(after.totalSpendKrw, 1);
      assert.equal(after.cacheHitRate, 42.9, 'cached 600 of 1400 cacheable tokens');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('cost analytics folds each live record in once, however often the overview is read', () => {
  const records = [turn()];
  const analytics = new CostAnalytics({ eventsFrom: () => records });
  assert.equal(analytics.getOverview().totalTokens, 1000);
  assert.equal(analytics.getOverview().totalTokens, 1000, 'a second read does not double-count');
});

// =========================================================================
// 2. Cache hit rate: per model and overall, with 미집계 distinct from 0%
// =========================================================================
test('cost analytics reports the cache hit rate per model and overall, and never invents a 0%', () => {
  const analytics = new CostAnalytics({ krwPerUsd: 1400 });
  analytics.recordEvent({
    taskId: 't-cache',
    type: 'llm_turn',
    model: 'claude-sonnet',
    route: 'zdr_cloud',
    promptTokens: 400,
    completionTokens: 100,
    cachedTokens: 600,
  });
  analytics.recordEvent({
    taskId: 't-cache',
    type: 'llm_turn',
    model: 'gpt-4o-mini',
    route: 'zdr_cloud',
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 300,
  });

  const task = analytics.getTaskCost('t-cache');
  assert.equal(task.cache.hitRate, 64.3, '(600 + 300) cached of (1000 + 900) cacheable');
  assert.equal(task.cache.label, '64.3%');
  const sonnet = task.cache.byModel.find((row) => row.model === 'claude-sonnet');
  const mini = task.cache.byModel.find((row) => row.model === 'gpt-4o-mini');
  assert.equal(sonnet.hitRate, 60, '600 of 1000 cacheable tokens on that model');
  assert.equal(mini.hitRate, 75, '300 of 400 cacheable tokens on that model');

  // A turn whose provider reported no cache figure leaves the rate 미집계 — not 0%.
  const unreported = new CostAnalytics();
  unreported.recordEvent({ taskId: 't-nocache', type: 'llm_turn', promptTokens: 500, completionTokens: 100 });
  const silent = unreported.getTaskCost('t-nocache');
  assert.equal(silent.cache.hitRate, null);
  assert.equal(silent.cache.label, '미집계');
  assert.equal(unreported.getOverview().cacheHitRateLabel, '미집계');
  assert.doesNotMatch(silent.koreanSummary, /캐시 적중률/, 'an unmeasured rate is not reported as a figure');

  // A provider that reported zero cached tokens reported a fact: that is a real 0%.
  const zero = new CostAnalytics();
  zero.recordEvent({ taskId: 't-zero', type: 'llm_turn', promptTokens: 500, completionTokens: 100, cachedTokens: 0 });
  assert.equal(zero.getTaskCost('t-zero').cache.hitRate, 0);
  assert.equal(zero.getTaskCost('t-zero').cache.label, '0%');
});

// =========================================================================
// 3. The memory hook is registered by the router, not by a test
// =========================================================================
test('POST /api/dx/tasks/resume restores memory state through the router-registered hook', async () => {
  const root = await createTempDir('dx-resume-root-');
  const state = await createTempDir('dx-resume-state-');
  try {
    // The smallest layer `memoryResumeState` reads: no ranking hits, one standing rule.
    const layer = {
      config: { project: 'demo' },
      embedder: null,
      store: {
        config: { project: 'demo' },
        candidates: () => [],
        keywordRank: () => [],
        list: () => [{
          id: 'm-1',
          type: 'project-rule',
          title: '빌드는 bun run build로 실행한다',
          body: '이 프로젝트의 빌드 명령은 bun run build 이다.',
          importance: 0.9,
          trustScore: 0.9,
          updatedAt: '2026-11-01T00:00:00.000Z',
        }],
      },
    };
    const options = { projectRoot: root, stateDir: state, resolveMemoryLayer: async () => layer };

    await withRouter(options, async ({ baseUrl }) => {
      await fetch(`${baseUrl}/api/dx/tasks/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 't-resume', sessionId: 'sess-7', request: '계산기 나눗셈 예외처리 추가' }),
      });
      const resumed = await (await fetch(`${baseUrl}/api/dx/tasks/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 't-resume' }),
      })).json();

      assert.equal(resumed.restored, true);
      assert.ok(resumed.memoryState, 'resume carries the memory state instead of null');
      assert.equal(resumed.memoryState.sessionKey, 'sess-7');
      assert.equal(resumed.memoryState.count, 1);
      assert.match(resumed.memoryState.text, /빌드는 bun run build/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

// =========================================================================
// 4. The pre-edit snapshot is taken by the bridge, on the tool-start frame
// =========================================================================
test('a file-modifying tool-start frame is snapshotted before the edit, and a read is not', async () => {
  const root = await createTempDir('dx-snap-root-');
  const state = await createTempDir('dx-snap-state-');
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'app.js'), 'const version = 1;\n', 'utf8');

    await withRouter({ projectRoot: root, stateDir: state }, async ({ router, baseUrl }) => {
      assert.deepEqual(fileModifyingPaths({ type: 'tool_execution_start', toolName: 'read', args: { file_path: 'src/app.js' } }), []);
      assert.deepEqual(
        fileModifyingPaths({ type: 'tool_execution_start', toolName: 'edit', args: { file_path: 'src/app.js' } }),
        ['src/app.js'],
      );

      // The bridge hands every core frame to this hook before the tool runs.
      const recorded = await router.noteFrame('sess-live', {
        type: 'tool_execution_start',
        toolName: 'edit',
        args: { file_path: join(root, 'src', 'app.js') },
      });
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].relativePath, 'src/app.js');
      assert.equal(recorded[0].existed, true);

      // The agent then writes the file.
      await writeFile(join(root, 'src', 'app.js'), 'const version = 2;\n', 'utf8');

      const diff = await (await fetch(`${baseUrl}/api/dx/snapshot/diff?taskId=sess-live`)).json();
      assert.equal(diff.files.length, 1);
      assert.equal(diff.files[0].path, 'src/app.js');
      assert.equal(diff.files[0].beforeContent, 'const version = 1;\n', 'the pre-edit content was preserved');

      // Revert through the documented endpoint still restores the baseline.
      const reverted = await (await fetch(`${baseUrl}/api/dx/snapshot/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 'sess-live', filePath: 'src/app.js' }),
      })).json();
      assert.equal(reverted.action, 'restored');
      assert.equal(await readFile(join(root, 'src', 'app.js'), 'utf8'), 'const version = 1;\n');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

// =========================================================================
// 4b. The bridge itself is the caller: every core frame reaches the DX hook
// =========================================================================
test('the running bridge hands its core frames to the DX snapshot hook', async () => {
  const { createBridge } = await import('../../server.mjs');
  const stateDir = await createTempDir('dx-hook-state-');
  const seen = [];
  const router = createDxRouter({ projectRoot: stateDir, stateDir });
  const spy = { ...router, noteFrame: (sessionId, frame) => { seen.push({ sessionId, frame }); return router.noteFrame(sessionId, frame); } };
  const app = await createBridge({ mock: true, config: { stateDir }, dxRouter: spy });
  try {
    const url = await app.start(0);
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/ws`);
    try {
      await new Promise((done, bad) => {
        socket.addEventListener('message', (event) => {
          const frame = JSON.parse(event.data);
          if (frame.type === 'bridge_ready') {
            socket.send(JSON.stringify({ id: 'p-1', type: 'prompt', message: '도와줘' }));
          }
          if (frame.type === 'session_settled') done();
        });
        socket.addEventListener('error', bad);
      });
    } finally {
      socket.close();
    }
    const toolStart = seen.find((entry) => entry.frame?.type === 'tool_execution_start');
    assert.ok(toolStart, 'the live frame path called noteFrame for the tool the core started');
    assert.equal(toolStart.frame.toolName, 'read_file');
    assert.equal(toolStart.sessionId, app.sessions.keys().next().value);
  } finally {
    await app.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

// =========================================================================
// 5. Snapshots survive a restart: the manifest is reloaded on init
// =========================================================================
test('a new process reloads the snapshot manifest and can still diff and revert', async () => {
  const root = await createTempDir('dx-restart-root-');
  const state = await createTempDir('dx-restart-state-');
  try {
    await mkdir(join(root, 'lib'), { recursive: true });
    await writeFile(join(root, 'lib', 'math.js'), 'export const add = (a, b) => a - b;\n', 'utf8');

    const first = new SnapshotManager({ storageDir: join(state, 'snapshots'), projectRoot: root });
    await first.init();
    await first.recordSnapshot('t-restart', 'lib/math.js');
    await writeFile(join(root, 'lib', 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
    // The manifest exists on disk; this instance is the one the next process replaces.
    assert.ok((await readdir(join(state, 'snapshots', 't-restart'))).includes('manifest.json'));

    const second = new SnapshotManager({ storageDir: join(state, 'snapshots'), projectRoot: root });
    await second.init();

    const diff = await second.getTaskDiff('t-restart');
    assert.equal(diff.files.length, 1, 'the reloaded index knows the task');
    assert.equal(diff.files[0].beforeContent, 'export const add = (a, b) => a - b;\n');
    assert.match(diff.files[0].diff, /\+export const add = \(a, b\) => a \+ b;/);

    await second.revertFile('t-restart', 'lib/math.js');
    assert.equal(await readFile(join(root, 'lib', 'math.js'), 'utf8'), 'export const add = (a, b) => a - b;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

// =========================================================================
// 6. POST /api/dx/snapshot/diff is the documented method (GET keeps working)
// =========================================================================
test('snapshot/diff answers both POST and GET with the same task diff', async () => {
  const root = await createTempDir('dx-diff-root-');
  const state = await createTempDir('dx-diff-state-');
  try {
    await writeFile(join(root, 'demo.js'), 'console.log("before");\n', 'utf8');
    await withRouter({ projectRoot: root, stateDir: state }, async ({ router, baseUrl }) => {
      await router.noteFrame('t-diff', {
        type: 'tool_execution_start',
        toolName: 'write',
        args: { path: 'demo.js' },
      });
      await writeFile(join(root, 'demo.js'), 'console.log("after");\n', 'utf8');

      const posted = await fetch(`${baseUrl}/api/dx/snapshot/diff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 't-diff' }),
      });
      assert.equal(posted.status, 200);
      const postData = await posted.json();
      const getData = await (await fetch(`${baseUrl}/api/dx/snapshot/diff?taskId=t-diff`)).json();
      assert.deepEqual(postData, getData);
      assert.match(postData.files[0].diff, /\+console\.log\("after"\);/);

      const missing = await fetch(`${baseUrl}/api/dx/snapshot/diff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(missing.status, 400, 'a POST without taskId is still a client error');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

// =========================================================================
// 7. The documented seven error categories, network disconnection included
// =========================================================================
test('the error explainer classifies the documented seven categories, with port conflict as an eighth', () => {
  const cases = [
    ['SyntaxError: Unexpected token "}" at src/app.js:14:2', 'syntax'],
    ["Error: Cannot find module 'lodash'", 'module_not_found'],
    ["TypeError: Cannot read properties of undefined (reading 'map')", 'type_error'],
    ['AssertionError: Expected: 100\nReceived: 50', 'assertion_failure'],
    ['Error: ETIMEDOUT: command timed out after 30000ms', 'timeout'],
    ["Error: EACCES: permission denied, open 'dist/bundle.js'", 'permission'],
    ['Error: connect ECONNREFUSED 127.0.0.1:443', 'network_disconnected'],
  ];
  for (const [log, expected] of cases) {
    const explanation = explainError(log);
    assert.equal(explanation.category, expected, log);
    assert.ok(explanation.cause.length > 0 && explanation.fix.length > 0);
  }

  // Other shapes of a dropped connection, all of which used to fall through.
  assert.equal(explainError('Error: socket hang up').category, 'network_disconnected');
  assert.equal(explainError('TypeError: fetch failed\n  cause: getaddrinfo ENOTFOUND api.example.com').category, 'network_disconnected');
  assert.equal(explainError('Error: EAI_AGAIN registry.npmjs.org').category, 'network_disconnected');
  assert.equal(explainError('Error: ETIMEDOUT connecting to 10.0.0.1:443').category, 'network_disconnected');
  assert.match(
    explainError('Error: connect ECONNREFUSED 127.0.0.1:443').cause,
    /연결이 끊겼거나/,
  );

  // Port conflict stays available as an additional category for existing callers.
  const port = explainError('Error: listen EADDRINUSE: address already in use :::3000');
  assert.equal(port.category, 'port_in_use');
  assert.match(port.cause, /3000/);
});

// Executable hidden-test evaluation for the live lane.
// The simulated lane trusts a passRate override; the live lane cannot. Every hidden
// test here is an executable assertion run against the workspace the agent actually
// produced. A test passes only if the observable behaviour matches the assertion.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CHECKS_BY_TASK = {
  'task-a-single-line-fix': checksForPagination,
  'task-b-frontend-component': checksForMetricCard,
  'task-c-multifile-refactor': checksForRefactor,
  'task-d-complex-debugging': checksForRetryManager,
};

/**
 * The hidden tests are only legitimate when the prompt states the requirement
 * they enforce. This is the audit gate the runner calls before any slot runs.
 */
export function validateTaskSpec(task, promptText = task.prompt) {
  const hidden = task.hiddenTests ?? [];
  const coverage = task.hiddenTestCoverage ?? [];
  if (coverage.length !== hidden.length) {
    throw new Error(`${task.id}: ${hidden.length} hidden tests but ${coverage.length} coverage entries`);
  }
  if (new Set(coverage).size !== coverage.length) {
    throw new Error(`${task.id}: hidden-test coverage maps two tests to one contract item`);
  }
  const missing = (task.promptContract ?? []).filter(
    (phrase) => !String(promptText).toLowerCase().includes(String(phrase).toLowerCase())
  );
  if (missing.length > 0) {
    throw new Error(`${task.id}: hidden tests enforce requirements the prompt never states: ${missing.join('; ')}`);
  }
  if (!CHECKS_BY_TASK[task.id]) throw new Error(`${task.id}: no live evaluator exists`);
  return true;
}

/** Stable identity of the initial code + task spec + verification conditions. */
export function taskSpecFingerprint(task, promptText = task.prompt) {
  const files = Object.entries(task.initialFiles).sort(([a], [b]) => a.localeCompare(b));
  const payload = JSON.stringify({
    taskId: task.id,
    initialFiles: files.map(([rel, content]) => [rel, content]),
    prompt: promptText,
    hiddenTests: task.hiddenTests.map((t) => t.name),
    promptContract: task.promptContract,
    coverage: task.hiddenTestCoverage,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function importFresh(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file ${filePath}`);
  // No cache-busting query: the workspace path is unique per run, and internal
  // relative imports (auth.js -> store.js) must resolve to the SAME module instance
  // or the scenario assertions would run against disjoint state.
  const url = pathToFileURL(filePath).href;
  return import(url);
}

function check(name, assertion) {
  return { name, assertion };
}

async function runOne(name, assertion) {
  try {
    await withTimeout(Promise.resolve().then(assertion), 20000, name);
    return { name, passed: true, reason: 'assertion passed' };
  } catch (err) {
    const reason = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 220);
    return { name, passed: false, reason };
  }
}

export async function evaluateTaskLive(task, workDir) {
  const builder = CHECKS_BY_TASK[task.id];
  if (!builder) throw new Error(`no live evaluator for task ${task.id}`);
  const checks = await builder(workDir);

  const taskNames = task.hiddenTests.map((t) => t.name);
  const results = [];
  for (let i = 0; i < checks.length; i++) {
    const name = taskNames[i] ?? checks[i].name;
    results.push(await runOne(name, checks[i].assertion));
  }

  const totalTests = task.hiddenTests.length;
  const passedCount = results.filter((r) => r.passed).length;
  return {
    passRate: totalTests > 0 ? Number((passedCount / totalTests).toFixed(4)) : 0,
    passedCount,
    totalTests,
    testResults: results,
  };
}

// ---------------------------------------------------------------- task a
function checksForPagination(workDir) {
  const file = path.join(workDir, 'src/pagination.js');
  const call = async (args) => {
    const mod = await importFresh(file);
    if (typeof mod.calculateTotalPages !== 'function') {
      throw new Error('src/pagination.js does not export calculateTotalPages');
    }
    const out = mod.calculateTotalPages(...args);
    if (typeof out !== 'number' || Number.isNaN(out)) throw new Error(`returned ${String(out)} (not a number)`);
    return out;
  };

  return [
    check('Zero totalItems should return 0 pages', async () => {
      if ((await call([0, 10])) !== 0) throw new Error(`calculateTotalPages(0,10) = ${await call([0, 10])}, expected 0`);
    }),
    check('Exact multiple (50 items, 10 per page) should return 5 pages', async () => {
      if ((await call([50, 10])) !== 5) throw new Error(`calculateTotalPages(50,10) = ${await call([50, 10])}, expected 5`);
    }),
    check('Partial page (51 items, 10 per page) should return 6 pages', async () => {
      if ((await call([51, 10])) !== 6) throw new Error(`calculateTotalPages(51,10) = ${await call([51, 10])}, expected 6`);
    }),
    check('Single item should return 1 page', async () => {
      if ((await call([1, 10])) !== 1) throw new Error(`calculateTotalPages(1,10) = ${await call([1, 10])}, expected 1`);
    }),
    check('Negative totalItems should return 0 pages', async () => {
      const value = await call([-5, 10]);
      if (value !== 0) throw new Error(`calculateTotalPages(-5,10) = ${value}, expected 0`);
    }),
    check('Invalid pageSize should throw error', async () => {
      let threw = false;
      try { await call([100, 0]); } catch { threw = true; }
      if (!threw) throw new Error('calculateTotalPages(100,0) did not throw for pageSize=0');
    }),
  ];
}

// ---------------------------------------------------------------- task b
function checksForMetricCard(workDir) {
  const jsFile = path.join(workDir, 'src/components/MetricCard.js');
  const cssFile = path.join(workDir, 'src/styles/metric-card.css');
  const render = async (props) => {
    const mod = await importFresh(jsFile);
    if (typeof mod.renderMetricCard !== 'function') throw new Error('src/components/MetricCard.js does not export renderMetricCard');
    const html = mod.renderMetricCard(props);
    if (typeof html !== 'string' || html.length === 0) throw new Error('renderMetricCard returned an empty value');
    return html;
  };

  return [
    check('Renders title and value correctly', async () => {
      const html = await render({ title: 'Memory Usage', value: '84.2%' });
      for (const snippet of ['Memory Usage', '84.2%']) {
        if (!html.includes(snippet)) throw new Error(`rendered markup is missing "${snippet}"`);
      }
    }),
    check('Applies correct status badge classes (success, warning, error)', async () => {
      const classes = ['badge-success', 'badge-warning', 'badge-error'];
      for (const cls of classes) {
        const status = cls.replace('badge-', '');
        const html = await render({ title: 'T', value: 1, status });
        if (!html.includes(cls)) throw new Error(`status="${status}" markup is missing class ${cls}`);
      }
    }),
    check('Includes accessible button toggle with aria-expanded attribute', async () => {
      const html = await render({ title: 'T', value: 1, details: 'detail text' });
      if (!html.includes('aria-expanded')) throw new Error('rendered markup is missing aria-expanded');
      if (!/<button/i.test(html)) throw new Error('rendered markup has no <button> element');
    }),
    check('CSS defines responsive rules for max-width 768px', async () => {
      if (!fs.existsSync(cssFile)) throw new Error('src/styles/metric-card.css missing');
      const css = fs.readFileSync(cssFile, 'utf8');
      if (!css.includes('@media')) throw new Error('css has no @media rule');
      if (!css.includes('768px')) throw new Error('css has no 768px breakpoint');
    }),
    check('Dark mode theme class support', async () => {
      const html = await render({ title: 'T', value: 1, isDark: true });
      if (!html.includes('theme-dark') && !html.includes('dark-mode')) {
        throw new Error('dark-mode render is missing theme-dark/dark-mode class');
      }
    }),
  ];
}

// ---------------------------------------------------------------- task c
function checksForRefactor(workDir) {
  let cached = null;
  // Module state must be shared across the checks: importing fresh copies would give
  // each call its own session store and make the scenarios meaningless.
  const mods = async () => {
    if (!cached) {
      cached = Promise.all([
        importFresh(path.join(workDir, 'src/verifier.js')).catch(() => ({ __missing: 'src/verifier.js' })),
        importFresh(path.join(workDir, 'src/auth.js')).catch(() => ({ __missing: 'src/auth.js' })),
        importFresh(path.join(workDir, 'src/store.js')).catch(() => ({ __missing: 'src/store.js' })),
        importFresh(path.join(workDir, 'src/server.js')).catch(() => ({ __missing: 'src/server.js' })),
      ]).then(([verifier, auth, store, server]) => ({ verifier, auth, store, server }));
    }
    return cached;
  };

  const seedSession = async (token, user, ttlMs) => {
    const { store } = await mods();
    if (typeof store.setSession !== 'function') throw new Error('src/store.js lost setSession export');
    store.setSession(token, user, ttlMs);
  };

  const request = async (authHeader) => {
    const { server } = await mods();
    if (typeof server.handleRequest !== 'function') throw new Error('src/server.js lost handleRequest export');
    const res = server.handleRequest({ headers: { authorization: authHeader } });
    if (!res || typeof res.status !== 'number') throw new Error('handleRequest did not return {status, user}');
    return res;
  };

  return [
    check('New src/verifier.js exists and exports TokenVerifier', async () => {
      const { verifier } = await mods();
      if (verifier.__missing) throw new Error('src/verifier.js was not created');
      if (typeof verifier.TokenVerifier !== 'function') throw new Error('src/verifier.js does not export TokenVerifier');
    }),
    check('Valid token resolves user object', async () => {
      await seedSession('tok-valid', { name: 'alice' });
      const res = await request('Bearer tok-valid');
      if (res.status !== 200) throw new Error(`valid token produced status ${res.status}`);
      if (!res.user || res.user.name !== 'alice') throw new Error('valid token did not resolve the session user');
    }),
    check('Expired token returns null and does not leak session', async () => {
      await seedSession('tok-expired', { name: 'bob' }, -1000);
      const res = await request('Bearer tok-expired');
      if (res.status !== 401) throw new Error(`expired token produced status ${res.status}`);
      if (res.user) throw new Error('expired token leaked the session user');
    }),
    check('Backward compatibility: src/auth.js verifyAuthHeader still works', async () => {
      const { auth } = await mods();
      if (typeof auth.verifyAuthHeader !== 'function') throw new Error('src/auth.js lost verifyAuthHeader export');
      await seedSession('tok-compat', { name: 'carol' });
      const user = auth.verifyAuthHeader('Bearer tok-compat');
      if (!user || user.name !== 'carol') throw new Error('verifyAuthHeader no longer resolves the session user');
      if (auth.verifyAuthHeader('') !== null) throw new Error('verifyAuthHeader no longer rejects a missing header');
    }),
    check('All unit & integration suites pass with zero regressions', async () => {
      const { auth, store, server } = await mods();
      for (const [name, member] of [['server.handleRequest', server.handleRequest], ['auth.verifyAuthHeader', auth.verifyAuthHeader], ['store.setSession', store.setSession], ['store.getSession', store.getSession], ['store.clearAllSessions', store.clearAllSessions]]) {
        if (typeof member !== 'function') throw new Error(`${name} is missing (public API regression)`);
      }
      store.clearAllSessions();
      await seedSession('tok-regress', { name: 'dave' });
      const viaServer = await request('Bearer tok-regress');
      const viaAuth = auth.verifyAuthHeader('Bearer tok-regress');
      if (viaServer.status !== 200 || !viaAuth) throw new Error('integration path between server and auth regressed');
      const unknown = await request('Bearer tok-unknown');
      if (unknown.status !== 401) throw new Error('unknown token was accepted');
    }),
  ];
}

// ---------------------------------------------------------------- task d
function checksForRetryManager(workDir) {
  const file = path.join(workDir, 'src/queue/retry-manager.js');
  const load = async () => {
    const mod = await importFresh(file);
    if (typeof mod.RetryManager !== 'function') throw new Error('src/queue/retry-manager.js does not export RetryManager');
    return mod.RetryManager;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return [
    check('Cancelled tasks clean up timers immediately', async () => {
      const RetryManager = await load();
      const mgr = new RetryManager({ maxRetries: 3, retryDelayMs: 25 });
      const failing = async () => { throw new Error('boom'); };
      mgr.enqueue('t-cancel', failing).catch(() => {});
      await sleep(15);
      mgr.cancel('t-cancel');
      await sleep(120);
      if (mgr.activeTimers.size !== 0) throw new Error(`activeTimers still holds ${mgr.activeTimers.size} timer(s) after cancel`);
      mgr.destroy();
    }),
    check('Listener count does not increase per retry attempt', async () => {
      const RetryManager = await load();
      const mgr = new RetryManager({ maxRetries: 3, retryDelayMs: 5 });
      const before = mgr.listenerCount('cancel');
      for (let i = 0; i < 4; i++) {
        let attempts = 0;
        const fn = async () => { attempts++; if (attempts <= 2) throw new Error('retry me'); return 'ok'; };
        await mgr.enqueue(`t-${i}`, fn);
      }
      const after = mgr.listenerCount('cancel');
      if (after - before > 2) throw new Error(`cancel listeners grew from ${before} to ${after} across 4 tasks with retries`);
      mgr.destroy();
    }),
    check('Concurrent dispatch of same taskId dedupes cleanly', async () => {
      const RetryManager = await load();
      const mgr = new RetryManager({ maxRetries: 1, retryDelayMs: 5 });
      let executions = 0;
      const fn = async () => { executions++; await sleep(30); return 'shared'; };
      const results = await Promise.all(Array.from({ length: 10 }, () => mgr.enqueue('dup', fn)));
      if (executions !== 1) throw new Error(`same taskId executed ${executions} times instead of 1`);
      if (results.some((r) => r !== 'shared')) throw new Error('deduped callers did not all receive the shared result');
      if (mgr.inFlight.size !== 0) throw new Error('inFlight map did not drain after dedupe');
      mgr.destroy();
    }),
    check('High concurrency 500 tasks stress test leaves 0 dangling listeners and timers', async () => {
      const RetryManager = await load();
      const mgr = new RetryManager({ maxRetries: 2, retryDelayMs: 1 });
      const jobs = [];
      for (let i = 0; i < 500; i++) {
        let attempts = 0;
        const fn = async () => { attempts++; if (attempts === 1) throw new Error('first attempt fails'); return i; };
        jobs.push(mgr.enqueue(`stress-${i}`, fn));
      }
      const results = await Promise.all(jobs);
      if (results.length !== 500) throw new Error(`only ${results.length}/500 tasks resolved`);
      if (mgr.activeTimers.size !== 0) throw new Error(`${mgr.activeTimers.size} timer(s) dangling after stress test`);
      if (mgr.listenerCount('cancel') > 5) throw new Error(`${mgr.listenerCount('cancel')} 'cancel' listeners dangling after stress test`);
      mgr.destroy();
    }),
    check('Exhausted retries emit single terminal failure event', async () => {
      const RetryManager = await load();
      const mgr = new RetryManager({ maxRetries: 1, retryDelayMs: 5 });
      let exhausted = 0;
      mgr.on('exhausted', () => { exhausted++; });
      const failing = async () => { throw new Error('always fails'); };
      let rejections = 0;
      await mgr.enqueue('exhaust', failing).catch(() => { rejections++; });
      await sleep(50);
      if (exhausted !== 1) throw new Error(`'exhausted' emitted ${exhausted} times, expected exactly 1`);
      if (rejections !== 1) throw new Error('promise rejected more than once');
      mgr.destroy();
    }),
  ];
}

// Offline benchmark harness: baseline OMP config vs the optimised config.
//
// It runs the *same* coding tasks through the gateway twice — once with
// `optimization.profile = "baseline"` (every gateway-side optimisation off) and
// once with `"optimized"` — and records, per task: success, input/output/cache
// tokens, USD cost, wall time. It never touches a paid provider: the upstream is
// the in-repo loopback stub (gateway/stub/stub-upstream.mjs), and the stub's
// answers are instrumented, not measured model behaviour.
//
// The output is therefore labelled `measurement: false`, `evidence: "offline_stub"`,
// and every number is described as a plumbing measurement (tokens/cost/time of the
// path) rather than a quality or latency claim about any real model. To use it for
// a real comparison the upstream base URLs would have to point at a served model;
// this harness deliberately does not do that.
//
// Run: node gateway/bench/run-benchmark.mjs [--profile baseline|optimized|both] [--out file.json]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStubUpstream } from '../stub/stub-upstream.mjs';
import { parseConfig } from '../lib/config.mjs';
import { createGateway } from '../lib/gateway.mjs';
import { createLogger } from '../lib/log.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { events, resetEvents } from '../lib/events.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Four representative coding tasks, each a short multi-turn conversation so the
// prefix cache has something to protect. `turns` are user messages.
export const BENCH_TASKS = Object.freeze([
  {
    id: 'simple-edit',
    kind: 'direct',
    turns: [
      'Fix the off-by-one in src/pagination.mjs and show the diff.',
      'Now add a unit test for the last page.',
      'Rerun the tests and tell me the result.',
    ],
  },
  {
    id: 'multi-file-refactor',
    kind: 'plan',
    turns: [
      'Refactor the auth module across src/auth.mjs, src/session.mjs and src/middleware.mjs so the token check has one owner. Survey first, then implement, then verify.',
      'Keep the public API unchanged; list every caller you touched.',
      'Add a regression test for the expiry path and run it.',
    ],
  },
  {
    id: 'test-fix',
    kind: 'implement',
    turns: [
      'A test in test/parser.test.mjs fails intermittently. Find the cause, fix it, and prove it with 20 runs.',
      'Explain the race you found in one paragraph.',
      'Do the same check for the other tests in that folder.',
    ],
  },
  {
    id: 'investigate',
    kind: 'survey',
    turns: [
      'Investigate why the CLI hangs on exit. Search the repo, do not guess; survey the shutdown paths across main.mjs and lifecycle.mjs.',
      'Propose the smallest fix and the risk it carries.',
      'Implement the fix and verify with a bounded run.',
    ],
  },
]);

function configFor({ stubPort, dir, profile }) {
  return {
    listen: { host: '127.0.0.1', port: 0 },
    route: { default: 'zdr_cloud' },
    quota: { identity_header: 'x-user-id', requests_per_day: 1000, tokens_per_day: 10_000_000, ledger_path: path.join(dir, `ledger-${profile}.json`) },
    logging: { level: 'warn', log_request_bodies: false, file: path.join(dir, `gateway-${profile}.log`) },
    health: { cache_ms: 0, timeout_ms: 700 },
    timeouts: { upstream_ms: 8000, video_ms: 8000 },
    max_body_bytes: 2 * 1024 * 1024,
    optimization: { profile },
    upstreams: [
      {
        id: 'stub-local',
        class: 'server_local',
        kind: 'openai',
        base_url: `http://127.0.0.1:${stubPort}/local/v1`,
        auth_mode: 'none',
        paths: { models: '/models', chat: '/chat/completions', images: '/images/generations' },
        models: [
          {
            id: 'stub-chat',
            display_name: 'Offline stub chat (not a model)',
            capabilities: ['chat'],
            zero_data_retention: true,
            training_opt_out: true,
            context_window: 32768,
            thinking_limit: 8192,
            supports_prompt_cache_key: true,
          },
        ],
      },
    ],
  };
}

// One profile's run: a fresh gateway over the shared stub, tasks executed in
// order, every turn accounted from the events the gateway emitted.
async function runProfile({ profile, stubPort, dir }) {
  const raw = configFor({ stubPort, dir, profile });
  const config = parseConfig(raw, { configPath: path.join(dir, `config-${profile}.json`), baseDir: dir });
  const redactor = createRedactor([]);
  const logger = createLogger({ level: 'warn', filePath: raw.logging.file, redactor, stdout: { write() {} } });
  const gateway = createGateway({ config, env: {}, logger });
  const address = await gateway.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  resetEvents();
  const results = [];
  for (const task of BENCH_TASKS) {
    const session = `bench-${profile}-${task.id}`;
    const taskResults = [];
    const history = [];
    for (const [index, turn] of task.turns.entries()) {
      history.push({ role: 'user', content: turn });
      const startedAt = process.hrtime.bigint();
      let status = 0;
      let answer = '';
      let error = null;
      try {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-user-id': 'bench',
            'x-app-session': session,
            'x-route': 'zdr_cloud',
          },
          body: JSON.stringify({ route: 'zdr_cloud', messages: history, max_tokens: 256 }),
        });
        status = response.status;
        const text = await response.text();
        try {
          const parsed = JSON.parse(text);
          answer = parsed?.choices?.[0]?.message?.content ?? '';
          history.push({ role: 'assistant', content: answer });
        } catch {
          error = 'non-json response';
        }
      } catch (caught) {
        error = String(caught?.message ?? caught);
      }
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      taskResults.push({
        turn: index + 1,
        ok: status === 200 && error === null,
        status,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        error,
      });
    }

    const taskTurns = events({ type: 'llm_turn', session });
    const taskOpts = events({ type: 'optimization', session });
    const sum = (key) => taskTurns.reduce((total, event) => total + (event.tokens?.[key] ?? 0), 0);
    const cost = taskTurns.reduce((total, event) => total + (event.cost?.usd ?? 0), 0);
    const baselineCost = taskTurns.reduce((total, event) => total + (event.cost?.baselineUsd ?? 0), 0);
    results.push({
      task: task.id,
      kind: task.kind,
      success: taskResults.every((entry) => entry.ok),
      turns: taskResults,
      wallMs: Number(taskResults.reduce((total, entry) => total + entry.elapsedMs, 0).toFixed(2)),
      tokens: { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') },
      costUsd: Number(cost.toFixed(6)),
      baselineCostUsd: Number(baselineCost.toFixed(6)),
      optimizations: taskOpts.map((event) => ({ strategy: event.strategy, tokensSaved: event.tokensSaved, costSavedUsd: event.costSavedUsd })),
    });
  }

  await gateway.close();
  const totals = results.reduce((acc, entry) => {
    acc.wallMs += entry.wallMs;
    acc.costUsd += entry.costUsd;
    acc.tokens.input += entry.tokens.input;
    acc.tokens.output += entry.tokens.output;
    acc.tokens.cacheRead += entry.tokens.cacheRead;
    acc.tokens.cacheWrite += entry.tokens.cacheWrite;
    acc.success += entry.success ? 1 : 0;
    return acc;
  }, { wallMs: 0, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, success: 0 });

  return {
    profile,
    config: { pinSessions: config.optimization.pinSessions, prefixStable: config.optimization.prefixStable, providerCache: config.optimization.providerCache },
    tasks: results,
    totals: {
      ...totals,
      costUsd: Number(totals.costUsd.toFixed(6)),
      wallMs: Number(totals.wallMs.toFixed(2)),
      tasks: results.length,
    },
  };
}

export async function runBenchmark({ profiles = ['baseline', 'optimized'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-bench-'));
  const stub = createStubUpstream();
  const address = await stub.listen(0, '127.0.0.1');
  const stubPort = address.port;
  try {
    const runs = [];
    for (const profile of profiles) runs.push(await runProfile({ profile, stubPort, dir }));
    return {
      // The label that keeps this honest: the upstream answered, but it is a stub.
      measurement: false,
      evidence: 'offline_stub',
      note: 'The upstream is gateway/stub/stub-upstream.mjs on loopback. Tokens, cost and wall time describe the gateway path under each config; they are not a measurement of any real model, and no paid provider was called.',
      generatedAt: new Date().toISOString(),
      workspace: dir,
      profiles: runs,
      comparison: comparisonOf(runs),
    };
  } finally {
    await stub.close();
  }
}

function comparisonOf(runs) {
  const baseline = runs.find((run) => run.profile === 'baseline');
  const optimized = runs.find((run) => run.profile === 'optimized');
  if (!baseline || !optimized) return null;
  const pct = (from, to) => (from === 0 ? null : Number((((to - from) / from) * 100).toFixed(2)));
  return {
    costDeltaPercent: pct(baseline.totals.costUsd, optimized.totals.costUsd),
    wallDeltaPercent: pct(baseline.totals.wallMs, optimized.totals.wallMs),
    inputTokenDeltaPercent: pct(baseline.totals.tokens.input, optimized.totals.tokens.input),
    cacheReadTokens: { baseline: baseline.totals.tokens.cacheRead, optimized: optimized.totals.tokens.cacheRead },
    success: { baseline: baseline.totals.success, optimized: optimized.totals.success },
  };
}

function table(report) {
  const lines = [];
  for (const run of report.profiles) {
    lines.push(`profile ${run.profile}: success ${run.totals.success}/${run.totals.tasks} · cost $${run.totals.costUsd} · ` +
      `tokens in/out ${run.totals.tokens.input}/${run.totals.tokens.output} · cache read ${run.totals.tokens.cacheRead} · wall ${run.totals.wallMs}ms`);
    for (const task of run.tasks) {
      lines.push(`  ${task.task.padEnd(18)} ${task.success ? 'ok  ' : 'FAIL'} turns ${task.turns.length} · ` +
        `$${task.costUsd} · wall ${task.wallMs}ms · cacheRead ${task.tokens.cacheRead}`);
    }
  }
  lines.push('');
  lines.push('measurement: false — offline stub, not a model measurement');
  return lines.join('\n');
}

// `both` is a CLI mode, not a profile name: it stands for the baseline run followed
// by the optimized run. Anything else is refused here, before a run starts, so the
// error names the flag instead of surfacing as `optimization.profile` inside a task.
const PROFILE_MODES = ['baseline', 'optimized', 'both'];
export function profilesFor(mode) {
  if (!PROFILE_MODES.includes(mode)) throw new Error(`--profile: must be one of ${PROFILE_MODES.join(', ')} (got "${mode}")`);
  return mode === 'both' ? ['baseline', 'optimized'] : [mode];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(here, 'run-benchmark.mjs')) {
  const argProfile = process.argv.indexOf('--profile');
  const profiles = argProfile > 0 ? profilesFor(process.argv[argProfile + 1]) : profilesFor('both');
  const outIndex = process.argv.indexOf('--out');
  const report = await runBenchmark({ profiles });
  if (outIndex > 0) fs.writeFileSync(path.resolve(process.argv[outIndex + 1]), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${table(report)}\n`);
}

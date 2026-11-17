// Optional second tier for the summarizer: polish Korean lines with a small
// generative model that is ALREADY on this machine.
//
// Roles are separate on purpose:
//   * SLM (one of the registry candidates) — session title, timeline summary,
//     memory-candidate cleanup, session summary. Generation only, never numbers.
//   * Embedding (Xenova/multilingual-e5-small) — memory retrieval vectors.
//   * Rules/engine — agent state, file diff, preview, HTML/SVG rendering.
//     These are deterministic and never wait for the SLM.
//
// No generative weight ships in this repository: the only model under
// app/memory/data/models is the 113 MB embedding ONNX, which cannot generate text.
// So on this machine the probe reports `rule-fallback (weights not installed)` and
// the summarizer keeps its deterministic rules tier. When a candidate's weights
// ARE installed, `createLocalGenerator` is the real generator the polish path runs
// (`pipeline('text-generation', …)` through the transformers.js runtime the probe
// found) — the tier is not a test-only seam. Nothing here downloads weights,
// installs a runtime or calls a provider: detection is limited to directory stats
// and generation to local files, sliced and budgeted so the CPU work cannot hold
// the harness's event loop.
//
// Inference itself never runs on this thread. A real transformers.js runtime
// (`<runner>/dist`, as opposed to a synthetic `index.cjs` stub) is driven through the
// persistent child process `slm-worker.mjs`, so a 2–8 s title or journal generation
// costs this process only an IPC round trip: no timer, socket or RPC frame waits
// behind ONNX.

import { fork } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeText } from '../privacy/index.mjs';

const GENERATIVE_HINTS = /(instruct|chat|qwen|llama|phi|gemma|mistral|deepseek|exaone|solar|tinyllama|granite|lfm)/i;
const MODEL_FILE = /\.(gguf|ggml|safetensors|bin)$/i;
const JOURNAL_CATEGORIES = Object.freeze(['조사', '추가', '수정', '삭제', '검증', '오류 복구']);
// A title is read at a glance in the header: 8–24 Korean characters is the whole
// budget, and it is a hard range, not a clip target — see `isUsableTitle`.
const MIN_TITLE_CHARS = 8;
const MAX_TITLE_CHARS = 24;
const MAX_JOURNAL_LINE_CHARS = 160;
const pipelineCache = new Map();

/**
 * The candidate registry. It holds exactly the two candidates the documentation and
 * `app/privacy/slm.mjs:SLM_CANDIDATES` name: the `default` pick and the slower
 * `high` option. Neither weight file is in the bundle — `app/memory/data/models`
 * holds only the 113 MB embedding ONNX — so `estimatedMb` is the published ONNX
 * footprint of each candidate, not a measurement of a file on this disk.
 */
export const REGISTRY = Object.freeze([
  {
    id: 'Qwen3.5-0.8B',
    label: 'Qwen3.5 0.8B (높은 품질)',
    parameters: '0.8B',
    quantization: 'q4f16',
    quality: 'high',
    contextWindow: 32768,
    estimatedMb: 520,
    roles: ['session-title', 'timeline-summary', 'memory-cleanup', 'session-summary'],
  },
  {
    id: 'Qwen2.5-0.5B-Instruct',
    label: 'Qwen2.5 0.5B Instruct (기본)',
    parameters: '0.5B',
    quantization: 'q4f16',
    quality: 'default',
    contextWindow: 32768,
    estimatedMb: 461,
    roles: ['session-title', 'timeline-summary', 'memory-cleanup', 'session-summary'],
  },
]);

/** The recommended pick, and the slower "high quality" option. */
export const DEFAULT_CANDIDATE = 'Qwen2.5-0.5B-Instruct';
export const HIGH_QUALITY_CANDIDATE = 'Qwen3.5-0.8B';

/** Role separation. The engine never asks the SLM for anything observable. */
export const ROLES = Object.freeze({
  slm: {
    label: '로컬 초소형 모델 (SLM)',
    tasks: ['세션 제목', '타임라인 요약', '기억 후보 정리', '세션 요약'],
  },
  embedding: {
    label: '임베딩',
    model: 'Xenova/multilingual-e5-small',
    path: 'app/memory/data/models/Xenova/multilingual-e5-small',
    tasks: ['장기 기억 검색 벡터'],
  },
  rules: {
    label: '규칙 엔진',
    tasks: ['에이전트 상태', '파일 diff', '미리보기', 'HTML·SVG 렌더링'],
  },
});

/** Which tier owns one task id. Unknown tasks belong to the deterministic engine. */
export function roleFor(task) {
  const name = String(task ?? '').trim().toLowerCase();
  if (!name) return 'rules';
  if (name === 'embedding' || name === 'memory-retrieval' || name === 'memory-embed') return 'embedding';
  if (ROLES.slm.tasks.some((label) => label.includes(name)) || ['session-title', 'timeline-summary', 'memory-cleanup', 'session-summary'].includes(name)) return 'slm';
  return 'rules';
}

/** Registry entry by id, or null. Accepts the `high`/`default` quality words too. */
export function candidateById(value) {
  const key = String(value ?? '').trim();
  if (!key) return null;
  const exact = REGISTRY.find((candidate) => candidate.id.toLowerCase() === key.toLowerCase());
  if (exact) return exact;
  const byQuality = REGISTRY.find((candidate) => candidate.quality === key.toLowerCase());
  return byQuality ?? null;
}

/**
 * The pick the operator asked for, else the default; a `high` request is the
 * high-quality candidate. Reported, never silently substituted.
 */
export function selectCandidate({ preference = null } = {}) {
  const explicit = candidateById(preference);
  if (explicit) return { ...explicit, requested: String(preference), usedDefault: false };
  const fallback = candidateById(DEFAULT_CANDIDATE);
  return { ...fallback, requested: preference === null ? null : String(preference), usedDefault: true };
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function walk(dir, depth, visit) {
  if (depth < 0 || !isDir(dir)) return;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      visit(full, entry.name, false);
      walk(full, depth - 1, visit);
    } else if (entry.isFile()) {
      visit(full, entry.name, true);
    }
  }
}

/** Normalized tokens a candidate's weights would carry in a directory or file name. */
function tokensOf(candidate) {
  return candidate.id.toLowerCase()
    .replace(/-q4$/i, '')
    .split(/[-_]/)
    .filter((token) => token.length > 2 && !['instruct', 'gguf', 'q4', 'q8'].includes(token));
}

/**
 * Look for a small local generative model and a runner, without downloading anything.
 * @returns {{available:boolean, kind:string|null, path:string|null, runner:string|null,
 *           reason:string, status:string, candidate:object, registry:object[],
 *           installed:string[], roles:object, probes:object[]}}
 */
export function detectLocalModel({ root = process.cwd(), env = process.env } = {}) {
  const probes = [];
  const preference = env.INSIGHT_SLM_MODEL ?? env.INSIGHT_LOCAL_MODEL_QUALITY ?? null;
  const candidate = selectCandidate({ preference });
  const explicit = env.INSIGHT_LOCAL_MODEL ?? env.INSIGHT_LOCAL_MODEL_PATH ?? env.LOCAL_MODEL_PATH ?? null;
  if (explicit) {
    const path = resolve(root, explicit);
    const exists = existsSync(path);
    probes.push({ probe: 'env', path, exists });
    if (exists && MODEL_FILE.test(path)) {
      return {
        available: false,
        kind: null,
        path,
        runner: null,
        reason: 'gguf_runner_missing',
        status: 'rule-fallback (runtime not installed)',
        candidate,
        registry: REGISTRY,
        installed: [],
        roles: ROLES,
        probes,
      };
    }
  }
  const rootOverride = env.INSIGHT_MODEL_ROOT;
  const effectiveRoot = rootOverride ? resolve(root, rootOverride) : root;

  const transformersRunner = [
    join(effectiveRoot, 'node_modules', '@huggingface', 'transformers'),
    join(effectiveRoot, 'node_modules', '@xenova', 'transformers'),
    // This repo's bundled runtime lives under `.omp-runtime`. Probing only
    // `<root>/node_modules` reported "runtime not installed" beside a runtime that is
    // in fact installed, so installed weights could never become available. The
    // harness runs with its cwd at the repo root or at `app/`, so both are probed.
    join(effectiveRoot, '.omp-runtime', 'node_modules', '@huggingface', 'transformers'),
    join(effectiveRoot, '..', '.omp-runtime', 'node_modules', '@huggingface', 'transformers'),
  ].find((path) => existsSync(path)) ?? null;

  const isAppCwd = existsSync(join(effectiveRoot, 'server.mjs')) || basename(resolve(effectiveRoot)) === 'app';
  const bases = [
    join(effectiveRoot, 'models'),
    join(effectiveRoot, 'data', 'models'),
    join(effectiveRoot, 'app', 'memory', 'data', 'models'),
    join(effectiveRoot, 'engine', 'models'),
    ...(isAppCwd ? [
      join(effectiveRoot, 'memory', 'data', 'models'),
      join(effectiveRoot, '..', 'models'),
      join(effectiveRoot, '..', 'data', 'models'),
      join(effectiveRoot, '..', 'engine', 'models'),
    ] : []),
  ];
  const installed = [];
  let found = null;
  for (const base of bases) {
    if (!existsSync(base)) continue;
    const before = found;
    walk(base, 3, (full, name, isFile) => {
      const lower = name.toLowerCase();
      const match = REGISTRY.find((entry) => {
        const tokens = tokensOf(entry);
        return tokens.length > 0 && tokens.every((token) => lower.includes(token));
      });
      if (match && !installed.includes(match.id)) installed.push(match.id);
      if (before || found) return;
      if (isFile && /\.gguf$/i.test(name)) {
        found = { path: full, kind: 'gguf', candidateId: match?.id ?? null };
        return;
      }
      if (!isFile && GENERATIVE_HINTS.test(name) && existsSync(join(full, 'config.json'))) {
        found = { path: full, kind: 'transformers.js', candidateId: match?.id ?? null };
      }
    });
    probes.push({ probe: 'models', path: base, found: found?.path ?? null });
  }

  // The registry pick is preferred when its own weights are present; otherwise any
  // generative weight that was found is used and named, never silently relabelled.
  const chosen = (found && !preference && candidateById(found.candidateId)) || candidate;
  const chosenInstalled = installed.includes(chosen.id);
  if (found) {
    const runnable = found.kind === 'transformers.js' ? Boolean(transformersRunner) : Boolean(env.INSIGHT_GGUF_RUNNER);
    return {
      available: runnable && chosenInstalled,
      kind: found.kind,
      path: found.path,
      runner: found.kind === 'transformers.js' ? transformersRunner : (env.INSIGHT_GGUF_RUNNER ?? null),
      reason: !chosenInstalled ? 'weights_not_installed' : runnable ? 'found' : 'runtime_not_installed',
      status: runnable && chosenInstalled ? 'local-model' : `rule-fallback (${chosenInstalled ? 'runtime not installed' : 'weights not installed'})`,
      candidate: { ...chosen, installed: chosenInstalled },
      registry: REGISTRY,
      installed,
      roles: ROLES,
      probes,
    };
  }
  return {
    available: false,
    kind: null,
    path: null,
    runner: transformersRunner,
    reason: 'weights_not_installed',
    status: 'rule-fallback (weights not installed)',
    candidate: { ...chosen, installed: false },
    registry: REGISTRY,
    installed,
    roles: ROLES,
    probes,
  };
}

/**
 * Run CPU-bound generation without holding the harness's event loop: work is
 * admitted in slices, a yield is awaited between each one, and the whole run has
 * a deadline. Exceeding it returns what finished plus `aborted: true` — never a
 * silent partial result presented as complete.
 *
 * @template T
 * @param {T[]} items
 * @param {(item:T, index:number)=>any} worker
 * @param {{budgetMs?:number, now?:()=>number, schedule?:(fn:Function)=>void}} [options]
 */
export async function runLowPriority(items = [], worker, { budgetMs = 8000, now = () => Date.now(), schedule = (fn) => setImmediate(fn) } = {}) {
  const startedAt = now();
  const results = [];
  if (typeof worker !== 'function') return { results, aborted: false, reason: 'no_worker', elapsedMs: 0, budgetMs };
  for (let index = 0; index < items.length; index += 1) {
    if (now() - startedAt > budgetMs) {
      return { results, aborted: true, reason: 'budget_exceeded', elapsedMs: now() - startedAt, budgetMs, items: items.length };
    }
    const itemResult = await worker(items[index], index);
    if (now() - startedAt > budgetMs) {
      return { results, aborted: true, reason: 'budget_exceeded', elapsedMs: now() - startedAt, budgetMs, items: items.length };
    }
    results.push(itemResult);
    // One macrotask yield per slice: timers, sockets and RPC frames run in between,
    // so a slow generator can never turn a turn's frame handling into a stall.
    await new Promise((resolveYield) => schedule(resolveYield));
  }
  return { results, aborted: false, reason: null, elapsedMs: now() - startedAt, budgetMs, items: items.length };
}

/**
 * Ask the model for the same shape the rules tier produced, and take only that
 * shape back. Anything else — prose, a truncated object, a different task set —
 * is `null`, which `polishSummary` reports as `unusable_output` instead of
 * pretending a line was polished.
 */
function polishPrompt(summary) {
  const lines = (summary?.tasks ?? []).map((task) => ({
    taskId: task.taskId,
    added: task.added,
    modified: task.modified,
    deleted: task.deleted,
  }));
  return [
    '다음 작업 요약의 각 문장을 한국어로 더 자연스럽게 다듬으세요.',
    '숫자, 파일 경로, taskId는 절대 바꾸지 마세요. 설명 없이 JSON만 출력하세요.',
    '형식: {"tasks":[{"taskId":"...","added":[],"modified":[],"deleted":[]}],"session":{"line":"..."}}',
    JSON.stringify({ tasks: lines, session: { line: summary?.session?.line ?? '' } }),
  ].join('\n');
}

const PHONE_RE = /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g;
const RRN_RE = /\b\d{6}[-\s]?[1-4]\d{6}\b/g;
const API_KEY_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|ocx_[A-Za-z0-9_-]{6,})\b/gi;
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const WIN_PATH_RE = /[a-zA-Z]:\\[^\s"'`]+/g;
const UNIX_ABS_PATH_RE = /(?:^|[\s"'`(])\/(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]*/g;

function hasLeakedPii(value) {
  const text = String(value ?? '');
  if (!text) return false;
  if (sanitizeText(text).total > 0) return true;
  PHONE_RE.lastIndex = 0;
  RRN_RE.lastIndex = 0;
  API_KEY_RE.lastIndex = 0;
  IPV4_RE.lastIndex = 0;
  return PHONE_RE.test(text) || RRN_RE.test(text) || API_KEY_RE.test(text) || IPV4_RE.test(text);
}

function hasAbsolutePath(value) {
  const text = String(value ?? '');
  if (!text) return false;
  WIN_PATH_RE.lastIndex = 0;
  UNIX_ABS_PATH_RE.lastIndex = 0;
  return WIN_PATH_RE.test(text) || UNIX_ABS_PATH_RE.test(text);
}

function stripPii(value) {
  const text = String(value ?? '');
  if (!text) return '';
  const sanitized = sanitizeText(text);
  const base = sanitized.total > 0
    ? sanitized.text.replace(/__PII_[A-Z0-9_]+__|\[(?:개인정보|전화번호|주민번호|이메일|카드번호|계좌번호|비밀키|인증토큰|주소|IP)[^\]]*\]/g, ' ')
    : text;
  return base
    .replace(PHONE_RE, ' ')
    .replace(RRN_RE, ' ')
    .replace(API_KEY_RE, ' ')
    .replace(IPV4_RE, ' ');
}

function hasCleanPolishedLines(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) return false;
  for (const task of parsed.tasks) {
    if (!task || typeof task !== 'object') return false;
    for (const category of ['added', 'modified', 'deleted']) {
      if (task[category] === undefined) continue;
      if (!Array.isArray(task[category])) return false;
      for (const line of task[category]) {
        if (typeof line !== 'string') return false;
        if (hasLeakedPii(line) || hasAbsolutePath(line)) return false;
      }
    }
  }
  if (typeof parsed.session?.line === 'string') {
    if (hasLeakedPii(parsed.session.line) || hasAbsolutePath(parsed.session.line)) return false;
  }
  return true;
}

function parsePolished(text, summary) {
  const source = typeof text === 'string' ? text : '';
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!hasCleanPolishedLines(parsed)) return null;
  // A generation that invents or drops a task id is not a polish of this summary.
  const known = new Set((summary?.tasks ?? []).map((task) => task.taskId));
  if (!parsed.tasks.every((task) => task && known.has(task.taskId))) return null;
  return parsed;
}

function extractGeneratedText(output) {
  if (typeof output === 'string') return output;
  const first = Array.isArray(output) ? output[0] : output;
  const generated = first?.generated_text ?? first;
  if (typeof generated === 'string') return generated;
  if (Array.isArray(generated)) {
    const last = [...generated].reverse().find((msg) => msg?.role === 'assistant') ?? generated[generated.length - 1];
    return typeof last?.content === 'string' ? last.content : '';
  }
  return '';
}

function detectOnnxDtype(modelPath) {
  return existsSync(join(modelPath, 'onnx', 'model_q4f16.onnx')) ? 'q4f16' : 'q4';
}

function loadCachedPipeline(model) {
  const dtype = detectOnnxDtype(model.path);
  const cacheKey = `${model.runner}::${model.path}::${dtype}`;
  if (!pipelineCache.has(cacheKey)) {
    const promise = (async () => {
      const require = createRequire(join(model.runner, 'noop.cjs'));
      const { pipeline, env } = require('@huggingface/transformers');
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      return pipeline('text-generation', model.path, { dtype });
    })().catch((error) => {
      pipelineCache.delete(cacheKey);
      throw error;
    });
    pipelineCache.set(cacheKey, promise);
  }
  return pipelineCache.get(cacheKey);
}

// ---------------------------------------------------------------------------
// Off-thread inference: real ONNX runs in `slm-worker.mjs`, never on this thread

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'slm-worker.mjs');
const DEFAULT_WORKER_TIMEOUT_MS = 120000;
const workerCache = new Map();
let workerExitHookInstalled = false;

/**
 * Whether the runtime the probe found is the real transformers.js package rather
 * than a synthetic test stub. The package ships compiled output under `dist/`; a
 * stub is a lone `index.cjs`, which needs no separate process to stay responsive.
 */
export function isRealTransformersRuntime(runner) {
  return typeof runner === 'string' && runner.length > 0 && existsSync(join(runner, 'dist'));
}

function workerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Nothing in flight: the child must not hold the server's or the runner's loop. */
function releaseWorker(entry) {
  try {
    entry.child.unref();
    entry.child.channel?.unref?.();
  } catch {
    // A worker that already exited has no handle left to release.
  }
}

/** A request is in flight: the parent must not exit from under the answer. */
function holdWorker(entry) {
  try {
    entry.child.ref();
    entry.child.channel?.ref?.();
  } catch {
    // Same as above: a dead handle has nothing to hold.
  }
}

function forgetWorker(key, entry) {
  if (workerCache.get(key) === entry) workerCache.delete(key);
}

/** Answer every request still waiting on this worker, then stop tracking it. */
function failWorker(entry, error) {
  forgetWorker(entry.key, entry);
  for (const request of entry.pending.values()) {
    if (request.timer) clearTimeout(request.timer);
    request.reject(error);
  }
  entry.pending.clear();
}

function spawnWorker(model) {
  const dtype = detectOnnxDtype(model.path);
  const key = `${model.runner}::${model.path}::${dtype}`;
  const cached = workerCache.get(key);
  if (cached && cached.child.exitCode === null && cached.child.signalCode === null) return cached;
  if (!workerExitHookInstalled) {
    workerExitHookInstalled = true;
    // No inference child can outlive the server or the test runner that forked it.
    process.once('exit', () => {
      for (const entry of workerCache.values()) {
        try {
          entry.child.kill();
        } catch {
          // Already gone.
        }
      }
    });
  }
  const child = fork(WORKER_PATH, [], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const entry = { key, child, pending: new Map(), nextId: 1, chain: Promise.resolve(), runner: model.runner, modelPath: model.path, dtype };
  child.on('message', (message) => {
    const request = entry.pending.get(message?.id);
    if (!request) return;
    entry.pending.delete(message.id);
    if (request.timer) clearTimeout(request.timer);
    if (entry.pending.size === 0) releaseWorker(entry);
    if (message.ok) request.resolve(message.output);
    else request.reject(workerError(String(message.error?.message ?? 'slm worker failed'), String(message.error?.code ?? 'worker_error')));
  });
  child.on('error', (error) => failWorker(entry, error));
  child.on('exit', (code, signal) => {
    failWorker(entry, workerError(`slm worker exited (code ${code}, signal ${signal})`, 'worker_exit'));
  });
  releaseWorker(entry);
  workerCache.set(key, entry);
  return entry;
}

function requestWorker(entry, input, options, timeoutMs) {
  const id = entry.nextId;
  entry.nextId += 1;
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_WORKER_TIMEOUT_MS;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      // ONNX inference cannot be cancelled mid-run inside the child, so the honest
      // reply is to stop the process and let the caller take its fallback tier.
      try {
        entry.child.kill();
      } catch {
        // Already gone; the pending rejection below is what the caller sees.
      }
      failWorker(entry, workerError(`slm worker timed out after ${limit}ms`, 'worker_timeout'));
    }, limit);
    timer.unref?.();
    entry.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    holdWorker(entry);
    try {
      entry.child.send(
        { id, runner: entry.runner, modelPath: entry.modelPath, dtype: entry.dtype, messagesOrPrompt: input, options },
        (error) => {
          if (!error) return;
          const request = entry.pending.get(id);
          if (!request) return;
          entry.pending.delete(id);
          clearTimeout(request.timer);
          if (entry.pending.size === 0) releaseWorker(entry);
          request.reject(error);
        },
      );
    } catch (error) {
      const request = entry.pending.get(id);
      if (!request) return;
      entry.pending.delete(id);
      clearTimeout(request.timer);
      if (entry.pending.size === 0) releaseWorker(entry);
      request.reject(error);
    }
  });
}

/**
 * One generation through the persistent child. Requests are queued per worker: the
 * pipeline keeps one decoder state, and the child is single-threaded anyway.
 */
function generateInWorker(model, input, options, { timeoutMs } = {}) {
  const entry = spawnWorker(model);
  const start = () => requestWorker(entry, input, options, timeoutMs);
  const queued = entry.chain.then(start, start);
  entry.chain = queued.then(() => undefined, () => undefined);
  return queued;
}

async function generateWithModel(model, input, options, workerOptions = {}) {
  if (isRealTransformersRuntime(model.runner)) return generateInWorker(model, input, options, workerOptions);
  const generate = await loadCachedPipeline(model);
  return generate(input, options);
}

/** How many inference workers this process keeps; zero means none outlived a call. */
export function activeLocalModelWorkers() {
  return workerCache.size;
}

/**
 * Stop every inference worker: pending requests are rejected as `worker_cancelled`,
 * the channel is disconnected (the child exits on `disconnect`), and a child that
 * ignores the polite signal is killed after `timeoutMs`.
 */
export async function shutdownLocalModelWorkers({ timeoutMs = 1000 } = {}) {
  const entries = [...workerCache.entries()];
  const cancelled = workerError('slm worker cancelled', 'worker_cancelled');
  const exits = [];
  for (const [key, entry] of entries) {
    workerCache.delete(key);
    for (const request of entry.pending.values()) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(cancelled);
    }
    entry.pending.clear();
    exits.push(new Promise((resolveExit) => {
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) return resolveExit();
      // Hold the child handle while waiting for it to exit: an idle worker was
      // unreffed, so without a ref an ESM top-level await here could see an empty
      // loop before the exit event arrives.
      holdWorker(entry);
      const timer = setTimeout(() => {
        try {
          entry.child.kill();
        } catch {
          // Already gone.
        }
        resolveExit();
      }, timeoutMs);
      entry.child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
      try {
        entry.child.disconnect();
      } catch {
        // Channel already closed; the exit event settles this.
      }
    }));
  }
  await Promise.all(exits);
}

/**
 * The production generator behind the `local-model` tier. It loads the weights the
 * probe already found, through the transformers.js runtime the probe already found,
 * on first use — no download (`allowRemoteModels = false`), no provider, no network
 * beyond reading local files. A real runtime is driven through `slm-worker.mjs` so
 * the inference runs in another process; a stub runtime is called in-process.
 * Returns `null` when the probe says there is nothing to load, so the caller keeps
 * the rules tier without a special case.
 */
export function createLocalGenerator(model, { maxNewTokens = 256, workerTimeoutMs = DEFAULT_WORKER_TIMEOUT_MS } = {}) {
  if (!model?.available || !model.path || !model.runner) return null;
  const options = { max_new_tokens: maxNewTokens, do_sample: false, return_full_text: false };
  return async function generateLocalPolish(summary) {
    const output = await generateWithModel(model, polishPrompt(summary), options, { timeoutMs: workerTimeoutMs });
    return parsePolished(extractGeneratedText(output), summary);
  };
}

/**
 * Rewrite the rules-tier lines with a local model. Never called when the probe
 * says unavailable, so the rules tier is always the fallback. A generator that
 * exceeds the budget or answers a shape the rules never produced leaves the
 * rules tier in place and says which happened.
 */
export async function polishSummary(summary, { model, generator, budgetMs = 15000, workerTimeoutMs = DEFAULT_WORKER_TIMEOUT_MS, now, schedule } = {}) {
  const base = { ...summary, tier: 'rules', modelStatus: model?.status ?? 'rule-fallback (weights not installed)' };
  const produce = typeof generator === 'function' ? generator : createLocalGenerator(model, { workerTimeoutMs });
  if (!model?.available || typeof produce !== 'function') return base;
  let run;
  try {
    run = await runLowPriority([summary], (input) => produce(input), { budgetMs, ...(now ? { now } : {}), ...(schedule ? { schedule } : {}) });
  } catch {
    return { ...base, tier: 'rules', fallbackReason: 'generation_error' };
  }
  const output = run.results[0];
  if (run.aborted) return { ...base, tier: 'rules', fallbackReason: 'budget_exceeded', generationMs: run.elapsedMs };
  if (!hasCleanPolishedLines(output)) {
    return { ...base, tier: 'rules', fallbackReason: 'unusable_output', generationMs: run.elapsedMs };
  }
  return { ...output, tier: 'local-model', modelStatus: 'local-model', generationMs: run.elapsedMs };
}

// ---------------------------------------------------------------------------
// Session title auto-generation (role: 'session-title' -> slm)

function stripPathsAndExtensions(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[a-zA-Z]:\\[^\s"'`)]+/g, ' ')
    .replace(/(?:^|[\s"'`(])\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+/g, ' ')
    .replace(/(?:^|[\s"'`(])(?:[a-zA-Z0-9_.-]+[\\/])+[a-zA-Z0-9_.-]+/g, ' ')
    .replace(/\b[a-zA-Z0-9_-]+\.[a-z0-9]{1,5}\b/gi, ' ');
}

const HANGUL_RE = /[가-힣]/;
// `--primary-color`, `:root`, `{…}`, `#3f51b5`, `styles.css`, a path, markup, a
// quote, a colon, an ellipsis or a comma-separated list is a code token or an echo
// of the prompt's subject line, never a word of a title.
const FORBIDDEN_TITLE_RE = /(?:--[A-Za-z0-9_-]+|:root\b|\{|\}|#[0-9a-fA-F]{3,8}\b|[A-Za-z0-9_-]+\.[a-z]{1,5}\b|[,\\/<>|`*_"'“”‘’「」『』:–—、\-]|…|\.{3})/;
// "…업로드합니다" is a sentence about the work; a title names the work.
const SENTENCE_TAIL_RE = /(?:습니다|합니다|됩니다|하세요|해\s*줘|한다|했다|하기|하기를)[.!]?$/;
// "…바꾸고" is a participle cut mid-sentence, not a noun phrase.
const FRAGMENT_TAIL_RE = /(?:하고|바꾸고|고치고|만들고|개선하고|강화하고|추가하고|제거하고|조정하고|맞추고|수정하고|검증하고|업로드하고)$/;

/** `styles` is a file's stem, not a Korean word of a title; `GitHub` is a name. */
function hasLowercaseCodeWord(text) {
  return text.split(/\s+/).some((token) => /^[a-z][a-z0-9_-]*[.,;:!?]?$/.test(token) && !/[가-힣]/.test(token));
}

/** Drop the code-shaped fragments a title must never carry, before judging length. */
function stripCodeTokens(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/:root\b/gi, ' ')
    .replace(/--[A-Za-z0-9_-]+/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/#[0-9a-fA-F]{3,8}\b/g, ' ')
    .replace(/…+|\.{3,}/g, ' ')
    .replace(/\s*[=;]\s*/g, ' ');
}

function sanitizeTitleText(raw) {
  let text = stripCodeTokens(raw).trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  text = lines[0] ?? '';
  text = text
    .replace(/^[-*#>\d.)\s]+/, '')
    .replace(/[*_`~]/g, '')
    .replace(/["'“”‘’「」『』\[\]]/g, '')
    .replace(/^(?:제목|세션\s*제목|제목\s*후보|title|summary)\s*[:：-]\s*/i, '');
  text = stripPathsAndExtensions(text);
  text = stripPii(text);
  text = text
    .replace(/["'“”‘’「」『』\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,:;!?·…-]+/, '')
    .replace(/[\s.,:;!?·…-]+$/, '')
    .trim();
  return text;
}

/**
 * A title is usable only when it reads as the work: 8–24 Korean characters, a noun
 * phrase, with no code token, path, markup, quote, ellipsis or trailing punctuation.
 * An answer that misses is unusable — the rule title answers instead. Never a slice.
 */
function isUsableTitle(value) {
  const text = String(value ?? '');
  const length = [...text].length;
  if (length < MIN_TITLE_CHARS || length > MAX_TITLE_CHARS) return false;
  if (!HANGUL_RE.test(text)) return false;
  if (FORBIDDEN_TITLE_RE.test(text) || SENTENCE_TAIL_RE.test(text) || FRAGMENT_TAIL_RE.test(text)) return false;
  if (hasLowercaseCodeWord(text)) return false;
  if (/[.,;:!?]$/.test(text)) return false;
  return true;
}

function fileStemLabel(filePath) {
  const normalized = String(filePath ?? '').trim().replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base.replace(/\.[^.]+$/, '') || base;
}

// The rule title is composed from the work the request names, never from a slice of
// the request itself: a subject phrase is looked up and paired with the action verb.
const TITLE_SUBJECTS = Object.freeze([
  { match: /세션\s*제목|자동\s*제목|\btitle\b/i, phrases: ['세션 제목 생성', '세션 제목'] },
  { match: /승인\s*게이트|승인\s*요청|\bapproval\b/i, phrases: ['승인 게이트', '승인 절차'] },
  { match: /테마|다크\s*모드|라이트\s*모드|\btheme\b/i, phrases: ['테마 기본값', '테마'] },
  { match: /색상|컬러|팔레트|색\s*톤/i, phrases: ['스타일 색상', '화면 색상'] },
  { match: /로컬\s*모델|\bslm\b|모델/i, phrases: ['로컬 모델', '모델 연결'] },
  { match: /시연\s*영상|데모\s*영상|영상|촬영/i, phrases: ['시연 영상', '영상'] },
  { match: /깃허브|\bgithub\b|원격\s*저장소/i, phrases: ['GitHub 업로드', '저장소 업로드'] },
  { match: /라우터|\brouter\b/i, phrases: ['인사이트 라우터', '라우터'] },
  { match: /프롬프트|\bprompt\b/i, phrases: ['프롬프트 정리', '프롬프트'] },
  { match: /일지|저널|타임라인/i, phrases: ['작업 일지', '타임라인'] },
  { match: /보고서|리포트|문서/i, phrases: ['보고서 작성', '문서 정리'] },
  { match: /접근성|\baria\b|명암|포커스/i, phrases: ['접근성 개선', '접근성 점검'] },
  { match: /테스트|검증/i, phrases: ['테스트 보강', '검증'] },
]);

const TITLE_ACTIONS = Object.freeze([
  { match: /수정|고쳐|고치|다듬|보완|\brefactor\b/i, verb: '수정' },
  { match: /제거|없애|삭제|지워|빼|비활성|\bremove\b/i, verb: '제거' },
  { match: /변경|바꿔|바꾸|바꿔|전환|교체|\bchange\b/i, verb: '변경' },
  { match: /재촬영|촬영/i, verb: '재촬영' },
  { match: /업로드|푸시|올려|올리|\bpush\b/i, verb: '업로드' },
  { match: /추가|구현|만들|넣|작성|\badd\b/i, verb: '추가' },
  { match: /조사|분석|확인|검토/i, verb: '점검' },
  { match: /테스트|검증/i, verb: '검증' },
]);

const FILE_SUBJECTS = Object.freeze([
  { match: /styles?\.css$/i, phrases: ['화면 스타일'] },
  { match: /app\.js$/i, phrases: ['화면 동작'] },
  { match: /routes\.mjs$/i, phrases: ['인사이트 라우터'] },
  { match: /local-model\.mjs$/i, phrases: ['로컬 모델'] },
  { match: /\.css$/i, phrases: ['화면 스타일'] },
  { match: /\.html$/i, phrases: ['화면 구조'] },
  { match: /\.(?:js|mjs|ts)$/i, phrases: ['코드 정리'] },
  { match: /\.md$/i, phrases: ['문서 정리'] },
]);

/** First composition that is a readable title; the only shortening is a shorter noun. */
function composeRuleTitle(phrases, verb) {
  for (const phrase of phrases) {
    const shapes = [];
    // A phrase that already names the action ("GitHub 업로드") must not repeat it.
    if (verb && !phrase.includes(verb)) shapes.push(`${phrase} ${verb}`);
    shapes.push(phrase, `${phrase} 정리`);
    for (const shape of shapes) {
      if (isUsableTitle(shape)) return shape;
    }
  }
  return '';
}

/**
 * Deterministic, tier-`rules` title: verb + object built from the request. Returns
 * at most `MAX_TITLE_CHARS`, at least `MIN_TITLE_CHARS`, and never a prompt slice.
 */
export function deriveRuleTitle(input) {
  const payload = typeof input === 'string' ? { prompt: input } : (input ?? {});
  const promptText = String(payload.prompt ?? '');
  const replyText = String(payload.reply ?? '');
  const files = Array.isArray(payload.files) ? payload.files : [];
  const verbOf = (text) => TITLE_ACTIONS.find((action) => action.match.test(text))?.verb ?? '';
  const subjectOf = (text) => TITLE_SUBJECTS.find((subject) => subject.match.test(text))?.phrases ?? null;
  // The request's own verb wins: the reply describes what the agent did to it.
  const verb = verbOf(promptText) || verbOf(replyText);
  const subjects = [
    subjectOf(promptText),
    subjectOf(replyText),
    FILE_SUBJECTS.find((subject) => subject.match.test(files.join(' ')))?.phrases ?? null,
  ].filter(Boolean);
  for (const phrases of subjects) {
    const title = composeRuleTitle(phrases, verb);
    if (title) return title;
  }
  return composeRuleTitle(['작업 내용', '세션 정리'], verb) || '작업 내용 정리';
}

/**
 * Scrub paths, extensions, code/CSS tokens and lowercase code identifiers from an
 * input line before sending it to the 0.5B title model so it never echoes `styles`,
 * `:root`, `--primary-color`, `#16a34a`, or `approval` back into the title.
 */
function scrubTitleInput(text, limit = 320) {
  let cleaned = stripPii(String(text ?? ''));
  // A masked value is not title material. A sentence that carried one cannot be
  // trusted either — the mask hides the very word the title would need — so it is
  // dropped whole rather than left as a hole the model has to guess around.
  const masked = /\[(?:[A-Z_]+)_?\d*\]|__PII_[A-Z0-9_]+__/;
  if (masked.test(cleaned)) {
    const sentences = cleaned.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter((sentence) => !masked.test(sentence));
    // Dropping the masked sentence is the point; dropping the whole request is not —
    // when every sentence carried one, the unmasked words still name the work.
    cleaned = (kept.length ? kept : sentences).join(' ');
  }
  cleaned = cleaned.replace(/\[(?:[A-Z_]+)_?\d*\]/g, ' ').replace(/__PII_[A-Z0-9_]+__/g, ' ');
  cleaned = stripPathsAndExtensions(cleaned);
  cleaned = stripCodeTokens(cleaned);
  // Drop lowercase code identifiers (`styles`, `approval`, `theme`, `aria`, `sample-project`),
  // while preserving proper-cased product names such as `GitHub`.
  cleaned = cleaned.replace(/(^|[\s(\["'“‘])([a-z][a-z0-9_-]*)(?=[\s)\]"'”’.,:;!?가-힣]|$)/g, '$1 ');
  // Clean up orphaned Korean particles left behind after removing a file/token stem.
  cleaned = cleaned
    .replace(/\s+/g, ' ')
    .replace(/(?:^|\s)[,·]+(?=\s|$)/g, ' ')
    .replace(/(?:^|\s)(?:에서|의|을|를|와|과|로|으로)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, limit).trim();
}

/**
 * The reply as title context, if it is usable as context at all. A reply written as
 * a sentence makes the 0.5B model answer with a sentence, so a reply that only exists
 * as a sentence is dropped — never handed to the model to echo.
 */
function scrubReplyLine(reply, limit = 90) {
  const cleaned = scrubTitleInput(reply, limit).trim();
  if (!cleaned) return '';
  // A sentence ending anywhere at the tail means the reply is a sentence, not a phrase.
  if (/(?:습니다|ㅂ니다|니다|어요|아요|세요|죠|해\s*줘|해\s*주세요)[.!]?\s*$/.test(cleaned)) return '';
  return cleaned.replace(/[.!?]\s*$/, '').trim();
}

function koreanFileSubjects(files) {
  if (!Array.isArray(files) || !files.length) return [];
  const labels = [];
  for (const file of files) {
    const entry = FILE_SUBJECTS.find((subject) => subject.match.test(String(file ?? '')));
    const label = entry?.phrases?.[0];
    if (label && !labels.includes(label)) labels.push(label);
  }
  // One subject is enough context: a longer list makes the 0.5B model answer with the
  // list instead of the request (its answer is capped at 24 characters).
  return labels.slice(0, 1);
}

/**
 * The exact messages the title model sees. Exported so the replay and the tests can
 * assert the prompt's constraints instead of restating them. The inputs are scrubbed
 * of code tokens and raw stems before they reach the model, and two chat-template
 * example pairs show the shape the answer must take.
 */
export function buildTitleMessages(input) {
  const request = scrubTitleInput(input?.prompt, 120);
  const result = scrubReplyLine(input?.reply);
  const subjects = koreanFileSubjects(input?.files);
  const lines = [`요청: ${request || '일반 개발 작업'}`];
  if (result) lines.push(`결과: ${result}`);
  if (subjects.length) lines.push(`대상: ${subjects.join(', ')}`);
  lines.push('제목:');
  const example = '요청: 파일의 색상 값을 초록 계열로 바꿔 주세요.\n결과: 초록 계열로 바꾸고 대비를 조정\n대상: 화면 스타일\n제목:';
  return [
    {
      role: 'system',
      content: `${MIN_TITLE_CHARS}~${MAX_TITLE_CHARS}자 한국어 명사구 제목 한 줄만 출력. 명사로 끝낸다(변경/수정/제거/업로드/검증). 문장(합니다/했습니다/하세요)과 연결 어미(하고/바꾸고)와 경로·코드·따옴표·마침표·말줄임표·쉼표 금지. 쉼표 목록이나 요청 단어 나열은 제목이 아니다.`,
    },
    { role: 'user', content: example },
    { role: 'assistant', content: '화면 색상 스타일 변경' },
    { role: 'user', content: '요청: 실행 전 확인 절차를 없애고 바로 동작하게 해 줘.\n결과: 확인 단계 제거\n제목:' },
    { role: 'assistant', content: '자동 실행 승인 절차 제거' },
    { role: 'user', content: lines.join('\n') },
  ];
}

function parseTitleOutput(raw) {
  const candidate = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.title === 'string'
    ? raw.title
    : extractGeneratedText(raw);
  if (!candidate || /^\s*[{[]/.test(candidate)) return '';
  if (hasLeakedPii(candidate) || hasAbsolutePath(candidate)) return '';
  const title = sanitizeTitleText(candidate);
  return isUsableTitle(title) ? title : '';
}

/**
 * Generate a concise Korean session title using the local SLM ('session-title' role),
 * falling back deterministically to a clean rule-derived title when weights/runtime
 * are absent or generation fails/times out.
 */
export async function generateSessionTitle(input, { model, generator, budgetMs = 90000, workerTimeoutMs = DEFAULT_WORKER_TIMEOUT_MS, root, env, now, schedule } = {}) {
  const payload = typeof input === 'string' ? { prompt: input } : (input ?? {});
  const resolvedModel = model ?? detectLocalModel({ ...(root !== undefined ? { root } : {}), ...(env !== undefined ? { env } : {}) });
  const modelId = resolvedModel?.candidate?.id ?? DEFAULT_CANDIDATE;
  const fallbackTitle = deriveRuleTitle(payload);

  if (!resolvedModel?.available) {
    return {
      title: fallbackTitle,
      tier: 'rules',
      source: 'rules',
      modelId,
      modelStatus: resolvedModel?.status ?? 'rule-fallback (weights not installed)',
      fallbackReason: resolvedModel?.reason ?? 'weights_not_installed',
    };
  }

  const messages = buildTitleMessages(payload);
  const produce = typeof generator === 'function'
    ? generator
    : async () => generateWithModel(
        resolvedModel,
        messages,
        { max_new_tokens: 24, do_sample: false, return_full_text: false },
        { timeoutMs: workerTimeoutMs },
      );

  let run;
  try {
    run = await runLowPriority(
      [payload],
      (item) => produce(typeof generator === 'function' ? item : messages),
      { budgetMs, ...(now ? { now } : {}), ...(schedule ? { schedule } : {}) },
    );
  } catch {
    return {
      title: fallbackTitle,
      tier: 'rules',
      source: 'rules',
      modelId,
      modelStatus: resolvedModel?.status ?? 'local-model',
      fallbackReason: 'generation_error',
    };
  }

  if (run.aborted) {
    return {
      title: fallbackTitle,
      tier: 'rules',
      source: 'rules',
      modelId,
      modelStatus: resolvedModel?.status ?? 'local-model',
      fallbackReason: 'budget_exceeded',
      generationMs: run.elapsedMs,
    };
  }

  // An answer that is not a readable noun phrase is unusable: the labelled rule
  // title answers instead. Nothing here truncates the answer to make it fit.
  const title = parseTitleOutput(run.results[0]);
  if (!title) {
    return {
      title: fallbackTitle,
      tier: 'rules',
      source: 'rules',
      modelId,
      modelStatus: resolvedModel?.status ?? 'local-model',
      fallbackReason: 'unusable_output',
      generationMs: run.elapsedMs,
    };
  }

  return {
    title,
    tier: 'local-model',
    source: 'model',
    modelId,
    modelStatus: 'local-model',
    generationMs: run.elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// AI work journal polishing (matches app/public/insight.js payload & rules)

function usableJournalText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > MAX_JOURNAL_LINE_CHARS) return '';
  if (hasLeakedPii(text) || hasAbsolutePath(text)) return '';
  if (/[\\/]|\.[a-z0-9]{1,5}\b/i.test(text)) return '';
  return text;
}

function sanitizeJournalSentence(raw) {
  let text = String(raw ?? '').replace(/```[\s\S]*?```/g, ' ').trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  text = lines[0] ?? '';
  text = text
    .replace(/^[-*#>\d.)\s]+/, '')
    .replace(/[*_`~]/g, '')
    .replace(/["'“”‘’「」『』\[\]]/g, '')
    .replace(/^(?:한\s*문장\s*요약|요약|설명|summary)\s*[:：-]\s*/i, '')
    .replace(/["'“”‘’「」『』\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return usableJournalText(text);
}

function summarizeTaskCategories(task) {
  const groups = new Map();
  for (const change of Array.isArray(task?.changes) ? task.changes : []) {
    const category = String(change?.category ?? '').trim();
    if (!JOURNAL_CATEGORIES.includes(category)) continue;
    let group = groups.get(category);
    if (!group) {
      group = { category, subjects: [], count: 0, added: 0, removed: 0 };
      groups.set(category, group);
    }
    group.count += 1;
    const rawSubject = String(change?.subject ?? '').trim();
    const subject = rawSubject && !/[\\/]|\.[a-z0-9]{1,5}\b/i.test(rawSubject)
      ? rawSubject
      : fileStemLabel(change?.path);
    if (subject && !group.subjects.includes(subject)) group.subjects.push(subject);
    if (Number.isFinite(change?.added)) group.added += change.added;
    if (Number.isFinite(change?.removed)) group.removed += change.removed;
  }
  return [...groups.values()];
}

function buildJournalRowMessages(item) {
  const lines = [];
  if (item.taskName) lines.push(`작업명: ${item.taskName}`);
  lines.push(`분류: ${item.category}`);
  if (item.subjects.length) lines.push(`대상: ${item.subjects.slice(0, 4).join(', ')}`);
  lines.push(`변경 건수: ${item.count}건`);
  if (item.added || item.removed) {
    lines.push(`추가 줄: ${item.added}, 삭제 줄: ${item.removed}`);
  }
  lines.push('한 문장 요약:');
  return [
    {
      role: 'system',
      content: '한국어 작업 일지 문장 작성기입니다. 주어진 작업 내역을 바탕으로 "~했습니다."로 끝나는 자연스러운 한국어 한 문장만 출력하세요. 파일 경로, 확장자, 따옴표, 설명은 절대 쓰지 마세요.',
    },
    {
      role: 'user',
      content: lines.join('\n'),
    },
  ];
}

function normalizeJournalTasks(tasksPayload) {
  const rawTasks = Array.isArray(tasksPayload?.tasks) ? tasksPayload.tasks : [];
  return rawTasks
    .filter((task) => task && typeof task.taskId === 'string' && task.taskId)
    .map((task) => ({
      taskId: task.taskId,
      taskName: String(task.taskName ?? '').trim().slice(0, 80),
      categories: summarizeTaskCategories(task),
    }))
    .filter((task) => task.categories.length > 0);
}

/**
 * Whether a journal payload carries anything a model could summarize. An activity
 * revision with no `changes`, or with changes whose category is not one of the
 * writable journal rows, has nothing to say — asking the SLM would burn seconds
 * on an answer that can only be rejected.
 */
export function hasSummarizableTasks(tasksPayload) {
  return normalizeJournalTasks(tasksPayload).length > 0;
}

function tryParseJson(text) {
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

/** The balanced `{...}`/`[...]` span that starts at `start`, string-aware. */
function balancedJsonSpan(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * First parseable object or array in a model answer. A small model wraps its JSON
 * in prose, in a ```json fence, or in a top-level array; every one of those is still
 * the same answer, so the first block that parses is the one to validate.
 */
function firstParsedJson(text) {
  const source = String(text ?? '');
  if (!source.trim()) return null;
  const fenced = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  for (const block of [source, ...fenced]) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const direct = tryParseJson(trimmed);
    if (direct) return direct;
    for (let index = 0; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (char !== '{' && char !== '[') continue;
      const span = balancedJsonSpan(trimmed, index);
      if (!span) continue;
      const parsed = tryParseJson(span);
      if (parsed) return parsed;
    }
  }
  return null;
}

/** A generator answer is either already-structured JSON or text to be parsed. */
function resolveJournalPayload(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.generated_text === 'undefined') {
    return raw;
  }
  if (Array.isArray(raw) && raw.length > 0 && raw.every((item) => item && typeof item === 'object' && !('role' in item))
    && raw.some((item) => Array.isArray(item.rows) || Array.isArray(item.categories) || 'category' in item)) {
    return raw;
  }
  return firstParsedJson(extractGeneratedText(raw));
}

const JOURNAL_PAYLOAD_KEYS = ['tasks', 'rows', 'categories', 'items', 'results', 'journal'];

function parseJournalTasks(raw, normalizedTasks) {
  const parsed = resolveJournalPayload(raw);
  if (!parsed) return [];
  const knownTasks = new Map(normalizedTasks.map((t) => [t.taskId, new Set(t.categories.map((c) => c.category))]));
  const rowsByTask = new Map();
  const accept = (taskId, category, text) => {
    if (typeof taskId !== 'string' || !knownTasks.has(taskId)) return;
    const cat = String(category ?? '').trim();
    if (!JOURNAL_CATEGORIES.includes(cat)) return;
    const clean = usableJournalText(text);
    if (!clean) return;
    if (!rowsByTask.has(taskId)) rowsByTask.set(taskId, new Map());
    const taskMap = rowsByTask.get(taskId);
    if (!taskMap.has(cat)) taskMap.set(cat, clean);
  };

  const seen = new Set();
  const walk = (node, inheritedTaskId) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inheritedTaskId);
      return;
    }
    const taskId = typeof node.taskId === 'string' ? node.taskId : inheritedTaskId;
    const text = node.text ?? node.summary ?? node.line;
    if (typeof text === 'string') accept(taskId, node.category, text);
    for (const key of JOURNAL_PAYLOAD_KEYS) {
      if (Array.isArray(node[key])) walk(node[key], taskId);
    }
  };
  walk(parsed, undefined);

  const out = [];
  for (const [taskId, catMap] of rowsByTask.entries()) {
    const rows = [];
    for (const [category, text] of catMap.entries()) rows.push({ category, text });
    if (rows.length > 0) out.push({ taskId, rows });
  }
  return out;
}

/**
 * Polish AI work journal tasks sent by `app/public/insight.js` (`{ tasks: [{ taskId, taskName, changes }] }`).
 * Returns `{ tasks: [{ taskId, rows: [{ category, text }] }], source: 'model', modelId, tier: 'local-model', generationMs }`
 * or `{ tasks: [], source: 'rules', tier: 'rules', fallbackReason }` on fallback.
 */
export async function polishJournalTasks(tasksPayload, { model, generator, budgetMs = 90000, workerTimeoutMs = DEFAULT_WORKER_TIMEOUT_MS, root, env, now, schedule } = {}) {
  const normalizedTasks = normalizeJournalTasks(tasksPayload);
  const knownModelId = model?.candidate?.id ?? DEFAULT_CANDIDATE;

  // A revision with nothing writable to say is answered from the rules tier
  // without ever touching the weights: generation would cost seconds and the
  // only possible verdict is rejection.
  if (normalizedTasks.length === 0) {
    return {
      tasks: [],
      source: 'rules',
      tier: 'rules',
      modelId: knownModelId,
      modelStatus: model?.status ?? 'rule-fallback (nothing to summarize)',
      fallbackReason: 'nothing_to_summarize',
    };
  }

  const resolvedModel = model ?? detectLocalModel({ ...(root !== undefined ? { root } : {}), ...(env !== undefined ? { env } : {}) });
  const modelId = resolvedModel?.candidate?.id ?? DEFAULT_CANDIDATE;

  if (!resolvedModel?.available) {
    return {
      tasks: [],
      source: 'rules',
      tier: 'rules',
      modelId,
      modelStatus: resolvedModel?.status ?? 'rule-fallback (weights not installed)',
      fallbackReason: resolvedModel?.reason ?? 'weights_not_installed',
    };
  }

  if (typeof generator === 'function') {
    let run;
    try {
      run = await runLowPriority(
        [tasksPayload],
        (item) => generator(item),
        { budgetMs, ...(now ? { now } : {}), ...(schedule ? { schedule } : {}) },
      );
    } catch {
      return {
        tasks: [],
        source: 'rules',
        tier: 'rules',
        modelId,
        modelStatus: resolvedModel?.status ?? 'local-model',
        fallbackReason: 'generation_error',
      };
    }

    if (run.aborted) {
      return {
        tasks: [],
        source: 'rules',
        tier: 'rules',
        modelId,
        modelStatus: resolvedModel?.status ?? 'local-model',
        fallbackReason: 'budget_exceeded',
        generationMs: run.elapsedMs,
      };
    }

    const polished = parseJournalTasks(run.results[0], normalizedTasks);
    if (polished.length === 0) {
      return {
        tasks: [],
        source: 'rules',
        tier: 'rules',
        modelId,
        modelStatus: resolvedModel?.status ?? 'local-model',
        fallbackReason: 'unusable_output',
        generationMs: run.elapsedMs,
      };
    }

    return {
      tasks: polished,
      source: 'model',
      modelId,
      tier: 'local-model',
      modelStatus: 'local-model',
      generationMs: run.elapsedMs,
    };
  }

  const rowWorkItems = [];
  for (const task of normalizedTasks) {
    for (const cat of task.categories) {
      rowWorkItems.push({
        taskId: task.taskId,
        taskName: task.taskName,
        category: cat.category,
        subjects: cat.subjects,
        count: cat.count,
        added: cat.added,
        removed: cat.removed,
      });
    }
  }

  let run;
  try {
    run = await runLowPriority(
      rowWorkItems,
      async (item) => {
        const output = await generateWithModel(
          resolvedModel,
          buildJournalRowMessages(item),
          { max_new_tokens: 64, do_sample: false, return_full_text: false },
          { timeoutMs: workerTimeoutMs },
        );
        return {
          taskId: item.taskId,
          category: item.category,
          text: sanitizeJournalSentence(extractGeneratedText(output)),
        };
      },
      { budgetMs, ...(now ? { now } : {}), ...(schedule ? { schedule } : {}) },
    );
  } catch {
    return {
      tasks: [],
      source: 'rules',
      tier: 'rules',
      modelId,
      modelStatus: resolvedModel?.status ?? 'local-model',
      fallbackReason: 'generation_error',
    };
  }

  if (run.aborted && run.results.length === 0) {
    return {
      tasks: [],
      source: 'rules',
      tier: 'rules',
      modelId,
      modelStatus: resolvedModel?.status ?? 'local-model',
      fallbackReason: 'budget_exceeded',
      generationMs: run.elapsedMs,
    };
  }

  const rowsByTask = new Map();
  for (const row of run.results) {
    if (!row?.text) continue;
    if (!rowsByTask.has(row.taskId)) rowsByTask.set(row.taskId, []);
    rowsByTask.get(row.taskId).push({ category: row.category, text: row.text });
  }
  const polished = [];
  for (const [taskId, rows] of rowsByTask.entries()) {
    if (rows.length > 0) polished.push({ taskId, rows });
  }

  if (polished.length === 0) {
    return {
      tasks: [],
      source: 'rules',
      tier: 'rules',
      modelId,
      modelStatus: resolvedModel?.status ?? 'local-model',
      fallbackReason: run.aborted ? 'budget_exceeded' : 'unusable_output',
      generationMs: run.elapsedMs,
    };
  }

  return {
    tasks: polished,
    source: 'model',
    modelId,
    tier: 'local-model',
    modelStatus: 'local-model',
    generationMs: run.elapsedMs,
  };
}

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

import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { sanitizeText } from '../privacy/index.mjs';

const GENERATIVE_HINTS = /(instruct|chat|qwen|llama|phi|gemma|mistral|deepseek|exaone|solar|tinyllama|granite|lfm)/i;
const MODEL_FILE = /\.(gguf|ggml|safetensors|bin)$/i;
const JOURNAL_CATEGORIES = Object.freeze(['조사', '추가', '수정', '삭제', '검증', '오류 복구']);
const MAX_TITLE_CHARS = 36;
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

/**
 * The production generator behind the `local-model` tier. It loads the weights the
 * probe already found, through the transformers.js runtime the probe already found,
 * on first use — no download (`allowRemoteModels = false`), no provider, no network
 * beyond reading local files. Returns `null` when the probe says there is nothing
 * to load, so the caller keeps the rules tier without a special case.
 */
export function createLocalGenerator(model, { maxNewTokens = 256 } = {}) {
  if (!model?.available || !model.path || !model.runner) return null;
  return async function generateLocalPolish(summary) {
    const generate = await loadCachedPipeline(model);
    const output = await generate(polishPrompt(summary), {
      max_new_tokens: maxNewTokens,
      do_sample: false,
      return_full_text: false,
    });
    return parsePolished(extractGeneratedText(output), summary);
  };
}

/**
 * Rewrite the rules-tier lines with a local model. Never called when the probe
 * says unavailable, so the rules tier is always the fallback. A generator that
 * exceeds the budget or answers a shape the rules never produced leaves the
 * rules tier in place and says which happened.
 */
export async function polishSummary(summary, { model, generator, budgetMs = 15000, now, schedule } = {}) {
  const base = { ...summary, tier: 'rules', modelStatus: model?.status ?? 'rule-fallback (weights not installed)' };
  const produce = typeof generator === 'function' ? generator : createLocalGenerator(model);
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

function sanitizeTitleText(raw) {
  let text = String(raw ?? '').replace(/```[\s\S]*?```/g, ' ').trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  text = lines[0] ?? '';
  text = text
    .replace(/^[-*#>\d.)\s]+/, '')
    .replace(/[*_`~]/g, '')
    .replace(/["'“”‘’「」『』\[\]]/g, '')
    .replace(/^(?:제목|세션\s*제목|title|summary)\s*[:：-]\s*/i, '')
    .replace(/["'“”‘’「」『』\[\]]/g, '');
  text = stripPii(text);
  text = stripPathsAndExtensions(text);
  text = text.replace(/\s+/g, ' ').replace(/[.,:;!?]+$/, '').trim();
  if (!text) return '';
  if (text.length <= MAX_TITLE_CHARS) return text;
  return `${text.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

function fileStemLabel(filePath) {
  const normalized = String(filePath ?? '').trim().replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base.replace(/\.[^.]+$/, '') || base;
}

export function deriveRuleTitle(input) {
  const payload = typeof input === 'string' ? { prompt: input } : (input ?? {});
  const fromPrompt = sanitizeTitleText(payload.prompt);
  if (fromPrompt.length >= 2) return fromPrompt;
  const fromReply = sanitizeTitleText(payload.reply);
  if (fromReply.length >= 2) return fromReply;
  const files = Array.isArray(payload.files) ? payload.files.map(fileStemLabel).filter(Boolean) : [];
  if (files.length === 1) return sanitizeTitleText(`${files[0]} 작업`) || '작업 세션';
  if (files.length > 1) return sanitizeTitleText(`${files[0]} 외 ${files.length - 1}개 작업`) || '작업 세션';
  return '새 대화';
}

function buildTitleMessages(input) {
  const prompt = stripPii(String(input?.prompt ?? '')).replace(/\s+/g, ' ').trim().slice(0, 400);
  const reply = stripPii(String(input?.reply ?? '')).replace(/\s+/g, ' ').trim().slice(0, 240);
  const files = Array.isArray(input?.files)
    ? input.files.map(fileStemLabel).filter(Boolean).slice(0, 5)
    : [];
  const parts = [];
  if (prompt) parts.push(`사용자 요청: ${prompt}`);
  if (reply) parts.push(`응답 요약: ${reply}`);
  if (files.length) parts.push(`관련 대상: ${files.join(', ')}`);
  return [
    {
      role: 'system',
      content: '한국어 세션 제목 생성기입니다. 대화 주제를 36자 이내의 한 줄 한국어 제목으로만 답하세요. 따옴표, 마크다운, 파일 경로, 확장자, 설명은 절대 포함하지 마세요.',
    },
    {
      role: 'user',
      content: `${parts.join('\n') || '일반 개발 대화'}\n제목:`,
    },
  ];
}

function parseTitleOutput(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.title === 'string') {
    if (hasLeakedPii(raw.title) || hasAbsolutePath(raw.title)) return '';
    return sanitizeTitleText(raw.title);
  }
  const text = extractGeneratedText(raw);
  if (!text || /^\s*[{[]/.test(text)) return '';
  if (hasLeakedPii(text) || hasAbsolutePath(text)) return '';
  return sanitizeTitleText(text);
}

/**
 * Generate a concise Korean session title using the local SLM ('session-title' role),
 * falling back deterministically to a clean rule-derived title when weights/runtime
 * are absent or generation fails/times out.
 */
export async function generateSessionTitle(input, { model, generator, budgetMs = 15000, root, env, now, schedule } = {}) {
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
    : async () => {
        const generate = await loadCachedPipeline(resolvedModel);
        return generate(messages, {
          max_new_tokens: 48,
          do_sample: false,
          return_full_text: false,
        });
      };

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

  const title = parseTitleOutput(run.results[0]);
  if (!title || title.length < 2) {
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
export async function polishJournalTasks(tasksPayload, { model, generator, budgetMs = 15000, root, env, now, schedule } = {}) {
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
        const generate = await loadCachedPipeline(resolvedModel);
        const output = await generate(buildJournalRowMessages(item), {
          max_new_tokens: 64,
          do_sample: false,
          return_full_text: false,
        });
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

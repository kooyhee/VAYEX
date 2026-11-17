// The optional stage-3 model pass — and the rule that keeps it optional.
//
// The design intent: a small local model may *promote* an ambiguous candidate
// (0.45 ≤ score < 0.80) when context supports it. It can never downgrade a
// mandatory rule, and it has a hard 150 ms deadline, because a privacy check that
// can stall the turn is a privacy check the user will turn off.
//
// On this host the generative weights are not installed: `Qwen2.5-0.5B-Instruct`
// and `Qwen3.5-0.8B` are absent, so the stage runs its fail-closed branch and the
// token-efficiency figure comes from the tokenizer that *is* installed.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, tokenizerStatus, loadTokenizer, entropyBits, tokenEfficiency } from './tokenizer.mjs';

export const SLM_DEADLINE_MS = 150;
export const AMBIGUOUS_LOW = 0.45;
export const AMBIGUOUS_HIGH = 0.8;

export const SLM_CANDIDATES = Object.freeze([
  { id: 'Qwen2.5-0.5B-Instruct', parameters: '0.5B', quality: 'default', status: 'weight-absent' },
  { id: 'Qwen3.5-0.8B', parameters: '0.8B', quality: 'high', status: 'weight-absent' },
]);

const MODEL_TOKENS = Object.freeze([
  { id: 'Qwen2.5-0.5B-Instruct', tokens: ['qwen2.5', '0.5b'] },
  { id: 'Qwen3.5-0.8B', tokens: ['qwen3.5', '0.8b'] },
]);

const MODEL_ROOTS = Object.freeze([
  join(PROJECT_ROOT, 'models'),
  join(PROJECT_ROOT, 'data', 'models'),
  join(PROJECT_ROOT, 'app', 'memory', 'data', 'models'),
  join(PROJECT_ROOT, 'engine', 'models'),
]);

function* walkDirectories(root, depth) {
  if (depth < 0) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    yield { full, name: entry.name, isFile: entry.isFile() };
    if (entry.isDirectory()) yield* walkDirectories(full, depth - 1);
  }
}

let cached = null;

/**
 * Where the generative weights are, honestly. No download, no assumption: the
 * status names what was probed and what was found.
 */
export function probeSlm({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  const installed = [];
  for (const root of MODEL_ROOTS) {
    if (!existsSync(root)) continue;
    for (const entry of walkDirectories(root, 3)) {
      const lower = entry.name.toLowerCase();
      const match = MODEL_TOKENS.find((candidate) => candidate.tokens.every((token) => lower.includes(token)));
      if (!match) continue;
      if (entry.isFile && /\.gguf$/i.test(entry.name) && !installed.includes(match.id)) installed.push(match.id);
      if (!entry.isFile && installed.includes(match.id)) continue;
      if (!entry.isFile && existsSync(join(entry.full, 'config.json')) && !installed.includes(match.id)) installed.push(match.id);
    }
  }
  const runner = existsSync(join(PROJECT_ROOT, 'node_modules', '@huggingface', 'transformers'))
    || existsSync(join(PROJECT_ROOT, 'node_modules', '@xenova', 'transformers'));
  loadTokenizer();
  const tokenizer = tokenizerStatus();
  cached = {
    available: installed.length > 0 && runner,
    installed,
    runner,
    reason: installed.length === 0 ? 'weights_not_installed' : runner ? 'found' : 'runtime_not_installed',
    candidates: SLM_CANDIDATES.map((candidate) => ({ ...candidate, installed: installed.includes(candidate.id) })),
    tokenizer: { ...tokenizer, loaded: tokenizer.state === 'ready' },
    deadlineMs: SLM_DEADLINE_MS,
    measured: {
      // Only what was actually measured on this host is reported as a number.
      tokenizerModel: 'Xenova/multilingual-e5-small',
      weights: 'unmeasured (weights not installed)',
    },
  };
  return cached;
}

/** Status only — cheap enough for a request path. */
export function slmStatus() {
  return probeSlm();
}

/** Run something with a hard deadline. A deadline is a wall, not a hint. */
export function withDeadline(task, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true, value: null });
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve()
      .then(task)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value: null, failed: true });
      });
  });
}

export function isAmbiguous(score) {
  return Number.isFinite(score) && score >= AMBIGUOUS_LOW && score < AMBIGUOUS_HIGH;
}

/**
 * The stage-3 hook. Promotion only, never demotion: a mandatory rule keeps its
 * score whatever the model says, and a promoted span is the only thing the model
 * is allowed to change.
 *
 * @param {{findings:object[], verify?:(finding:object)=>Promise<boolean>|boolean, deadlineMs?:number}} input
 */
export async function runSlmStage({ findings = [], verify = null, deadlineMs = SLM_DEADLINE_MS } = {}) {
  const status = probeSlm();
  const ambiguous = findings.filter((finding) => isAmbiguous(finding.score));
  if (ambiguous.length === 0) {
    return { ran: false, reason: 'no_ambiguous_span', promoted: [], timedOut: false, status };
  }
  if (!status.available || typeof verify !== 'function') {
    return { ran: false, reason: status.available ? 'no_verifier' : status.reason, promoted: [], timedOut: false, status };
  }
  const started = Date.now();
  const run = await withDeadline(async () => {
    const promoted = [];
    for (const finding of ambiguous) {
      if (finding.mandatory && finding.score >= AMBIGUOUS_HIGH) continue;
      const confirmed = await verify(finding);
      if (confirmed === true) promoted.push(finding);
    }
    return promoted;
  }, deadlineMs);
  const promoted = run.timedOut || !Array.isArray(run.value) ? [] : run.value;
  for (const finding of promoted) finding.score = Math.min(0.95, AMBIGUOUS_HIGH + 0.15);
  return { ran: true, reason: run.timedOut ? 'deadline_exceeded' : null, promoted, timedOut: Boolean(run.timedOut), elapsedMs: Date.now() - started, status };
}

// National-ID and credential spans that are ambiguous cannot be waved through by
// a model that is not there: the gate must refuse rather than guess.
const UNVERIFIABLE_RULES = new Set(['korean_rrn', 'korean_arn', 'korean_brn', 'generic_secret', 'db_uri', 'env_file_body']);

export async function verifyHighRisk(findings = [], options = {}) {
  const risky = findings.filter((finding) => isAmbiguous(finding.score)
    && finding.risk === 'high'
    && (finding.class === 'credential' || UNVERIFIABLE_RULES.has(finding.rule)));
  if (risky.length === 0) return { unverifiable: [], stage: null };
  const stage = await runSlmStage({ findings, ...options });
  const promoted = new Set(stage.promoted ?? []);
  const unverifiable = risky.filter((finding) => !promoted.has(finding));
  return { unverifiable, stage };
}

export { entropyBits, tokenEfficiency };

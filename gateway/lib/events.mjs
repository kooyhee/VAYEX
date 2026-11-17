// Structured execution events — the single, documented stream every optimisation
// in this repository reports through.
//
// One JSON object per line (JSONL) on `AI_EVENTS_PATH` when that path is set,
// plus an in-memory ring buffer that tests and the orchestrator read directly.
// Every record carries the same envelope and only the fields listed for its type:
//
//   { "v": 1, "seq": 1, "ts": "2026-…Z", "type": "task.done",
//     "session": "s-1", "turn": null, "task": "t-1", "run": null,
//     "agent": "lead", "model": "qwen2.5:72b", "role": "implementer",
//     "tokens": { "input": 120, "output": 42, "cacheRead": 0, "cacheWrite": 0,
//                 "total": 162 },
//     "cost": { "usd": 0.0, "baselineUsd": 0.0, "savedUsd": 0.0 },
//     "elapsedMs": 1234, "data": { … } }
//
// `data` is the only free-form bag; it must stay small (no prompt or tool
// output bodies, no credentials — the caller redacts before emitting). Unknown
// event types are rejected loudly in test/CI by `assertEventShape`, and a
// sink failure is swallowed by the emitter so telemetry can never break a request.
//
// Types (grouped by what the UI consumes):
//   run.start/run.done          one orchestrated run: data { profile, tasks, plan }
//   decision                     track/plan choice: data { track, reason, violations }
//   model.select                 model + reasoning pick: data { tier, reason, pinned }
//   pin.set / pin.expire         session pin installed or dropped: data { ttlMs }
//   cache.report                 prompt/prefix cache outcome: data { kind, hit }
//   task.start                   a task entered execution: data { kind, deps }
//   task.delegate                assignment to a subagent: data { owner, files }
//   task.file_change             a file touched: data { path, change }
//   task.verify                  verification result: data { ok, checks }
//   task.retry                   retry attempt: data { attempt, escalatedModel }
//   task.done                    task finished: data { ok, escalated }
//   tool.compress / tool.recover bounded tool output and its original handle
//   llm_turn                     per-request accounting from real usage fields, in
//                                the flat shape cost analytics reads: taskId,
//                                route, promptTokens, completionTokens,
//                                cachedTokens, model, provider (the same figures
//                                are also mirrored into tokens/cost)
//   optimization                 a saving worth counting, flat: taskId, strategy,
//                                tokensSaved, costSavedUsd
//   background.skipped           a background LLM call replaced by local logic
//
// `llm_turn` and `optimization` are the only records with flat fields on the
// envelope on purpose: `app/dx/cost-analytics.mjs` ingests runtime-cost events
// directly, with no adapter, and reads `event.type`, `event.taskId`,
// `event.promptTokens`, `event.completionTokens`, `event.cachedTokens`,
// `event.route`, `event.model`, `event.provider`, `event.strategy`,
// `event.tokensSaved`, `event.costSavedUsd` off the top level.

export const EVENT_SCHEMA_VERSION = 1;

export const EVENT_TYPES = Object.freeze([
  'run.start',
  'run.done',
  'decision',
  'model.select',
  'pin.set',
  'pin.expire',
  'cache.report',
  'task.start',
  'task.delegate',
  'task.file_change',
  'task.verify',
  'task.retry',
  'task.done',
  'tool.compress',
  'tool.recover',
  'llm_turn',
  'optimization',
  'background.skipped',
  // Privacy guard decisions. They carry rule ids, counts, field paths and an
  // 8-hex HMAC fingerprint — never the matched value.
  'privacy.masked',
  'privacy.blocked',
]);

const KNOWN = new Set(EVENT_TYPES);

// Fields copied verbatim onto the record root, by type. They exist so a consumer
// that already reads flat runtime-cost events (app/dx/cost-analytics.mjs) needs no
// adapter; every other event keeps its fields under `data`.
const FLAT_FIELDS = Object.freeze({
  llm_turn: Object.freeze(['taskId', 'route', 'promptTokens', 'completionTokens', 'cachedTokens', 'model', 'provider']),
  optimization: Object.freeze(['taskId', 'strategy', 'tokensSaved', 'costSavedUsd']),
});
const RING_LIMIT = 500;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function countOrNull(value) {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function moneyOrNull(value) {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? value : null;
}

// Token accounting is only ever reported from provider usage fields; an unknown
// figure stays null and is never coerced to zero.
function normalizeTokens(tokens) {
  if (!isObject(tokens)) return null;
  const input = countOrNull(tokens.input);
  const output = countOrNull(tokens.output);
  const cacheRead = countOrNull(tokens.cacheRead);
  const cacheWrite = countOrNull(tokens.cacheWrite);
  const total = countOrNull(tokens.total) ?? (input !== null && output !== null ? input + output : null);
  if (input === null && output === null && cacheRead === null && cacheWrite === null && total === null) return null;
  return { input, output, cacheRead, cacheWrite, total };
}

function normalizeCost(cost) {
  if (!isObject(cost)) return null;
  const usd = moneyOrNull(cost.usd);
  const baselineUsd = moneyOrNull(cost.baselineUsd);
  const savedUsd = moneyOrNull(cost.savedUsd);
  if (usd === null && baselineUsd === null && savedUsd === null) return null;
  return { usd, baselineUsd, savedUsd };
}

export function createEventBus({ sink = null, now = () => Date.now(), limit = RING_LIMIT } = {}) {
  let seq = 0;
  let currentSink = sink;
  const buffer = [];

  function append(record) {
    buffer.push(record);
    if (buffer.length > limit) buffer.shift();
    if (currentSink) {
      try {
        currentSink(record);
      } catch {
        // Telemetry must never fail the request it describes.
      }
    }
    return record;
  }

  return {
    emit(type, fields = {}) {
      if (typeof type !== 'string' || !KNOWN.has(type)) {
        throw new Error(`unknown event type: ${String(type)}`);
      }
      if (!isObject(fields)) throw new Error('event fields must be an object');
      seq += 1;
      const record = {
        v: EVENT_SCHEMA_VERSION,
        seq,
        ts: new Date(now()).toISOString(),
        type,
        session: fields.session ?? null,
        turn: fields.turn ?? null,
        task: fields.task ?? null,
        run: fields.run ?? null,
        agent: fields.agent ?? null,
        model: fields.model ?? null,
        role: fields.role ?? null,
        tokens: normalizeTokens(fields.tokens),
        cost: normalizeCost(fields.cost),
        elapsedMs: countOrNull(fields.elapsedMs),
        data: isObject(fields.data) ? fields.data : null,
      };
      const flat = FLAT_FIELDS[type];
      if (flat) {
        for (const key of flat) record[key] = fields[key] ?? null;
      }
      return append(record);
    },
    events(filter = {}) {
      return buffer.filter((record) => (filter.type === undefined || record.type === filter.type)
        && (filter.session === undefined || record.session === filter.session)
        && (filter.task === undefined || record.task === filter.task)
        && (filter.run === undefined || record.run === filter.run));
    },
    drain() {
      return buffer.splice(0, buffer.length);
    },
    clear() {
      buffer.length = 0;
      seq = 0;
    },
    setSink(next) {
      currentSink = next;
    },
  };
}

const processBus = createEventBus();

export function emitEvent(type, fields) {
  return processBus.emit(type, fields);
}

export function events(filter) {
  return processBus.events(filter);
}

export function resetEvents() {
  processBus.clear();
}

// JSONL on a path: appended line by line, one record each, never buffered
// across requests. A path that cannot be opened disables the file sink and the
// in-memory buffer keeps working.
export function createJsonlSink(path, { mkdirSync, appendFileSync } = {}) {
  if (typeof path !== 'string' || !path) return null;
  // Imported lazily so a browser/bundled build that never configures a sink
  // does not pull node:fs.
  const { mkdirSync: makeDir = mkdirSync, appendFileSync: append = appendFileSync } = globalThis.__aiEventsFs || {};
  try {
    if (makeDir) makeDir(path.replace(/[^\\/]*$/, '').replace(/\/$/, ''), { recursive: true });
    return (record) => {
      if (append) append(path, `${JSON.stringify(record)}\n`);
    };
  } catch {
    return null;
  }
}

// Test-side shape assertion: every known type must carry its documented data
// keys, and the envelope must never drift.
export function assertEventShape(record) {
  if (!isObject(record) || record.v !== EVENT_SCHEMA_VERSION) throw new Error('event envelope version drifted');
  if (!KNOWN.has(record.type)) throw new Error(`unknown event type: ${record.type}`);
  if (typeof record.ts !== 'string' || Number.isNaN(Date.parse(record.ts))) throw new Error('event ts must be an ISO timestamp');
  if (!Number.isInteger(record.seq) || record.seq < 1) throw new Error('event seq must be a positive integer');
  if (record.elapsedMs !== null && !(Number.isInteger(record.elapsedMs) && record.elapsedMs >= 0)) {
    throw new Error('elapsedMs must be null or a non-negative integer');
  }
  return true;
}

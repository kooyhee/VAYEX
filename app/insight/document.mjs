// The document model behind the deliverable visualizations (HTML/PDF).
//
// A document is not a dashboard: it is the written record of what this session
// set out to do, how it proceeded, what changed and how it was verified. Every
// block below is derived from the structured events the bridge received — the
// journal, the metrics and the tool reports. Nothing is invented: a figure that
// was never reported is `null` and the renderer prints its em dash form.

import { createHash } from 'node:crypto';
import { summarizeEvents, countToolCalls } from './summarize.mjs';
import { aggregateMetrics } from './metrics.mjs';
import { evaluateWatchdog } from './watchdog.mjs';
import { REGISTRY, ROLES, DEFAULT_CANDIDATE, HIGH_QUALITY_CANDIDATE } from './local-model.mjs';
import { sanitizeText } from '../privacy/index.mjs';

export const DOC_TYPES = Object.freeze(['report', 'study', 'spec', 'summary']);

// The one naming the product uses, and the same strings `app/public/session-report.js`
// renders in the pills: a generated document and the tab that offers it must not
// describe the same artifact with two different names.
export const DOC_TYPE_LABELS = Object.freeze({
  report: '작업 결과 보고서',
  study: '선행 연구·기술 검토',
  spec: '시스템 아키텍처 명세서',
  summary: '경영진·심사위원 1장 요약',
});

export const BRAND = Object.freeze({
  name: 'VAYEX (바엑스)',
  tagline: '로컬 통합 AI 코딩 하네스',
});

const SNIPPET_LIMIT = 14;
const SNIPPET_MAX = 3;
const ASK_LIMIT = 200;

function stamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function eventAt(event) {
  return stamp(event?.ts ?? event?.timestamp ?? event?.time ?? event?.data?.ts);
}

function textOf(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The first user prompt the core received, as the document's stated goal. */
function askedGoal(events) {
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (String(event.type ?? '') !== 'prompt') continue;
    const message = event.message ?? event.data?.message ?? event.prompt ?? null;
    const text = textOf(message, ASK_LIMIT);
    if (text) return { text, at: eventAt(event) };
  }
  return null;
}

/** Diff bodies a tool result actually reported, bounded and attributed. */
function codeSnippets(events) {
  const snippets = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (!['tool_execution_end', 'tool_execution_result', 'tool_result'].includes(String(event.type ?? ''))) continue;
    const details = event.result?.details ?? event.details ?? event.data?.details ?? null;
    if (!details || typeof details !== 'object') continue;
    const diff = details.diff ?? details.patch ?? null;
    if (typeof diff !== 'string' || !diff.trim()) continue;
    const path = String(details.path ?? details.file_path ?? event.args?.file_path ?? '').trim() || '경로 미보고';
    const lines = diff.split(/\r?\n/).filter((line) => line.trim()).slice(0, SNIPPET_LIMIT);
    snippets.push({ path, code: lines.join('\n'), truncated: diff.split(/\r?\n/).length > lines.length });
    if (snippets.length >= SNIPPET_MAX) break;
  }
  return snippets;
}

function stepTitle(entry) {
  const target = entry.targets[0] ?? '대상 미보고';
  return `${entry.category} · ${target}`;
}

/** JSON with object keys in a fixed order, so equal inputs always hash equal. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Everything in a model that reaches the printed page. The identity of a deliverable
 * is the rendered projection — the meta the caller resolved (`title`, `model`, `mode`,
 * `route`, `consent`), the model status, and the sanitized evidence — so a request
 * that changes any printed field yields a different hash, while the one volatile
 * field (the generation stamp, which is wall clock and printed as such) is left out.
 * @param {object} model
 */
export function documentProjection(model) {
  const context = model?.context ?? {};
  return {
    type: model?.type ?? 'report',
    typeLabel: model?.typeLabel ?? null,
    brand: model?.brand ?? null,
    empty: model?.empty === true,
    message: model?.message ?? null,
    context: {
      sessionId: context.sessionId ?? null,
      title: context.title ?? null,
      model: context.model ?? null,
      mode: context.mode ?? null,
      route: context.route ?? null,
      consent: context.consent === true,
      startedAt: context.startedAt ?? null,
      endedAt: context.endedAt ?? null,
      durationMs: context.durationMs ?? null,
    },
    goal: model?.goal ?? null,
    steps: model?.steps ?? null,
    deliverables: model?.deliverables ?? null,
    verification: model?.verification ?? null,
    metrics: model?.metrics ?? null,
    registry: model?.registry ?? null,
    watchdog: model?.watchdog ?? null,
  };
}

/** The artifact identity: session id + document type + hash of the rendered projection. */
export function contentHashFor(model) {
  const projection = documentProjection(model);
  const seed = canonical({
    sessionId: projection.context.sessionId,
    type: projection.type,
    projection,
  });
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/**
 * Build one document model.
 * @param {{type?:string, events?:object[], session?:string|null, meta?:object, now?:number, modelRoot?:string, env?:object}} input
 */
export async function buildDocumentModel({ type = 'report', events = [], session = null, meta = {}, now = Date.now(), modelRoot = undefined, env = undefined } = {}) {
  const kind = DOC_TYPES.includes(type) ? type : 'report';
  const records = events.filter((event) => event && typeof event === 'object');
  const summary = await summarizeEvents({
    events: records,
    session: session ?? null,
    ...(modelRoot !== undefined ? { modelRoot } : {}),
    ...(env !== undefined ? { env } : {}),
  });
  const journal = summary.journal ?? { entries: [], counts: { 추가: 0, 수정: 0, 삭제: 0 }, line: '작업 일지에 남길 단계가 없습니다.', status: 'unknown', verification: { state: 'unknown', passed: 0, failed: 0 } };
  const entries = journal.entries ?? [];
  const goal = askedGoal(records);
  const firstAt = records.reduce((min, event) => {
    const at = eventAt(event);
    return at === null ? min : min === null ? at : Math.min(min, at);
  }, null);
  const lastAt = records.reduce((max, event) => {
    const at = eventAt(event);
    return at === null ? max : max === null ? at : Math.max(max, at);
  }, null);
  // Metrics and watchdog windows are anchored to the last recorded evidence, not
  // to the wall clock: identical evidence must render identical figures, or every
  // request would look like a content change and write a new version.
  const evalAt = lastAt ?? now;
  const metrics = aggregateMetrics({ events: records, session: session ?? null, now: evalAt });
  const watchdog = evaluateWatchdog({ events: records, session: session ?? null, now: evalAt });
  const model = summary.localModel ?? null;
  const candidate = model?.candidate ?? { id: DEFAULT_CANDIDATE };
  const deliverableItems = entries.map((entry) => ({
    at: entry.at,
    category: entry.category,
    path: entry.targets[0] ?? null,
    text: entry.lines[0],
    note: entry.lines[1],
    status: entry.status,
    records: entry.evidence?.records ?? 1,
    renamedFrom: entry.evidence?.renamedFrom ?? null,
  }));
  const counts = {
    추가: deliverableItems.filter((item) => item.category === '추가').length,
    수정: deliverableItems.filter((item) => item.category === '수정').length,
    삭제: deliverableItems.filter((item) => item.category === '삭제').length,
  };
  const toolCalls = countToolCalls(records);
  const empty = deliverableItems.length === 0 && toolCalls === 0;
  const context = {
    sessionId: meta.sessionId ?? session ?? 'current',
    title: meta.title ?? '작업 결과 문서',
    model: meta.model ?? (candidate?.id ?? 'harness-local/auto'),
    mode: meta.mode ?? '오케스트레이터',
    route: meta.route ?? 'local_only',
    consent: meta.consent === true,
    startedAt: meta.startedAt ?? firstAt,
    // The real generation time. It is printed as "생성" and is deliberately outside
    // the hashed projection: identity is the content, not the moment it was written.
    generatedAt: meta.generatedAt ?? now,
    endedAt: lastAt,
    durationMs: firstAt !== null && lastAt !== null ? Math.max(0, lastAt - firstAt) : null,
  };
  const cleanGoalText = goal?.text ? sanitizeText(goal.text, { hint: 'goal' }).text : null;
  const rawSnippets = codeSnippets(records);
  const cleanSnippets = rawSnippets.map((snippet) => ({
    ...snippet,
    code: sanitizeText(snippet.code, { hint: 'snippet' }).text,
  }));
  const document = {
    type: kind,
    typeLabel: DOC_TYPE_LABELS[kind],
    brand: BRAND,
    empty,
    message: empty ? '세션 작업 기록이 없습니다.' : null,
    context,
    goal: {
      text: cleanGoalText,
      askAt: goal?.at ?? null,
      summary: summary.session?.line ? sanitizeText(summary.session.line, { hint: 'summary' }).text : journal.line,
      line: journal.line,
      points: [
        { label: '변경 규모', value: `추가 ${counts.추가} · 수정 ${counts.수정} · 삭제 ${counts.삭제}` },
        { label: '작업 단계', value: `${entries.length}단계` },
        { label: '검증', value: journal.verification?.state === 'passed' ? `통과 ${journal.verification.passed}건` : journal.verification?.state === 'failed' ? `실패 ${journal.verification.failed}건` : '검증 기록 없음' },
        { label: '모델', value: `${candidate?.id ?? '모델 미보고'}` },
      ],
      note: records.length
        ? `이 문서는 브리지가 수신한 구조화 이벤트 ${records.length}건만으로 구성했습니다. 보고되지 않은 항목은 표시하지 않습니다.`
        : '이 세션에서 수신한 이벤트가 없습니다. 문서를 채우기 위해 내용을 만들지 않았습니다.',
    },
    steps: entries.map((entry, index) => ({
      index: index + 1,
      at: entry.at,
      title: stepTitle(entry),
      detail: entry.lines[0] ? sanitizeText(entry.lines[0], { hint: 'step-detail' }).text : '',
      note: entry.lines[1] ? sanitizeText(entry.lines[1], { hint: 'step-note' }).text : null,
      category: entry.category,
      status: entry.status,
      taskId: entry.taskId,
    })),
    deliverables: {
      counts,
      items: deliverableItems,
      snippets: cleanSnippets,
      topDir: summary.session?.topDir ?? null,
    },
    verification: {
      state: journal.verification?.state ?? 'unknown',
      passed: journal.verification?.passed ?? 0,
      failed: journal.verification?.failed ?? 0,
      watchdog: { state: watchdog.state, reason: watchdog.reason },
    },
    metrics: {
      tokens: metrics.cumulative?.total ?? null,
      promptTokens: metrics.cumulative?.promptReported ? metrics.cumulative.prompt : null,
      completionTokens: metrics.cumulative?.completionReported ? metrics.cumulative.completion : null,
      speed: metrics.speed?.reported ? metrics.speed.tokensPerSecond : null,
      cacheRate: metrics.cache?.reported && metrics.cache.hitRate !== null ? metrics.cache.hitRate * 100 : null,
      events: records.length,
      works: entries.length,
      tools: toolCalls,
      fileChanges: deliverableItems.length,
    },
    registry: {
      status: summary.modelStatus ?? model?.status ?? 'rule-fallback (weights not installed)',
      candidate: candidate?.id ?? DEFAULT_CANDIDATE,
      default: DEFAULT_CANDIDATE,
      highQuality: HIGH_QUALITY_CANDIDATE,
      candidates: REGISTRY.map((entry) => ({ id: entry.id, parameters: entry.parameters, quality: entry.quality })),
      roles: ROLES,
      installed: model?.installed ?? [],
    },
    watchdog,
  };
  // Identity is taken from the model the renderer will actually print, so every
  // field that reaches the page (meta, model status, sanitized evidence) is part
  // of the hash and nothing that does not reach it can change the version.
  document.contentHash = contentHashFor(document);
  document.documentKey = `${document.context.sessionId}:${document.type}:${document.contentHash}`;
  return document;
}

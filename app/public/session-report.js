// @ts-check
// Deliverable document generator: one self-contained HTML file per session.
//
// This is not a statistics dashboard. It is the written record a reader keeps:
// purpose, step-by-step process, deliverables with diagrams and code, then the
// verification and quality figures. Everything comes from the document model
// (`app/insight/document.mjs`), which itself derives only from structured
// harness events.
//
// Constraints held here: no network of any kind (no CDN, no external font, no
// remote image), inline SVG diagrams, a light/dark switch, a print button and an
// A4 print layout. The returned string can be served, saved to disk or opened
// straight from the filesystem.

import { costLabel } from './protocol.js';

export const DOC_TYPES = /** @type {const} */ (['report', 'study', 'spec', 'summary']);

export const BRAND = { name: 'VAYEX (바엑스)', tagline: '로컬 통합 AI 코딩 하네스' };
export const EMPTY_SESSION_MESSAGE = '세션 작업 기록이 없습니다.';

/**
 * Check whether a session document model or legacy report input has 0 file changes and 0 tool calls.
 * @param {any} model
 * @returns {boolean}
 */
export function isEmptySession(model) {
  if (!model || typeof model !== 'object') return true;
  if (model.empty === true) return true;
  const items = Array.isArray(model?.deliverables?.items) ? model.deliverables.items.length : 0;
  const steps = Array.isArray(model?.steps) ? model.steps.length : 0;
  const legacyChanges = Array.isArray(model?.changes) ? model.changes.length : 0;
  const counts = model?.deliverables?.counts ?? {};
  const countTotal = (Number(counts['추가']) || 0) + (Number(counts['수정']) || 0) + (Number(counts['삭제']) || 0);
  const fileChanges = items + steps + legacyChanges + countTotal + (Number(model?.metrics?.fileChanges) || 0);
  const toolCalls = Number(model?.metrics?.tools ?? model?.tools ?? 0) || 0;
  return fileChanges === 0 && toolCalls === 0;
}

/**
 * Guard against generating fabricated/meaningless documents for empty sessions.
 * @param {any} model
 * @returns {{empty:true, message:string}|null}
 */
export function guardEmptySession(model) {
  if (isEmptySession(model)) {
    return { empty: true, message: EMPTY_SESSION_MESSAGE };
  }
  return null;
}

const TYPE_META = {
  report: {
    label: '작업 결과 보고서',
    eyebrow: 'WORK REPORT',
    lead: '이번 세션에서 무엇을 하려 했고, 어떻게 진행했으며, 무엇이 남았는지 순서대로 정리한 문서입니다.',
    accent: '#2563eb',
  },
  study: {
    label: '선행 연구·기술 검토',
    eyebrow: 'STUDY NOTES',
    lead: '이번 작업이 기대는 기술과 대안을 검토한 기록입니다. 각 단계가 어떤 근거로 채택되었는지 정리했습니다.',
    accent: '#7c3aed',
  },
  spec: {
    label: '시스템 아키텍처 명세서',
    eyebrow: 'SYSTEM SPEC',
    lead: '구성 요소, 실행 경로, 로컬 모델 역할 분담을 명세 형태로 정리했습니다. 관찰된 사실만 적었습니다.',
    accent: '#0f766e',
  },
  summary: {
    label: '경영진·심사위원 1장 요약',
    eyebrow: 'EXECUTIVE SUMMARY',
    lead: '한 장으로 읽는 요약입니다. 결론과 검증 결과를 앞에 두고 근거는 뒤에 붙였습니다.',
    accent: '#b45309',
  },
};

// Category colours are theme tokens: the same hex on both themes would drop the
// 삭제 label to 2.6:1 in dark, so :root and the light/print palettes define them.
const CATEGORY_COLOR = { '추가': 'var(--cat-add)', '수정': 'var(--cat-mod)', '삭제': 'var(--cat-del)', '미분류': 'var(--cat-misc)' };
const CATEGORY_TINT = { '추가': 'rgba(5,150,105,.12)', '수정': 'rgba(2,132,199,.12)', '삭제': 'rgba(190,18,60,.12)', '미분류': 'rgba(100,116,139,.12)' };
const STATE_LABEL = { running: '실행 중', done: '완료', completed: '완료', failed: '실패', idle: '대기', waiting: '대기', unknown: '미보고' };
const VERIFY_LABEL = { passed: '통과', failed: '실패', unknown: '검증 기록 없음' };

const escapeText = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// A UUID's middle groups read as a phone number to a personal-data sweep: `4278-9549`
// is a 2–4 digit group followed by a four-digit tail. The header chip therefore names
// the session by its leading group — `session f08cfc6b` — so the exported document
// carries no digit run that a reader (or an OCR pass) mistakes for a number.
const PHONE_SHAPED = /[^\d]\d{2,4}[-.\s]\d{4}(?:[^\d]|$)/;
function sessionChipText(value) {
  const text = String(value ?? '').trim();
  if (!text) return '미보고';
  return PHONE_SHAPED.test(text) ? text.split(/[-.\s]/)[0].slice(0, 8) : text;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Compact token count: 269500000 → 269.5M, 1200 → 1.2k. */
export function tokenText(value) {
  const tokens = numberOrNull(value);
  if (tokens === null) return '—';
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`;
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k`;
  return String(Math.round(tokens));
}

export function speedText(value) {
  const speed = numberOrNull(value);
  if (speed === null) return '—';
  return `${speed >= 100 ? Math.round(speed) : speed.toFixed(1)} tok/s`;
}

function percentText(value) {
  const percent = numberOrNull(value);
  return percent === null ? '—' : `${percent.toFixed(1)}%`;
}

function costText(value, remote = false) {
  const cost = numberOrNull(value);
  if (cost === null) return '—';
  return costLabel(cost, { remote });
}

function stamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ko-KR', { hour12: false });
}

function clock(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('ko-KR', { hour12: false });
}

function duration(ms) {
  const value = numberOrNull(ms);
  if (value === null || value <= 0) return '—';
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function categoryOf(value) {
  return CATEGORY_COLOR[value] ? value : '미분류';
}

/* ------------------------------------------------------------------ diagrams */

/**
 * The step flow: one node per journal step, in order, coloured by category.
 * Bounded to 12 nodes plus a count note, so a long session stays legible.
 */
function flowSvg(steps) {
  const visible = steps.slice(0, 12);
  const rowH = 46;
  const height = Math.max(96, 44 + visible.length * rowH + 18);
  const nodes = visible.map((step, index) => {
    const y = 34 + index * rowH;
    const color = CATEGORY_COLOR[categoryOf(step.category)];
    const title = String(step.title ?? '').slice(0, 52);
    return `
      <g>
        <line x1="34" y1="${y + 12}" x2="34" y2="${y + rowH}" stroke="var(--line)" stroke-width="1"/>
        <circle cx="34" cy="${y + 1}" r="10" fill="${color}" opacity=".18"/>
        <text x="34" y="${y + 4.5}" text-anchor="middle" font-size="10" font-weight="700" fill="${color}">${index + 1}</text>
        <text x="54" y="${y + 4}" font-size="11.5" font-weight="600" fill="var(--ink)">${escapeText(title)}</text>
        <text x="54" y="${y + 20}" font-size="10" fill="var(--ink-2)">${escapeText(String(step.detail ?? '').slice(0, 96))}</text>
        <text x="742" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${escapeText(clock(step.at))}</text>
        <text x="742" y="${y + 19}" text-anchor="end" font-size="9.5" fill="${color}">${escapeText(STATE_LABEL[step.status] ?? String(step.status ?? '미보고'))}</text>
      </g>`;
  }).join('');
  const more = steps.length > visible.length
    ? `<text x="34" y="${34 + visible.length * rowH + 12}" font-size="10" fill="var(--muted)">그 밖에 ${steps.length - visible.length}단계가 더 있습니다.</text>`
    : '';
  // The drawing caps at 12 nodes; the text alternative lists every reported step,
  // in journal order, with the values exactly as reported.
  return `<figure class="diagram" aria-labelledby="flow-cap">
      <figcaption class="diagram-cap" id="flow-cap">작업 단계 흐름 · ${steps.length ? `보고된 ${steps.length}단계` : '보고된 단계 없음'}</figcaption>
      <svg viewBox="0 0 760 ${height}" role="img" aria-label="작업 단계 흐름" aria-describedby="flow-alt">
      ${steps.length ? nodes : `<text x="34" y="52" font-size="11" fill="var(--muted)">보고된 작업 단계가 없습니다.</text>`}
      ${more}
    </svg>
      <div class="diagram-alt" id="flow-alt">
        ${steps.length
          ? `<ol aria-label="작업 단계 ${steps.length}개, 순서대로">${steps.map((step, index) => `<li>${index + 1}단계${index ? ` (${index}단계 다음)` : ''} · ${escapeText(categoryOf(step.category))} · ${escapeText(step.title || '제목 미보고')}${step.detail ? ` — ${escapeText(step.detail)}` : ''} · 시각 ${escapeText(step.at ? clock(step.at) : '미보고')} · 상태 ${escapeText(STATE_LABEL[step.status] ?? String(step.status ?? '미보고'))}</li>`).join('')}</ol>`
          : '<p>보고된 작업 단계가 없습니다.</p>'}
      </div>
    </figure>`;
}

/**
 * The architecture this session actually ran on: client, node harness, core,
 * the route plane and the three role tiers.
 */
function architectureSvg(model) {
  const route = String(model.context?.route ?? 'local_only');
  const roles = model.registry?.roles ?? null;
  const modelLabel = model.context?.model ? String(model.context.model) : '모델 미보고';
  const boxes = [
    { x: 14, y: 76, w: 150, h: 58, title: '화면 (브라우저)', sub: 'app/public', color: '#2563eb' },
    { x: 190, y: 76, w: 160, h: 58, title: '노드 하네스', sub: 'app/server.mjs', color: '#0284c7' },
    // `sub` is the drawn label (bounded so it fits the box); `full` is the
    // reported identity and is what the caption and the text alternative say.
    { x: 376, y: 76, w: 150, h: 58, title: 'OMP 코어', sub: modelLabel.slice(0, 20), full: modelLabel, color: '#7c3aed' },
    { x: 552, y: 76, w: 194, h: 58, title: route === 'local_only' ? '로컬 경로' : '클라우드 경로 (ZDR)', sub: route, color: route === 'local_only' ? '#059669' : '#b45309' },
  ];
  const roleLines = [
    roles?.rules ? `규칙 엔진 — ${roles.rules.tasks.join(' · ')}` : '규칙 엔진 — 에이전트 상태 · 파일 diff · 미리보기 · HTML/SVG',
    roles?.slm ? `초소형 모델 — ${roles.slm.tasks.join(' · ')}` : '초소형 모델 — 세션 제목 · 타임라인 요약 · 기억 정리',
    roles?.embedding ? `임베딩 — ${roles.embedding.model}` : '임베딩 — Xenova/multilingual-e5-small',
  ];
  const roleRows = roleLines.map((line, index) => `<text x="34" y="${196 + index * 18}" font-size="10" fill="var(--ink-2)">${escapeText(line.length > 96 ? `${line.slice(0, 95)}…` : line)}</text>`).join('');
  const shapes = boxes.map((box) => `
      <g>
        <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="9" fill="var(--surface-2)" stroke="${box.color}" stroke-width="1.3"/>
        <text x="${box.x + 12}" y="${box.y + 22}" font-size="11" font-weight="700" fill="var(--ink)">${escapeText(box.title)}</text>
        <text x="${box.x + 12}" y="${box.y + 40}" font-size="9.5" fill="var(--ink-2)">${escapeText(box.sub)}</text>
      </g>`).join('');
  const altLayers = boxes.map((box, index) => `<li>${index ? `${boxes[index - 1].title}에서 연결 → ` : ''}${escapeText(box.title)} (${escapeText(box.full ?? box.sub)})</li>`).join('');
  const altRoles = roleLines.map((line) => `<li>${escapeText(line)}</li>`).join('');
  return `<figure class="diagram" aria-labelledby="arch-cap">
      <figcaption class="diagram-cap" id="arch-cap">세션 실행 구조 · ${escapeText(boxes[2].full ?? boxes[2].sub)} · ${escapeText(boxes[3].title)}</figcaption>
      <svg viewBox="0 0 760 250" role="img" aria-label="세션 실행 구조" aria-describedby="arch-alt">
      <defs>
        <marker id="doc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 Z" fill="var(--muted)"/>
        </marker>
      </defs>
      <path d="M 164 105 L 190 105" stroke="var(--muted)" stroke-width="1.2" marker-end="url(#doc-arrow)"/>
      <path d="M 350 105 L 376 105" stroke="var(--muted)" stroke-width="1.2" marker-end="url(#doc-arrow)"/>
      <path d="M 526 105 L 552 105" stroke="var(--muted)" stroke-width="1.2" marker-end="url(#doc-arrow)"/>
      <path d="M 300 134 L 300 168" stroke="var(--muted)" stroke-width="1.1"/>
      ${shapes}
      <rect x="14" y="168" width="732" height="70" rx="9" fill="var(--surface-2)" stroke="var(--line)" stroke-width="1"/>
      <text x="26" y="186" font-size="10" font-weight="700" fill="var(--ink)">역할 분담</text>
      ${roleRows}
    </svg>
      <div class="diagram-alt" id="arch-alt">
        <ol aria-label="실행 계층 연결 순서">${altLayers}</ol>
        <ul aria-label="역할 분담">${altRoles}</ul>
      </div>
    </figure>`;
}

/* ------------------------------------------------------------------ helpers */

function metricCard(label, value, hint, { accent = false } = {}) {
  return `<div class="metric${accent ? ' accent' : ''}">
      <span class="metric-label">${escapeText(label)}</span>
      <b class="metric-value">${escapeText(value)}</b>
      <span class="metric-hint">${escapeText(hint)}</span>
    </div>`;
}

function emptyRow(columns, text) {
  return `<tr class="empty"><td colspan="${columns}">${escapeText(text)}</td></tr>`;
}

function badge(category) {
  const name = categoryOf(category);
  return `<span class="badge" style="color:${CATEGORY_COLOR[name]};background:${CATEGORY_TINT[name]};border-color:color-mix(in srgb,${CATEGORY_COLOR[name]} 35%,transparent)">${escapeText(name)}</span>`;
}

function sectionHeading(index, title, subtitle) {
  return `<header class="sec-head">
      <span class="sec-num">${String(index).padStart(2, '0')}</span>
      <div>
        <h2>${escapeText(title)}</h2>
        ${subtitle ? `<p class="sec-sub">${escapeText(subtitle)}</p>` : ''}
      </div>
    </header>`;
}

/* --------------------------------------------------------------- normalizing */

/**
 * The document model the renderer consumes. `buildSessionDocument` takes the
 * model produced by `app/insight/document.mjs`; the earlier reporter shape is
 * folded into it by `modelFromLegacy`, so both entry points share one renderer.
 */
function normalize(model) {
  const type = DOC_TYPES.includes(/** @type {any} */ (model?.type)) ? model.type : 'report';
  const meta = TYPE_META[type];
  const context = {
    sessionId: model?.context?.sessionId ?? null,
    title: model?.context?.title ?? '작업 결과 문서',
    model: model?.context?.model ?? null,
    mode: model?.context?.mode ?? null,
    route: model?.context?.route ?? 'local_only',
    consent: model?.context?.consent === true,
    startedAt: model?.context?.startedAt ?? null,
    generatedAt: model?.context?.generatedAt ?? Date.now(),
    endedAt: model?.context?.endedAt ?? null,
    durationMs: model?.context?.durationMs ?? null,
  };
  return {
    type,
    typeLabel: meta.label,
    meta,
    brand: model?.brand ?? BRAND,
    context,
    goal: {
      text: model?.goal?.text ?? null,
      summary: model?.goal?.summary ?? '',
      line: model?.goal?.line ?? '',
      points: Array.isArray(model?.goal?.points) ? model.goal.points : [],
      note: model?.goal?.note ?? '',
    },
    steps: Array.isArray(model?.steps) ? model.steps : [],
    deliverables: {
      counts: model?.deliverables?.counts ?? { '추가': 0, '수정': 0, '삭제': 0 },
      items: Array.isArray(model?.deliverables?.items) ? model.deliverables.items : [],
      snippets: Array.isArray(model?.deliverables?.snippets) ? model.deliverables.snippets : [],
      topDir: model?.deliverables?.topDir ?? null,
    },
    verification: {
      state: model?.verification?.state ?? 'unknown',
      passed: model?.verification?.passed ?? 0,
      failed: model?.verification?.failed ?? 0,
      watchdog: model?.verification?.watchdog ?? null,
    },
    metrics: model?.metrics ?? {},
    registry: model?.registry ?? null,
    extra: model?.extra ?? {},
  };
}

/** Fold the earlier report input shape into the document model. */
function modelFromLegacy(input = {}) {
  const changes = Array.isArray(input.changes) ? input.changes : [];
  const agents = Array.isArray(input.agents) ? input.agents : [];
  const steps = changes.map((change, index) => ({
    index: index + 1,
    at: change.at ?? null,
    title: `${categoryOf(change.category)} · ${String(change.path ?? '대상 미보고')}`,
    detail: String(change.text ?? ''),
    category: categoryOf(change.category),
    status: 'done',
  }));
  const counts = { '추가': 0, '수정': 0, '삭제': 0 };
  for (const change of changes) counts[categoryOf(change.category)] += 1;
  const verification = input.verification ?? { passed: 0, failed: 0 };
  const verifyState = verification.failed > 0 ? 'failed' : verification.passed > 0 ? 'passed' : 'unknown';
  return {
    type: 'report',
    brand: BRAND,
    context: {
      sessionId: input.sessionId ?? null,
      title: input.title ?? '세션 리포트',
      model: input.model ?? null,
      mode: input.mode ?? null,
      route: input.route ?? 'local_only',
      consent: input.consent === true,
      startedAt: input.startedAt ?? null,
      generatedAt: input.generatedAt ?? Date.now(),
      durationMs: input.durationMs ?? null,
    },
    goal: {
      text: null,
      summary: changes.length
        ? `이번 세션에서는 파일 변경 ${changes.length}건을 기록했습니다.`
        : '이번 세션에서는 기록된 파일 변경이 없습니다.',
      line: `${changes.length}건`,
      points: [
        { label: '변경 규모', value: `추가 ${counts['추가']} · 수정 ${counts['수정']} · 삭제 ${counts['삭제']}` },
        { label: '메시지', value: input.messages != null ? String(input.messages) : '—' },
        { label: '도구 호출', value: input.tools != null ? String(input.tools) : '—' },
        { label: '검증', value: VERIFY_LABEL[verifyState] },
      ],
      note: '이 문서는 브리지가 보고한 값만으로 구성했습니다. 보고되지 않은 측정값은 빈 값으로 표시합니다.',
    },
    steps,
    deliverables: {
      counts,
      items: changes.map((change) => ({
        at: change.at ?? null,
        category: categoryOf(change.category),
        path: change.path ?? null,
        text: change.text ?? '',
        note: '',
        status: 'done',
        records: 1,
      })),
      snippets: [],
      topDir: null,
    },
    verification: { state: verifyState, passed: verification.passed ?? 0, failed: verification.failed ?? 0, watchdog: null },
    metrics: {
      tokens: input.tokens ?? null,
      speed: input.speed ?? null,
      cacheRate: input.cacheRate ?? null,
      cost: input.cost ?? null,
      messages: input.messages ?? null,
      tools: input.tools ?? null,
    },
    registry: null,
    extra: { agents },
  };
}

/* ------------------------------------------------------------------- render */

/**
 * Render one deliverable document.
 * If the session has 0 file changes and 0 tool calls (unless allowEmpty is true),
 * returns `{ empty: true, message: "세션 작업 기록이 없습니다." }` instead of fabricating a document.
 * @param {object} raw the model from `app/insight/document.mjs`
 * @param {{agents?:object[], allowEmpty?:boolean}} [options]
 * @returns {string | {empty: true, message: string}}
 */
export function buildSessionDocument(raw, options = {}) {
  if (!options?.allowEmpty && isEmptySession(raw)) {
    return { empty: true, message: EMPTY_SESSION_MESSAGE };
  }
  const model = normalize({ ...raw, extra: { ...(raw?.extra ?? {}), ...options } });
  const meta = TYPE_META[model.type];
  const steps = model.steps;
  const items = model.deliverables.items;
  const counts = model.deliverables.counts;
  const snippets = model.deliverables.snippets;
  const verification = model.verification;
  const metrics = model.metrics;
  const registry = model.registry;
  const agents = Array.isArray(model.extra.agents) ? model.extra.agents : [];
  const isSummary = model.type === 'summary';
  const isStudy = model.type === 'study';
  const isSpec = model.type === 'spec';

  const verifyClass = verification.state === 'passed' ? 'passed' : verification.state === 'failed' ? 'failed' : 'unknown';
  const verifyText = verification.state === 'passed'
    ? `통과 ${verification.passed}건`
    : verification.state === 'failed'
      ? `실패 ${verification.failed}건`
      : '검증 기록 없음';

  const stepRows = steps.length
    ? steps.map((step) => `<tr>
        <td class="num" data-label="#">${step.index}</td>
        <td class="time" data-label="시각">${escapeText(clock(step.at))}</td>
        <td data-label="분류">${badge(step.category)}</td>
        <td class="wide" data-label="단계">
          <span class="row-title">${escapeText(step.title)}</span>
          <span class="row-detail">${escapeText(step.detail)}</span>
        </td>
        <td class="time" data-label="상태">${escapeText(STATE_LABEL[step.status] ?? String(step.status ?? '미보고'))}</td>
      </tr>`).join('')
    : emptyRow(5, '보고된 작업 단계가 없습니다. 문서를 채우기 위해 내용을 만들지 않았습니다.');

  const itemRows = items.length
    ? items.slice(0, isSummary ? 8 : 60).map((item) => `<tr>
        <td class="time" data-label="시각">${escapeText(clock(item.at))}</td>
        <td data-label="분류">${badge(item.category)}</td>
        <td class="path" data-label="대상">${escapeText(item.path ?? '대상 미보고')}${item.renamedFrom ? `<span class="renamed"> ← ${escapeText(item.renamedFrom)}</span>` : ''}</td>
        <td class="wide" data-label="내용">${escapeText(item.text)}${item.note ? `<span class="row-detail">${escapeText(item.note)}</span>` : ''}</td>
      </tr>`).join('')
    : emptyRow(4, '보고된 변경 항목이 없습니다.');

  const snippetBlocks = snippets.length && !isSummary
    ? snippets.map((snippet) => `<figure class="snippet">
        <figcaption>${escapeText(snippet.path)}</figcaption>
        <pre><code>${escapeText(snippet.code)}</code></pre>
        ${snippet.truncated ? '<p class="snippet-note">앞부분만 표시했습니다.</p>' : ''}
      </figure>`).join('')
    : '';

  const agentRows = agents.length
    ? agents.map((agent) => `<tr>
        <td class="path" data-label="이름">${escapeText(agent.name)}</td>
        <td data-label="상태">${escapeText(STATE_LABEL[agent.state] ?? String(agent.state ?? '미보고'))}</td>
        <td class="mono" data-label="모델">${escapeText(agent.model ?? '—')}</td>
        <td class="num" data-label="토큰">${escapeText(tokenText(agent.tokens))}</td>
        <td class="num" data-label="비용">${escapeText(costText(agent.cost, Boolean(meta.route && meta.route !== 'local_only')))}</td>
        <td class="num" data-label="경과">${escapeText(agent.duration ?? '—')}</td>
      </tr>`).join('')
    : '';

  const roleRows = registry?.roles
    ? Object.entries(registry.roles).map(([key, role]) => `<tr>
        <td class="mono" data-label="구분">${escapeText(key)}</td>
        <td data-label="이름">${escapeText(role.label)}</td>
        <td class="wide" data-label="담당">${escapeText(role.tasks.join(' · '))}${role.model ? ` · ${escapeText(role.model)}` : ''}</td>
      </tr>`).join('')
    : '';

  const candidateRows = registry?.candidates
    ? registry.candidates.map((candidate) => `<tr>
        <td class="mono" data-label="후보">${escapeText(candidate.id)}</td>
        <td class="num" data-label="파라미터">${escapeText(candidate.parameters)}</td>
        <td data-label="품질">${escapeText(candidate.quality)}${candidate.id === registry.default ? ' · 기본' : candidate.id === registry.highQuality ? ' · 높은 품질' : ''}</td>
        <td data-label="상태">${candidate.id === registry.candidate ? '이 세션에서 선택됨' : '후보'}</td>
      </tr>`).join('')
    : '';

  const qualityMetrics = [
    metricCard('누적 토큰', tokenText(metrics.tokens), metrics.events ? `이벤트 ${metrics.events}건` : '보고된 값만', { accent: true }),
    metricCard('속도', speedText(metrics.speed), '보고된 측정값'),
    metricCard('캐시 적중', percentText(metrics.cacheRate), '프롬프트 토큰 대비'),
    metricCard('비용', costText(metrics.cost, Boolean(meta.route && meta.route !== 'local_only')), '보고된 값만'),
    metricCard('작업 단계', `${metrics.works ?? steps.length}단계`, `추가 ${counts['추가']} · 수정 ${counts['수정']} · 삭제 ${counts['삭제']}`),
    metricCard('검증', verifyText, verification.failed > 0 ? '실패가 있습니다' : verification.passed > 0 ? '실행된 검증 결과' : '기록 없음'),
  ].join('');

  const watchdogState = verification.watchdog?.state ?? null;
  const watchdogRow = watchdogState
    ? `<tr><td class="path" data-label="항목">정지 감지 (관찰 신호)</td><td data-label="결과">${escapeText(STATE_LABEL[watchdogState] ?? watchdogState)}</td><td class="wide" data-label="근거">${escapeText(verification.watchdog?.reason ?? '보고된 신호 없음')}</td></tr>`
    : '';

  const goalAsk = model.goal.text
    ? `<blockquote class="ask">“${escapeText(model.goal.text)}”</blockquote>`
    : '<p class="ask muted">이 세션에서 요청 문구가 기록되지 않았습니다.</p>';

  const points = model.goal.points.length
    ? model.goal.points.map((point) => `<div class="point">
        <span class="point-label">${escapeText(point.label)}</span>
        <b class="point-value">${escapeText(point.value)}</b>
      </div>`).join('')
    : '';

  const studyBlock = isStudy
    ? `<div class="study-grid">
        ${(items.length ? items.slice(0, 4) : []).map((item) => `<article class="study-card">
          <h4>${escapeText(item.text)}</h4>
          <p>이 단계는 <code>${escapeText(item.path ?? '대상 미보고')}</code>를 대상으로 했습니다. 남은 근거는 ${escapeText(item.note || '보고된 기록 없음')}</p>
        </article>`).join('') || '<p class="muted">해설할 단계가 보고되지 않았습니다.</p>'}
      </div>
      <p class="study-note">학습 포인트: 규칙 엔진이 관찰 가능한 값을 먼저 만들고, 초소형 모델은 문장만 다듬습니다. 수치와 diff는 모델을 거치지 않습니다.</p>`
    : '';

  const specBlock = isSpec && roleRows
    ? `<h3 class="sub" id="tbl-roles-cap">역할 분담 명세</h3>
      <div class="table-wrap" tabindex="0" role="region" aria-labelledby="tbl-roles-cap">
      <table class="data" aria-label="역할 분담">
        <thead><tr><th>구분</th><th>이름</th><th>담당</th></tr></thead>
        <tbody>${roleRows}</tbody>
      </table>
      </div>
      ${candidateRows ? `<h3 class="sub" id="tbl-cand-cap">초소형 모델 후보 명세</h3>
      <div class="table-wrap" tabindex="0" role="region" aria-labelledby="tbl-cand-cap">
      <table class="data" aria-label="모델 후보">
        <thead><tr><th>후보</th><th>파라미터</th><th>품질</th><th>상태</th></tr></thead>
        <tbody>${candidateRows}</tbody>
      </table>
      </div>` : ''}`
    : '';

  const registryLine = registry
    ? `<p class="sub-line">로컬 모델 상태: ${escapeText(registry.status)} · 선택 후보 ${escapeText(registry.candidate)} (기본 ${escapeText(registry.default)} · 높은 품질 ${escapeText(registry.highQuality)}). 외부 API 호출은 0회입니다.</p>`
    : '<p class="sub-line">이 문서는 외부 API를 호출하지 않습니다.</p>';

  return `<!doctype html>
<html lang="ko" data-theme="dark" data-doc-type="${model.type}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="text-scale" content="scale">
<meta name="color-scheme" content="dark light">
<meta name="generator" content="${escapeText(model.brand.name)} 문서 생성기">
<title>${escapeText(model.context.title)} · ${escapeText(meta.label)}</title>
<style>
:root{color-scheme:dark;
  --bg:#0b0f14;--surface:#121821;--surface-2:#171f2b;--line:rgba(148,163,184,.18);
  --ink:#e6edf3;--ink-2:#9fb0c3;--muted:#7d8ea3;--accent:${meta.accent};--green:#34d399;--amber:#fbbf24;--red:#fb7185;
  --cat-add:#34d399;--cat-mod:#7dd3fc;--cat-del:#fda4af;--cat-misc:#a8b6c6;}
:root[data-theme=light]{color-scheme:light;
  --bg:#f5f7fa;--surface:#ffffff;--surface-2:#f1f5f9;--line:rgba(15,23,42,.14);
  --ink:#0f172a;--ink-2:#3b4a5e;--muted:#64748b;--accent:${meta.accent};--green:#059669;--amber:#b45309;--red:#be123c;
  --cat-add:#047857;--cat-mod:#0369a1;--cat-del:#be123c;--cat-misc:#526175;}
*{box-sizing:border-box}
body{margin:0;padding:1.5rem 1rem 2.75rem;background:var(--bg);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic",system-ui,sans-serif;
  font-size:1rem;line-height:1.6;overflow-wrap:anywhere;word-break:keep-all}
.doc{max-width:56.25rem;margin:0 auto;display:flex;flex-direction:column;gap:1.125rem}
header.doc-head{display:flex;justify-content:space-between;gap:1.125rem;flex-wrap:wrap;
  border-bottom:2px solid var(--ink);padding-bottom:.875rem}
.eyebrow{font-size:.75rem;letter-spacing:.14em;font-weight:700;color:var(--muted)}
h1{margin:.375rem 0 .25rem;font-size:clamp(1.375rem,1.1rem + 1.4vw,1.875rem);line-height:1.25;letter-spacing:-.02em;text-wrap:balance}
.brand{font-size:.875rem;font-weight:700;color:var(--accent)}
.tagline{font-size:.8125rem;color:var(--muted);margin-left:.375rem;font-weight:500}
.chips{display:flex;gap:.375rem;flex-wrap:wrap;margin-top:.625rem}
.chip{font-size:.8125rem;padding:.1875rem .5625rem;border-radius:999px;border:1px solid var(--line);color:var(--ink-2);background:var(--surface-2)}
.chip.accent{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 45%,transparent)}
.toolbar{display:flex;align-items:center;gap:.375rem;flex-wrap:wrap;align-self:flex-start}
button.plain{border:1px solid var(--line);background:var(--surface-2);color:var(--ink-2);border-radius:8px;
  padding:.4375rem .75rem;font-size:.875rem;cursor:pointer;font-family:inherit;min-block-size:2.25rem}
button.plain:hover{color:var(--ink)}
section.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:1.125rem 1.25rem;min-inline-size:0}
.sec-head{display:flex;gap:.75rem;align-items:flex-start;margin-bottom:.75rem}
.sec-num{font-size:1.25rem;font-weight:800;color:var(--accent);line-height:1.1;font-variant-numeric:tabular-nums}
h2{margin:0;font-size:1.125rem;line-height:1.35;letter-spacing:-.01em;text-wrap:balance}
.sec-sub{margin:.25rem 0 0;font-size:.875rem;color:var(--muted)}
.lead{font-size:.9375rem;color:var(--ink-2);margin:0 0 .75rem;max-width:65ch;text-wrap:pretty}
blockquote.ask{margin:0 0 .75rem;padding:.625rem .875rem;border-left:3px solid var(--accent);background:var(--surface-2);
  font-size:.9375rem;color:var(--ink);max-width:65ch;text-wrap:pretty}
blockquote.ask.muted{color:var(--muted);font-style:normal}
.points{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr));gap:.5625rem;margin-bottom:.75rem}
.point{border:1px solid var(--line);border-radius:10px;background:var(--surface-2);padding:.5625rem .6875rem;display:flex;flex-direction:column;gap:.125rem;min-inline-size:0}
.point-label{font-size:.75rem;letter-spacing:.04em;color:var(--muted)}
.point-value{font-size:.9375rem;font-variant-numeric:tabular-nums}
.note{font-size:.8125rem;color:var(--muted);margin:.375rem 0 0}
figure.diagram{border:1px solid var(--line);border-radius:10px;padding:.625rem;background:var(--surface-2);margin:0 0 .75rem}
.diagram-cap{font-size:.875rem;font-weight:700;color:var(--ink);margin:0 0 .5rem}
.diagram svg{display:block;width:100%;height:auto}
.diagram-alt{margin:.625rem 0 0;padding:.625rem .75rem;border-top:1px solid var(--line);font-size:.875rem;line-height:1.55;color:var(--ink-2)}
ol.diagram-alt,.diagram-alt ol,.diagram-alt ul{margin:.375rem 0 0;padding-left:1.25rem}
.diagram-alt li{margin-bottom:.25rem}
.table-wrap{overflow-x:auto;max-inline-size:100%;container-type:inline-size;border-radius:8px}
.table-wrap:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
table.data{width:100%;border-collapse:collapse;font-size:.9375rem;line-height:1.5}
table.data th{text-align:left;font-weight:600;font-size:.8125rem;letter-spacing:.03em;text-wrap:balance;
  color:var(--muted);padding:.375rem .5rem .5rem;border-bottom:1px solid var(--line);white-space:nowrap}
table.data td{padding:.5rem;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
td.num,td.time{font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap;width:1%}
td.path{font-family:ui-monospace,Consolas,"Cascadia Code",monospace;font-size:.875rem;color:var(--ink-2);overflow-wrap:anywhere}
td.wide{width:auto}
td.mono{font-family:ui-monospace,Consolas,"Cascadia Code",monospace;font-size:.875rem;overflow-wrap:anywhere}
.row-title{display:block;font-weight:600}
.row-detail{display:block;color:var(--muted);font-size:.875rem;margin-top:.125rem}
.renamed{color:var(--muted)}
tr.empty td{text-align:center;color:var(--muted);padding:.875rem}
.badge{display:inline-block;font-size:.75rem;padding:.125rem .5rem;border-radius:999px;border:1px solid transparent;white-space:nowrap}
.counts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.5625rem;margin-bottom:.75rem}
.count{border:1px solid var(--line);border-radius:10px;background:var(--surface-2);padding:.5625rem .6875rem}
.count-name{font-size:.8125rem;color:var(--muted)}
.count-value{font-size:1.25rem;font-weight:700;font-variant-numeric:tabular-nums}
.snippet{border:1px solid var(--line);border-radius:10px;margin:.625rem 0 0;overflow:hidden}
.snippet figcaption{font-family:ui-monospace,Consolas,monospace;font-size:.8125rem;color:var(--ink-2);
  padding:.375rem .625rem;border-bottom:1px solid var(--line);background:var(--surface-2);overflow-wrap:anywhere}
.snippet pre{margin:0;padding:.625rem;font-size:.875rem;line-height:1.55;overflow-x:auto;background:var(--bg)}
.snippet-note{margin:0;padding:.3125rem .625rem;font-size:.75rem;color:var(--muted)}
.sub{font-size:.9375rem;font-weight:700;margin:.875rem 0 .375rem;color:var(--ink-2)}
.sub-line{font-size:.875rem;color:var(--muted);margin:.625rem 0 0}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,9.5rem),1fr));gap:.5625rem;margin-bottom:.75rem}
.metric{border:1px solid var(--line);border-radius:10px;padding:.5625rem .6875rem;background:var(--surface-2);display:flex;flex-direction:column;gap:.125rem;min-inline-size:0}
.metric.accent{border-color:color-mix(in srgb,var(--accent) 40%,transparent)}
.metric-label{font-size:.75rem;color:var(--muted);letter-spacing:.03em}
.metric-value{font-size:1.125rem;font-weight:650;font-variant-numeric:tabular-nums}
.metric.accent .metric-value{color:var(--accent)}
.metric-hint{font-size:.75rem;color:var(--muted)}
.pill{display:inline-block;font-size:.8125rem;padding:.1875rem .625rem;border-radius:999px;border:1px solid var(--line);margin-bottom:.625rem}
.pill.passed{color:var(--green);border-color:color-mix(in srgb,var(--green) 45%,transparent);background:color-mix(in srgb,var(--green) 12%,transparent)}
.pill.failed{color:var(--red);border-color:color-mix(in srgb,var(--red) 45%,transparent);background:color-mix(in srgb,var(--red) 12%,transparent)}
.pill.unknown{color:var(--muted)}
.study-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14rem),1fr));gap:.625rem;margin-bottom:.625rem}
.study-card{border:1px solid var(--line);border-radius:10px;padding:.625rem .75rem;background:var(--surface-2)}
.study-card h4{margin:0 0 .3125rem;font-size:.9375rem}
.study-card p{margin:0;font-size:.875rem;color:var(--ink-2)}
.study-note{font-size:.875rem;color:var(--muted);margin:0}
.muted{color:var(--muted)}
footer.doc-foot{display:flex;justify-content:space-between;gap:.75rem;color:var(--muted);font-size:.8125rem;flex-wrap:wrap;
  border-top:1px solid var(--line);padding-top:.625rem}
/* Wide-container SVG labels shrink when the container is narrow; hide only the
   scaled diagram below 34rem and lean on .diagram-alt, keeping both in wide
   views and print. */
@container (max-width:34rem){
  figure.diagram svg{display:none}
  .diagram-alt{margin-top:0;padding-top:0;border-top:none}
  table.data thead{display:none}
  table.data,table.data tbody,table.data tr,table.data td{display:block;width:100%}
  table.data tr{border:1px solid var(--line);border-radius:8px;padding:.375rem .625rem;margin-bottom:.5rem;background:var(--surface-2)}
  table.data tr.empty{padding:.75rem;text-align:center}
  table.data td{border-bottom:none;padding:.1875rem 0;white-space:normal;width:100%}
  td.num,td.time{width:100%;white-space:normal}
  table.data td::before{content:attr(data-label) ": ";font-size:.75rem;font-weight:700;color:var(--muted)}
  table.data tr.empty td::before{content:none}
}
section.panel{container-type:inline-size}
@page{size:A4;margin:14mm}
@media print{
  body{background:#fff;color:#0f172a;padding:0;font-size:10.5pt;line-height:1.5}
  :root{--bg:#fff;--surface:#fff;--surface-2:#f8fafc;--ink:#0f172a;--ink-2:#334155;--muted:#64748b;--line:rgba(15,23,42,.2);
    --cat-add:#047857;--cat-mod:#0369a1;--cat-del:#be123c;--cat-misc:#526175}
  .doc{max-width:none;gap:12px}
  .toolbar{display:none}
  section.panel{border:1px solid #cbd5e1;border-radius:0;padding:10mm 9mm;container-type:normal}
  section.panel + section.panel{break-before:page}
  .sec-head,figure.diagram,.counts,.metrics,.study-card,.snippet,table.data tr,footer.doc-foot{break-inside:avoid}
  figure.diagram svg{display:block}
  .table-wrap{overflow:visible;container-type:normal}
}
@media (max-width:40em){
  body{padding:1.125rem .75rem 1.875rem}
  section.panel{padding:.875rem .9375rem}
  .counts{grid-template-columns:1fr}
}
</style>
</head>
<body>
<main class="doc">
  <header class="doc-head">
    <div>
      <span class="eyebrow">${escapeText(meta.eyebrow)} · ${escapeText(meta.label)}</span>
      <h1>${escapeText(model.context.title)}</h1>
      <div><span class="brand">${escapeText(model.brand.name)}</span><span class="tagline">${escapeText(model.brand.tagline)}</span></div>
      <div class="chips">
        <span class="chip accent">${escapeText(meta.label)}</span>
        <span class="chip">session ${escapeText(sessionChipText(model.context.sessionId))}</span>
        <span class="chip">${escapeText(model.context.model ?? '모델 미보고')}</span>
        <span class="chip">${escapeText(model.context.route ?? 'local_only')}${model.context.consent ? ' · 동의함' : ' · 동의 안 함'}</span>
        <span class="chip">생성 ${escapeText(stamp(model.context.generatedAt))}</span>
      </div>
    </div>
    <div class="toolbar">
      <button type="button" class="plain" id="theme-toggle" aria-label="테마 전환">라이트로 전환</button>
      <button type="button" class="plain" id="print-doc" aria-label="문서 인쇄">인쇄 · PDF</button>
    </div>
  </header>

  <section class="panel" id="sec-goal">
    ${sectionHeading(1, '작업 목적 및 배경', '이번 세션이 무엇을 하려 했는지 기록에서 확인합니다.')}
    <p class="lead">${escapeText(meta.lead)}</p>
    ${goalAsk}
    <p class="lead">${escapeText(model.goal.summary || model.goal.line || '기록된 요약이 없습니다.')}</p>
    ${points ? `<div class="points">${points}</div>` : ''}
    <p class="note">${escapeText(model.goal.note || '보고된 값만 사용했습니다.')}</p>
  </section>

  <section class="panel" id="sec-process">
    ${sectionHeading(2, '진행 과정 및 단계별 요약', '단계는 작업 일지 순서대로이며, 시각과 상태는 도구 보고에서 온 값입니다.')}
    ${flowSvg(steps)}
    <div class="table-wrap" tabindex="0" role="region" aria-label="단계별 진행">
      <table class="data" aria-label="단계별 진행">
        <thead><tr><th>#</th><th>시각</th><th>분류</th><th>단계</th><th>상태</th></tr></thead>
        <tbody>${stepRows}</tbody>
      </table>
    </div>
  </section>

  <section class="panel" id="sec-result">
    ${sectionHeading(3, '핵심 결과 및 변경 상세', '무엇이 추가·수정·삭제되었고, 어떤 구조 위에서 이뤄졌는지 정리합니다.')}
    <div class="counts">
      ${['추가', '수정', '삭제'].map((name) => `<div class="count">
        <span class="count-name" style="color:${CATEGORY_COLOR[name]}">${name}</span>
        <b class="count-value" style="color:${CATEGORY_COLOR[name]}">${counts[name] ?? 0}</b>
      </div>`).join('')}
    </div>
    <div class="table-wrap" tabindex="0" role="region" aria-label="변경 상세">
      <table class="data" aria-label="변경 상세">
        <thead><tr><th>시각</th><th>분류</th><th>대상</th><th>내용</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
    </div>
    ${architectureSvg({ context: model.context, registry: model.registry })}
    ${registryLine}
    ${specBlock}
    ${isStudy ? studyBlock : ''}
    ${snippetBlocks}
    ${agentRows ? `<h3 class="sub" id="tbl-agents-cap">보고된 하위 에이전트</h3>
      <div class="table-wrap" tabindex="0" role="region" aria-labelledby="tbl-agents-cap">
        <table class="data" aria-label="하위 에이전트">
          <thead><tr><th>이름</th><th>상태</th><th>모델</th><th>토큰</th><th>비용</th><th>경과</th></tr></thead>
          <tbody>${agentRows}</tbody>
        </table>
      </div>` : ''}
  </section>

  <section class="panel" id="sec-verify">
    ${sectionHeading(4, '검증 내용 및 품질 지표', '실행된 검증 결과와 보고된 측정값입니다. 없는 값은 추정하지 않습니다.')}
    <span class="pill ${verifyClass}">${escapeText(verifyText)}</span>
    <div class="metrics">${qualityMetrics}</div>
    <div class="table-wrap" tabindex="0" role="region" aria-label="검증 결과">
      <table class="data" aria-label="검증 결과">
        <thead><tr><th>항목</th><th>결과</th><th>근거</th></tr></thead>
        <tbody>
          <tr><td class="path" data-label="항목">테스트 · 린트 실행</td><td data-label="결과">${escapeText(verifyText)}</td><td class="wide" data-label="근거">검증 실행기 결과만 집계했습니다.</td></tr>
          <tr><td class="path" data-label="항목">세션 경과</td><td data-label="결과">${escapeText(duration(model.context.durationMs))}</td><td class="wide" data-label="근거">${escapeText(stamp(model.context.startedAt))} → ${escapeText(stamp(model.context.endedAt))}</td></tr>
          ${watchdogRow}
        </tbody>
      </table>
    </div>
  </section>

  <footer class="doc-foot">
    <span>${escapeText(model.brand.name)} · ${escapeText(model.brand.tagline)}</span>
    <span>외부 리소스 없이 동작하는 단일 HTML 문서입니다. ${escapeText(meta.label)} ${escapeText(stamp(model.context.generatedAt))}</span>
  </footer>
</main>
<script>
(function(){
  var root = document.documentElement;
  var themeButton = document.getElementById('theme-toggle');
  var printButton = document.getElementById('print-doc');
  if (themeButton) themeButton.addEventListener('click', function(){
    var light = root.getAttribute('data-theme') !== 'light';
    root.setAttribute('data-theme', light ? 'light' : 'dark');
    root.style.colorScheme = light ? 'light' : 'dark';
    themeButton.textContent = light ? '다크로 전환' : '라이트로 전환';
  });
  if (printButton) printButton.addEventListener('click', function(){ window.print(); });
})();
</script>
</body>
</html>`;
}

/**
 * Backwards-compatible reporter entry point: the earlier shape is folded into
 * the same document renderer, always as a 작업 결과 보고서.
 * Returns `{ empty: true, message: "세션 작업 기록이 없습니다." }` when 0 file changes and 0 tool calls.
 * @param {object} input
 * @returns {string | {empty: true, message: string}}
 */
export function buildSessionReport(input = {}) {
  if (!input?.allowEmpty && isEmptySession(input)) {
    return { empty: true, message: EMPTY_SESSION_MESSAGE };
  }
  return buildSessionDocument(modelFromLegacy(input));
}

/** A filesystem-safe name for the exported document. */
export function reportFileName(input = {}) {
  const title = String(input.title ?? 'session').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 48) || 'session';
  const type = DOC_TYPES.includes(/** @type {any} */ (input.type)) ? input.type : 'report';
  const hash = input.hash ?? input.contentHash ?? null;
  if (hash) return `${title}-${type}-${hash}.html`;
  const stampValue = new Date(input.generatedAt ?? Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${title}-${stampValue}-${type}.html`;
}

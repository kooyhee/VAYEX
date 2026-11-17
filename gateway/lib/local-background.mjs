// Background work, done locally.
//
// Every background job this platform used to delegate to a model — session title,
// progress summary, conversation digest/compaction summary, heartbeat narration —
// is computed here from text and structured events. None of it opens a socket,
// and the whole module imports nothing that can.
//
// The output is deliberately extractive, not generative: a title is the first
// meaningful line of the prompt, a digest is the lines that carry decisions,
// errors and file paths, a progress summary is a count of the events the run
// already emitted. The platform's rule is that a background job may be less
// pretty than a model's version, and it may never cost money or leave the host.
//
// Callers that would previously have called a model report through
// `skippedExternal()`: one `background.skipped` event per replacement, so the
// absence of an external call is visible in the event stream rather than being
// something a reader has to infer.

import { emitEvent } from './events.mjs';

export const BACKGROUND_KINDS = Object.freeze(['title', 'progress', 'digest', 'heartbeat']);

const NOISE_LINE = /^(?:```|[-*]\s*$|>\s*$|\s*$)/;

function firstMeaningfulLine(text) {
  for (const rawLine of String(text ?? '').split('\n')) {
    // A markdown heading is a title with decoration, not noise: strip the
    // markers and keep the words.
    const line = rawLine.trim().replace(/^#{1,6}\s+/, '');
    if (!line || NOISE_LINE.test(line)) continue;
    return line;
  }
  return '';
}

export function localTitle({ prompt = '', files = [], maxChars = 48 } = {}) {
  const base = firstMeaningfulLine(prompt)
    .replace(/^[\s"'`*#>\-]+/, '')
    .replace(/[.!?。！？]+$/, '');
  let title = base;
  if (!title && Array.isArray(files) && files.length > 0) title = `작업: ${files.slice(0, 3).join(', ')}`;
  if (!title) title = '새 세션';
  if (title.length > maxChars) title = `${title.slice(0, maxChars - 1)}…`;
  return title;
}

const SIGNAL = /(?:결정|선택|계획|구현|검증|실패|오류|에러|원인|수정|남은|다음|TODO|decid|plan|implement|verify|fail|error|fix|remaining|next)/i;

// Extractive digest: the lines that carry a decision, a failure, a file path or
// an explicit next step, capped by `maxLines`. It never invents a sentence.
export function localDigest({ text = '', maxLines = 12 } = {}) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const picked = [];
  for (const line of lines) {
    if (picked.length >= maxLines) break;
    if (SIGNAL.test(line) || /(?:^|\s)[\w./-]+\.(?:mjs|js|ts|py|json|md|yml)\b/.test(line)) {
      if (!picked.includes(line)) picked.push(line.length > 240 ? `${line.slice(0, 239)}…` : line);
    }
  }
  if (picked.length === 0 && lines.length > 0) {
    picked.push(lines[0].length > 240 ? `${lines[0].slice(0, 239)}…` : lines[0]);
  }
  return picked.join('\n');
}

export function localProgressSummary({ events = [], run = null } = {}) {
  const scoped = run === null ? events : events.filter((event) => event.run === run);
  const counts = { started: 0, done: 0, failed: 0, retries: 0, files: 0, delegated: 0 };
  const files = new Set();
  for (const event of scoped) {
    if (event.type === 'task.start') counts.started += 1;
    else if (event.type === 'task.done') {
      counts.done += 1;
      if (event.data && event.data.ok === false) counts.failed += 1;
    } else if (event.type === 'task.retry') counts.retries += 1;
    else if (event.type === 'task.delegate') counts.delegated += 1;
    else if (event.type === 'task.file_change' && event.data && typeof event.data.path === 'string') {
      files.add(event.data.path);
    }
  }
  counts.files = files.size;
  const lines = [`진행: 시작 ${counts.started} · 완료 ${counts.done} · 실패 ${counts.failed} · 재시도 ${counts.retries}`];
  if (counts.delegated > 0) lines.push(`위임 ${counts.delegated}건`);
  if (files.size > 0) lines.push(`변경 파일: ${[...files].sort().join(', ')}`);
  return lines.join('\n');
}

// The counter that keeps the promise: a background job that would have been an
// external LLM call reports that it was replaced, with the local function named.
export function skippedExternal({ kind, session = null, run = null, task = null, replacedBy, detail = null }) {
  if (!BACKGROUND_KINDS.includes(kind)) throw new Error(`unknown background kind: ${kind}`);
  emitEvent('background.skipped', {
    session,
    run,
    task,
    data: { kind, replaced_by: replacedBy, external: false, detail },
  });
  return { kind, external: false, replaced_by: replacedBy };
}

// One place to ask whether a background job may touch a provider. The answer is
// always "no": this platform performs background work locally, full stop.
export function backgroundExternalAllowed() {
  return false;
}

// Local "what did the AI do" summarizer.
//
// Input is the harness's own structured stream — `task.file_change` records from
// the orchestrator (`{data:{path, change}}`), per-file tool results from
// `tool_execution_end` frames (`{result:{details:{perFileResults:[…]}}}`) and any
// frame that carries explicit change evidence. One task gets at most one Korean
// sentence per 추가/수정/삭제. No provider, no network, no prompt bodies: this
// module is pure except for the optional local-model probe (local-model.mjs),
// which only stats directories.
//
// Tier: `rules` here. `local-model` is only recorded when a small generative
// model that is already on disk actually rewrites a line; see local-model.mjs.

import { detectLocalModel, polishSummary } from './local-model.mjs';

const VERB = Object.freeze({
  added: '새로 만들었습니다',
  modified: '수정했습니다',
  deleted: '삭제했습니다',
});

const MAX_LINE = 120;

/** Normalize a reported path once: forward slashes, no `./`, no quotes. */
export function normalizePath(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function dirOf(path) {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(0, index) : '';
}

function fileOf(path) {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
}

function extOf(path) {
  const file = fileOf(path);
  const index = file.lastIndexOf('.');
  return index >= 0 ? file.slice(index).toLowerCase() : '';
}

function stemOf(path) {
  let file = fileOf(path);
  file = file.replace(/\.(test|spec)(\.[^.]+)?$/i, '');
  const index = file.indexOf('.');
  return index >= 0 ? file.slice(0, index) : file;
}

// ---------------------------------------------------------------------------
// Korean particles

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;

function lastChar(text) {
  const trimmed = String(text ?? '').trim();
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    const ch = trimmed[i];
    if (ch === ')' || ch === ']' || ch === '”' || ch === '"' || ch === '`') continue;
    return ch;
  }
  return '';
}

/** Korean syllables and Latin/digit endings: does the last character end in a consonant? */
export function hasBatchim(word) {
  const ch = lastChar(word);
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code >= HANGUL_BASE && code <= HANGUL_LAST) return (code - HANGUL_BASE) % 28 !== 0;
  if (ch >= '0' && ch <= '9') return ['0', '1', '3', '6', '7', '8'].includes(ch);
  if (/[a-z]/i.test(ch)) {
    // Approximation for file names: these Latin letters end in a consonant sound.
    return ['b', 'c', 'd', 'f', 'g', 'k', 'l', 'm', 'n', 'p', 'q', 'r', 's', 't', 'x', 'z'].includes(ch.toLowerCase());
  }
  return false;
}

/** Pick the right member of a Korean particle pair, e.g. josa('모듈', ['을','를']). */
export function josa(word, pair) {
  const [withBatchim, withoutBatchim] = pair;
  return hasBatchim(word) ? withBatchim : withoutBatchim;
}

const OBJECT = ['을', '를'];

function objectParticle(subject) {
  return josa(subject, OBJECT);
}

// ---------------------------------------------------------------------------
// Korean subject phrases

const ROLE_WORDS = Object.freeze({
  routes: '라우터',
  route: '라우터',
  summarize: '요약기',
  metrics: '지표 집계 모듈',
  server: '서버',
  index: '진입점',
  config: '설정 모듈',
  readme: 'README 문서',
  package: '패키지 설정',
  protocol: '프로토콜 정의',
  activity: '활동 로그 표시',
  app: '화면 애플리케이션',
  styles: '스타일시트',
  launch: '실행 스크립트',
  orchestrator: '오케스트레이터',
  selection: '모델 선택 로직',
  'decision-planner': '역할·실행 계획기',
  'selection-record': '선택 기록 모듈',
  'session-pin': '세션 핀 모듈',
  'turn-plan': '턴 계획 검증기',
  'cost-rates': '단가 계산 모듈',
  'prompt-cache': '프롬프트 캐시 모듈',
  'local-background': '로컬 백그라운드 모듈',
  inference: '추론 어댑터',
  gateway: '게이트웨이',
  events: '이벤트 스트림',
  accounting: '토큰 회계 모듈',
  chat: '채팅 처리 모듈',
  insight: '인사이트 모듈',
  demo: '데모 실행기',
  test: '테스트',
  tests: '테스트',
  setup: '설정 스크립트',
});

// What a file is *for*, in the words a reader of the journal needs. A journal
// entry says which purpose a target serves before it says what happened to it,
// so "지표 모듈을 수정했습니다" never appears as "metrics를 수정했습니다".
const PURPOSES = Object.freeze({
  metrics: '세션 토큰과 캐시 사용량을 집계하는',
  summarize: '도구 기록을 한국어 작업 문장으로 바꾸는',
  watchdog: '멈춘 작업을 관찰 신호만으로 판별하는',
  'local-model': '로컬 초소형 모델을 연결하는',
  document: '결과 문서의 뼈대를 만드는',
  routes: '인사이트 요청을 받아 응답하는',
  'event-source': '이벤트 로그를 읽어 들이는',
  server: '하네스를 실행하고 연결을 관리하는',
  'session-report': '작업 결과 문서를 그리는',
  insight: '요약 결과를 화면에 전달하는',
  protocol: '프레임 규약을 정의하는',
  activity: '작업 활동을 기록하고 묶는',
  app: '화면 상호작용을 처리하는',
  index: '화면 진입점을 이루는',
  styles: '화면 스타일을 정의하는',
  config: '설정 값을 담는',
  selection: '모델 선택을 기록하는',
  'decision-planner': '6역할 분류와 실행 계획을 세우는',
  'selection-record': '모델 선택 결과를 메모리에 보존하는',
  'session-pin': '세션별 모델과 추론 등급을 고정하는',
  'turn-plan': '턴 실행 계획을 검증하는',
  'cost-rates': '모델별 토큰 단가와 캐시 절감액을 계산하는',
  'prompt-cache': '프롬프트 캐시 지시자를 생성하는',
  'local-background': '백그라운드 요약을 로컬에서 처리하는',
  inference: '로컬 하네스 추론 경로를 연결하는',
  readme: '사용 방법을 안내하는',
  orchestrator: '작업을 나눠 배분하는',
  demo: '시연 흐름을 실행하는',
  chat: '대화 요청을 처리하는',
  gateway: '모델 요청 경로를 지키는',
  memory: '장기 기억을 저장하고 검색하는',
  preview: '작업 화면을 미리 보여 주는',
  test: '동작을 검증하는',
});

/** The purpose phrase for one path, or '' when nothing is known about it. */
export function purposeFor(path) {
  const full = normalizePath(path);
  if (!full) return '';
  const key = stemOf(full).toLowerCase();
  return PURPOSES[key] ?? '';
}

const DIR_WORDS = Object.freeze({
  insight: '인사이트',
  gateway: '게이트웨이',
  app: '앱',
  engine: '엔진',
  harness: '하네스',
  public: '화면 자원',
  orchestrator: '오케스트레이터',
  test: '테스트',
  tests: '테스트',
  lib: '라이브러리',
  data: '데이터',
  scripts: '스크립트',
  설계문서: '설계 문서',
  참고자료: '참고 자료',
});

function roleFor(dir) {
  const name = fileOf(dir);
  return DIR_WORDS[name] ?? name;
}

/** A Korean-friendly subject for one changed path. Unknown names keep their file name. */
export function subjectFor(path) {
  const full = normalizePath(path);
  if (!full) return '이름이 없는 변경';
  const dir = dirOf(full);
  const ext = extOf(full);
  const rawStem = fileOf(full).replace(/\.(test|spec)(\.[^.]+)?$/i, '');
  const isTest = /\.(test|spec)(\.[^.]+)?$/i.test(fileOf(full)) || /^(test|tests)$/i.test(rawStem);
  const stem = stemOf(full);
  const key = stem.toLowerCase();
  const suffix = isTest ? ' 테스트' : '';

  if (key === 'readme') return 'README 문서';
  if (ROLE_WORDS[key]) return `${ROLE_WORDS[key]}${suffix}`;
  if (ext === '.md') return `${stem} 문서`;
  if (['.json', '.yaml', '.yml', '.toml', '.ini', '.conf'].includes(ext)) return `${stem} 설정 파일`;
  if (ext === '.css') return '스타일시트';
  if (ext === '.html') return `${stem} 화면`;
  if (['.png', '.jpg', '.jpeg', '.svg', '.gif'].includes(ext)) return `${stem} 이미지`;
  if (['.ps1', '.cmd', '.bat', '.sh'].includes(ext)) return `${stem} 실행 스크립트`;
  if (isTest) return `${stem} 테스트`;
  if (dir && !dir.includes('/')) return `${roleFor(dir)} 모듈의 ${stem} 파일`;
  return `${stem} 모듈`;
}

// ---------------------------------------------------------------------------
// Event → change records

function eventTask(event) {
  const candidates = [
    event.task, event.taskId,
    event.data?.task, event.data?.taskId,
    event.payload?.task, event.payload?.taskId,
    event.event?.task, event.event?.taskId,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function eventSession(event) {
  const value = event.session ?? event.data?.session ?? event.payload?.session ?? null;
  return typeof value === 'string' ? value : null;
}

function eventTs(event) {
  const value = event.ts ?? event.timestamp ?? event.time ?? null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function argumentPath(args) {
  if (!args) return '';
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return '';
    }
  }
  if (typeof value !== 'object') return '';
  const candidate = value.file_path ?? value.path ?? value.filePath ?? value.file ?? value.target;
  return typeof candidate === 'string' ? normalizePath(candidate) : '';
}

function normWord(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[_\s-]+/g, '');
}

const ADD_WORDS = new Set(['create', 'created', 'add', 'added', 'new', 'newness', 'write', 'writefile', 'touch', 'mkdir']);
const DELETE_WORDS = new Set(['delete', 'deleted', 'remove', 'removed', 'unlink', 'rmdir']);

/** 추가 / 수정 / 삭제 from explicit evidence only. A bare edit defaults to 수정. */
export function classifyChange(record) {
  if (record.deleted === true) return 'deleted';
  if (record.created === true) return 'added';
  if (record.existedBefore === false) return 'added';
  const word = normWord(record.op ?? record.change ?? record.operation ?? '');
  if (DELETE_WORDS.has(word)) return 'deleted';
  if (ADD_WORDS.has(word)) return 'added';
  return 'modified';
}

function flag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (['true', 'yes', 'y', 'new', 'created', 'create', 'added', 'add'].includes(text)) return true;
  if (['false', 'no', 'n', 'existing', 'modified', 'edit'].includes(text)) return false;
  return null;
}

/** All change records one frame reports. Frames that report no change yield []. */
export function changesOf(event, index = 0) {
  if (!event || typeof event !== 'object') return [];
  const type = String(event.type ?? '');
  const argPath = argumentPath(event.args);
  const push = (record) => (record.path ? [{
    path: record.path,
    category: record.category ?? classifyChange(record),
    created: record.created ?? null,
    deleted: record.deleted ?? null,
    existedBefore: record.existedBefore ?? null,
    op: record.op ?? null,
    renamedFrom: record.renamedFrom ?? null,
    at: eventTs(event),
    index,
  }] : []);

  if (type === 'task.file_change') {
    const data = event.data ?? {};
    return push({
      path: normalizePath(data.path), change: data.change,
      renamedFrom: data.renamed_from ?? data.renamedFrom ?? null,
      op: data.op ?? null,
    });
  }

  if (['tool_execution_end', 'tool_execution_result', 'tool_result'].includes(type)) {
    const details = event.result?.details ?? event.details ?? event.data?.details ?? event.payload?.details ?? null;
    const items = details?.perFileResults ?? details?.per_file_results ?? null;
    if (Array.isArray(items)) {
      const out = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const path = normalizePath(item.path ?? item.file_path ?? item.filePath ?? argPath);
        if (!path) continue;
        out.push({
          path,
          category: classifyChange({
            deleted: flag(item.deleted ?? item.removed ?? item.is_deleted ?? item.isDeleted),
            created: flag(item.created ?? item.created_new ?? item.is_new ?? item.new_file ?? item.newFile),
            existedBefore: flag(item.existed_before ?? item.existedBefore ?? item.existed),
            op: item.op ?? item.operation ?? item.action ?? null,
          }),
          created: flag(item.created ?? item.new_file ?? item.newFile),
          deleted: flag(item.deleted ?? item.removed ?? item.isDeleted),
          existedBefore: flag(item.existedBefore ?? item.existed),
          op: item.op ?? item.operation ?? null,
          renamedFrom: normalizePath(item.renamed_from ?? item.renamedFrom ?? item.oldPath ?? '') || null,
          at: eventTs(event),
          index,
        });
      }
      return out;
    }
    if (typeof details?.diff === 'string' && details.diff) {
      return push({
        path: normalizePath(details.path ?? details.file_path ?? argPath), change: 'modified',
        renamedFrom: details.renamed_from ?? details.renamedFrom ?? null,
      });
    }
    return [];
  }

  if (type === 'subagent_event' && event.payload?.event && typeof event.payload.event === 'object') {
    return changesOf(event.payload.event, index);
  }

  const directPath = normalizePath(event.path ?? event.file_path ?? event.filePath ?? event.file ?? '');
  if (directPath && (event.created !== undefined || event.deleted !== undefined || event.change !== undefined || event.op !== undefined || event.existedBefore !== undefined)) {
    return push({
      path: directPath,
      change: event.change,
      created: flag(event.created),
      deleted: flag(event.deleted),
      existedBefore: flag(event.existedBefore ?? event.existed_before),
      op: event.op ?? event.operation ?? null,
      renamedFrom: normalizePath(event.renamed_from ?? event.renamedFrom ?? event.from ?? '') || null,
    });
  }
  return [];
}

// ---------------------------------------------------------------------------
// Rename pairing, collapsing, sentences

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

function renameLikely(from, to) {
  if (!from || !to || from === to) return false;
  if (extOf(from) !== extOf(to)) return false;
  const a = stemOf(from).toLowerCase();
  const b = stemOf(to).toLowerCase();
  if (a === b) return true;
  const prefix = commonPrefix(a, b);
  if (prefix < 3) return false;
  return Math.abs(a.length - b.length) <= 4;
}

function collapse(task) {
  const changes = task.changes;
  const used = new Set();
  const merged = [];
  for (let i = 0; i < changes.length; i += 1) {
    const change = changes[i];
    if (used.has(i)) continue;
    const at = change.at ?? null;
    if (change.category === 'deleted' || change.renamedFrom) {
      if (change.renamedFrom) {
        merged.push({ path: change.path, category: 'modified', count: 1, renamedFrom: change.renamedFrom, firstAt: at, lastAt: at });
        continue;
      }
      // A delete immediately followed by an add of a similar name is a rename.
      let partner = null;
      for (let j = i + 1; j < changes.length && j <= i + 2; j += 1) {
        if (used.has(j) || changes[j].category !== 'added') continue;
        if (renameLikely(change.path, changes[j].path)) {
          partner = j;
          break;
        }
      }
      if (partner !== null) {
        used.add(partner);
        merged.push({
          path: changes[partner].path, category: 'modified', count: 2, renamedFrom: change.path,
          firstAt: at, lastAt: changes[partner].at ?? at,
        });
      } else {
        merged.push({ path: change.path, category: 'deleted', count: 1, renamedFrom: null, firstAt: at, lastAt: at });
      }
      continue;
    }
    merged.push({ path: change.path, category: change.category, count: 1, renamedFrom: null, firstAt: at, lastAt: at });
  }

  const targets = new Map();
  for (const entry of merged) {
    const key = `${entry.category}|${entry.path}`;
    const existing = targets.get(key);
    if (existing) {
      existing.count += entry.count;
      if (!existing.renamedFrom && entry.renamedFrom) existing.renamedFrom = entry.renamedFrom;
      if (entry.firstAt !== null && entry.firstAt !== undefined) existing.firstAt = existing.firstAt === null || existing.firstAt === undefined ? entry.firstAt : Math.min(existing.firstAt, entry.firstAt);
      if (entry.lastAt !== null && entry.lastAt !== undefined) existing.lastAt = existing.lastAt === null || existing.lastAt === undefined ? entry.lastAt : Math.max(existing.lastAt, entry.lastAt);
    } else {
      targets.set(key, { ...entry });
    }
  }
  const byCategory = { added: [], modified: [], deleted: [] };
  for (const entry of targets.values()) byCategory[entry.category].push(entry);
  for (const category of Object.keys(byCategory)) {
    byCategory[category].sort((a, b) => a.path.localeCompare(b.path));
  }
  return byCategory;
}

function singleLine(entry) {
  const subject = subjectFor(entry.path);
  const object = objectParticle(subject);
  const purpose = purposeFor(entry.path);
  const prefix = purpose ? `${purpose} ` : '';
  if (entry.renamedFrom && entry.category === 'modified') {
    return `${prefix}${subject}${object} 이름만 바꿔 수정했습니다.`;
  }
  if (entry.category === 'added') {
    return entry.count > 1
      ? `${prefix}${subject}${object} ${entry.count}회 새로 추가했습니다.`
      : `${prefix}${subject}${object} 새로 만들었습니다.`;
  }
  if (entry.category === 'deleted') {
    return entry.count > 1
      ? `${prefix}${subject}${object} ${entry.count}회 삭제했습니다.`
      : `${prefix}${subject}${object} 삭제했습니다.`;
  }
  return entry.count > 1
    ? `${prefix}${subject}${object} ${entry.count}회 수정했습니다.`
    : `${prefix}${subject}${object} 수정했습니다.`;
}

function groupLine(category, dir, count) {
  const label = dir ? `${dir} 디렉터리` : '프로젝트 루트';
  if (category === 'added') return `${label}에 파일 ${count}개를 새로 만들었습니다.`;
  if (category === 'deleted') return `${label}에서 파일 ${count}개를 삭제했습니다.`;
  return `${label}의 파일 ${count}개를 수정했습니다.`;
}

function categoryLines(category, entries) {
  if (entries.length === 0) return [];
  if (entries.length === 1) return [singleLine(entries[0])];
  const dirs = [...new Set(entries.map((entry) => dirOf(entry.path)))];
  if (dirs.length === 1) return [groupLine(category, dirs[0], entries.length)];
  const names = dirs.slice(0, 3).map((dir) => dir || '프로젝트 루트');
  const joined = names.join('·');
  if (category === 'added') return [`${joined}에 파일 ${entries.length}개를 새로 만들었습니다.`];
  if (category === 'deleted') return [`${joined}에서 파일 ${entries.length}개를 삭제했습니다.`];
  return [`${joined}의 파일 ${entries.length}개를 수정했습니다.`];
}

function clip(line) {
  return line.length <= MAX_LINE ? line : `${line.slice(0, MAX_LINE - 1)}…`;
}

// ---------------------------------------------------------------------------
// Task status and verification outcome (reported frames only)

const TASK_TERMINAL = new Set(['task.end', 'task.finish']);
const TASK_START_TYPES = new Set(['task.start', 'task.status', 'task.update']);
const TURN_TERMINAL = new Set(['prompt_result', 'session_settled', 'turn_end', 'agent_end']);
const DONE_WORDS = new Set(['completed', 'complete', 'done', 'success', 'succeeded', 'finished', 'ok', 'settled']);
const FAILED_WORDS = new Set(['failed', 'failure', 'error', 'aborted', 'cancelled', 'canceled', 'timeout']);

function wordOf(event) {
  const value = event?.status ?? event?.data?.status ?? event?.result?.status ?? event?.payload?.status ?? null;
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function normalized(word) {
  if (!word) return null;
  if (DONE_WORDS.has(word)) return 'done';
  if (FAILED_WORDS.has(word)) return 'failed';
  return 'running';
}

/** The last status a task frame reported, else null. */
export function taskStatusOf(events, taskId = null) {
  let status = null, at = null, source = null;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const type = String(event.type ?? '');
    if (taskId !== null && eventTask(event) !== taskId) continue;
    if (TASK_START_TYPES.has(type) || TASK_TERMINAL.has(type)) {
      const word = normalized(wordOf(event) ?? (TASK_TERMINAL.has(type) ? 'done' : null));
      if (word) { status = word; at = eventTs(event); source = 'task'; }
      continue;
    }
    if (TURN_TERMINAL.has(type)) {
      const word = normalized(wordOf(event) ?? (type === 'session_settled' ? 'done' : null));
      if (word && source === null) { status = word; at = eventTs(event); source = 'turn'; }
    }
  }
  return { status, at, source, reported: status !== null };
}

const VERIFY_COMMAND = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|verify|lint|typecheck)\b/i,
  /\bnode\s+--test\b/i,
  /\b(?:pytest|py\.test)\b|\bpython\s+-m\s+(?:pytest|unittest)\b/i,
  /\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b|\bmvn\s+test\b|\bgradlew?\s+test\b/i,
  /\b(?:jest|vitest|mocha)\b/i,
  /\btsc\b|\beslint\b|\bruff\b|\bmypy\b/i,
];

function commandOf(event) {
  const raw = event?.args ?? event?.data?.args ?? event?.payload?.args ?? null;
  let args = raw;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = null; }
  }
  const value = args?.command ?? event?.command ?? event?.data?.command ?? null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The verification outcome reported by tool results only: a test/lint runner that
 * ended. Nothing else is counted as verification.
 * @returns {{state:'passed'|'failed'|'unknown', passed:number, failed:number, at:number|null, commands:string[]}}
 */
export function verificationOf(events) {
  let passed = 0, failed = 0, at = null;
  const commands = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const type = String(event.type ?? '');
    if (!['tool_execution_end', 'tool_execution_result', 'tool_result'].includes(type)) continue;
    const command = commandOf(event);
    if (!command || !VERIFY_COMMAND.some((pattern) => pattern.test(command))) continue;
    const isError = event?.result?.isError === true || event?.isError === true || event?.data?.isError === true;
    const word = normalized(wordOf(event));
    const outcome = isError || word === 'failed' ? 'failed' : 'passed';
    if (outcome === 'failed') failed += 1; else passed += 1;
    at = Math.max(at ?? 0, eventTs(event) ?? 0) || at;
    const label = command.split(/\s+/).slice(0, 3).join(' ');
    if (!commands.includes(label)) commands.push(label);
  }
  return { state: failed > 0 ? 'failed' : passed > 0 ? 'passed' : 'unknown', passed, failed, at, commands };
}

function verificationLine(verification) {
  if (verification.state === 'passed') return `검증 실행 ${verification.passed}건이 통과했습니다`;
  if (verification.state === 'failed') return `검증 실행 ${verification.failed}건이 실패했습니다`;
  return '검증 실행은 보고되지 않았습니다';
}

const CATEGORY_LABEL = Object.freeze({ added: '추가', modified: '수정', deleted: '삭제' });

/**
 * One journal entry per collated target: what purpose it served, what happened,
 * when it happened, the task's reported status and the verification outcome.
 * Entries come only from the collated change records; nothing is invented.
 */
function journalForTask(taskId, byCategory, { status, label, verification }) {
  const entries = [];
  for (const category of ['added', 'modified', 'deleted']) {
    for (const entry of byCategory[category]) {
      const line = clip(singleLine(entry));
      const count = entry.count ?? 1;
      const evidence = count > 1
        ? `같은 대상에 대한 반복 변경 ${count}회를 하나로 묶었습니다`
        : '도구가 보고한 변경 1건을 근거로 했습니다';
      entries.push({
        at: entry.lastAt ?? entry.firstAt ?? null,
        firstAt: entry.firstAt ?? null,
        lastAt: entry.lastAt ?? null,
        taskId,
        taskLabel: label,
        category: CATEGORY_LABEL[category],
        status,
        lines: [line, `${evidence} · ${verificationLine(verification)}`],
        text: `${line} ${evidence} · ${verificationLine(verification)}`,
        targets: [entry.path],
        evidence: { records: count, renamedFrom: entry.renamedFrom ?? null },
        verification: { state: verification.state, passed: verification.passed, failed: verification.failed },
      });
    }
  }
  entries.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.targets[0].localeCompare(b.targets[0]));
  return entries;
}

function journalRollup(entries, session) {
  const counts = { 추가: 0, 수정: 0, 삭제: 0 };
  for (const entry of entries) counts[entry.category] += 1;
  const line = entries.length
    ? `작업 일지 ${entries.length}단계 · 추가 ${counts.추가} · 수정 ${counts.수정} · 삭제 ${counts.삭제}`
    : '작업 일지에 남길 단계가 없습니다.';
  return {
    line,
    counts,
    entries,
    verification: session.verification ?? { state: 'unknown', passed: 0, failed: 0 },
    status: session.status ?? 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Public API

function collectChanges(events, filter) {
  const tasks = new Map();
  const labels = new Map();
  events.forEach((event, index) => {
    if (!event || typeof event !== 'object') return;
    const taskId = eventTask(event);
    const session = eventSession(event);
    if (filter.session && session !== filter.session) return;
    if (filter.taskId && taskId !== filter.taskId) return;
    if (String(event.type ?? '') === 'task.start' && taskId) {
      const description = event.data?.description;
      if (typeof description === 'string' && description.trim() && !labels.has(taskId)) {
        labels.set(taskId, description.trim().slice(0, 60));
      }
    }
    for (const change of changesOf(event, index)) {
      if (filter.taskId && taskId !== filter.taskId) return;
      const id = taskId ?? 'unassigned';
      if (!tasks.has(id)) tasks.set(id, { taskId: id, changes: [], firstIndex: index });
      tasks.get(id).changes.push(change);
    }
  });
  return { tasks, labels };
}

const TOOL_EVENT_TYPES = new Set([
  'tool_execution_start',
  'tool_execution_end',
  'tool_execution_result',
  'tool_result',
  'tool_call',
  'task.file_change',
  'task.verify',
]);

/** Count real tool calls / file change events reported in the event stream. */
export function countToolCalls(events = []) {
  if (!Array.isArray(events)) return 0;
  let count = 0;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const type = String(event.type ?? '');
    if (
      TOOL_EVENT_TYPES.has(type)
      || typeof event.toolName === 'string'
      || typeof event.toolCallId === 'string'
      || typeof event.command === 'string'
    ) {
      count += 1;
    } else if (type === 'subagent_event' && event.payload?.event && typeof event.payload.event === 'object') {
      count += countToolCalls([event.payload.event]);
    }
  }
  return count;
}

/** Whether a session stream has 0 file changes and 0 tool calls. */
export function isEmptySessionEvents(events = []) {
  if (!Array.isArray(events) || events.length === 0) return true;
  let fileChanges = 0;
  for (let i = 0; i < events.length; i += 1) {
    fileChanges += changesOf(events[i], i).length;
  }
  return fileChanges === 0 && countToolCalls(events) === 0;
}

export function sessionRollup(taskResults) {
  const counts = { added: 0, modified: 0, deleted: 0 };
  const dirs = new Map();
  for (const task of taskResults) {
    for (const category of ['added', 'modified', 'deleted']) {
      counts[category] += task.details[category].length;
    }
    for (const entry of [...task.details.added, ...task.details.modified, ...task.details.deleted]) {
      const dir = dirOf(entry.path);
      if (dir) dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    }
  }
  const total = counts.added + counts.modified + counts.deleted;
  if (total === 0) {
    return { line: '이번 세션에서는 기록된 파일 변경이 없습니다.', counts, tasks: taskResults.length, topDir: null };
  }
  const parts = [];
  if (counts.added) parts.push(`파일 ${counts.added}개를 새로 만들었`);
  if (counts.modified) parts.push(`파일 ${counts.modified}개를 수정했`);
  if (counts.deleted) parts.push(`파일 ${counts.deleted}개를 삭제했`);
  const topDir = [...dirs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const line = `이번 세션에서는 ${parts.join('고 ')}습니다.`
    + (topDir && total > 1 ? ` 주요 변경은 ${topDir} 디렉터리에 집중되었습니다.` : '');
  return { line, counts, tasks: taskResults.length, topDir };
}

/**
 * Summarize the stream by task.
 *
 * @param {object} input
 * @param {object[]} input.events Real harness frames/records.
 * @param {string} [input.taskId] Only this task.
 * @param {string} [input.session] Only this session.
 * @param {Function} [input.generator] Override for the local-model tier. The default
 *        generator is built from the probe result by `polishSummary`; this argument
 *        exists so a test can inject a deterministic one.
 * @param {string} [input.modelRoot] Override root directory for local model probing.
 * @param {object} [input.env] Override environment variables for local model probing.
 * @param {number} [input.budgetMs] Optional generation time budget in ms.
 * @returns {Promise<{tasks:object[], session:object, tier:string, localModel:object}>}
 */
export async function summarizeEvents({ events = [], taskId = null, session = null, generator = null, modelRoot = undefined, env = undefined, budgetMs = undefined } = {}) {
  // Verification and status are read from the same filtered stream the changes
  // come from, so a report about session A never carries session B's outcome.
  const scoped = events.filter((event) => {
    if (!event || typeof event !== 'object') return false;
    if (session && eventSession(event) !== session) return false;
    if (taskId && eventTask(event) !== taskId) return false;
    return true;
  });
  const { tasks: byTask, labels } = collectChanges(scoped, { taskId, session });
  const verification = verificationOf(scoped);
  const sessionStatus = taskStatusOf(scoped, null);
  const results = [];
  const journalEntries = [];
  for (const [id, task] of [...byTask.entries()].sort((a, b) => a[1].firstIndex - b[1].firstIndex)) {
    const byCategory = collapse(task);
    const added = categoryLines('added', byCategory.added).map(clip);
    const modified = categoryLines('modified', byCategory.modified).map(clip);
    const deleted = categoryLines('deleted', byCategory.deleted).map(clip);
    const ownStatus = taskStatusOf(scoped, id);
    const status = ownStatus.status ?? sessionStatus.status ?? 'running';
    const entries = journalForTask(id, byCategory, {
      status,
      label: labels.get(id) ?? null,
      verification,
    });
    journalEntries.push(...entries);
    results.push({
      taskId: id,
      label: labels.get(id) ?? null,
      added,
      modified,
      deleted,
      details: {
        added: byCategory.added.map((entry) => ({ path: entry.path, count: entry.count, renamedFrom: entry.renamedFrom })),
        modified: byCategory.modified.map((entry) => ({ path: entry.path, count: entry.count, renamedFrom: entry.renamedFrom })),
        deleted: byCategory.deleted.map((entry) => ({ path: entry.path, count: entry.count, renamedFrom: entry.renamedFrom })),
      },
      status,
      statusSource: ownStatus.status !== null ? ownStatus.source : sessionStatus.status !== null ? sessionStatus.source : 'none',
      verification: { state: verification.state, passed: verification.passed, failed: verification.failed },
      journal: entries,
      tier: 'rules',
    });
  }

  const detectOpts = {};
  if (modelRoot !== undefined) detectOpts.root = modelRoot;
  if (env !== undefined) detectOpts.env = env;
  const model = detectLocalModel(detectOpts);
  let tier = 'rules';
  let modelStatus = model.status ?? 'rule-fallback (weights not installed)';
  let fallbackReason = null;
  const rollup = sessionRollup(results);
  // The polish tier runs whenever the probe found weights and a runtime: polishSummary
  // builds the generator from that probe result, so this is the production path and
  // `generator` is only the caller's override. An absent model keeps the rules tier.
  if (model.available && results.length > 0) {
    const polished = await polishSummary(
      { tasks: results, session: rollup },
      {
        model,
        ...(typeof generator === 'function' ? { generator } : {}),
        ...(budgetMs !== undefined ? { budgetMs } : {}),
      },
    );
    if (polished.tier === 'local-model') {
      tier = 'local-model';
      modelStatus = 'local-model';
      const byId = new Map(
        (polished.tasks ?? [])
          .filter((item) => item && typeof item.taskId === 'string')
          .map((item) => [item.taskId, item]),
      );
      for (const task of results) {
        const patch = byId.get(task.taskId);
        if (!patch) continue;
        for (const category of ['added', 'modified', 'deleted']) {
          if (task[category].length > 0 && Array.isArray(patch[category])) {
            const lines = patch[category]
              .filter((line) => typeof line === 'string' && line.trim())
              .map((line) => clip(line.trim()));
            if (lines.length > 0) task[category] = lines;
          }
        }
      }
      if (typeof polished.session?.line === 'string' && polished.session.line.trim()) {
        rollup.line = clip(polished.session.line.trim());
      }
    } else {
      fallbackReason = polished.fallbackReason ?? null;
    }
  } else {
    fallbackReason = model.reason ?? null;
  }
  for (const task of results) task.tier = tier;
  const toolCalls = countToolCalls(scoped);
  const totalChanges = rollup.counts.added + rollup.counts.modified + rollup.counts.deleted;
  const empty = totalChanges === 0 && toolCalls === 0;
  const status = sessionStatus.status ?? (results.length ? 'done' : 'unknown');
  return {
    tasks: results,
    session: { ...rollup, tier, status, verification, journal: journalEntries.length, toolCalls, empty },
    journal: journalRollup(journalEntries, { verification, status }),
    empty,
    tier,
    modelStatus,
    fallbackReason,
    localModel: model,
  };
}

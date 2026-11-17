// @ts-check
// Local work summary: "what the AI did" one-liners for the timeline.
//
// Two sources, in this order:
//  1. `POST /api/insight/summarize` — the local summarizer module. Every request
//     stays on this machine; this file never opens a socket of its own.
//  2. A deterministic rule pass over the same tool events. It is labelled
//     `rules` in the UI so nobody mistakes it for model output.
//
// The rows carry no file paths, no tool names and no log lines. Paths are only
// used *inside* the subject derivation and inside the collapsed detail.

export const INSIGHT_ENDPOINT = '/api/insight/summarize';
export const CATEGORY_ORDER = /** @type {const} */ (['조사', '추가', '수정', '삭제', '검증', '오류 복구']);

// Tools that only look at the code or the record: their rows say "살펴봤습니다",
// never a path. Everything else that is not a write or a verification is ignored.
const INVESTIGATION_TOOLS = /^(read|view|open|grep|glob|find|list|search|code_graph|web_search|fetch|lookup|inspect)/i;

const STOP_WORDS = new Set(['app','index','main','util','utils','helper','helpers','lib','common','core','src','public','server','client','mod','mods']);
const WORDS = new Map([
  ['login','로그인'], ['signin','로그인'], ['auth','인증'], ['validate','검증'], ['validation','검증'], ['verify','검증'],
  ['button','버튼'], ['color','색상'], ['colors','색상'], ['colour','색상'], ['theme','테마'], ['style','스타일'], ['styles','스타일'],
  ['memory','메모리'], ['timeline','타임라인'], ['consent','전송 동의'], ['preview','미리보기'], ['diff','변경 비교'],
  ['cost','비용'], ['chart','시각화'], ['visualize','시각화'], ['viz','시각화'], ['summary','요약'], ['summarize','요약'],
  ['insight','요약'], ['readme','설명'], ['config','설정'], ['settings','설정'], ['footer','하단 표시'], ['header','상단 표시'],
  ['agent','에이전트'], ['subagent','하위 에이전트'], ['token','토큰'], ['tokens','토큰'], ['cache','캐시'], ['usage','사용량'],
  ['selection','모델 선택'], ['route','전송 경로'], ['test','테스트'], ['tests','테스트'], ['spec','테스트'], ['layout','배치'],
  ['panel','패널'], ['panel','패널'], ['tab','탭'], ['tabs','탭'], ['form','입력 양식'], ['input','입력'], ['menu','메뉴'],
  ['dialog','대화상자'], ['modal','대화상자'], ['page','화면'], ['view','화면'], ['card','카드'], ['list','목록'],
  ['search','검색'], ['filter','필터'], ['sort','정렬'], ['upload','업로드'], ['download','내려받기'], ['api','연결 코드'],
  ['store','저장소'], ['database','데이터베이스'], ['db','데이터베이스'], ['model','모델'], ['prompt','요청 문구']
]);
const TYPE_WORDS = [
  [/\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])(tests?|__tests__)[\\/]/i, '테스트'],
  [/\.(css|scss|sass|less)$/i, '화면 스타일'],
  [/\.html?$/i, '화면 구성'],
  [/\.(md|mdx|txt)$/i, '설명 문서'],
  [/\.(json|ya?ml|toml|ini|env|conf|config)$/i, '설정'],
  [/\.(png|jpe?g|gif|svg|webp|ico)$/i, '이미지'],
  [/\.(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|cs|sh|ps1)$/i, '동작 코드']
];

function hasBatchim(word) {
  const last = String(word ?? '').trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}
function withParticle(word, withBatchim, withoutBatchim) {
  return `${word}${hasBatchim(word) ? withBatchim : withoutBatchim}`;
}
function cleanSubject(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  // A subject must never leak a path, an extension or a separator.
  if (/[\\/]|\.[a-z0-9]{1,5}\b/i.test(text)) return '';
  return text.slice(0, 24);
}

/**
 * A human noun for the thing a path stands for: "로그인 검증", "화면 스타일",
 * "설정". Deterministic and offline; unknown names fall back to the file type,
 * never to the path itself.
 */
export function subjectOf(path) {
  const raw = String(path ?? '').replace(/\\/g, '/');
  const basename = raw.split('/').filter(Boolean).at(-1) ?? '';
  const type = TYPE_WORDS.find(([pattern]) => pattern.test(raw))?.[1] ?? '파일';
  const stem = basename.replace(/\.[^.]*$/, '');
  const parts = stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9가-힣]+/)
    .map(token => token.toLowerCase())
    .filter(token => token && !STOP_WORDS.has(token) && !/^\d+$/.test(token));
  const words = parts.map(token => WORDS.get(token)).filter(Boolean);
  if (/\.(test|spec)\./i.test(raw) && !words.includes('테스트')) words.push('테스트');
  const subject = cleanSubject(words.join(' '));
  if (subject) return subject;
  return cleanSubject(type) || '파일';
}

function categoryOf(op) {
  const value = String(op ?? '').trim();
  if (value === '추가' || value === '삭제') return value;
  return '수정';
}

function listSubjects(subjects) {
  const unique = [...new Set(subjects.filter(Boolean))];
  if (unique.length <= 1) return unique[0] ?? '작업 파일';
  if (unique.length === 2) return `${unique[0]}${hasBatchim(unique[0]) ? '과' : '와'} ${unique[1]}`;
  return `${unique[0]} 등 ${unique.length}가지`;
}

function sentence(category, subjects) {
  const list = listSubjects(subjects);
  if (category === '추가') return `${withParticle(list, '을', '를')} 새로 만들었습니다`;
  if (category === '삭제') return `${withParticle(list, '을', '를')} 지웠습니다`;
  return `${withParticle(list, '을', '를')} 바꿨습니다`;
}

/** One short Korean line per bucket: what the agent did, never where. */
function summaryText(bucket) {
  const total = bucket.events.length;
  if (bucket.category === '검증') {
    if (bucket.fail > 0) return `검증에서 실패 ${bucket.fail}건을 보고받았습니다`;
    if (bucket.pass > 0) return `검증을 ${total}회 실행해 ${bucket.pass}건 통과했습니다`;
    return `검증을 ${total}회 실행했으나 통과/실패 수치는 수집되지 않았습니다`;
  }
  if (bucket.category === '오류 복구') {
    const errors = bucket.events.filter(event => event.kind === 'error' || event.kind === 'failed' || (event.kind === 'tool.end' && event.facts?.failed)).length;
    const retries = bucket.events.filter(event => event.kind === 'retry').length;
    if (retries) return `오류 ${errors}건을 겪고 ${retries}회 다시 시도했습니다`;
    return `오류 ${errors}건을 기록했습니다`;
  }
  if (bucket.category === '조사') return `코드와 기록을 ${total}회 살펴봤습니다`;
  return sentence(bucket.category, bucket.subjects);
}

function taskNameOf(activity, taskId) {
  if (activity?.main?.id === taskId || taskId === 'main') return activity?.main?.name || '메인 작업';
  return activity?.tasks?.find(task => task.id === taskId)?.name || '하위 작업';
}

/**
 * One row per task per category that has at least one reported write.
 * Categories with nothing produce no row at all.
 * @returns {{tasks:{taskId:string,taskName:string,state:string,rows:{category:string,text:string,source:'rules',events:any[],paths:string[],subjects:string[]}[]}[], total:number}}
 */
export function ruleSummary(activity) {
  const buckets = new Map();
  const bucketFor = (taskId, category) => {
    const key = `${taskId}|${category}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { taskId, category, events:[], paths:new Set(), subjects:[], pass:0, fail:0 };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  for (const event of activity?.events ?? []) {
    const taskId = event.taskId ?? 'main';
    if (event.kind === 'write') {
      const path = String(event.facts?.path ?? '').trim();
      if (!path) continue;
      const bucket = bucketFor(taskId, categoryOf(event.facts?.op));
      bucket.events.push(event);
      bucket.paths.add(path);
      const subject = subjectOf(path);
      if (subject && !bucket.subjects.includes(subject)) bucket.subjects.push(subject);
      continue;
    }
    if (event.kind === 'verify') {
      const bucket = bucketFor(taskId, '검증');
      bucket.events.push(event);
      if (event.facts?.state === 'passed') bucket.pass += 1;
      else if (event.facts?.state === 'failed') bucket.fail += 1;
      continue;
    }
    if (event.kind === 'retry' || event.kind === 'error' || event.kind === 'failed') {
      bucketFor(taskId, '오류 복구').events.push(event);
      continue;
    }
    if (event.kind === 'tool.end') {
      if (event.facts?.failed) { bucketFor(taskId, '오류 복구').events.push(event); continue; }
      if (INVESTIGATION_TOOLS.test(String(event.facts?.tool ?? ''))) bucketFor(taskId, '조사').events.push(event);
    }
  }
  const taskIds = [...new Set([...buckets.values()].map(bucket => bucket.taskId))];
  const tasks = [];
  for (const taskId of taskIds) {
    const rows = [];
    for (const category of CATEGORY_ORDER) {
      const bucket = buckets.get(`${taskId}|${category}`);
      if (!bucket) continue;
      rows.push({
        category,
        text: summaryText(bucket),
        source:'rules',
        events:bucket.events,
        paths:[...bucket.paths],
        subjects:bucket.subjects
      });
    }
    const task = taskId === 'main' ? activity?.main : activity?.tasks?.find(entry => entry.id === taskId);
    tasks.push({ taskId, taskName:taskNameOf(activity, taskId), state:task?.status ?? 'running', rows });
  }
  return { tasks, total:tasks.reduce((sum, task) => sum + task.rows.length, 0) };
}

/**
 * The request body the local summarizer receives. Paths are included because
 * the local model may need them; nothing here is network-bound.
 */
export function insightPayload(activity) {
  const rule = ruleSummary(activity);
  return {
    tasks: rule.tasks.map(task => ({
      taskId:task.taskId,
      taskName:task.taskName,
      changes:task.rows.flatMap(row => row.events.map(event => ({
        path:String(event.facts?.path ?? ''),
        category:row.category,
        subject:subjectOf(event.facts?.path),
        added:Number.isFinite(event.facts?.added) ? event.facts.added : null,
        removed:Number.isFinite(event.facts?.removed) ? event.facts.removed : null
      })))
    }))
  };
}

function usableText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 160) return '';
  if (/[\\/]|\.[a-z0-9]{1,5}\b/i.test(text)) return '';
  return text;
}

function collectModelRows(data) {
  const texts = new Map();
  const accept = (taskId, category, text) => {
    if (typeof taskId !== 'string' || !taskId) return;
    const name = String(category ?? '').trim();
    if (!CATEGORY_ORDER.includes(/** @type {any} */ (name))) return;
    const clean = usableText(text);
    if (clean) texts.set(`${taskId}|${name}`, clean);
  };
  for (const item of Array.isArray(data?.items) ? data.items : []) accept(item?.taskId, item?.category, item?.text ?? item?.summary);
  for (const item of Array.isArray(data?.summaries) ? data.summaries : []) accept(item?.taskId, item?.category, item?.text ?? item?.summary ?? item?.line);
  for (const task of Array.isArray(data?.tasks) ? data.tasks : []) {
    for (const row of Array.isArray(task?.rows) ? task.rows : Array.isArray(task?.categories) ? task.categories : []) {
      accept(task?.taskId ?? row?.taskId, row?.category, row?.text ?? row?.summary ?? row?.line);
    }
  }
  return texts;
}

/**
 * Ask the local summarizer. Returns `null` for any failure, an empty answer or
 * an unusable one; the caller then keeps the rule rows and says so in the UI.
 */
export async function fetchInsight(activity, { fetchImpl = globalThis.fetch, signal = null, timeoutMs = 15000 } = {}) {
  const payload = insightPayload(activity);
  if (!payload.tasks.length || typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once:true });
  try {
    const response = await fetchImpl(INSIGHT_ENDPOINT, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify(payload),
      signal:controller.signal
    });
    if (!response?.ok) return null;
    const data = await response.json();
    if (data?.tier === 'rules' && data?.source !== 'model') return null;
    if (typeof data?.source === 'object' && data?.tier !== 'local-model') return null;
    const texts = collectModelRows(data);
    if (!texts.size) return null;
    const source = 'model';
    const modelId = String(data?.modelId ?? data?.localModel?.candidate?.id ?? data?.model?.id ?? data?.provenance?.model_id ?? '').trim();
    return { source, modelId, texts };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Merge rule rows with a model answer. A model line is adopted only for the
 * exact task+category the rule pass found, so a stale or partial answer can
 * never invent a row.
 */
export function summarizeView(activity, model = null) {
  const rule = ruleSummary(activity);
  const tasks = rule.tasks.map(task => ({
    ...task,
    rows:task.rows.map(row => {
      const modelText = model?.texts.get(`${task.taskId}|${row.category}`);
      return modelText ? { ...row, text:modelText, source:'model' } : row;
    })
  }));
  return {
    tasks,
    total:rule.total,
    source:model ? 'model' : 'rules',
    modelId:model?.modelId ?? ''
  };
}

export const INSIGHT_SOURCE_LABEL = { rules:'규칙 요약', model:'로컬 모델 요약' };

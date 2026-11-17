// @ts-check
// Task, agent and timeline model built only from frames the core actually sends.
//
// Wire names read here (omp 18.16.0, dist/types/modes/rpc/wire): agent_start,
// turn_start/turn_end/agent_end, message_*, tool_execution_start/update/end,
// subagent_lifecycle/subagent_progress/subagent_event, extension_ui_request,
// auto_retry_*, prompt_result, session_settled, extension_error, rpc_frame_error,
// response(get_state|get_session_stats|get_subagents) and bridge_error.
//
// `ingestFrame` is the single swap point for a structured event stream: the render
// side (`timelineRows`, `eventLines`, `taskSummary`, `lanes`) keeps its shape.
import { changeFiles, costLabel } from './protocol.js';

export const taskStates = { running:'실행 중', waiting:'대기', done:'완료', failed:'실패' };
export const verifyStates = { passed:'통과', failed:'실패', unknown:'결과 미확인' };

const maxEvents = 400;
const maxOpenTools = 200;
const maxResult = 1200;
const maxDetailEvents = 8;
const approvalMethods = new Set(['confirm','select','input','editor']);
// Commands whose output is a verification result. A plain shell command is never
// treated as one: only these runners are, so the label "검증" stays meaningful.
const verifyCommands = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|verify|lint|typecheck)\b/i,
  /\bnode\s+--test\b/i,
  /\b(?:pytest|py\.test)\b|\bpython\s+-m\s+(?:pytest|unittest)\b/i,
  /\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b|\bmvn\s+test\b|\bgradlew?\s+test\b/i,
  /\b(?:jest|vitest|mocha)\b/i,
  /\btsc\b|\beslint\b|\bruff\b|\bmypy\b/i
];

/** @returns {object} */
export function createActivity(at = Date.now()) {
  return { at, seq:0, events:[], main:null, tasks:[], openTools:new Map() };
}

export function clock(at) {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2,'0')).join(':');
}

export function formatElapsed(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0,Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

export function diffTotals(diff) {
  let added = 0, removed = 0;
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

function clip(value, limit = 160) {
  const text = String(value ?? '').replace(/\s+/g,' ').trim();
  return text.length > limit ? `${text.slice(0,limit)}…` : text;
}
function raw(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(block => block?.type === 'text').map(block => block.text ?? '').join('');
  return value == null ? '' : JSON.stringify(value);
}
function resultText(result) {
  const content = result?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('');
  return content ? JSON.stringify(content) : '';
}
function elapsedOf(task, now) {
  if (task?.startedAt == null) return null;
  return Math.max(0,(task.endedAt ?? now) - task.startedAt);
}

function ensureMain(activity, now, ctx = {}) {
  if (activity.main) {
    if (ctx.title && activity.main.name === '새 작업') activity.main.name = ctx.title;
    return activity.main;
  }
  activity.main = { id:'main', name:ctx.title || '새 작업', kind:'main', lane:0, status:'waiting', stage:'시작 전', startedAt:null, endedAt:null, model:ctx.coreModel ?? null, tokens:null, cost:null, turn:0, files:[] };
  return activity.main;
}
function ensureTask(activity, id, now, fields = {}) {
  const key = typeof id === 'string' && id ? id : `subagent-${activity.tasks.length}`;
  let task = activity.tasks.find(x => x.id === key);
  if (!task) {
    task = { id:key, name:key, kind:'sub', lane:null, status:'running', stage:'시작', startedAt:now, endedAt:null, model:null, tokens:null, cost:null, turn:0, files:[], dependsOn:null };
    activity.tasks.push(task);
    if (activity.tasks.length > 24) activity.tasks.splice(0,activity.tasks.length - 24);
  }
  for (const [field,value] of Object.entries(fields)) if (value !== undefined && value !== null && value !== '') task[field] = value;
  return task;
}

function push(activity, task, at, event) {
  const record = {
    id:`e${++activity.seq}`, seq:activity.seq, at,
    kind:event.kind,
    taskId:task?.id ?? 'main', taskName:task?.name ?? '작업',
    taskState:taskStates[task?.status] ?? '대기',
    target:event.target ?? '',
    groupable:event.groupable !== false,
    groupKey:`${event.kind}|${task?.id ?? 'main'}|${event.target ?? ''}`,
    facts:event.facts ?? {}
  };
  activity.events.push(record);
  if (activity.events.length > maxEvents) activity.events.splice(0,activity.events.length - maxEvents);
  return record;
}

function noteUsage(task, message) {
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object' || !task) return;
  const total = Number(usage.totalTokens);
  const tokens = Number.isFinite(total) && total > 0 ? total : (Number(usage.input) || 0) + (Number(usage.output) || 0);
  if (Number.isFinite(tokens) && tokens > 0) task.tokens = (task.tokens ?? 0) + tokens;
  const cost = typeof usage.cost === 'number' ? usage.cost : usage.cost?.total;
  if (Number.isFinite(cost) && cost >= 0) task.cost = (task.cost ?? 0) + cost;
}

function targetOf(args) {
  if (!args || typeof args !== 'object') return '';
  const keys = ['path','file_path','filePath','command','pattern','query','url','target','identifier'];
  for (const key of keys) if (typeof args[key] === 'string' && args[key].trim()) return clip(args[key],120);
  return '';
}
function argsSummary(args) {
  if (!args || typeof args !== 'object') return '';
  const keys = Object.keys(args);
  if (!keys.length) return '';
  return clip(raw(args),240);
}

/** The verification command one tool call runs, or null when it runs none. */
export function verifyCommand(tool, args) {
  const name = String(tool ?? '').toLowerCase();
  const command = typeof args?.command === 'string' ? args.command : typeof args?.cmd === 'string' ? args.cmd : '';
  const candidates = [command, name].filter(Boolean);
  if (name.startsWith('test') || name === 'run_tests') return command || name;
  for (const candidate of candidates) {
    if (verifyCommands.some(pattern => pattern.test(candidate))) return command || candidate;
  }
  return null;
}

/** Outcome the command's own output reports; counts are read, never estimated. */
export function verifyOutcome({ isError, output } = {}) {
  const text = String(output ?? '');
  const counts = (patterns) => { for (const pattern of patterns) { const match = text.match(pattern); if (match) return Number(match[1]); } return null; };
  const pass = counts([/^# pass (\d+)/m,/(\d+) passing\b/i,/Tests:\s*(\d+) passed/i,/(\d+) passed\b/i,/\b(\d+)\s+tests?\s+passed\b/i,/✔\s*(\d+)/i]);
  const fail = counts([/^# fail (\d+)/m,/(\d+) failing\b/i,/Tests:\s*(\d+) failed/i,/(\d+) failed\b/i,/\b(\d+)\s+tests?\s+failed\b/i,/✖\s*(\d+)/i]);
  if (fail !== null && fail > 0) return { state:'failed', pass, fail };
  if (isError === true) return { state:'failed', pass, fail };
  if (pass !== null && pass > 0) return { state:'passed', pass, fail:fail ?? 0 };
  if (isError === false && /(?:passed|ok|success|통과)/i.test(text) && !/(?:fail|error|오류|실패)/i.test(text)) {
    return { state:'passed', pass:1, fail:0 };
  }
  return { state:'unknown', pass, fail };
}

function fileOpLabel(file) {
  if (file.deleted === true) return '삭제';
  if (file.created === true || file.existedBefore === false) return '추가';
  if (file.existedBefore === true || file.created === false) return '수정';
  const op = String(file.op ?? '').toLowerCase();
  if (op.includes('delete') || op.includes('remove')) return '삭제';
  if (op.includes('create') || op.includes('add')) return '추가';
  return '변경';
}

/** The files one tool result reported, as `{path, op, added, removed}` records. */
function reportedFiles(task, details, argumentPath) {
  const files = [];
  for (const file of changeFiles(details ?? {}, argumentPath || '')) {
    const totals = diffTotals(file.diff);
    const record = { path:file.path, op:fileOpLabel(file), tool:'', added:totals.added, removed:totals.removed };
    files.push(record);
    if (task && !task.files.includes(file.path)) task.files.push(file.path);
  }
  return files;
}

function applyTaskFrame(activity, task, frame, now, ctx) {
  const type = frame?.type;
  switch (type) {
    case 'agent_start': {
      task.status = 'running';
      if (!task.startedAt) task.startedAt = now;
      task.endedAt = null;
      task.stage = '답변 준비';
      return;
    }
    case 'turn_start': {
      task.turn = (task.turn ?? 0) + 1;
      task.status = 'running';
      task.stage = '답변 작성';
      if (!task.startedAt) task.startedAt = now;
      push(activity, task, now, { kind:'turn', groupable:false, facts:{ index:task.turn } });
      return;
    }
    case 'turn_end': task.stage = '턴 마무리'; return;
    case 'agent_end': {
      if (task.status !== 'failed') { task.status = 'done'; task.stage = '완료'; task.endedAt = now; }
      return;
    }
    case 'message_end': noteUsage(task, frame.message); return;
    case 'model_changed': {
      const model = frame.payload?.model ?? frame.model;
      const id = typeof model === 'string' ? model : (model?.id ? `${model.provider ?? ''}/${model.id}` : null);
      if (id) task.model = id; return;
    }
    case 'tool_execution_start': {
      const tool = String(frame.toolName ?? '도구');
      const args = frame.args && typeof frame.args === 'object' ? frame.args : {};
      const target = targetOf(args);
      const verification = verifyCommand(tool,args);
      activity.openTools.set(String(frame.toolCallId), { tool, args, target });
      if (activity.openTools.size > maxOpenTools) activity.openTools.delete(activity.openTools.keys().next().value);
      task.status = 'running';
      task.stage = verification ? `검증: ${tool}` : `도구: ${tool}`;
      push(activity, task, now, { kind:'tool.start', target, facts:{ tool, target, args:argsSummary(args), verify:!!verification } });
      return;
    }
    case 'tool_execution_update': return;
    case 'tool_execution_end': {
      const opening = activity.openTools.get(String(frame.toolCallId)) ?? {};
      const tool = String(frame.toolName ?? opening.tool ?? '도구');
      const args = opening.args ?? {};
      const target = opening.target || targetOf(args);
      const failed = frame.isError === true;
      const output = resultText(frame.result);
      const files = reportedFiles(task, frame.result?.details, args.path ?? args.file_path ?? '').map(file => ({ ...file, tool }));
      activity.openTools.delete(String(frame.toolCallId));
      task.stage = failed ? `${tool} 실패` : `${tool} 완료`;
      push(activity, task, now, { kind:'tool.end', target, facts:{ tool, target, failed, files, output:clip(output,maxResult) } });
      for (const file of files) push(activity, task, now, { kind:'write', target:file.path, facts:{ path:file.path, op:file.op, tool, added:file.added, removed:file.removed, files:[file] } });
      const command = verifyCommand(tool,args);
      if (command) {
        const outcome = verifyOutcome({ isError:failed, output });
        push(activity, task, now, { kind:'verify', target:command, facts:{ command:clip(command,180), state:outcome.state, pass:outcome.pass, fail:outcome.fail, output:clip(output,maxResult) } });
      }
      return;
    }
    case 'extension_ui_request': {
      if (!approvalMethods.has(frame.method)) return;
      task.status = 'waiting';
      task.stage = '승인 대기';
      push(activity, task, now, { kind:'approval', target:String(frame.id ?? ''), facts:{ title:clip(frame.title ?? '코어 승인 요청',120), method:frame.method } });
      return;
    }
    case 'auto_retry_start': {
      task.stage = '재시도 대기';
      const attempt = Number(frame.attempt ?? frame.payload?.attempt);
      push(activity, task, now, { kind:'retry', facts:{ attempt:Number.isFinite(attempt) ? attempt : null, reason:clip(frame.reason ?? frame.payload?.reason ?? '',120) } });
      return;
    }
    case 'auto_retry_end': {
      task.stage = frame.success === false ? '재시도 포기' : '재시도 후 계속';
      return;
    }
    case 'prompt_result': {
      if (frame.usage) noteUsage(task, frame);
      if (frame.status === 'error') {
        task.status = 'failed'; task.stage = '실패'; task.endedAt = now;
        push(activity, task, now, { kind:'failed', groupable:false, facts:{ message:clip(frame.error?.message ?? '코어가 오류를 보고했습니다',200) } });
      } else if (frame.status === 'aborted') {
        task.status = 'failed'; task.stage = '중단'; task.endedAt = now;
        push(activity, task, now, { kind:'failed', groupable:false, facts:{ message:'사용자가 실행을 멈췄습니다' } });
      } else if (frame.sessionSettled === false) {
        task.status = 'waiting'; task.stage = '백그라운드 작업';
      } else {
        task.status = 'done'; task.stage = '완료'; task.endedAt = now;
        push(activity, task, now, { kind:'done', groupable:false, facts:{ elapsed:formatElapsed(elapsedOf(task,now)), tokens:task.tokens, cost:task.cost, remote:Boolean(ctx.remote) } });
      }
      return;
    }
    case 'session_settled': {
      if (task.status === 'waiting') { task.status = 'done'; task.stage = '입력 대기'; task.endedAt = now; }
      else if (task.status === 'done') task.stage = '입력 대기';
      return;
    }
    case 'extension_error': case 'rpc_frame_error': {
      const message = clip(raw(frame.error ?? frame.message),200);
      push(activity, task, now, { kind:'error', groupable:false, facts:{ code:String(frame.type), message } });
      return;
    }
    case 'bridge_error': {
      if (['not_ready','invalid_command'].includes(frame.code)) return;
      task.status = 'failed'; task.stage = '연결 오류'; task.endedAt = now;
      push(activity, task, now, { kind:'error', groupable:false, facts:{ code:String(frame.code ?? 'bridge_error'), message:clip(frame.message ?? '',200) } });
      return;
    }
    case 'response': {
      const data = frame.data;
      if (frame.success !== true || !data) return;
      if (frame.command === 'get_state') {
        if (data.model) task.model = `${data.model.provider ?? ''}/${data.model.id ?? ''}`;
        if (data.isStreaming && task.status !== 'failed') { task.status = 'running'; if (!task.startedAt) task.startedAt = now; }
      } else if (frame.command === 'get_session_stats') {
        const tokens = Number(data.tokens?.total);
        if (Number.isFinite(tokens)) { task.tokens = tokens; task.tokensReported = true; }
        const cost = Number(data.cost);
        if (Number.isFinite(cost)) { task.cost = cost; task.costReported = true; }
      } else if (frame.command === 'get_subagents' && Array.isArray(data.subagents)) {
        data.subagents.forEach((entry, index) => {
          if (entry?.id) ensureTask(activity, entry.id, now, { name:entry.name ?? entry.agent, status:entry.status === 'completed' ? 'done' : entry.status === 'running' ? 'running' : entry.status === 'failed' || entry.status === 'error' ? 'failed' : 'waiting', model:typeof entry.model === 'string' ? entry.model : undefined, lane:index, stage:entry.detail ?? entry.task });
        });
      }
      return;
    }
    default: return;
  }
}

function ingestLifecycle(activity, payload, now) {
  if (!payload) return;
  const status = payload.status;
  const name = typeof payload.agent === 'string' && payload.agent ? payload.agent : '서브에이전트';
  const task = ensureTask(activity, payload.id, now, { name, lane:Number.isFinite(payload.index) ? payload.index : null, stage:payload.description ?? '시작' });
  task.dependsOn = payload.parentToolCallId ? { toolCallId:String(payload.parentToolCallId), label:activity.main?.name ?? '메인 작업' } : task.dependsOn;
  if (status === 'started') {
    task.status = 'running'; task.endedAt = null; task.startedAt = now;
    push(activity, task, now, { kind:'delegate', target:String(payload.id ?? ''), facts:{ agent:name, task:clip(payload.description ?? '',80), lane:payload.index ?? 0, parent:activity.main?.name ?? '메인 작업' } });
    return;
  }
  if (status === 'completed') { task.status = 'done'; task.stage = '완료'; task.endedAt = now; }
  else if (status === 'failed') { task.status = 'failed'; task.stage = '실패'; task.endedAt = now; }
  else { task.status = 'failed'; task.stage = '중단'; task.endedAt = now; }
  push(activity, task, now, { kind:'agent.end', target:String(payload.id ?? ''), groupable:false, facts:{ agent:name, state:taskStates[task.status] ?? '완료', elapsed:formatElapsed(elapsedOf(task,now)) } });
}

function ingestProgress(activity, payload, now) {
  if (!payload) return;
  const task = ensureTask(activity, payload.id ?? payload.agent, now);
  if (typeof payload.agent === 'string' && payload.agent) task.name = payload.agent;
  if (Number.isFinite(payload.index)) task.lane = payload.index;
  const progress = payload.progress ?? {};
  const stage = typeof payload.task === 'string' && payload.task ? payload.task : typeof progress.task === 'string' ? progress.task : null;
  if (stage && stage !== task.stage) {
    task.stage = clip(stage,80);
    if (task !== activity.main) push(activity, task, now, { kind:'progress', target:String(payload.id ?? ''), facts:{ text:clip(stage,120) } });
  }
  if (typeof progress.status === 'string' && ['queued','waiting','pending'].includes(progress.status)) task.status = 'waiting';
  else if (typeof progress.status === 'string' && ['running','working','active'].includes(progress.status)) task.status = 'running';
  if (typeof progress.model === 'string' && progress.model) task.model = progress.model;
  noteUsage(task, progress.message);
}

/** One incoming frame → zero or more normalised activity events. Returns how many were added. */
export function ingestFrame(activity, frame, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const type = frame?.type;
  if (!type) return 0;
  const before = activity.events.length;
  if (type === 'subagent_lifecycle') { ingestLifecycle(activity, frame.payload, now); return activity.events.length - before; }
  if (type === 'subagent_progress') { ingestProgress(activity, frame.payload, now); return activity.events.length - before; }
  if (type === 'subagent_event') {
    const payload = frame.payload ?? {};
    const task = ensureTask(activity, payload.id, now);
    if (payload.event) applyTaskFrame(activity, task, payload.event, now, ctx);
    return activity.events.length - before;
  }
  if (type === 'agent_start' && !activity.main) {
    const main = ensureMain(activity, now, ctx);
    main.startedAt = main.startedAt ?? now;
    main.status = 'running';
    main.stage = '답변 준비';
    main.endedAt = null;
    return 0;
  }
  const task = ensureMain(activity, now, ctx);
  applyTaskFrame(activity, task, frame, now, ctx);
  return activity.events.length - before;
}

/** The user's request is the run boundary: elapsed time and the run event start here. */
export function markPrompt(activity, prompt, at = Date.now()) {
  const main = ensureMain(activity, at);
  const title = String(prompt ?? '').replace(/\s+/g,' ').trim();
  if (title) main.name = title.slice(0,48);
  main.status = 'waiting';
  main.stage = '요청 전달';
  main.startedAt = at;
  main.endedAt = null;
  main.turn = 0;
  main.files = [];
  push(activity, main, at, { kind:'run', groupable:false, facts:{ name:main.name } });
  return main;
}

/** An approval the page answered is the user's action, so the wait ends with it. */
export function markApprovalAnswered(activity, at = Date.now()) {
  const main = ensureMain(activity, at);
  main.status = 'running';
  main.stage = '도구: 승인됨';
  push(activity, main, at, { kind:'approval.end', groupable:false, facts:{} });
  return main;
}

/**
 * Consecutive identical events fold into one row; different targets never merge,
 * and an event marked `groupable:false` always stands alone.
 */
export function timelineRows(activity, { grouped = true } = {}) {
  const rows = [];
  if (grouped) {
    const buckets = new Map();
    for (const event of activity.events) {
      if (!event.groupable) {
        rows.push({ key:event.id, groupKey:event.groupKey, events:[event] });
        continue;
      }
      let existing = buckets.get(event.groupKey);
      if (!existing) {
        existing = { key:event.id, groupKey:event.groupKey, events:[] };
        buckets.set(event.groupKey, existing);
        rows.push(existing);
      }
      existing.events.push(event);
    }
  } else {
    for (const event of activity.events) {
      rows.push({ key:event.id, groupKey:event.groupKey, events:[event] });
    }
  }
  return rows.map(row => {
    const first = row.events[0], last = row.events.at(-1);
    return {
      key:row.key, kind:last.kind, count:row.events.length,
      at:first.at, lastAt:last.at,
      taskId:last.taskId, taskName:last.taskName, taskState:last.taskState,
      target:last.target, facts:last.facts, events:row.events,
      highlight:last.kind === 'error' ? 'error' : last.kind === 'approval' ? 'approval' : last.kind === 'verify' ? 'verify' : null,
      lines:eventLines({ kind:last.kind, facts:last.facts, taskName:last.taskName, taskState:last.taskState })
    };
  });
}

/** A tool target is shown only when it is not a path: the timeline never lists files. */
function plainTarget(target) {
  const text = String(target ?? '').trim();
  if (!text) return '';
  if (/[\\/]|\.[a-z0-9]{1,5}\b/i.test(text)) return '';
  return clip(text, 100);
}

/** One or two local Korean lines per event; no model writes them. */
export function eventLines(event) {
  const facts = event?.facts ?? {};
  switch (event?.kind) {
    case 'run': return [`‘${clip(facts.name,44)}’ 작업을 시작했습니다`, '에이전트가 요청을 받았습니다'];
    case 'turn': return [`${facts.index ?? 1}번째 턴을 시작했습니다`, event.taskName];
    case 'tool.start': return [facts.verify ? `${facts.tool}로 검증을 실행합니다` : `${facts.tool} 도구를 실행합니다`, plainTarget(facts.target) || (facts.verify ? '검증 명령' : '대상 미보고')];
    case 'tool.end': return facts.failed ? [`${facts.tool} 실행이 실패했습니다`, plainTarget(facts.target) || '대상 미보고'] : [`${facts.tool} 실행을 마쳤습니다`, plainTarget(facts.target) || '대상 미보고'];
    case 'write': return [`${facts.op} · ${facts.added ?? 0}줄 추가 / ${facts.removed ?? 0}줄 삭제`, '파일 변경 내역은 Diff 탭에서 확인합니다'];
    case 'verify': {
      const counts = facts.state === 'passed' && facts.pass != null ? ` · ${facts.pass}건 통과` : facts.state === 'failed' ? ` · 실패 보고${facts.fail != null ? ` ${facts.fail}건` : ''}` : '';
      return [`검증 ${verifyStates[facts.state] ?? '결과 미확인'}`, `${plainTarget(facts.command) || '검증 명령'}${counts}`];
    }
    case 'delegate': return [`${facts.agent}에게 작업을 넘겼습니다`, `‘${clip(facts.task,60) || '내용 미보고'}’ · 레인 ${Number(facts.lane) + 1}`];
    case 'agent.end': return [`${facts.agent} 작업 ${facts.state}`, `걸린 시간 ${facts.elapsed}`];
    case 'progress': return [`${event.taskName} 진행 상황을 보고했습니다`, clip(facts.text,120)];
    case 'approval': return [`승인을 기다립니다 · ${facts.method}`, clip(facts.title,120)];
    case 'approval.end': return ['승인 요청에 답했습니다', '요청한 도구를 계속 실행합니다'];
    case 'retry': return [`자동 재시도 ${facts.attempt ?? ''}회차`.trim(), clip(facts.reason,120) || '코어가 다시 시도합니다'];
    case 'error': return [`오류 · ${facts.code}`, clip(facts.message,140)];
    case 'done': {
      const remote = facts.remote ?? false;
      const costStr = costLabel(facts.cost, { remote });
      const parts = [facts.elapsed, facts.tokens != null ? `${facts.tokens} 토큰` : '토큰 미보고', costStr];
      return ['작업을 마쳤습니다', parts.join(' · ')];
    }
    case 'failed': return ['작업이 실패했습니다', clip(facts.message,140)];
    default: return ['활동을 기록했습니다', ''];
  }
}

/** Rows run newest-last; the detail is what the page shows after a click. */
export function eventDetail(row) {
  const events = row.events.slice(-maxDetailEvents);
  const files = [];
  for (const event of row.events) {
    for (const file of event.facts.files ?? []) files.push(file);
  }
  return {
    count: row.events.length,
    log: events.map(event => ({ at:event.at, kind:event.kind, lines:eventLines(event), output:event.facts.output ?? '' })),
    output: [...row.events].reverse().find(event => event.facts.output)?.facts.output ?? '',
    files
  };
}

export function taskSummary(activity, now = Date.now()) {
  const main = activity.main;
  const tasks = activity.tasks.map(task => ({ ...task, elapsed:elapsedOf(task,now), state:taskStates[task.status] ?? '대기' }));
  const verify = { passed:0, failed:0, unknown:0 };
  const files = new Set();
  for (const event of activity.events) {
    if (event.kind === 'verify') verify[event.facts.state] = (verify[event.facts.state] ?? 0) + 1;
    if (event.kind === 'write') files.add(event.facts.path);
  }
  return {
    main: main ? { ...main, elapsed:elapsedOf(main,now), state:taskStates[main.status] ?? '대기' } : null,
    tasks, verify,
    running:tasks.filter(task => task.status === 'running').length,
    waiting:tasks.filter(task => task.status === 'waiting').length,
    files:[...files]
  };
}

/** Parallel lanes: one bar per task, positioned on the run's own time span. */
export function lanes(activity, now = Date.now()) {
  const tasks = [activity.main, ...activity.tasks].filter(Boolean);
  const starts = tasks.map(task => task.startedAt).filter(value => Number.isFinite(value));
  const start = starts.length ? Math.min(...starts) : activity.at;
  const end = Math.max(now, ...tasks.map(task => task.endedAt ?? now));
  const span = Math.max(1,end - start);
  return {
    start, end, span,
    rows:tasks.map(task => {
      const from = task.startedAt ?? start;
      const to = task.endedAt ?? end;
      return {
        id:task.id, name:task.name, kind:task.kind, lane:task.lane, state:task.status,
        label:formatElapsed(to - from),
        offset:Math.min(1,Math.max(0,(from - start) / span)),
        width:Math.min(1,Math.max(0.02,(to - from) / span)),
        dependsOn:task.dependsOn ?? null
      };
    })
  };
}

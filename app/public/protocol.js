// @ts-check
// omp 18.16.0 observed frames. Wire interpretation and command creation stay here.
/** @typedef {{id:string, role:string, text:string, blocks:Record<number,string>, pending?:boolean, order?:number}} Message */
/** @typedef {{path:string, diff:string, op:string|null, truncated?:boolean, created:boolean|null, existedBefore:boolean|null, deleted:boolean|null, isError:boolean|null, statusIssue:'failed'|'in_progress'|null}} ToolFile */
/** @typedef {{created:boolean|null, existedBefore:boolean|null, deleted:boolean|null, op:string|null, opField?:string|null, command:string|null, statusIssue:'failed'|'in_progress'|null, target:string}} ChangeEvidence */
/** @typedef {{id:string, name:string, arguments:string, result:string, status:string, isError?:boolean, order?:number, files?:ToolFile[], evidence?:ChangeEvidence, seenAt?:number}} Tool */
/** @typedef {{source:'model', modelId:string, summary:string, sentences:string[], role:string, roleNote:string|null}} TimelinePhrasing */
/** @typedef {{id:string, method:string, title:string, message:string, options:string[], value:string}} Approval */
/** @typedef {{name:string, description?:string, input?:unknown, subcommands?:unknown[], source?:unknown}} AvailableCommand */
/** @typedef {{code:string,message:string,order?:number}} UiError */
/** @typedef {{selected:'local'|'cloud', consent:boolean, confirmed:string|null, pending:{id:string,key:string}|null, failure:string|null}} RouteState */
/** @typedef {{level:string, reported:string|null, confirmed:string|null, pending:{id:string,level:string}|null, failure:string|null, available:string[]|null}} ThinkingState */
/** @typedef {{modelId:string, upstream:string|null, grade:string|null, budget:number|null, reason:string|null, sequence:number|null, decidedAt:string|null, planMode:string|null, planTier:string|null, role:string|null, roleReason:string|null, decisionSource:string|null, decisionReason:string|null, decisionUpstream:string|null, fallbackChain:string[], primaryModel:string|null}} GatewaySelection */
/** @typedef {{known:boolean, count:number|null}} SubagentState */
/** @typedef {{content:string, status:string, blocker?:string}} TodoTask */
/** @typedef {{name:string, tasks:TodoTask[]}} TodoPhase */
/** @typedef {{turn:number, model:string|null, grade:string|null, gradeReported:string|null, subagents:number|null, tools:string[], skills:string[]}} TurnRecord */
/** @typedef {{phase:string,messages:Message[],tools:Tool[],approvals:Approval[],widgets:Record<string,string[]>,commands:AvailableCommand[],notices:string[],background:string|null,error:UiError|null,errors:UiError[],activeMessage:string|null,nextMessage:number,nextOrder:number,coreModel:string|null,selection:GatewaySelection|null,promptStatus:string|null,route:RouteState,thinking:ThinkingState,subagents:SubagentState,todos:TodoPhase[],sawTodos:boolean,coreTools:string[],plan:TurnRecord[],sessionId:string|null,sessionFailed:boolean,terminalError:UiError|null}} ViewModel */
/** @returns {ViewModel} */
export function createViewModel() {
  return { phase:'연결 준비', messages:[], tools:[], approvals:[], widgets:{}, commands:[], notices:[], background:null, error:null, errors:[], activeMessage:null, nextMessage:0, nextOrder:0, coreModel:null, selection:null, promptStatus:null, route:createRouteState(), thinking:createThinkingState(), subagents:{ known:false, count:null }, subagentList:[], usage:{ tokens:0, cost:0, seen:false }, stats:null, context:null, missing:[], todos:[], sawTodos:false, coreTools:[], plan:[], sessionId:null, sessionFailed:false, terminalError:null, timelinePhrasing:null };
}
/** @returns {ThinkingState} */
export function createThinkingState() { return { level:'off', reported:null, confirmed:null, pending:null, failure:null, available:null }; }
/**
 * The gateway's own last model+reasoning decision for this identity and route, as
 * the bridge read it back. Only fields the record actually carries survive; every
 * missing one stays null so the UI shows nothing for it. `null` — nothing decided
 * yet, an evicted record, a restart, or a failed read — is a real answer and clears
 * back to the neutral label, never to an invented one.
 * @param {any} raw
 * @returns {GatewaySelection|null}
 */
export function gatewaySelection(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const model = value?.model;
  if (!model || typeof model !== 'object' || Array.isArray(model) || typeof model.id !== 'string' || !model.id.trim()) return null;
  const reasoning = value.reasoning && typeof value.reasoning === 'object' ? value.reasoning : {};
  const grade = typeof reasoning.grade === 'string' && reasoning.grade ? reasoning.grade : null;
  const planMode = typeof value?.plan_mode === 'string' ? value.plan_mode : typeof value?.planMode === 'string' ? value.planMode : null;
  const planTier = typeof value?.plan_tier === 'string' ? value.plan_tier : typeof value?.planTier === 'string' ? value.planTier : null;
  // Where the choice came from, in the gateway's own words. A value outside the four
  // reported sources is not interpreted: it stays null and the page claims nothing.
  const decisionSources = ['remote_decision', 'local_fallback', 'local', 'caller'];
  const decisionSourceRaw = typeof model.decision_source === 'string' ? model.decision_source : null;
  const decisionSource = decisionSourceRaw && decisionSources.includes(decisionSourceRaw) ? decisionSourceRaw : null;
  const fallbackChain = Array.isArray(model.fallback_chain)
    ? model.fallback_chain.filter(x => typeof x === 'string' && x)
    : [];
  return {
    modelId:model.id,
    upstream:typeof model.upstream === 'string' && model.upstream ? model.upstream : null,
    grade,
    budget:Number.isInteger(reasoning.thinking_budget) && reasoning.thinking_budget >= 0 ? reasoning.thinking_budget : null,
    reason:typeof model.reason === 'string' && model.reason ? model.reason : null,
    sequence:Number.isSafeInteger(value.sequence) ? value.sequence : null,
    decidedAt:typeof value.decided_at === 'string' && value.decided_at ? value.decided_at : null,
    planMode,
    planTier,
    role:typeof model.role === 'string' && model.role ? model.role : null,
    roleReason:typeof model.role_reason === 'string' && model.role_reason ? model.role_reason : null,
    decisionSource,
    decisionReason:typeof model.decision_reason === 'string' && model.decision_reason ? model.decision_reason : null,
    decisionUpstream:typeof model.decision_upstream === 'string' && model.decision_upstream ? model.decision_upstream : null,
    decisionDetail:typeof model.decision_detail === 'string' && model.decision_detail ? model.decision_detail : null,
    requestId:typeof value.request_id === 'string' && value.request_id ? value.request_id : null,
    routedModel:typeof value.routed_model === 'string' && value.routed_model ? value.routed_model : null,
    fallbackChain,
    primaryModel:typeof model.primary === 'string' && model.primary ? model.primary : null
  };
}
/** Monotonic transcript position so tool cards, messages and errors keep arrival order. */
export function nextOrder(vm) { return ++vm.nextOrder; }
/** Levels the core documents in its RPC type; only offered when the core reports no subset. */
export const thinkingLevels = ['off','minimal','low','medium','high','xhigh','max'];
/** Skills the core listed in its own command catalog, by catalog source. */
export function skillNames(vm) {
  return vm.commands.filter(x => x && x.source === 'skill' && typeof x.name === 'string').map(x => x.name);
}
/** Snapshot of what the harness told us about this turn. Unknown values stay null, never guessed. */
export function recordTurn(vm, turn) {
  const record = {
    turn:Number.isFinite(turn) ? turn : vm.plan.length + 1,
    model:vm.route.confirmed ?? vm.coreModel,
    grade:vm.thinking.confirmed ?? vm.thinking.level ?? null,
    gradeReported:vm.thinking.reported,
    subagents:vm.subagents.known ? vm.subagents.count ?? 0 : null,
    tools:[...vm.coreTools],
    skills:skillNames(vm)
  };
  vm.plan.push(record);
  return record;
}
export const protocolVersion = 2;
export const physicalFrameLimit = 1048576;
export const logicalFrameLimit = 67108864;
export function command(type, fields = {}) { return { id:crypto.randomUUID(), type, ...fields }; }
export function negotiation(id) { return { id, type:'negotiate_protocol', protocolVersion }; }
export function launchArguments(extra = []) { return ['--mode', 'rpc', ...extra]; }
export function isReady(frame) { return frame?.type === 'ready'; }
export function readyLimits(frame) {
  if (!Array.isArray(frame.supportedProtocolVersions) || !frame.supportedProtocolVersions.includes(2)) throw new Error('코어가 프로토콜 v2를 지원하지 않습니다.');
  const physical = frame.maxFrameBytes, logical = frame.maxReassembledFrameBytes;
  if (!Number.isSafeInteger(physical) || physical < 1024 || physical > physicalFrameLimit || !Number.isSafeInteger(logical) || logical < physical || logical > logicalFrameLimit) throw new Error('코어 프레임 한도를 지원하지 않습니다.');
  return { physical, logical };
}
export function negotiationResult(frame, id) {
  if (frame?.type !== 'response' || frame.command !== 'negotiate_protocol' || frame.id !== id) return null;
  return { ok:frame.success === true && frame.data?.protocolVersion === protocolVersion, message:frame.error ?? '프로토콜 v2 협상 응답을 확인할 수 없습니다.' };
}
export function promptCommand(message) { return command('prompt',{ message }); }
export function modelCommand(route) { return command('set_model',{ provider:route.provider, modelId:route.model }); }
/** @returns {RouteState} */
export function createRouteState() { return { selected:'local', consent:false, confirmed:null, pending:null, failure:null }; }
export function routeKey(route) {
  return route && typeof route.provider === 'string' && route.provider && typeof route.model === 'string' && route.model ? `${route.provider}/${route.model}` : '';
}
/** Any route or consent change invalidates the previous confirmation. */
export function resetRoute(vm, selected) {
  vm.route.selected = selected;
  vm.route.confirmed = null;
  vm.route.pending = null;
  vm.route.failure = null;
}
export function setConsent(vm, consent) {
  vm.route.consent = consent === true;
  if (!vm.route.consent) { vm.route.confirmed = null; vm.route.pending = null; }
}
/** Marks the selected route pending until a correlated set_model response confirms it. */
export function beginModelSwitch(vm, selected, route) {
  resetRoute(vm, selected);
  const key = routeKey(route);
  if (!key) return null;
  const cmd = modelCommand(route);
  vm.route.pending = { id:cmd.id, key };
  return cmd;
}
function reportedModelKey(data) {
  const model = data?.model ?? data;
  const id = model?.id ?? model?.modelId;
  return model && typeof model.provider === 'string' && model.provider && typeof id === 'string' && id ? `${model.provider}/${id}` : null;
}
/** Correlated only: a response for another request can never confirm the selected route. */
export function modelSwitchSettled(vm, frame) {
  const pending = vm.route.pending;
  if (!pending || frame?.type !== 'response' || frame.command !== 'set_model' || frame.id !== pending.id) return false;
  vm.route.pending = null;
  const reported = reportedModelKey(frame.data);
  if (frame.success === true && (!reported || reported === pending.key)) {
    vm.route.confirmed = pending.key;
    vm.route.failure = null;
    vm.coreModel = pending.key;
    if (vm.error?.code === 'model_switch_failed') vm.error = null;
    vm.phase = '입력 대기';
    return true;
  }
  const reason = frame.success === false
    ? (typeof frame.error === 'string' && frame.error ? frame.error : '코어가 모델 전환을 거절했습니다.')
    : `코어가 요청한 모델(${pending.key})과 다른 모델(${reported})을 반환했습니다.`;
  vm.route.confirmed = null;
  vm.route.failure = reason;
  if (reported) vm.coreModel = reported;
  recordError(vm,'model_switch_failed',reason);
  vm.phase = '모델 전환 실패';
  return true;
}
/** Sending requires the exact selected model to have been confirmed on the live session. */
export function routeReady(vm, route, { ready = true } = {}) {
  if (!ready || !route || vm.route.pending || vm.route.failure) return false;
  const key = routeKey(route);
  if (!key || vm.route.confirmed !== key) return false;
  if (vm.route.selected === 'cloud' && !vm.route.consent) return false;
  if (vm.coreModel && vm.coreModel !== key) return false;
  return true;
}
export function canSendPrompt(vm, route, options = {}) {
  return routeReady(vm, route, options) && vm.approvals.length === 0;
}
export function approvalCommand(request, value) {
  const reply = { type:'extension_ui_response', id:request.id };
  if (request.method === 'select') {
    if (!request.options.includes(value)) throw new Error('코어가 제공하지 않은 승인 항목입니다.');
    return { ...reply, value };
  }
  if (request.method === 'confirm') return { ...reply, confirmed:value === true };
  if (value === null) return { ...reply, cancelled:true };
  return { ...reply, value:String(value) };
}
/** The core's select frame carries only its own English option labels (`options: string[]`,
    no grant/scope field — see `approvalChoiceLabels` in the installed core), so the scope is
    recovered from the label vocabulary it emits: `Approve`/`Approve Once` (once), `Approve File`,
    `Approve Directory: <path>`, the `Always …` global grants, `Approve <subject> for this session`
    and `Deny`. Each variant keeps its own meaning: a global grant is not the session grant. */
export function approvalLabel(value) {
  const text = String(value ?? '');
  const labels = {
    'Approve':'한 번 승인', 'Approve Once':'한 번 승인',
    'Approve File':'파일에 대해 승인', 'Always Approve File':'항상 파일에 대해 승인',
    'Always Approve':'항상 승인', 'Deny':'거절'
  };
  if (labels[text]) return labels[text];
  const session = /^Approve (.+) for this session$/.exec(text);
  if (session) return `이 세션에서 ${session[1]} 승인`;
  const directory = /^Approve Directory: (.+)$/.exec(text);
  if (directory) return `폴더에 대해 승인: ${directory[1]}`;
  const alwaysDirectory = /^Always Approve Directory: (.+)$/.exec(text);
  if (alwaysDirectory) return `항상 폴더에 대해 승인: ${alwaysDirectory[1]}`;
  return text;
}
export function supportedApproval(request) { return ['confirm','select','input','editor'].includes(request.method); }
/** The core's own reject option, if it sent one. Only the value `Deny` (or its label) is a reject. */
export function isDenyApproval(value) {
  const text = String(value ?? '');
  return text === 'Deny' || approvalLabel(text) === '거절';
}
/**
 * The core's select options split into the approve choices the radio group offers and
 * the one deny value the secondary button sends. The radio list is built from
 * `request.options` alone, because `approvalCommand` refuses a value the core did not
 * offer; an option this page cannot name still appears, verbatim.
 */
export function approvalChoices(request) {
  if (!request || request.method !== 'select') return { approve:[], deny:null };
  const options = Array.isArray(request.options) ? request.options.filter(x => typeof x === 'string') : [];
  return { approve:options.filter(value => !isDenyApproval(value)), deny:options.find(isDenyApproval) ?? null };
}
/** The radio default: 한 번 승인 first, then the core's first approve option. */
export function defaultApprovalValue(request) {
  const { approve } = approvalChoices(request);
  return approve.find(value => value === 'Approve' || value === 'Approve Once') ?? approve[0] ?? null;
}
/** An `항상 …` grant applies beyond this file, so the gate asks a second time. */
export function approvalIsGlobal(value) {
  return /^Always\s/.test(String(value ?? '')) || approvalLabel(value).startsWith('항상');
}
/** The core's English ask in the product's words; null when the core said nothing mappable. */
export function approvalActionText(request) {
  const raw = String(request?.title ?? '').trim();
  const tool = /^Allow tool:\s*(\S+)\s*$/i.exec(raw)?.[1] ?? null;
  if (tool) return `${tool} 도구를 실행하려 합니다`;
  return null;
}
/**
 * The core's reason sentence, mapped; a reason this page has no wording for is not
 * paraphrased — `null` leaves the line off the card and the raw text in `자세히`.
 */
export function approvalReasonText(request) {
  const raw = String(request?.message ?? '').trim();
  const reason = /^Reason:\s*(.+)$/i.exec(raw)?.[1]?.trim() ?? null;
  if (!reason) return null;
  const map = {
    'target not yet approved': '이 경로는 아직 승인되지 않았습니다',
    'tool not yet approved': '이 도구는 아직 승인되지 않았습니다',
    'directory not yet approved': '이 폴더는 아직 승인되지 않았습니다'
  };
  return map[reason] ?? null;
}
/** The tool call this approval is about: the newest call with no terminal status. */
export function pendingApprovalTool(vm) {
  const open = (vm?.tools ?? []).filter(tool => tool.status === '실행 중' || tool.status === '호출 준비 중');
  return open.at(-1) ?? null;
}
/** Unified-diff lines, changed rows only, at most `limit`. */
function changedLines(diff, limit = 6) {
  const rows = [];
  for (const raw of String(diff ?? '').split('\n')) {
    if (!raw || raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('@@') || raw.startsWith(' ')) continue;
    const add = raw.startsWith('+'), del = raw.startsWith('-');
    if (!add && !del) continue;
    rows.push({ kind:add ? 'add' : 'del', text:raw.slice(1) });
    if (rows.length === limit) break;
  }
  return rows;
}
/**
 * What the approval would change, read from the waiting tool's own arguments — the
 * approval frame itself carries no arguments. `none` is a real answer: the card then
 * says it did not receive the change rather than implying one was shown.
 */
export function approvalPreview(tool) {
  if (!tool) return { kind:'none', path:null, lines:[], command:null };
  let args = {};
  try { const parsed = JSON.parse(tool.arguments || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed; } catch {}
  const path = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : null;
  if (typeof args.command === 'string' && args.command.trim()) return { kind:'command', path, lines:[], command:args.command.trim() };
  const diff = typeof args.diff === 'string' ? args.diff : typeof args.patch === 'string' ? args.patch : '';
  if (diff) return { kind:'diff', path, lines:changedLines(diff), command:null };
  if (typeof args.content === 'string' && args.content) {
    const lines = args.content.split('\n').slice(0,6).map((text, index) => ({ kind:'add', num:index + 1, text }));
    return { kind:'diff', path, lines, command:null };
  }
  return { kind:'none', path, lines:[], command:null };
}
export function allowedCommand(frame) {
  return frame && typeof frame === 'object' && ['prompt','steer','follow_up','abort','new_session','open_session','get_state','get_messages','set_model','compact','branch','fork','set_todos','get_session_stats','set_thinking_level','get_available_thinking_levels','get_subagents','extension_ui_response'].includes(frame.type);
}
/** Codes after which the session is dead and every later peer must see the same error, never readiness. */
export function terminalErrorCode(code) {
  return ['launch_failed','core_crashed','protocol_mismatch','frame_too_large','write_failed','backpressure','transport_closed','consent_required','invalid_route'].includes(code);
}
/** README-documented core levels; the selector only offers what the core itself reports as available. */
export function thinkingLabel(level) {
  const labels = { off:'끔', minimal:'최소', low:'낮음', medium:'보통', high:'높음', xhigh:'매우 높음', max:'최대', inherit:'코어 기본값' };
  return labels[level] ?? (typeof level === 'string' && level ? level : '알 수 없음');
}
export function frameType(frame) {
  return frame?.type ?? (typeof frame?.agentInvoked === 'boolean' && ['completed','aborted','error'].includes(frame.status) ? 'prompt_result' : undefined);
}
// The core reports assistant text on `message_start|message_update|message_end` as
// `message.content` (and nests `{type:'text_end'}` inside `message_update.assistantMessageEvent`);
// it never emits a top-level `text_end` frame, so reading that type alone reports no text.
// A completed turn can also carry only tool calls (`content:[{type:'toolCall'}]`) with no
// text block at all. That is "the core reported no text", which an empty bubble hides.
export const ASSISTANT_NOTE = Object.freeze({
  toolOnly: '답변 텍스트는 보고되지 않았습니다. 이 턴은 도구 호출만 보고했습니다.',
  none: '답변 텍스트를 코어가 보고하지 않았습니다.',
});
/** @param {any} message @param {boolean} [turnHadTools] @returns {string|null} */
export function assistantNote(message, turnHadTools = false) {
  if (!message || message.role !== 'assistant') return null;
  if (typeof message.text === 'string' && message.text.trim()) return null;
  return turnHadTools ? ASSISTANT_NOTE.toolOnly : ASSISTANT_NOTE.none;
}
/** Stateful, bounded protocol-v2 rpc_chunk reassembly. Never accepts chunks before negotiation. */
export class FrameDecoder {
  constructor() { this.negotiated = false; this.physical = physicalFrameLimit; this.logical = logicalFrameLimit; this.sequence = null; }
  push(frame) {
    if (frame?.type !== 'rpc_chunk') { if (this.sequence) throw new Error('rpc_chunk 전송이 중간에 끊겼습니다.'); if (!frame || typeof frame !== 'object' || Array.isArray(frame) || !frameType(frame)) throw new Error('RPC 프레임 객체가 아닙니다.'); return frame; }
    if (!this.negotiated) throw new Error('프로토콜 협상 전에 rpc_chunk가 도착했습니다.');
    const { chunkId, index, count, byteLength, data } = frame;
    if (typeof chunkId !== 'string' || !chunkId.length || chunkId.length > 128 || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 2 || count > 1024 || index < 0 || index >= count || !Number.isSafeInteger(byteLength) || byteLength < this.physical || byteLength > this.logical || typeof data !== 'string' || !data.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('올바르지 않은 rpc_chunk 메타데이터입니다.');
    const binary = atob(data);
    if (btoa(binary) !== data || binary.length > this.physical) throw new Error('rpc_chunk 데이터 한도를 초과했습니다.');
    if (!this.sequence) { if (index !== 0) throw new Error('rpc_chunk는 index 0부터 시작해야 합니다.'); this.sequence = { chunkId,count,byteLength,nextIndex:0,received:0,chunks:[] }; }
    const s = this.sequence;
    if (s.chunkId !== chunkId || s.count !== count || s.byteLength !== byteLength || s.nextIndex !== index) throw new Error('rpc_chunk 순서가 맞지 않습니다.');
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    s.chunks.push(bytes); s.received += bytes.length; s.nextIndex++;
    if (s.received > byteLength) throw new Error('rpc_chunk 선언 크기를 초과했습니다.');
    if (s.nextIndex < count) return null;
    if (s.received !== byteLength) throw new Error('rpc_chunk 재조립 크기가 맞지 않습니다.');
    const combined = new Uint8Array(byteLength); let offset = 0;
    for (const chunk of s.chunks) { combined.set(chunk,offset); offset += chunk.length; }
    this.sequence = null;
    const result = JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(combined));
    if (!result || typeof result !== 'object' || Array.isArray(result) || !frameType(result) || result.type === 'rpc_chunk') throw new Error('재조립한 RPC 프레임이 올바르지 않습니다.');
    return result;
  }
}
function textContent(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(x => x.type === 'text').map(x => x.text ?? '').join('') : '';
}
function summary(value) { return typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2); }
const maxToolDiff = 400000;
function recordError(vm, code, message) { const error = { code,message,order:nextOrder(vm) }; vm.error = error; vm.errors.push(error); }
/** Optional capabilities: a core that does not implement them is reported as missing, not as a UI error. */
export const optionalCommands = ['get_subagents','get_session_stats','get_available_thinking_levels'];
function capabilityMissing(vm, command) {
  if (!vm.missing.includes(command)) vm.missing.push(command);
}
/** Only usage numbers the core actually attached to a finished message are accumulated; nothing is estimated. */
function noteUsage(vm, raw) {
  const usage = raw?.usage;
  if (!usage || typeof usage !== 'object') return;
  const total = Number(usage.totalTokens);
  const input = Number(usage.input) || 0;
  const output = Number(usage.output) || 0;
  const tokens = Number.isFinite(total) && total > 0 ? total : input + output;
  if (Number.isFinite(tokens) && tokens > 0) {
    vm.usage.tokens += tokens;
    vm.usage.seen = true;
  }
  const cost = typeof usage.cost === 'number' ? usage.cost : usage.cost?.total;
  if (Number.isFinite(cost)) vm.usage.cost += cost;

  // Cache read tokens: reported on Anthropic/OpenAI wire (cacheRead / cache_read_input_tokens / cached_tokens)
  const cacheRead = Number(usage.cacheRead ?? usage.cache_read ?? usage.cachedTokens ?? usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  if (Number.isFinite(cacheRead) && cacheRead >= 0) {
    vm.usage.cacheRead = (vm.usage.cacheRead ?? 0) + cacheRead;
    vm.usage.hasCacheRead = true;
  }
  if (Number.isFinite(input) && input > 0) {
    vm.usage.promptTokens = (vm.usage.promptTokens ?? 0) + input;
  }
  // Record time of this message usage for rolling token rate calculation
  const now = Date.now();
  if (!Array.isArray(vm.usage.frames)) vm.usage.frames = [];
  if (Number.isFinite(tokens) && tokens > 0) {
    vm.usage.frames.push({ at:now, tokens });
    if (vm.usage.frames.length > 20) vm.usage.frames.shift();
  }
}
function subagentId(entry, index) {
  const raw = entry?.id ?? entry?.name ?? entry?.agent;
  return typeof raw === 'string' && raw ? raw : `subagent-${index}`;
}
function noteSubagent(vm, entry, index) {
  if (!entry || typeof entry !== 'object') return;
  const id = subagentId(entry, index);
  const status = typeof entry.status === 'string' ? entry.status : 'unknown';
  const existing = vm.subagentList.find(x => x.id === id);
  const record = existing ?? { id, name:id, status, model:null, detail:null };
  if (typeof entry.agent === 'string' && entry.agent) record.name = entry.agent;
  else if (typeof entry.name === 'string' && entry.name) record.name = entry.name;
  if (typeof entry.model === 'string' && entry.model) record.model = entry.model;
  const detail = entry.detail ?? entry.task ?? entry.role ?? entry.summary;
  if (typeof detail === 'string' && detail) record.detail = detail;
  record.status = status;
  if (!existing) vm.subagentList.push(record);
}
function noteToolName(vm, name) { if (typeof name === 'string' && name && !vm.coreTools.includes(name)) vm.coreTools.push(name); }
function toolFor(vm, id, name) {
  let tool = vm.tools.find(x => x.id === id);
  if (!tool) { tool = { id,name:name ?? '도구',arguments:'',result:'',status:'호출 준비 중',order:nextOrder(vm) }; vm.tools.push(tool); }
  if (name) tool.name = name;
  noteToolName(vm,tool.name);
  return tool;
}
function boundedDiff(diff) {
  const text = typeof diff === 'string' ? diff : '';
  return text.length > maxToolDiff ? { diff:text.slice(0,maxToolDiff), truncated:true } : { diff:text, truncated:false };
}
/**
 * Only observed edit details are kept; nothing is synthesised when the core sends no diff.
 * Each entry keeps the creation/existence/deletion/status evidence reported for *that* file,
 * so per-file evidence can outrank the tool name exactly like `engine/session_timeline.py`.
 */
function isRelativePath(p) {
  return !!p && !p.startsWith('/') && !p.startsWith('\\') && !/^[A-Za-z]:/.test(p);
}
function toolFiles(tool, details, argumentPath) {
  const files = [];
  const keep = (result) => {
    const rawResultPath = typeof result.path === 'string' && result.path ? result.path : '';
    const normRes = rawResultPath.replace(/\\/g, '/');
    const normArg = String(argumentPath || '').replace(/^\.\//, '').replace(/\\/g, '/');
    const path = (isRelativePath(normArg) && normRes.toLowerCase().endsWith('/' + normArg.toLowerCase()))
      ? argumentPath
      : (rawResultPath || argumentPath);
    const bounded = boundedDiff(result.diff);
    const status = itemField(result,['isError','is_error','status','result_status']);
    const issue = status === undefined ? null : statusIssue(status);
    files.push({
      path:path || '경로 미상',
      diff:bounded.diff,
      op:typeof result.op === 'string' ? result.op : null,
      truncated:bounded.truncated,
      created:itemFlag(result,['created','created_new','createdNew','is_new','isNew','new_file','newFile']),
      existedBefore:itemFlag(result,['existed_before','existedBefore','existed']),
      deleted:itemFlag(result,['deleted','removed','is_deleted','isDeleted']),
      isError:issue === null ? null : issue === 'failed',
      statusIssue:issue
    });
  };
  if (Array.isArray(details.perFileResults)) {
    for (const result of details.perFileResults) {
      if (!result || typeof result !== 'object') continue;
      keep(result);
    }
    return files;
  }
  if (typeof details.diff === 'string' && details.diff) keep(details);
  return files;
}
/** The per-file change records one tool result reported, for readers that are not the transcript. */
export function changeFiles(details, argumentPath = '') { return toolFiles(null, details, argumentPath); }
function argsObject(tool) {
  try { const args = JSON.parse(tool.arguments); return args && typeof args === 'object' ? args : {}; } catch { return {}; }
}
function argumentPath(tool) {
  const args = argsObject(tool);
  return typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : '';
}
/** Same nesting the bridge uses for tool details: a field may live at any of these depths. */
const evidenceScopes = [[],['details'],['result'],['result','details'],['args'],['meta'],['data'],['payload'],['payload','details']];
function scopedField(raw, names) {
  for (const scope of evidenceScopes) {
    let container = raw, ok = true;
    for (const key of scope) {
      if (!container || typeof container !== 'object' || !(key in container)) { ok = false; break; }
      container = container[key];
    }
    if (!ok || !container || typeof container !== 'object') continue;
    for (const name of names) if (container[name] !== undefined && container[name] !== null) return { value:container[name], field:[...scope, name].filter(Boolean).join('.') };
  }
  return { value:undefined, field:null };
}
/** A per-file result is read flat, the way `engine/session_timeline.py` reads `perFileResults[i]`. */
function itemField(item, names) {
  if (!item || typeof item !== 'object') return undefined;
  for (const name of names) if (item[name] !== undefined && item[name] !== null) return item[name];
  return undefined;
}
function itemFlag(item, names) {
  const value = itemField(item,names);
  return value === undefined ? null : evidenceFlag(value);
}
/** Explicit true/false only; a value that does not say is left null instead of guessed. */
function evidenceFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (['true','yes','y','new','created','create','added','add'].includes(text)) return true;
  if (['false','no','n','existing','modified','edit','edit_file'].includes(text)) return false;
  return null;
}
const statusFailureWords = ['error','failed','failure','denied','rejected','refused','cancelled','canceled','aborted','timeout','blocked'];
const statusPendingWords = ['running','pending','in_progress','inprogress','in_flight','started','start','queued','waiting','streaming'];
/** Engine parity: booleans fail when true, HTTP-style codes when not 2xx, exit codes when non-zero. */
function statusFailure(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value >= 100 ? !(value >= 200 && value < 300) : value !== 0;
  return typeof value === 'string' && statusFailureWords.includes(value.trim().toLowerCase());
}
function statusPending(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return false;
  return typeof value === 'string' && statusPendingWords.includes(value.trim().toLowerCase().replace(/[\s-]+/g,'_'));
}
/** `null` when the reported status says nothing about completion. */
function statusIssue(value) {
  if (value === undefined || value === null) return null;
  if (statusPending(value)) return 'in_progress';
  if (statusFailure(value)) return 'failed';
  return null;
}
/**
 * Creation/existence/deletion evidence a tool frame actually reported. Nothing is
 * inferred: `null` means the frame was silent about that field. `command` carries the
 * `str_replace_editor`-style create/edit selector, which only create-capable tools use.
 * @returns {ChangeEvidence}
 */
export function changeEvidence(raw) {
  const created = scopedField(raw,['created','created_new','createdNew','is_new','isNew','new_file','newFile']);
  const existed = scopedField(raw,['existed_before','existedBefore','existed']);
  const deleted = scopedField(raw,['deleted','removed','is_deleted','isDeleted']);
  const op = scopedField(raw,['op','operation','action','change_type','changeType']);
  const command = scopedField(raw,['command']);
  const status = scopedField(raw,['isError','is_error','status','result_status']);
  const target = scopedField(raw,['target','path','file_path','filePath','file','identifier','target_id','targetId']);
  const opText = typeof op.value === 'string' ? op.value.trim().toLowerCase().replace(/[\s-]+/g,'_') : '';
  const commandText = typeof command.value === 'string' ? command.value.trim().toLowerCase().replace(/[\s-]+/g,'_') : '';
  return {
    created:evidenceFlag(created.value),
    existedBefore:evidenceFlag(existed.value),
    deleted:evidenceFlag(deleted.value),
    op:opText || null,
    opField:opText ? op.field : null,
    command:commandText || null,
    statusIssue:statusIssue(status.value),
    target:typeof target.value === 'string' ? target.value : ''
  };
}
/**
 * A phrasing the bridge forwards from the local aux model (engine `PhrasedTimeline.to_dict()`).
 * Only a `local` provider with a model id is kept; anything else stays structural.
 * @returns {TimelinePhrasing|null}
 */
export function timelinePhrasing(raw) {
  const data = raw && typeof raw === 'object' && raw.provenance ? raw : null;
  if (!data) return null;
  const provenance = data.provenance;
  if (provenance.source !== 'model' || provenance.provider !== 'local') return null;
  if (typeof provenance.model_id !== 'string' || !provenance.model_id.trim()) return null;
  const sentences = Array.isArray(data.sentences) ? data.sentences.filter(x => typeof x === 'string' && x.trim()) : [];
  const summary = typeof data.summary === 'string' ? data.summary : '';
  if (!sentences.length || !summary.trim()) return null;
  return { source:'model', modelId:provenance.model_id, summary, sentences, role:typeof provenance.role === 'string' ? provenance.role : '', roleNote:typeof provenance.role_note === 'string' ? provenance.role_note : null };
}
function thinkingTodoPhases(value) {
  if (!Array.isArray(value)) return null;
  return value.filter(phase => phase && typeof phase === 'object' && typeof phase.name === 'string').map(phase => ({
    name:phase.name,
    tasks:(Array.isArray(phase.tasks) ? phase.tasks : []).filter(task => task && typeof task === 'object' && typeof task.content === 'string').map(task => ({
      content:task.content,
      status:typeof task.status === 'string' ? task.status : 'unknown',
      ...(typeof task.blocker === 'string' ? { blocker:task.blocker } : {})
    }))
  }));
}
export function thinkingCommand(level) { return command('set_thinking_level',{ level }); }
export function availableThinkingCommand() { return command('get_available_thinking_levels'); }
export function subagentsCommand() { return command('get_subagents'); }
export function statsCommand() { return command('get_session_stats'); }
/** Context usage as reported by get_state / get_session_stats; never invented when absent. */
export function reportedContext(state) {
  const usage = state?.contextUsage;
  if (!usage || typeof usage !== 'object') return null;
  const tokens = Number(usage.tokens), window = Number(usage.contextWindow), percent = Number(usage.percent);
  if (!Number.isFinite(tokens) || tokens < 0) return null;
  return { tokens, window:Number.isFinite(window) && window > 0 ? window : null, percent:Number.isFinite(percent) ? percent : null };
}
/** Marks the level pending until a correlated set_thinking_level response arrives. */
export function beginThinkingSwitch(vm, level) {
  vm.thinking.pending = null; vm.thinking.failure = null;
  if (typeof level !== 'string' || !level) return null;
  const cmd = thinkingCommand(level);
  vm.thinking.pending = { id:cmd.id, level };
  return cmd;
}
/** Correlated only: an unrelated response can never confirm a reasoning grade. */
export function thinkingSwitchSettled(vm, frame) {
  const pending = vm.thinking.pending;
  if (!pending || frame?.type !== 'response' || frame.command !== 'set_thinking_level' || frame.id !== pending.id) return false;
  vm.thinking.pending = null;
  if (frame.success === true) { vm.thinking.level = pending.level; vm.thinking.confirmed = pending.level; vm.thinking.failure = null; return true; }
  const reason = typeof frame.error === 'string' && frame.error ? frame.error : '코어가 추론 등급 변경을 거절했습니다.';
  vm.thinking.confirmed = null; vm.thinking.failure = reason;
  recordError(vm,'thinking_switch_failed',reason);
  return true;
}
/** Stable machine code for the same conditions sendBlockReason describes; the UI localises it. */
export function promptBlockCode(vm, route, { ready = true } = {}) {
  if (!ready) return 'not_ready';
  if (vm.sessionFailed) return 'session_failed';
  if (vm.route.pending) return 'model_pending';
  if (vm.route.failure) return 'model_failed';
  if (!route || !routeKey(route)) return 'no_model';
  if (vm.route.selected === 'cloud' && !vm.route.consent) return 'consent';
  if (vm.route.confirmed !== routeKey(route)) return 'unconfirmed';
  if (vm.coreModel && vm.coreModel !== routeKey(route)) return 'model_mismatch';
  if (vm.approvals.length) return 'approvals';
  return null;
}
/** Why sending is blocked right now; null means the composer may send. */
export function sendBlockReason(vm, route, { ready = true } = {}) {
  if (!ready) return '코어 연결을 기다리는 중입니다.';
  if (vm.sessionFailed) return '이 세션은 실패 상태입니다. 새 세션을 시작하세요.';
  if (vm.route.pending) return '모델 전환 응답을 기다리는 중입니다.';
  if (vm.route.failure) return `모델 전환 실패: ${vm.route.failure}`;
  if (!route || !routeKey(route)) return '선택한 경로에 모델이 설정되지 않았습니다.';
  if (vm.route.selected === 'cloud' && !vm.route.consent) return '클라우드 전송 동의가 필요합니다.';
  if (vm.route.confirmed !== routeKey(route)) return '모델 전환 확인 전에는 보낼 수 없습니다.';
  if (vm.coreModel && vm.coreModel !== routeKey(route)) return `코어 활성 모델(${vm.coreModel})과 선택한 경로가 다릅니다.`;
  if (vm.approvals.length) return '승인 대기 중에는 새 요청을 보낼 수 없습니다.';
  return null;
}
/** @param {ViewModel} vm @param {any} frame @returns {ViewModel} */
export function applyFrame(vm, frame) {
  const type = frameType(frame);
  if (type === 'bridge_connected') { vm.phase = '코어 준비 중'; if (typeof frame.sessionId === 'string' && frame.sessionId) vm.sessionId = frame.sessionId; }
  if (type === 'bridge_error') {
    recordError(vm,frame.code,frame.message); vm.route.confirmed = null; vm.route.pending = null; vm.phase = '작업 중단';
    if (terminalErrorCode(frame.code)) { vm.sessionFailed = true; vm.terminalError = { code:frame.code, message:frame.message }; }
    else if (frame.code === 'not_ready') { vm.sessionFailed = true; vm.terminalError = { code:frame.code, message:frame.message }; }
    return vm;
  }
  if (type === 'bridge_ready') { vm.phase = '입력 대기'; vm.route.confirmed = null; vm.route.pending = null; vm.route.failure = null; vm.sessionFailed = false; vm.terminalError = null; }
  if (type === 'agent_start' || type === 'turn_start') vm.phase = '답변 작성 중';
  if (type === 'turn_end') vm.phase = '턴 완료';
  if (type === 'agent_end') vm.phase = '에이전트 작업 완료';
  if (type === 'session_settled') vm.phase = '입력 대기';
  if (type === 'message_start' || type === 'message_update' || type === 'message_end') {
    const event = frame.assistantMessageEvent;
    const raw = frame.message ?? event?.partial;
    const role = raw?.role ?? (event ? 'assistant' : null);
    if (role === 'user' || role === 'assistant') {
      let existing = type === 'message_start' ? null : vm.messages.find(x => x.id === vm.activeMessage && x.role === role);
      if (type === 'message_start' && role === 'user') existing = vm.messages.find(x => x.role === 'user' && x.pending && x.text === textContent(raw?.content));
      if (!existing) { existing = { id:String(raw?.id ?? `message-${++vm.nextMessage}`),role,text:'',blocks:{},order:nextOrder(vm) }; vm.messages.push(existing); }
      existing.order ??= nextOrder(vm);
      existing.pending = false; vm.activeMessage = existing.id;
      const content = raw?.content;
      if (typeof content === 'string' || Array.isArray(content)) {
        existing.text = textContent(content);
        existing.blocks = {};
        if (Array.isArray(content)) content.forEach((block,index) => { if (block.type === 'text') existing.blocks[index] = block.text ?? ''; });
        else existing.blocks[0] = content;
      } else if (event?.type === 'text_start') existing.blocks[event.contentIndex] = '';
      else if (event?.type === 'text_delta') { existing.blocks[event.contentIndex] = (existing.blocks[event.contentIndex] ?? '') + (event.delta ?? ''); existing.text = Object.keys(existing.blocks).map(Number).sort((a,b) => a-b).map(i => existing.blocks[i]).join(''); }
      else if (event?.type === 'text_end' && typeof event.content === 'string') { existing.blocks[event.contentIndex] = event.content; existing.text = Object.values(existing.blocks).join(''); }
      if (event?.type?.startsWith('toolcall_')) {
        vm.phase = '도구 호출 준비 중';
        const call = event.partial?.content?.[event.contentIndex];
        if (call?.type === 'toolCall' && call.id) { const tool = toolFor(vm,String(call.id),call.name); tool.arguments = summary(call.arguments); }
      }
      if (raw?.stopReason === 'error') recordError(vm,'core_error',raw.errorMessage ?? '코어가 답변을 완료하지 못했습니다.');
      if (raw?.stopReason === 'refusal') vm.phase = '요청 거절';
      if (type === 'message_end') { noteUsage(vm,raw); vm.activeMessage = null; }
    }
  }
  if (['tool_execution_start','tool_execution_update','tool_execution_end'].includes(type)) {
    const tool = toolFor(vm,String(frame.toolCallId),frame.toolName);
    if (type === 'tool_execution_start') { vm.phase = '도구 실행 중'; tool.arguments = summary(frame.args); tool.status = '실행 중'; }
    else { tool.result = textContent((frame.result ?? frame.partialResult)?.content) || summary(frame.result ?? frame.partialResult); }
    if (tool.seenAt === undefined) tool.seenAt = Date.now();
    // Tool arguments only arrive on the start frame; the evidence contract reads `args.command`
    // for `str_replace_editor`-style create selectors and `args.path` for the target, so the
    // stored arguments are carried into a frame that omits them.
    if (!tool.evidence || type === 'tool_execution_end') tool.evidence = changeEvidence(frame.args === undefined ? { ...frame, args:argsObject(tool) } : frame);
    if (type === 'tool_execution_end') {
      tool.isError = !!frame.isError; tool.status = frame.isError ? '실패' : '완료';
      const details = frame.result?.details;
      if (details && typeof details === 'object') tool.files = toolFiles(tool,details,argumentPath(tool));
    }
  }
  if (type === 'extension_ui_request') {
    if (frame.method === 'setWidget') {
      if (Array.isArray(frame.widgetLines)) vm.widgets[frame.widgetKey] = frame.widgetLines.map(String);
      else delete vm.widgets[frame.widgetKey];
    } else if (frame.method === 'cancel') vm.approvals = vm.approvals.filter(x => x.id !== frame.targetId);
    else if (frame.method === 'notify') vm.notices.push(String(frame.message));
    else if (supportedApproval(frame)) {
      vm.approvals.push({ id:String(frame.id),method:frame.method,title:frame.title ?? '코어 승인 요청',message:frame.message ?? frame.placeholder ?? '',options:Array.isArray(frame.options) ? frame.options.filter(x => typeof x === 'string') : [],value:frame.prefill ?? '' }); vm.phase = '승인 대기';
    } else vm.notices.push(`지원하지 않는 코어 UI 요청: ${frame.method}. 자동 승인하거나 실행하지 않았습니다.`);
  }
  if (type === 'available_commands_update') vm.commands = Array.isArray(frame.commands) ? frame.commands : [];
  // A phrased timeline is an optional relay from the bridge; unusable payloads leave the structural text alone.
  if (type === 'session_timeline') { const phrasing = timelinePhrasing(frame.data ?? frame); if (phrasing) vm.timelinePhrasing = phrasing; }
  // The gateway's selection is read back by the bridge, so it belongs to this session
  // only. A payload without a model id is the same answer as none: stay on 자동.
  if (type === 'selection') vm.selection = gatewaySelection(frame.selection ?? frame.data);
  if (type?.startsWith('subagent_')) vm.background = frame.payload?.status ? `백그라운드 작업: ${frame.payload.status}` : '백그라운드 작업 이벤트 수신';
  if (type === 'response') {
    const switchSettled = frame.command === 'set_model' && modelSwitchSettled(vm,frame);
    const thinkingSettled = frame.command === 'set_thinking_level' && thinkingSwitchSettled(vm,frame);
    if (frame.command === 'set_model' && !switchSettled && frame.success === false && !vm.route.pending) {
      const reason = typeof frame.error === 'string' && frame.error ? frame.error : '코어가 모델 전환을 거절했습니다.';
      vm.route.confirmed = null; vm.route.failure = reason; recordError(vm,'model_switch_failed',reason); vm.phase = '모델 전환 실패';
    } else if (frame.command === 'set_thinking_level' && !thinkingSettled && frame.success === false && !vm.thinking.pending) {
      const reason = typeof frame.error === 'string' && frame.error ? frame.error : '코어가 추론 등급 변경을 거절했습니다.';
      vm.thinking.confirmed = null; vm.thinking.failure = reason; recordError(vm,'thinking_switch_failed',reason);
    } else if (frame.success === false && !switchSettled && !thinkingSettled && optionalCommands.includes(frame.command)) {
      capabilityMissing(vm,frame.command);
    } else if (frame.success === false && !switchSettled && !thinkingSettled) { recordError(vm,frame.command === 'parse' ? 'parse_error' : 'command_refused',String(frame.error)); vm.phase = '요청 거절'; }
    else if (frame.command === 'get_available_thinking_levels' && frame.success === true) {
      const levels = Array.isArray(frame.data?.levels) ? frame.data.levels.filter(x => typeof x === 'string') : [];
      vm.thinking.available = levels;
    } else if (frame.command === 'get_subagents' && frame.success === true) {
      const list = Array.isArray(frame.data?.subagents) ? frame.data.subagents : [];
      vm.subagents = { known:true, count:list.length };
      vm.subagentList = [];
      list.forEach((entry,index) => noteSubagent(vm,entry,index));
    } else if (frame.command === 'get_session_stats' && frame.success === true && frame.data) {
      const tokens = Number(frame.data.tokens?.total);
      const cost = Number(frame.data.cost);
      vm.stats = {
        tokens:Number.isFinite(tokens) ? tokens : 0,
        cost:Number.isFinite(cost) ? cost : null,
        received:true,
        cacheRead:Number.isFinite(Number(frame.data.tokens?.cacheRead ?? frame.data.tokens?.cached)) ? Number(frame.data.tokens?.cacheRead ?? frame.data.tokens?.cached) : null,
        prompt:Number.isFinite(Number(frame.data.tokens?.prompt)) ? Number(frame.data.tokens?.prompt) : null
      };
      const context = reportedContext(frame.data);
      if (context) vm.context = context;
    } else if (frame.command === 'get_state' && frame.data) {
      const state = frame.data;
      if (state.model) {
        vm.coreModel = `${state.model.provider ?? ''}/${state.model.id ?? ''}`;
        if (!vm.route.pending && vm.route.confirmed && vm.coreModel !== vm.route.confirmed) {
          const expected = vm.route.confirmed;
          vm.route.confirmed = null;
          vm.route.failure = `코어 활성 모델(${vm.coreModel})이 확인된 경로(${expected})와 일치하지 않습니다.`;
          recordError(vm,'model_switch_failed',vm.route.failure);
          vm.phase = '모델 전환 실패';
        }
      }
      if (typeof state.thinkingLevel === 'string' && state.thinkingLevel) {
        vm.thinking.reported = state.thinkingLevel;
        if (!vm.thinking.pending && !vm.thinking.failure) { vm.thinking.level = state.thinkingLevel; vm.thinking.confirmed = state.thinkingLevel; }
      }
      const phases = thinkingTodoPhases(state.todoPhases);
      if (phases) { vm.todos = phases; vm.sawTodos = true; }
      const context = reportedContext(state);
      if (context) vm.context = context;
      if (Array.isArray(state.dumpTools)) vm.coreTools = state.dumpTools.map(x => typeof x?.name === 'string' ? x.name : '').filter(Boolean);
      if (typeof state.sessionId === 'string' && state.sessionId) vm.sessionId = state.sessionId;
      if (state.isCompacting) vm.phase = '대화 압축 중'; else if (state.isStreaming) vm.phase = '답변 작성 중';
      // systemPrompt/dumpTools and non-rendered state fields are deliberately not retained.
    } else if (frame.command === 'session_timeline' && frame.success === true) {
      const phrasing = timelinePhrasing(frame.data);
      if (phrasing) vm.timelinePhrasing = phrasing;
    }
  }
  if (type === 'subagent_lifecycle' && frame.payload) {
    const status = frame.payload.status;
    vm.background = `${frame.payload.agent ?? '서브에이전트'} · ${status === 'started' ? '시작' : status === 'completed' ? '완료' : status === 'failed' ? '실패' : '중단'}`;
    noteSubagent(vm,{ ...frame.payload,status },vm.subagentList.length);
    if (vm.subagents.known) vm.subagents.count = status === 'started' ? (vm.subagents.count ?? 0) + 1 : Math.max(0,(vm.subagents.count ?? 1) - 1);
  }
  if (type === 'extension_error' || type === 'rpc_frame_error') recordError(vm,type,summary(frame.error ?? frame.message));
  if (type === 'privacy.masked' || type === 'privacy.blocked') {
    const record = privacyRecord(frame,nextOrder(vm),vm.messages.filter(x => x.role === 'user').length);
    if (record) (vm.privacy ??= []).push(record);
  }
  if (type === 'prompt_result') {
    if (frame.usage) noteUsage(vm,frame);
    vm.promptStatus = frame.status;
    if (frame.status === 'error') { recordError(vm,'prompt_failed',frame.error?.message ?? summary(frame.error)); vm.phase = '요청 실패'; }
    else if (frame.status === 'aborted') vm.phase = '요청 중단';
    else vm.phase = frame.sessionSettled ? '입력 대기' : '백그라운드 작업 대기';
  }
  return vm;
}

/* ------------------------------------------------- display decisions (pure) */

/** The prompt the page just sent, placed in transcript order at send time so the answer can never sort above it. */
export function addPendingPrompt(vm, text) {
  const message = { id:crypto.randomUUID(), role:'user', text, blocks:{}, pending:true, order:nextOrder(vm) };
  vm.messages.push(message);
  return message;
}

/** Messages, tool cards and privacy lines in arrival order; an entry's position never changes between renders. */
export function transcriptEntries(vm, query = '') {
  const q = query.trim().toLowerCase();
  for (const message of vm.messages) message.order ??= nextOrder(vm);
  const messages = vm.messages.filter(x => !q || x.text.toLowerCase().includes(q));
  const tools = vm.tools.filter(x => !q || `${x.name} ${x.arguments} ${x.result}`.toLowerCase().includes(q));
  const privacy = q ? [] : (vm.privacy ?? []);
  return [
    ...messages.map(message => ({ order:message.order, message })),
    ...tools.map(tool => ({ order:tool.order, tool })),
    ...privacy.map(record => ({ order:record.order, privacy:record }))
  ].sort((a,b) => a.order - b.order);
}

/**
 * One token figure for the whole page: the usage the core attached to finished
 * messages, else the core's own stats reply when it carries a real total, else null.
 * A stats reply fetched before the first turn reads 0 and must not mask live usage.
 */
export function sessionTokens(vm) {
  if (vm?.usage?.seen) return vm.usage.tokens;
  if (vm?.stats?.received && vm.stats.tokens > 0) return vm.stats.tokens;
  return null;
}
export function sessionCost(vm) {
  if (Number.isFinite(vm?.stats?.cost) && vm.stats.cost > 0) return vm.stats.cost;
  return vm?.usage?.seen ? vm.usage.cost : null;
}

export const UNPRICED_REMOTE = '비용 미집계(원격 워커 과금 미노출)';
/** A zero is only shown as "no charge" for a local run; a remote turn whose worker billing is hidden is unpriced, not free. */
export function costLabel(cost, { remote = false } = {}) {
  if (Number.isFinite(cost) && cost > 0) return `$${cost.toFixed(3)}`;
  if (remote) return UNPRICED_REMOTE;
  return Number.isFinite(cost) ? '로컬 실행 · 과금 없음' : '비용 미보고';
}

/** Which side picked the model, in Korean; null when the gateway did not say. */
export function decisionLabel(selection) {
  if (selection?.decisionSource === 'remote_decision') return '원격 결정 모델';
  if (selection?.decisionSource === 'local_fallback') return '로컬 대체 경로';
  if (selection?.decisionSource === 'local' && selection.decisionReason === 'no_decision_model_available') return '원격 결정 건너뜀';
  return null;
}
/**
 * The model this session is answered by: the gateway's selection when it reported one,
 * else what the core reports as its active model. The core's endpoint alias is kept as
 * `endpoint` so it can be explained, never shown as a second model name.
 */
export function resolvedModel(vm) {
  const selection = vm?.selection;
  if (selection?.modelId) return { id:selection.modelId, source:decisionLabel(selection) ?? '게이트웨이 선택', endpoint:vm.coreModel ?? null };
  if (vm?.coreModel) return { id:vm.coreModel, source:'코어 보고', endpoint:null };
  return null;
}

/** The one header state: a connection problem wins, then pending answers, failure, work in progress, a finished turn, idle. */
export function sessionStatus({ problem = null, approvals = 0, failed = false, blocked = false, busy = false, stage = '', completed = false } = {}) {
  if (problem) return problem;
  if (approvals) return { state:'busy', text:'답변 기다리는 중' };
  if (failed) return { state:'error', text:'작업 실패' };
  if (busy) return { state:'busy', text:stage || '작업 중' };
  if (blocked) return { state:'checking', text:'보낼 준비 중' };
  if (completed) return { state:'ready', text:'완료' };
  return { state:'ready', text:'준비됨' };
}

/** One verification sentence from recorded outcomes; null when no verification ran. */
export function verifyStatement({ runs = 0, passed = 0, failed = 0 } = {}) {
  if (!runs) return null;
  const unknown = Math.max(0,runs - passed - failed);
  const parts = [];
  if (passed) parts.push(`통과 ${passed}`);
  if (failed) parts.push(`실패 ${failed}`);
  if (unknown) parts.push(passed || failed ? `결과 미수집 ${unknown}` : '결과 미수집(출력에서 통과/실패를 읽지 못함)');
  return { state:failed ? 'failed' : unknown ? 'unknown' : 'passed', text:`검증 ${runs}회 실행 · ${parts.join(' · ')}` };
}

/** Korean names for the privacy rule ids; an id outside this list is shown as a generic type, never echoed. */
export const PRIVACY_RULE_LABELS = Object.freeze({
  korean_rrn:'주민등록번호', korean_arn:'외국인등록번호', korean_brn:'사업자등록번호', credit_card_luhn:'카드번호',
  email_address:'이메일', ipv4_address:'IP 주소', phone_number:'전화번호', account_digit_run:'계좌번호',
  korean_name:'이름', korean_address:'주소', private_key_pem:'개인 키', private_key_openssh:'SSH 키',
  provider_key:'API 키', jwt_token:'JWT 토큰', auth_header:'인증 헤더', db_uri:'DB 접속 정보',
  generic_secret:'비밀 값', private_network_ip:'내부 IP', internal_hostname:'내부 호스트명',
  env_file_body:'.env 내용', confidential_marker:'기밀 표시'
});
const RULE_ID = /^[a-z0-9_]{1,40}$/;
// A structural path only (`messages[0].content`): identifier segments and small indexes, so a value cannot pass as a path.
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]{0,40}(?:\[\d{1,4}\]|\.[A-Za-z_][A-Za-z0-9_]{0,40}){0,12}$/;
/**
 * Copy only the published contract out of a privacy event — rule ids, counts, field
 * paths, the 8-hex fingerprint, code and the sent decision — so no original value can
 * ride along into the page, a tooltip, the copy buffer or an exported report.
 */
export function privacyRecord(frame, order, turn) {
  const type = frameType(frame);
  if (type !== 'privacy.masked' && type !== 'privacy.blocked') return null;
  const data = frame.data && typeof frame.data === 'object' ? frame.data : {};
  const rules = (Array.isArray(data.rules) ? data.rules : []).filter(x => typeof x === 'string' && RULE_ID.test(x));
  const counts = {};
  for (const rule of rules) { const n = Number(data.counts?.[rule]); counts[rule] = Number.isInteger(n) && n > 0 ? n : 1; }
  const fields = (Array.isArray(data.fields) ? data.fields : []).filter(x => typeof x === 'string' && FIELD_PATH.test(x));
  const fingerprint = typeof data.fingerprint === 'string' && /^[0-9a-f]{8}$/.test(data.fingerprint) ? data.fingerprint : null;
  const code = typeof data.code === 'string' && RULE_ID.test(data.code) ? data.code : null;
  const blocked = type === 'privacy.blocked';
  const action = !blocked ? 'masked' : code === 'privacy_guard_unverifiable_high_risk' ? 'review' : 'blocked';
  return { kind:'privacy', action, sent:!blocked, rules, counts, fields, fingerprint, code, order, turn };
}
const PRIVACY_ACTIONS = { masked:'가명화', blocked:'차단', review:'확인 필요' };
/** The compact per-turn line and its tooltip; built from ids and counts only. */
export function privacyLine(record) {
  const types = record.rules.map(rule => `${PRIVACY_RULE_LABELS[rule] ?? '민감 정보'} ${record.counts[rule]}건`);
  const text = `개인정보 보호 · ${types.length ? types.join(', ') : '민감 정보'} · ${PRIVACY_ACTIONS[record.action]} · ${record.sent ? '요청 전송됨' : '요청 보내지 않음'}`;
  const title = [
    `규칙 ${record.rules.join(', ') || '미보고'}`,
    record.fields.length ? `필드 ${record.fields.join(', ')}` : null,
    record.fingerprint ? `지문 ${record.fingerprint}` : null,
    '원래 값은 이 화면에 오지 않습니다.'
  ].filter(Boolean).join(' · ');
  return { text, title };
}

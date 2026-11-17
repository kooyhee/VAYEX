import { createViewModel, applyFrame, promptCommand, command, approvalCommand, approvalLabel, approvalChoices, defaultApprovalValue, approvalIsGlobal, approvalActionText, approvalReasonText, pendingApprovalTool, approvalPreview, resetRoute, setConsent, nextOrder, subagentsCommand, statsCommand, thinkingLabel, assistantNote, addPendingPrompt, transcriptEntries, transcriptSegments, sessionTokens, sessionCost, costLabel, decisionLabel, resolvedModel, sessionStatus, verifyStatement, privacyLine } from './protocol.js';
import { createActivity, ingestFrame, markPrompt, markApprovalAnswered, timelineRows as actTimelineRows, eventDetail as actEventDetail, taskSummary as actTaskSummary, lanes as actLanes, formatElapsed, clock as actClock } from './activity.js';
import { summarizeView, fetchInsight } from './insight.js';
import { renderTaskGraph, renderCostChart, renderMemoryChart, memoryChartData } from './visualize.js';
import { reportFileName } from './session-report.js';

function promptBlockReason(current) {
  if (!current.ready) return '아직 브리지에 연결하는 중입니다.';
  if (current.vm.sessionFailed) return '이 작업은 실패했습니다. 새 작업으로 다시 시작해 주세요.';
  const policy = policyRefusal(current);
  if (policy) return policy.title;
  const gate = routeGate(current);
  if (gate) return gate.title;
  if (current.vm.approvals.length) return '코어가 보낸 요청에 먼저 답해 주세요.';
  return null;
}
const statusLabel = value => ({ completed:'완료', running:'실행 중', parked:'일시 정지', idle:'대기', started:'시작', failed:'실패', error:'오류', aborted:'중단', pending:'대기 중', in_progress:'진행 중', blocked:'막힘', unknown:'미확인' })[value] ?? '미확인';

const NS = 'http://www.w3.org/2000/svg';
const $ = id => document.getElementById(id);
const el = (tag,cls,text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
const icon = name => {
  const svg = document.createElementNS(NS,'svg'); svg.setAttribute('class','ic'); svg.setAttribute('aria-hidden','true');
  const use = document.createElementNS(NS,'use'); use.setAttribute('href',`#${name}`); svg.append(use); return svg;
};
const sessions = new Map();
const drafts = new Map();
const view = { agents:'list', collapsed:new Set(), search:'', recentOpen:true, approvalPick:new Map(), approvalConfirm:new Map() };
let activeKey = null, approvalOwner = null, openMenuNode = null, openMenuAnchor = null;

const bridgeRefusals = {
  consent_required:{ title:'클라우드 전송 동의 필요', message:'이 대화는 클라우드로 나가기 때문에 명시적 동의가 있어야 합니다. 아직 코어 프로세스는 실행하지 않았습니다.' },
  invalid_route:{ title:'유효하지 않은 경로', message:'브리지가 이 경로 값을 인식할 수 없어 local_only로 되돌렸습니다. 아직 코어 프로세스는 실행하지 않았습니다. 지원하는 경로로 다시 연결해 주세요.' }
};
const modelRoute = current => current.route === 'local_only' ? 'local' : 'cloud';
/** A turn priced by nobody on this page: off-device, or picked by the remote decision model. */
const remoteTurn = current => !!current && (modelRoute(current) === 'cloud' || current.vm.selection?.decisionSource === 'remote_decision');
const ROUTES = ['local_only','zdr_cloud','any_cloud'];
// The default route is read from the bridge config (`/api/config`); until read, falls back to null.
let defaultRoute = null;
// Off until the operator flips the visible consent toggle. A new session inherits the
// operator's standing choice, which is still that toggle's state, never a constant.
let operatorConsent = false;
function refusalFor(current) {
  if (!current || current.vm.error?.code === 'transport_closed') return null;
  // Only two things end a session here: a terminal bridge refusal, and an unreadable route.
  if (current.refusal) return current.refusal;
  if (current.config?.route?.invalid != null) return { code:'invalid_route', ...bridgeRefusals.invalid_route };
  return null;
}
/**
 * Why this session cannot send yet, in the operator's own terms, before any prompt
 * leaves the page: consent not granted for an off-device model, or a route whose
 * upstream the bridge reports as not served right now. Never a hard failure.
 */
function routeGate(current) {
  if (!current || current.vm.error?.code === 'transport_closed' || refusalFor(current)) return null;
  if (!current.ready) return null;
  if (current.route !== 'local_only' && !current.consent) return { state:'consent', title:'외부 모델 사용에 동의해야 전송됩니다', message:'상단의 클라우드 동의 스위치를 켜면 이 경로로 보낼 수 있습니다.' };
  const chosen = current.config?.routes?.[current.route];
  if (chosen?.served === false) return { state:'unserved', title:chosen.reason || '선택한 경로를 처리할 업스트림이 없습니다', message:'부스 운영자가 경로를 바꾸면 바로 보낼 수 있습니다.' };
  const report = current.config?.route;
  if (report?.served === false) return { state:'unserved', title:report.servedReason || '선택한 경로를 처리할 업스트림이 없습니다', message:'부스 운영자가 경로를 바꾸면 바로 보낼 수 있습니다.' };
  const slot = current.route === 'local_only' ? current.config?.local : current.config?.cloud;
  if (slot?.available === false) return { state:'unserved', title:current.route === 'local_only' ? '로컬 모델이 실행 중이 아닙니다' : '모델을 쓸 수 없습니다', message:slot.reason || '고른 엔드포인트에 연결하지 못했습니다.' };
  return null;
}
/**
 * Consent held back on a cloud route while the local fallback cannot serve either:
 * the bridge's reconciliation, not a broken endpoint. Shown as a refusal.
 */
function policyRefusal(current) {
  if (!current || current.vm.error?.code === 'transport_closed' || refusalFor(current)) return null;
  if (!current.ready || current.route === 'local_only' || current.consent) return null;
  const local = current.config?.local;
  if (local?.available !== false) return null;
  return { code:'consent_policy', title:'클라우드 전송 동의 필요', message:local.reason || '이 경로는 동의 없이 보낼 수 없고 로컬 대체 모델도 실행 중이 아닙니다.' };
}
/** The bridge reports the chosen route as unserved upstream: an outage, not a policy answer. */
function routeProblem(current) {
  if (!current || current.vm.error || current.refusal || policyRefusal(current) || !current.ready) return null;
  const report = current.config?.route;
  const slot = current.route === 'local_only' ? current.config?.local : current.config?.cloud;
  const reason = report?.served === false ? report.servedReason || slot?.reason : slot?.available === false ? slot?.reason : null;
  if (!reason) return null;
  return { title:current.route === 'local_only' ? '로컬 모델이 실행 중이 아닙니다' : '모델을 쓸 수 없습니다', message:reason };
}

const fmtK = value => {
  if (value >= 100000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
};
const fmtSeconds = ms => `${(ms / 1000).toFixed(1)}s`;
const relative = time => {
  const seconds = Math.max(0,Math.round((Date.now() - time) / 1000));
  if (seconds < 45) return '방금';
  if (seconds < 3600) return `${Math.round(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}시간 전`;
  return `${Math.round(seconds / 86400)}일 전`;
};

function session() { return sessions.get(activeKey) ?? null; }
function realFiles(vm) {
  return vm.tools.flatMap(tool => (tool.files ?? []).map((file,index) => ({ ...file, tool:tool.name, changeKey:JSON.stringify([tool.id,file.path,index]) })));
}
function diffTotals(file) {
  let added = 0, removed = 0;
  for (const line of (file.diff || '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}
/**
 * The bridge's file ledger for this session, read from tool results. It is the journal's
 * evidence when the activity stream carries no write row of its own: every path, category
 * and line count here comes from what the tool reported, and an unreported count stays null.
 */
function reportedChanges(vm) {
  const merged = new Map();
  for (const file of realFiles(vm ?? createViewModel())) {
    if (!file.path || file.isError === true || file.statusIssue === 'failed') continue;
    const op = file.deleted === true ? '삭제' : file.created === true || file.existedBefore === false ? '추가' : '수정';
    const key = `${file.path}|${op}`;
    const totals = typeof file.diff === 'string' && file.diff ? diffTotals(file) : null;
    const previous = merged.get(key);
    const added = totals ? totals.added : previous?.added ?? null;
    const removed = totals ? totals.removed : previous?.removed ?? null;
    merged.set(key, { path:String(file.path), op, taskId:'main', added, removed, at:Number.isFinite(file.seenAt) ? file.seenAt : previous?.at ?? null });
  }
  return [...merged.values()];
}
/** One request key per reported work: a new file row or a new activity revision re-asks the model. */
function insightKeyOf(activity, reported) {
  const rows = reported.map(item => `${item.path}|${item.op}|${item.added}|${item.removed}`).join('\n');
  return `${activity.seq}\n${rows}`;
}

/* ------------------------------------------------------------------ sockets */
function routeQuery(current) { return new URLSearchParams({ route:current.route, consent:current.consent ? '1' : '0' }).toString(); }
function wsUrl(query) { return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?${query}`; }
function send(current, frame) {
  if (!current || !current.ready || refusalFor(current) || current.socket?.readyState !== WebSocket.OPEN) return false;
  current.socket.send(JSON.stringify(frame)); return true;
}
function activateSession(current) {
  const previous = session();
  if (previous) previous.composerDraft = $('prompt').value;
  activeKey = current.key;
  approvalOwner = null;
  resetDocLive();
  docGenerated = false;
  docHtml = '';
  docHash = null;
  docSessionKey = null;
  docServerKey = null;
  docServerEntries = [];
  docServerRequest = null;
  $('prompt').value = current.composerDraft;
  if (!($('pane-visualize')?.hidden)) renderDocTab();
}
function newSession() {
  const current = { key:crypto.randomUUID(), bridgeId:null, title:'새 작업', createdAt:Date.now(), vm:createViewModel(), activity:createActivity(), expandedEvents:new Set(), selectedEventKey:null, config:null, connection:null, refusal:null, socket:null, ready:false, route:defaultRoute ?? 'any_cloud', consent:operatorConsent, promptStarted:null, durationMs:null, timelineOpen:true, timelineMode:'journal', composerDraft:'', changeRows:new Map(), insightModel:null, insightFetching:false, insightRev:0, pageWork:0, pageWorkStartedAt:null, titleReqSeq:0, titleFetching:false, titlePromptRequested:false, titleSettledRequested:false, titlePendingRefresh:false, titleResolved:false, titleSettled:false, titleRevision:'', titleTier:null, gateIndex:0, gateShownId:null, gateField:null };
  sessions.set(current.key,current);
  const open = [...sessions.values()].filter(x => x.socket);
  if (open.length > 6) open[0].socket?.close();
  activateSession(current);
  connect(current); render();
  return current;
}
/** A draft belongs to a request that is still pending: pruning reads the live approvals only, so it also
    covers removals that never passed through a frame (abort, session switch), not just the previous snapshot. */
function pruneDrafts(current) {
  const prefix = `${current.key}:`;
  const live = new Set(current.vm.approvals.map(request => request.id));
  for (const key of [...drafts.keys()]) {
    if (!key.startsWith(prefix)) continue;
    if (!live.has(key.slice(prefix.length))) drafts.delete(key);
  }
}
async function connect(current) {
  const connection = { ended:false };
  current.connection = connection;
  current.ready = false;
  const previous = current.socket;
  current.socket = null;
  previous?.close();
  // A replacement core owns fresh authorization, approvals and measured state, not the old core's pending work.
  current.vm = { ...createViewModel(), messages:current.vm.messages, tools:current.vm.tools, privacy:current.vm.privacy, nextOrder:current.vm.nextOrder };
  setConsent(current.vm,current.consent);
  resetRoute(current.vm,modelRoute(current));
  pruneDrafts(current);
  current.bridgeId = null; current.refusal = null; current.config = null;
  current.promptStarted = null; current.durationMs = null;
  const query = routeQuery(current);
  render();
  let config;
  try {
    const response = await fetch(`/api/config?${query}`);
    if (!response.ok) throw new Error('연결 정보를 받지 못했습니다.');
    config = await response.json();
  } catch {
    if (current.connection !== connection) return;
    current.vm.error = { code:'transport_closed',message:'브리지가 보낸 연결 정보를 읽지 못했습니다.' };
    render(); return;
  }
  if (current.connection !== connection) return;
  current.config = config;
  if (ROUTES.includes(config?.defaultRoute)) {
    defaultRoute = config.defaultRoute;
    if (!current.routeManuallySet && current.route !== defaultRoute) {
      current.route = defaultRoute;
    }
  }
  // The bridge's default wins over the provisional constant in `newSession` before
  // the socket opens, so the probe and the session cannot disagree about the route.
  const socket = new WebSocket(wsUrl(routeQuery(current)));
  current.socket = socket;
  const live = () => current.connection === connection && !connection.ended;
  socket.addEventListener('message',event => {
    if (!live()) return;
    let frame; try { frame = JSON.parse(event.data); } catch { current.vm.error = { code:'protocol_mismatch', message:'브리지가 보낸 데이터를 해석하지 못했습니다.' }; render(); return; }
    if (frame.type === 'bridge_error' && bridgeRefusals[frame.code]) {
      current.refusal = { code:frame.code, ...bridgeRefusals[frame.code] };
      frame = { ...frame,message:current.refusal.message };
      connection.ended = true;
      current.ready = false;
      socket.close();
    }
    applyFrame(current.vm,frame);
    if (!current.activity) current.activity = createActivity(current.createdAt);
    ingestFrame(current.activity,frame,{ title:current.title, coreModel:current.vm.coreModel, remote:remoteTurn(current) });
    scheduleDocLive(current);
    pruneDrafts(current);
    if (frame.type === 'bridge_connected' && typeof frame.sessionId === 'string' && frame.sessionId) current.bridgeId = frame.sessionId;
    if (frame.type === 'bridge_ready') {
      current.ready = true;
      send(current,command('get_state'));
      send(current,statsCommand());
      send(current,subagentsCommand());
    }
    if (frame.type === 'bridge_error' && !['invalid_command','not_ready'].includes(frame.code)) current.ready = false;
    if (frame.type === 'prompt_result' && current.promptStarted) current.durationMs = Date.now() - current.promptStarted;
    // The stats reply fetched at ready predates every turn; ask again once a turn ends.
    if (frame.type === 'agent_end' || frame.type === 'prompt_result') send(current,statsCommand());
    const user = current.vm.messages.find(x => x.role === 'user');
    // The header keeps its neutral placeholder until a real title answers: a slice
    // of the prompt is not a title, so it is never shown as one.
    if (user && !current.titlePromptRequested) scheduleAutoTitle(current, { settled:false });
    if (frame.type === 'agent_end' || frame.type === 'prompt_result' || frame.type === 'session_settled') {
      if (user && !current.titleSettledRequested) scheduleAutoTitle(current, { settled:true });
      loadMemoryStatus();
    }
    render();
  });
  socket.addEventListener('close',() => {
    if (!live()) return;
    connection.ended = true;
    current.ready = false; resetRoute(current.vm,modelRoute(current));
    if (!current.vm.error) current.vm.error = { code:'transport_closed', message:'브리지 연결이 끊겼습니다. 서버가 켜져 있는지 확인한 뒤 새 작업으로 다시 시작해 주세요.' };
    render();
  });
  socket.addEventListener('error',() => {
    if (!live()) return;
    current.ready = false;
    current.vm.error = { code:'transport_closed', message:'브리지에 연결하지 못했습니다.' };
    render();
  });
  render();
}

/* --------------------------------------------------------------------- menu */
/** Closing always resets the trigger contract: aria-expanded back to false, focus only on request. */
function closeMenu(options) {
  if (!openMenuNode) return;
  const anchor = openMenuAnchor;
  openMenuNode.remove();
  openMenuNode = null;
  openMenuAnchor = null;
  if (!anchor) return;
  anchor.setAttribute('aria-expanded','false');
  if (options?.restoreFocus) anchor.focus();
}
const menuChoices = box => [...box.querySelectorAll('.menu-item:not([disabled])')];
function stepMenuFocus(box,step) {
  const items = menuChoices(box);
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  const next = index === -1 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
  items[next].focus();
}
function openMenu(anchor,items) {
  closeMenu();
  const box = el('div','menu-pop');
  box.setAttribute('role','menu');
  box.setAttribute('aria-label',anchor.getAttribute('aria-label') ?? '메뉴');
  for (const item of items) {
    const button = el('button','menu-item');
    button.type = 'button';
    button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
    if (item.checked !== undefined) button.setAttribute('aria-checked', String(!!item.checked));
    if (item.swatch) {
      const dot = el('span','menu-swatch');
      dot.style.setProperty('background', item.swatch);
      button.append(dot);
    }
    if (item.hint) {
      const copy = el('span','menu-copy');
      copy.append(el('span','',item.label), el('span','',item.hint));
      button.append(copy);
    } else {
      button.append(el('span','',item.label));
    }
    if (item.checked) {
      const check = icon('ic-check');
      check.classList.add('menu-check');
      button.append(check);
    }
    if (item.disabled) { button.disabled = true; button.title = item.title ?? ''; }
    else button.addEventListener('click', () => { closeMenu(); item.run?.(anchor); });
    box.append(button);
  }
  box.addEventListener('keydown',event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); stepMenuFocus(box,1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); stepMenuFocus(box,-1); }
    else if (event.key === 'Home') { event.preventDefault(); menuChoices(box)[0]?.focus(); }
    else if (event.key === 'End') { event.preventDefault(); menuChoices(box).at(-1)?.focus(); }
    else if (event.key === 'Escape') { event.preventDefault(); closeMenu({ restoreFocus:true }); }
    // Guide `menu`: Tab leaves the menu system. The menu closes and hands focus back to
    // its trigger, and the Tab is left to the browser, so it continues from there into
    // the page instead of being trapped inside a menu that is no longer on screen.
    else if (event.key === 'Tab') { closeMenu({ restoreFocus:true }); }
  });
  document.body.append(box);
  const rect = anchor.getBoundingClientRect();
  box.style.setProperty('position','fixed');
  box.style.setProperty('top',`${Math.round(rect.bottom + 6)}px`);
  box.style.setProperty('right',`${Math.round(Math.max(8,window.innerWidth - rect.right))}px`);
  openMenuNode = box;
  openMenuAnchor = anchor;
  anchor.setAttribute('aria-expanded','true');
  const first = menuChoices(box)[0];
  if (first) first.focus(); else box.setAttribute('tabindex','-1');
  if (!first) box.focus();
  const onPointer = event => { if (!box.contains(event.target) && event.target !== anchor) { closeMenu(); document.removeEventListener('pointerdown',onPointer); } };
  setTimeout(() => document.addEventListener('pointerdown',onPointer),0);
}

/* ------------------------------------------------------------------ render */
function render() {
  renderSessions();
  renderHeader();
  renderThread();
  renderAgents();
  renderTimeline();
  renderApprovals();
  renderInspector();
  renderComposer();
}

function renderSessions() {
  const list = $('recent-list');
  // Every incoming bridge frame calls render(), which rebuilds this list from scratch.
  // A rebuild between a keyboard focus and the activation key replaced the focused row
  // with a new node, so the key landed on <body> and the row never activated — it only
  // showed up when a frame happened to arrive in that window. Focus is part of this
  // list's state: capture which control owns it and give it back to its replacement.
  const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement)
    ? (document.activeElement.dataset.sessionKey ?? 'recent-head') : null;
  list.replaceChildren();
  const group = el('div','recent-group');
  const head = el('button','recent-row');
  head.type = 'button';
  head.dataset.sessionKey = 'recent-head';
  head.setAttribute('aria-expanded',String(view.recentOpen));
  const live = [...sessions.values()].sort((a,b) => b.createdAt - a.createdAt);
  head.append(icon(view.recentOpen ? 'ic-chev-d' : 'ic-chev-r'),el('span','nm','작업 목록'));
  head.title = '작업 목록 접기/펼치기';
  head.addEventListener('click',() => { view.recentOpen = !view.recentOpen; renderSessions(); });
  group.append(head);
  if (view.recentOpen) {
    for (const current of live) {
      const row = el('button','recent-sub');
      row.type = 'button';
      row.dataset.sessionKey = current.key;
      if (current.key === activeKey) row.setAttribute('aria-current','true');
      row.append(el('span','t',current.title),el('span','w',relative(current.createdAt)));
      row.title = `${current.title} · ${current.ready ? '브리지 연결됨' : current.socket ? '연결 중' : '연결 안 됨'}`;
      row.addEventListener('click',() => {
        const left = leaveSidebarDrawer();
        if (current.key !== activeKey) { activateSession(current); render(); }
        if (left) $('prompt').focus();
      });
      group.append(row);
    }
  }
  list.append(group);
  if (!sessions.size) list.append(el('p','recent-empty','아직 작업이 없습니다.'));
  // A session can leave the map between two frames, and then the focused row has no
  // replacement: `?.focus()` no-ops and the keyboard user is dropped onto <body> with
  // no way back into the list. Fall back to the head button, which is always rebuilt.
  if (focused) (list.querySelector(`[data-session-key="${CSS.escape(focused)}"]`) ?? head).focus({ preventScroll:true });
}

function renderHeader() {
  const current = session(), vm = current?.vm;
  $('head-project').textContent = '로컬 하네스';
  $('chip-project').textContent = '로컬 하네스';
  $('project-chip-head').title = '로컬 하네스 작업 공간';
  $('thread-project').title = '로컬 하네스 작업 공간';
  $('head-title').textContent = current?.title ?? '새 작업';
  $('head-title').title = current?.title ?? '새 작업';
  $('session-count').textContent = String(sessions.size);

  const act = current?.activity ? actTaskSummary(current.activity) : null;
  const stageChip = $('head-stage');
  const runChip = $('head-run'), runLabel = $('head-run-label');
  const planChip = $('head-plan'), planLabel = $('head-plan-label');

  const mainState = act?.main?.status ?? (vm?.sessionFailed ? 'failed' : vm?.approvals?.length ? 'waiting' : !current?.ready ? 'waiting' : 'waiting');
  const stageText = act?.main?.stage || vm?.phase || '시작 전';
  stageChip.textContent = stageText;
  stageChip.dataset.state = mainState;
  stageChip.title = `현재 단계: ${stageText}`;

  const runLabelText = act?.main?.state ?? statusLabel(mainState);
  runLabel.textContent = runLabelText;
  runChip.dataset.state = mainState;
  runChip.title = `실행 상태: ${runLabelText}`;

  const selection = vm?.selection;
  if (selection?.planMode) {
    planChip.hidden = false;
    const planText = selection.planMode === 'direct_execute' ? '직접 실행' : selection.planMode;
    const tierText = selection.planTier ? ` · ${selection.planTier}` : '';
    planLabel.textContent = `${planText}${tierText}`;
    planChip.title = `게이트웨이 플랜 모드: ${selection.planMode}${selection.planTier ? ` (티어: ${selection.planTier})` : ''}`;
  } else {
    planChip.hidden = true;
  }

  const pill = $('connection'), label = $('connection-label');
  let state = 'checking', text = '연결 확인 중';
  if (!current) { state = 'error'; text = '작업 없음'; }
  else if (vm?.error?.code === 'transport_closed') { state = 'error'; text = '브리지 응답 없음'; }
  else if (refusalFor(current)) { state = 'refused'; text = refusalFor(current).title; }
  else if (policyRefusal(current)) { state = 'refused'; text = policyRefusal(current).title; }
  else if (routeGate(current)) { state = routeGate(current).state === 'consent' ? 'checking' : 'error'; text = routeGate(current).state === 'consent' ? '동의 필요' : routeGate(current).title; }
  else if (!current.ready) { state = vm?.error ? 'error' : 'checking'; text = vm?.error ? '브리지 오류' : '연결 확인 중'; }
  else {
    const busy = !['입력 대기','턴 완료','에이전트 작업 완료','연결 준비'].includes(vm.phase);
    ({ state, text } = sessionStatus({ approvals:vm.approvals.length, failed:vm.sessionFailed, blocked:!!promptBlockReason(current), busy, stage:act?.main?.stage || vm.phase, completed:act?.main?.status === 'done' }));
  }
  // Sub-chips only while a step is genuinely in flight; once settled the pill alone states the state.
  const showSub = current?.ready && !['입력 대기','턴 완료','에이전트 작업 완료','연결 준비'].includes(vm?.phase ?? '');
  stageChip.hidden = !showSub;
  runChip.hidden = !showSub;
  pill.dataset.state = state;
  label.textContent = text;

  // Header Consent Toggle
  const consentBtn = $('consent-toggle');
  const consentLabel = $('consent-label');
  const consentSub = $('consent-sub');
  const consentNote = $('consent-note');
  if (consentBtn) {
    const isConsent = Boolean(current?.consent);
    consentBtn.setAttribute('aria-pressed', String(isConsent));
    if (consentLabel) consentLabel.textContent = isConsent ? '클라우드 허용' : '클라우드 차단';
    if (consentSub) consentSub.textContent = isConsent ? '클라우드 경로 사용' : '로컬 실행';
    consentBtn.title = isConsent
      ? '클라우드 경로 사용 중. 끄면 로컬 실행으로 돌아갑니다.'
      : '로컬 실행 중. 켜면 클라우드 경로를 사용합니다.';
  }
  if (consentNote) {
    consentNote.dataset.state = current?.consent ? 'cloud' : 'local';
    consentNote.textContent = current?.consent ? '클라우드 활성 · 외부 경로' : '클라우드 차단 · 로컬 실행';
  }
}

const TOOL_RUNNING = new Set(['실행 중', '호출 준비 중']);
/** The one-line bar: count, outcome, and the tool names that ran. */
function toolBatchSummary(tools) {
  const names = [...new Set(tools.map(tool => tool.name || '도구'))].join(', ');
  const errored = tools.filter(tool => tool.isError).length;
  const running = tools.filter(tool => !tool.isError && TOOL_RUNNING.has(tool.status)).length;
  const total = tools.length;
  const suffix = names ? ` · ${names}` : '';
  if (running) return { state:'running', text:`도구 실행 중 · ${names || '도구'} (${total - running}/${total})`, title:`${total - running}/${total}건 완료${errored ? ` · 오류 ${errored}건` : ''}` };
  if (errored) return { state:'error', text:`도구 ${total}건 실행 · 오류 ${errored}건${suffix}`, title:`도구 ${total}건 중 ${errored}건이 오류를 보고했습니다. 펼쳐서 확인하세요.` };
  return { state:'done', text:`도구 ${total}건 실행 완료${suffix}`, title:`도구 ${total}건이 실패 없이 끝났습니다. 펼치면 호출별 인자와 결과를 봅니다.` };
}
/** Individual records stay inspectable: name, status, arguments and result per call. */
function toolBatchBody(tools,notices = []) {
  const body = el('div','tool-batch-body');
  for (const tool of tools) {
    const record = el('div','tool-record');
    record.dataset.error = String(!!tool.isError);
    const head = el('div','tool-record-head');
    head.append(el('span','tool-record-name',tool.name || '도구'),el('span','tool-record-status',tool.status || '상태 미보고'));
    record.append(head,el('p','tool-record-args',`넘긴 값: ${tool.arguments || '없음'}`),el('pre','tool-record-result',tool.result || '결과를 기다리는 중입니다'));
    body.append(record);
  }
  for (const text of notices) body.append(el('p','tool-batch-note',text));
  return body;
}
function renderThread() {
  const current = session(), vm = current?.vm;
  const transcript = $('transcript');
  const hasReal = !!vm && (vm.messages.length > 0 || vm.tools.length > 0);
  transcript.replaceChildren();
  const refusal = refusalFor(current) ?? policyRefusal(current);
  const problem = refusal ?? routeProblem(current) ?? (vm?.error ? { title:vm.error.code === 'transport_closed' ? '브리지에 연결할 수 없습니다' : '브리지가 오류를 알려 왔습니다', message:vm.error.message } : null);
  if (problem) {
    const box = el('div',refusal ? 'refusal-box' : 'error-box');
    box.setAttribute('role','status');
    box.dataset.state = refusal ? 'refused' : 'error';
    box.append(el('strong','',problem.title),el('p','',problem.message));
    transcript.append(box);
  }
  const query = view.search.trim().toLowerCase();
  if (!hasReal) {
    if (query) transcript.append(el('p','agent-empty','검색 결과가 없습니다.'));
  } else {
    const messages = vm.messages.filter(x => !query || x.text.toLowerCase().includes(query));
    const tools = vm.tools.filter(x => !query || `${x.name} ${x.arguments} ${x.result}`.toLowerCase().includes(query));
    if (query) transcript.append(el('p','agent-empty',`대화와 도구 호출에서 ${messages.length + tools.length}건을 찾았습니다.`));
    const entries = transcriptEntries(vm, query);
    for (const segment of transcriptSegments(entries)) {
      if (!segment.foldable) {
        const entry = segment.entry;
        if (entry.message) {
          const note = assistantNote(entry.message, vm.tools.length > 0);
          const node = note
            ? el('div','assistant-empty',note)
            : el('div',entry.message.role === 'user' ? 'user-bubble' : 'assistant-text',entry.message.text);
          transcript.append(node);
        } else if (entry.privacy) {
          const line = privacyLine(entry.privacy);
          const pnode = el('div','privacy-line',line.text);
          pnode.title = line.title;
          pnode.dataset.action = entry.privacy.action;
          pnode.dataset.sent = String(entry.privacy.sent);
          transcript.append(pnode);
        }
        continue;
      }
      const tools = segment.entries.flatMap(entry => (entry.tool ? [entry.tool] : []));
      const notices = segment.entries.flatMap(entry => {
        if (entry.tool || !entry.message) return [];
        const note = assistantNote(entry.message, vm.tools.length > 0);
        return [note ?? entry.message.text];
      });
      if (!tools.length) {
        // A notice with no tool beside it keeps its own honest line.
        for (const text of notices) transcript.append(el('div','assistant-empty',text));
        continue;
      }
      // One uninterrupted run of tool calls collapses into a single one-line bar; the
      // textless notices that rode along with it stay inspectable inside the disclosure.
      const details = el('details','tool tool-batch');
      details.dataset.error = String(tools.some(tool => tool.isError));
      details.open = tools.some(tool => tool.isError);
      const summary = toolBatchSummary(tools);
      const summaryNode = el('summary','tool-batch-summary');
      summaryNode.dataset.state = summary.state;
      summaryNode.title = summary.title;
      summaryNode.append(icon('ic-code'),el('span','tool-batch-text',summary.text));
      details.append(summaryNode,toolBatchBody(tools,notices));
      transcript.append(details);
    }
  }
  const steps = vm ? completedSteps(vm) : null;
  if (steps) transcript.append(steps);
  const files = vm ? realFiles(vm) : [];
  if (files.length) transcript.append(changesPill(files));
  scrollThreadToBottom();
}

let lastThreadScrollHeight = 0;
function scrollThreadToBottom() {
  const body = document.querySelector('.center-body');
  if (!body) return;
  const nextHeight = body.scrollHeight;
  if (nextHeight === lastThreadScrollHeight) return;
  lastThreadScrollHeight = nextHeight;
  body.scrollTo({ top: nextHeight, behavior: 'smooth' });
}

function completedSteps(vm) {
  if (!vm.sawTodos || !vm.todos.length) return null;
  const tasks = vm.todos.flatMap(phase => phase.tasks);
  const done = tasks.filter(task => task.status === 'completed').length;
  const button = el('button','steps');
  button.type = 'button';
  button.append(el('span','',`${tasks.length}단계 중 ${done}단계 완료`),icon('ic-chev-r'));
  const list = el('div','agent-detail');
  list.hidden = true;
  list.textContent = vm.todos.map(phase => `${phase.name}\n${phase.tasks.map(task => `  ${statusLabel(task.status)} · ${task.content}`).join('\n')}`).join('\n\n');
  button.addEventListener('click',() => { list.hidden = !list.hidden; });
  const wrap = el('div','turn');
  wrap.append(button,list);
  return wrap;
}

function changesPill(files) {
  const button = el('button','changes-pill');
  button.type = 'button';
  let added = 0, removed = 0;
  for (const file of files) { const totals = diffTotals(file); added += totals.added; removed += totals.removed; }
  button.append(icon('ic-file'),el('span','',`파일 ${files.length}개 변경`));
  if (added || removed) button.append(el('span','add',`+${added}`),el('span','del',`-${removed}`));
  button.append(el('span','go','검토 ›'));
  button.title = '이 세션에서 도구 결과가 보고한 변경 내용입니다.';
  button.addEventListener('click',openChangesCard);
  return button;
}

/** Three states, never conflated: reported non-empty, reported empty, and not reported at all. */
function agentSource(vm) {
  if (!vm) return 'unknown';
  if (vm.subagents?.known || vm.subagentList.length) return 'reported';
  if (vm.missing.includes('get_subagents')) return 'unsupported';
  return 'unknown';
}
function agentRows(vm, activity) {
  if (agentSource(vm) !== 'reported') return [];
  const now = Date.now();
  // The edge is reported twice over: the bridge lists the agent as a subagent of this
  // session, and the lifecycle frame may name the parent task it was delegated from.
  const mainName = activity?.main?.name || null;
  return vm.subagentList.map(entry => {
    const state = ({ running:'running', completed:'completed', failed:'parked', error:'parked', aborted:'parked' })[entry.status] ?? 'idle';
    const task = activity?.tasks.find(record => record.id === entry.id) ?? null;
    const elapsed = task?.startedAt != null ? formatElapsed(Math.max(0,(task.endedAt ?? now) - task.startedAt)) : null;
    const tokens = task?.tokens != null ? `${task.tokens} 토큰` : '';
    const cost = Number.isFinite(task?.cost) ? costLabel(task.cost, { remote:remoteTurn(session()) }) : '';
    const lane = Number.isFinite(task?.lane) ? `레인 ${task.lane + 1}` : '';
    const from = task?.dependsOn?.label || mainName || null;
    const edge = [lane, from ? `← ${from}에서 위임` : ''].filter(Boolean).join(' · ');
    return { id:entry.id, state, status:entry.status, label:statusLabel(entry.status), title:entry.detail ? `${entry.name} · ${entry.detail}` : entry.name, role:entry.name, model:entry.model ?? task?.model ?? null, tokens, cost, elapsed, lane, from, edge, detail:'브리지가 보고한 하위 에이전트 정보입니다' };
  });
}

/** A `task`-style call, or any call whose own output names the agent registry. */
function delegationTool(tool) {
  const name = String(tool?.name ?? '').trim().toLowerCase();
  return name === 'task' || name === 'delegate' || /agent:\/\//.test(String(tool?.result ?? ''));
}
function toolArguments(tool) {
  try {
    const parsed = JSON.parse(tool?.arguments || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
/** The agent name the call's own output reports: the core writes it as `agent://<name>`. */
function reportedAgentName(text) {
  const match = String(text ?? '').match(/agent:\/\/([A-Za-z0-9_.:-]+)/);
  return match ? match[1] : null;
}
/** Only the statuses the record reported; anything else stays unreported. */
function recordOutcome(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (['완료','completed','done','idle'].includes(text)) return { state:'completed', label:'완료' };
  if (['실패','failed','error','중단','aborted'].includes(text)) return { state:'parked', label:'실패' };
  if (['실행 중','running','started','working'].includes(text)) return { state:'running', label:'실행 중' };
  return null;
}
/** The agent's own state as the call's output words it ("… is now idle"), if it says so. */
function recordOutcomeOfText(text) {
  const body = String(text ?? '');
  if (/is now idle|is idle|now idle|완료|→ idle/i.test(body)) return recordOutcome('완료');
  if (/is now running|now running|실행 중/i.test(body)) return recordOutcome('실행 중');
  if (/failed|failure|실패/i.test(body)) return recordOutcome('실패');
  return null;
}
/**
 * Delegation the session record reported even though the live registry has no entries:
 * the core drops settled agents before the page's next `get_subagents` poll, but the
 * `delegate`/`agent.end` events and the `task` tool call it emitted stay in the record.
 * Every field is read from that record; nothing is filled in by guesswork.
 */
function recordedAgentRows(vm, activity) {
  const mainName = activity?.main?.name || null;
  const agents = new Map();
  const slot = name => {
    if (!agents.has(name)) agents.set(name, { name, role:null, lane:null, from:null, startedAt:null, endedAt:null, state:null, elapsed:null, stage:null });
    return agents.get(name);
  };
  for (const event of activity?.events ?? []) {
    if (event.kind !== 'delegate' && event.kind !== 'agent.end') continue;
    const facts = event.facts ?? {};
    const name = typeof facts.agent === 'string' && facts.agent ? facts.agent : null;
    if (!name) continue;
    const record = slot(name);
    if (event.kind === 'delegate') {
      record.startedAt = record.startedAt ?? event.at;
      if (Number.isFinite(facts.lane)) record.lane = facts.lane;
      if (typeof facts.parent === 'string' && facts.parent) record.from = facts.parent;
      if (typeof facts.task === 'string' && facts.task && !record.stage) record.stage = facts.task;
    } else {
      record.endedAt = record.endedAt ?? event.at;
      if (typeof facts.state === 'string' && facts.state) record.state = facts.state;
      if (typeof facts.elapsed === 'string' && facts.elapsed && facts.elapsed !== '—') record.elapsed = facts.elapsed;
    }
  }
  for (const tool of vm?.tools ?? []) {
    if (!delegationTool(tool)) continue;
    const args = toolArguments(tool);
    const name = [args.name, args.agent, args.subagent_type, args.role, reportedAgentName(tool.result)]
      .find(value => typeof value === 'string' && value) ?? null;
    if (name && agents.has(name)) continue; // a delegate event already described this agent
    // A call that reports no agent name is still a recorded delegation: it keeps the
    // row and says 미보고 instead of dropping out of the pane.
    const key = name ?? `tool:${tool.id}`;
    const record = slot(key);
    const role = [args.subagent_type, args.role].find(value => typeof value === 'string' && value) ?? null;
    if (role) record.role = role;
    // The call's own output describes the agent's state; the tool's status is the fallback.
    record.state = recordOutcomeOfText(tool.result)?.label ?? tool.status ?? null;
    record.stage = typeof args.description === 'string' && args.description ? args.description : record.stage;
    record.from = mainName;
  }
  const rows = [];
  for (const record of agents.values()) {
    const outcome = recordOutcome(record.state);
    const elapsed = record.elapsed
      ?? (record.startedAt != null && record.endedAt != null ? formatElapsed(record.endedAt - record.startedAt) : null);
    const lane = Number.isFinite(record.lane) ? `레인 ${record.lane + 1}` : '';
    const from = record.from || mainName;
    const edge = [lane, from ? `← ${from}에서 위임` : ''].filter(Boolean).join(' · ');
    const name = record.name.startsWith('tool:') ? '미보고' : record.name;
    rows.push({
      id:`record:${record.name}`, recorded:true, name,
      role:record.role || name, model:null, tokens:'', cost:'',
      state:outcome?.state ?? 'idle', label:outcome?.label ?? '미보고', status:null,
      title:record.stage ? `${name} · ${record.stage}` : name,
      elapsed:elapsed ?? '미보고', lane, from, edge,
      detail:record.stage ? `보고된 호출 기록: ${record.stage}` : '브리지가 보고한 호출 기록에서 읽은 하위 에이전트입니다.'
    });
  }
  return rows;
}

function renderAgents() {
  const current = session(), vm = current?.vm;
  const source = agentSource(vm);
  // The live registry first, then any delegation only the session record still reports:
  // the core drops settled agents before the next poll, the delegate events do not vanish.
  const registry = agentRows(vm, current?.activity);
  const rows = [...registry, ...recordedAgentRows(vm, current?.activity).filter(row => !registry.some(item => item.role === row.name))];
  const act = current?.activity ? actTaskSummary(current.activity) : null;
  // A card that only says "nothing here" is chrome, not information: flatten it.
  if ($('agents')) $('agents').dataset.empty = String(!rows.length && !act?.main);
  const laneData = current?.activity ? actLanes(current.activity) : null;

  // Main-context block: the task this pane is about, from the activity summary only.
  const taskName = $('task-name'), taskState = $('task-state'), taskMeta = $('task-meta'), taskVerify = $('task-verify');
  if (taskName) {
    const main = act?.main;
    const block = $('task-summary');
    if (block && !block.querySelector('.ts-kicker')) {
      const kicker = el('span','ts-kicker','메인 컨텍스트');
      block.prepend(kicker);
    }
    taskName.textContent = main?.name || current?.title || '작업 없음';
    taskName.title = taskName.textContent;
    taskState.textContent = main?.state || statusLabel(vm?.phase ? 'running' : 'idle');
    taskState.dataset.state = main?.status || 'waiting';

    // Every figure below is one the bridge or the gateway actually reported; a value
    // nobody reported is left out instead of being replaced by a placeholder.
    const metaParts = [];
    if (main?.elapsed != null) metaParts.push(`경과 ${formatElapsed(main.elapsed)}`);
    const model = resolvedModel(vm)?.id || main?.model || null;
    if (model) metaParts.push(model);
    const totalTok = sessionTokens(vm);
    if (totalTok != null) metaParts.push(`${fmtK(totalTok)} 토큰`);
    const costFigure = sessionCost(vm);
    if (Number.isFinite(costFigure) || remoteTurn(current)) metaParts.push(costLabel(costFigure, { remote:remoteTurn(current) }));
    taskMeta.textContent = metaParts.length ? metaParts.join(' · ') : '아직 보고된 측정값이 없습니다.';

    // Verification is stated once, in the AI 작업 일지.
    taskVerify.hidden = true;
  }

  // Parallel lanes track
  const laneTrack = $('lane-track');
  if (laneTrack) {
    if (laneData && laneData.rows.length > 1) {
      laneTrack.hidden = false;
      laneTrack.replaceChildren();
      for (const row of laneData.rows) {
        const item = el('div','lane-row');
        const name = el('span','lane-name',row.name);
        name.title = row.name;
        const barWrap = el('div','lane-bar-wrap');
        const bar = el('div','lane-bar');
        bar.dataset.state = row.state;
        bar.style.left = `${Math.round(row.offset * 100)}%`;
        bar.style.width = `${Math.max(4,Math.round(row.width * 100))}%`;
        barWrap.append(bar);
        const dur = el('span','lane-dur',row.label);
        item.append(name,barWrap,dur);
        if (row.dependsOn?.label) {
          const dep = el('div','lane-dep',`↳ 의존: ${row.dependsOn.label}`);
          item.append(dep);
        }
        laneTrack.append(item);
      }
    } else {
      laneTrack.hidden = true;
      laneTrack.replaceChildren();
    }
  }

  const running = rows.filter(row => row.state === 'running').length;
  $('agents-count').textContent = rows.length ? `${running}/${rows.length}` : source === 'reported' ? '0/0' : '보고 없음';
  $('agents-count').hidden = false;
  $('agents-count').title = rows.length
    ? `하위 에이전트 ${rows.length}개 중 ${running}개 실행 중`
    : source === 'reported' ? '이번 세션에는 하위 에이전트가 없습니다.' : '하위 에이전트 없음';
  const list = $('agent-list'), graph = $('agent-graph');
  list.hidden = view.agents !== 'list';
  graph.hidden = view.agents !== 'graph';
  if (!rows.length) {
    const empty = source === 'reported'
      ? '이번 세션에는 하위 에이전트가 없습니다.'
      : source === 'unsupported'
      ? '이 브리지는 하위 에이전트 목록을 제공하지 않습니다.'
      : '브리지가 하위 에이전트 현황을 아직 보고하지 않았습니다.';
    if (view.agents === 'graph') { list.replaceChildren(); graph.replaceChildren(el('p','agent-empty',empty)); }
    else { graph.replaceChildren(); list.replaceChildren(el('p','agent-empty',empty)); }
    return;
  }
  if (view.agents === 'graph') { list.replaceChildren(); renderGraph(rows); return; }
  graph.replaceChildren();
  list.replaceChildren();
  for (const row of rows) {
    const card = el('div','agent-row');
    card.dataset.state = row.state;
    const top = el('div','agent-top');
    const disc = el('button','agent-disc');
    disc.type = 'button';
    disc.setAttribute('aria-expanded',String(!view.collapsed.has(row.id)));
    disc.setAttribute('aria-label',`${row.title} 상세 펼치기/접기`);
    disc.append(icon('ic-chev-r'));
    const status = el('span','agent-status');
    status.append(el('i','dot'),el('span','',row.label ?? statusLabel(row.status ?? row.state)));
    top.append(disc,el('span','agent-name',row.title),status);
    const meta = el('div','agent-meta');
    meta.append(icon('ic-robot'),el('span','who',`${row.role}${row.model ? ` · ${row.model}` : ''}`));
    if (row.recorded) {
      const marker = el('span','agent-source','실행 기록 기반');
      marker.title = '브리지가 보고한 호출 기록에서 읽은 행입니다. 실시간 레지스트리 값이 아닙니다.';
      meta.append(marker);
    }
    for (const [cls,value] of [['sep',row.tokens],['sep',row.cost],['dur',row.elapsed]]) {
      if (!value) continue;
      meta.append(el('span',cls,value));
    }
    const detail = el('div','agent-detail',row.detail ?? '');
    detail.hidden = view.collapsed.has(row.id);
    card.append(top,meta);
    if (row.edge) card.append(el('div','agent-edge',row.edge));
    if (row.detail) card.append(detail);
    disc.addEventListener('click',() => {
      const open = view.collapsed.has(row.id);
      if (open) view.collapsed.delete(row.id); else view.collapsed.add(row.id);
      detail.hidden = !open; disc.setAttribute('aria-expanded',String(open));
    });
    list.append(card);
  }
}

function renderGraph(rows) {
  const host = $('agent-graph');
  host.replaceChildren();
  const svg = document.createElementNS(NS,'svg');
  svg.setAttribute('viewBox','0 0 320 180');
  svg.setAttribute('role','img');
  svg.setAttribute('aria-label','에이전트 관계도: 이 작업과 브리지가 보고한 하위 에이전트');
  const colors = { completed:'var(--success)', running:'var(--accent)', parked:'var(--warning)', idle:'var(--steel)' };
  const line = (x1,y1,x2,y2) => { const node = document.createElementNS(NS,'line'); node.setAttribute('x1',x1); node.setAttribute('y1',y1); node.setAttribute('x2',x2); node.setAttribute('y2',y2); node.setAttribute('stroke','var(--line-2)'); node.setAttribute('stroke-width','1.25'); svg.append(node); };
  const circle = (x,y,color) => { const node = document.createElementNS(NS,'circle'); node.setAttribute('cx',x); node.setAttribute('cy',y); node.setAttribute('r',9); node.setAttribute('fill','var(--surface-2)'); node.setAttribute('stroke',color); node.setAttribute('stroke-width','2'); svg.append(node); };
  const text = (x,y,value,anchor,size,fill) => { const node = document.createElementNS(NS,'text'); node.setAttribute('x',x); node.setAttribute('y',y); node.setAttribute('text-anchor',anchor); node.setAttribute('font-size',size); node.setAttribute('fill',fill); node.textContent = value; svg.append(node); };
  circle(160,34,'var(--ink-2)'); text(160,14,'세션','middle','10','var(--ink-2)');
  rows.forEach((row,index) => {
    const x = rows.length === 1 ? 160 : 34 + index * (252 / (rows.length - 1));
    const y = 136;
    line(160,44,x,y - 12);
    circle(x,y,colors[row.state] ?? colors.idle);
    text(x,y + 26,(row.role || '에이전트').slice(0,16),'middle','9.5','var(--ink)');
  });
  host.append(svg);
  host.append(el('span','graph-note','브리지 보고 기준 · 이 작업에서 갈라진 하위 에이전트'));
}

/* ------------------------------------------------------- activity timeline */
/** Category vocabulary mirrors the engine module (`engine/session_timeline.py`) exactly. */
const TL_ADD = '추가', TL_MODIFY = '수정', TL_DELETE = '삭제', TL_UNCLASSIFIED = '분류 불가';
const TL_CATEGORIES = [TL_ADD, TL_MODIFY, TL_DELETE, TL_UNCLASSIFIED];
const TL_MARKS = { [TL_ADD]:'ic-plus', [TL_MODIFY]:'ic-new', [TL_DELETE]:'ic-x', [TL_UNCLASSIFIED]:'ic-more' };
const TL_EMPTY_ROW = { [TL_ADD]:'추가된 파일이 없습니다.', [TL_MODIFY]:'수정된 파일이 없습니다.', [TL_DELETE]:'삭제된 파일이 없습니다.', [TL_UNCLASSIFIED]:'분류되지 않은 작업이 없습니다.' };
const TL_TOOLS = {
  delete:new Set(['delete','delete_file','delete_path','remove','remove_file','rm','rmdir','unlink','trash']),
  create:new Set(['create','create_file','create_directory','create_dir','new_file','write_new_file','add_file','mkdir']),
  edit:new Set(['edit','edit_file','str_replace','replace_in_file','insert_lines','multiedit','multi_edit']),
  createCapable:new Set(['apply_patch','patch','str_replace_editor','apply_edits']),
  overwrite:new Set(['write','write_file','save','save_file','overwrite_file','put_file'])
};
const TL_OPS = {
  delete:new Set(['delete','deleted','remove','removed','unlink','unlinked','rm']),
  create:new Set(['create','created','create_file','write_new','new_file']),
  weak:new Set(['add','added','new','insert_added']),
  write:new Set(['write','wrote','overwrite','overwrote','rewrite','rewrote','save','saved','patch','patched']),
  edit:new Set(['edit','edited','modify','modified','update','updated','replace','replaced','str_replace','insert','inserted','append','appended'])
};
const TL_WRITE_TOOLS = new Set([...TL_TOOLS.delete,...TL_TOOLS.create,...TL_TOOLS.edit,...TL_TOOLS.createCapable,...TL_TOOLS.overwrite]);
function toolKey(name) { return String(name ?? '').trim().toLowerCase().replace(/[\s-]+/g,'_'); }
function tlDescribe(category,tool,target,variant) {
  const name = target || '대상 미확인';
  const toolName = tool || '도구 미확인';
  if (category === TL_ADD) return `${name} 추가 — ${toolName} 실행 결과 새 파일이 생겼다고 브리지가 보고했습니다`;
  if (category === TL_MODIFY) return `${name} 수정 — ${toolName} 실행이 고쳤다고 보고했습니다`;
  if (category === TL_DELETE) return `${name} 삭제 — ${toolName} 실행이 지웠다고 보고했습니다`;
  if (variant === 'in_progress') return `${name} 변경 미확정 — ${toolName} 실행이 아직 끝나지 않았습니다`;
  if (variant === 'failed') return `${name} 변경 없음 — ${toolName} 실행이 실패하거나 거부되었습니다`;
  return `${name} 분류 불가 — 생성/존재 여부가 보고되지 않음`;
}
/** Existence/creation/deletion evidence alone; `null` means the evidence says nothing. */
function tlByEvidence(created,existedBefore,deleted) {
  if (deleted === true) return TL_DELETE;
  if (created === true || existedBefore === false) return TL_ADD;
  if (existedBefore === true || created === false) return TL_MODIFY;
  return null;
}
/**
 * Ordered rules from `engine/session_timeline.py`: status first, then per-file evidence,
 * then event evidence, then unambiguous operation vocabulary, then unambiguous tool names.
 * Ambiguous writes (`write`/`overwrite`/`rewrite`), line-addition ops (`add`/`added`/`new`)
 * and create-capable tools (`apply_patch`/`patch`/`str_replace_editor`) never decide a
 * category on their own: without creation/existence evidence they stay 분류 불가.
 */
function tlCategory(key,evidence,op,file,issue) {
  const created = file && file.created != null ? file.created : evidence.created;
  const existedBefore = file && file.existedBefore != null ? file.existedBefore : evidence.existedBefore;
  const deleted = file && file.deleted != null ? file.deleted : evidence.deleted;
  const fileOp = file && file.op ? String(file.op).trim().toLowerCase().replace(/[\s-]+/g,'_') : '';
  const operation = fileOp || op || null;
  const createCapable = TL_TOOLS.createCapable.has(key);
  const effectiveOp = operation ?? (createCapable ? evidence.command : null);
  if (issue) return { category:TL_UNCLASSIFIED, variant:issue };
  const fromItem = !!file && (file.created != null || file.existedBefore != null || file.deleted != null || !!file.statusIssue);
  if (fromItem) { const category = tlByEvidence(created,existedBefore,deleted); if (category) return { category, variant:null }; }
  if (TL_TOOLS.delete.has(key) || deleted === true || TL_OPS.delete.has(effectiveOp)) return { category:TL_DELETE, variant:null };
  const byEvidence = tlByEvidence(created,existedBefore,deleted);
  if (byEvidence) return { category:byEvidence, variant:null };
  if (TL_OPS.write.has(effectiveOp) || TL_OPS.weak.has(effectiveOp)) {
    return TL_TOOLS.edit.has(key) ? { category:TL_MODIFY, variant:null } : { category:TL_UNCLASSIFIED, variant:null };
  }
  if (TL_OPS.create.has(effectiveOp) || TL_TOOLS.create.has(key)) return { category:TL_ADD, variant:null };
  if (TL_OPS.edit.has(effectiveOp) || TL_TOOLS.edit.has(key)) return { category:TL_MODIFY, variant:null };
  return { category:TL_UNCLASSIFIED, variant:null };
}
/** Reported failure beats everything; a call with no terminal (or a running/pending) status is unfinished. */
function tlStatusIssue(tool,file) {
  return (file && file.statusIssue) || tool.evidence?.statusIssue || (tool.isError === true ? 'failed' : null);
}
/** A call whose frame never reported a terminal result is not a completed change. */
function tlInProgress(tool,file) {
  const issue = tlStatusIssue(tool,file);
  if (issue) return issue === 'in_progress';
  return tool.status !== '완료' && tool.status !== '실패';
}
function tlCandidate(tool) {
  const key = toolKey(tool.name);
  const evidence = tool.evidence ?? {};
  // `command` is not a candidate trigger by itself: only create-capable tools (already write
  // tools) use it, so an arbitrary shell command never turns a read into a timeline row.
  return TL_WRITE_TOOLS.has(key) || (tool.files ?? []).length > 0 || evidence.created != null || evidence.existedBefore != null || evidence.deleted != null || !!evidence.op;
}
/** Entries come only from the tool calls/results the bridge reported — the same source as the changed-files card. */
function timelineEntries(vm) {
  const entries = [];
  for (const tool of vm.tools) {
    if (!tlCandidate(tool)) continue;
    const evidence = tool.evidence ?? {};
    const key = toolKey(tool.name);
    const files = Array.isArray(tool.files) ? tool.files : [];
    const reportedOp = String(evidence.op ?? '').trim().toLowerCase().replace(/[\s-]+/g,'_') || null;
    const targets = files.length
      ? files.map(file => ({ path:String(file.path ?? '').trim(), op:file.op ?? null, file }))
      : [{ path:String(evidence.target ?? '').trim(), op:reportedOp, file:null }];
    targets.forEach((target, index) => {
      const op = String(target.op ?? '').trim().toLowerCase().replace(/[\s-]+/g,'_') || reportedOp;
      const issue = tlStatusIssue(tool,target.file);
      const verdict = tlCategory(key,evidence,op,target.file,issue);
      const confirmed = !tlInProgress(tool,target.file);
      // A call that never reported a terminal result is not a completed change.
      const variant = confirmed ? verdict.variant : (verdict.variant ?? 'in_progress');
      const category = confirmed ? verdict.category : TL_UNCLASSIFIED;
      entries.push({
        id:`${tool.id}#${index}`,
        category,
        description:tlDescribe(category,tool.name,target.path,variant),
        target:target.path,
        tool:tool.name,
        confirmed,
        time:tool.seenAt ?? Date.now(),
        order:tool.order ?? 0,
        file:index
      });
    });
  }
  return entries.sort((a,b) => a.time - b.time || a.order - b.order || a.file - b.file);
}
/** Structural text unless a validated local-model phrasing matches the entries one-for-one. */
function timelineView(vm) {
  const entries = timelineEntries(vm);
  const counts = { [TL_ADD]:0, [TL_MODIFY]:0, [TL_DELETE]:0, [TL_UNCLASSIFIED]:0 };
  for (const entry of entries) counts[entry.category] += 1;
  const structural = `파일 작업 ${entries.length}건 — 추가 ${counts[TL_ADD]}건, 수정 ${counts[TL_MODIFY]}건, 삭제 ${counts[TL_DELETE]}건, 분류 불가 ${counts[TL_UNCLASSIFIED]}건.`;
  const phrasing = vm.timelinePhrasing;
  // A phrasing is only adoptable when it was produced for exactly these entries.
  const adoptable = !!phrasing && phrasing.sentences.length === entries.length;
  const descriptions = adoptable ? phrasing.sentences : entries.map(entry => entry.description);
  return {
    entries, counts,
    summary:adoptable ? phrasing.summary : structural,
    description:index => descriptions[index] ?? entries[index].description,
    provenance:adoptable ? { source:'model', modelId:phrasing.modelId } : { source:'structural', modelId:'' }
  };
}
function tlMark(category) {
  const mark = el('span','tl-mark');
  mark.append(icon(TL_MARKS[category] ?? 'ic-more'));
  return mark;
}
function tlRow(entry,description) {
  const row = el('li','tl-row');
  row.dataset.category = entry.category;
  row.dataset.event = entry.id;
  const mark = tlMark(entry.category);
  mark.setAttribute('aria-hidden','true');
  const desc = el('span','tl-desc');
  desc.append(el('span','tl-text',description),el('span','tl-cat',entry.category));
  const path = el('span','tl-path mono path',entry.target || '대상 미확인');
  path.title = entry.target || '대상 미확인';
  row.append(mark,desc,path,el('span','tl-time',relative(entry.time)));
  row.title = `${entry.description} (${entry.tool || '도구 미확인'})`;
  return row;
}
function tlChrome() {
  const current = session();
  const mode = 'journal';
  const open = current ? current.timelineOpen !== false : true;
  $('timeline-grouped')?.setAttribute('aria-pressed','true');
  $('timeline-collapse').setAttribute('aria-expanded',String(open));
  $('timeline-body').hidden = !open;
  return mode;
}
function renderTimeline() {
  const current = session(), vm = current?.vm;
  const view = timelineView(vm ?? createViewModel());
  const mode = tlChrome();
  renderActivity(current, mode);
  // The card itself always stays; only its file-work explanation depends on reported rows.
  $('timeline').dataset.empty = String(view.entries.length === 0);
  scheduleInsight(current);
  const provenance = $('timeline-provenance');
  // The journal is a work log, not a model showcase: its header never names the local SLM.
  provenance.hidden = true;
  provenance.dataset.source = 'structural';
  provenance.textContent = '';
  provenance.removeAttribute('title');
  const verify = current?.activity ? actTaskSummary(current.activity).verify : null;
  const verifyBadge = $('timeline-verify');
  const verifyRuns = (current?.activity?.events ?? []).filter(e => e.kind === 'verify').length;
  const tOutcome = verifyStatement({ runs:verifyRuns, passed:verify?.passed ?? 0, failed:verify?.failed ?? 0 });
  verifyBadge.hidden = true; // the journal card carries the single verification statement
  if (tOutcome) {
    verifyBadge.textContent = tOutcome.text;
    verifyBadge.dataset.state = tOutcome.state;
    verifyBadge.title = '도구 출력이 보고한 검증 결과만 셉니다.';
  } else {
    // No verification ran, so nothing is stated here: the badge is hidden and carries no line.
    verifyBadge.textContent = '';
    delete verifyBadge.dataset.state;
    verifyBadge.removeAttribute('title');
  }
  const count = () => `파일 작업 ${view.entries.length}건 · 추가 ${view.counts[TL_ADD]}건, 수정 ${view.counts[TL_MODIFY]}건, 삭제 ${view.counts[TL_DELETE]}건, 분류 불가 ${view.counts[TL_UNCLASSIFIED]}건`;
  $('timeline-count').textContent = `${view.entries.length}건`;
  $('timeline-count').title = count();
  $('timeline').setAttribute('aria-label',`AI 작업 일지 — ${count()}`);
  $('timeline-summary').textContent = view.summary;
  $('timeline-summary').title = view.summary;
  const strip = $('timeline-counts');
  strip.replaceChildren();
  for (const name of TL_CATEGORIES) {
    const chip = el('span','tl-c');
    chip.dataset.category = name;
    chip.append(el('span','',name),el('b','',`${view.counts[name]}건`));
    strip.append(chip);
  }
  const host = $('timeline-groups');
  host.replaceChildren();
  host.classList.toggle('tl-chrono',mode === 'raw');
  const rowsFor = filter => view.entries
    .map((entry,index) => ({ entry, description:view.description(index) }))
    .filter(row => !filter || row.entry.category === filter.source);
  const group = (name,rows,all) => {
    const box = el('div','tl-group');
    box.dataset.category = name;
    box.dataset.count = String(all);
    const head = el('div','tl-group-head');
    head.append(tlMark(name),el('span','tl-group-name',name),el('span','tl-group-count',`${all}건`));
    box.append(head);
    if (rows.length) {
      const list = el('ul','tl-rows');
      for (const row of rows) list.append(tlRow(row.entry,row.description));
      box.append(list);
    } else box.append(el('p','tl-empty',TL_EMPTY_ROW[name] ?? '기록된 항목이 없습니다.'));
    box.setAttribute('role','listitem');
    return box;
  };
  const allRows = view.entries.map((entry,index) => ({ entry, description:view.description(index) }));
  if (mode === 'raw') {
    // Chronological order restores the events as the tools reported them, oldest first.
    const ordered = allRows.slice().sort((a,b) => (a.entry.seq ?? 0) - (b.entry.seq ?? 0) || (a.entry.time ?? 0) - (b.entry.time ?? 0));
    host.append(group('원본',ordered,view.entries.length));
  } else {
    for (const name of TL_CATEGORIES) host.append(group(name,allRows.filter(row => row.entry.category === name),view.counts[name]));
  }
  $('timeline').title = view.entries.length
    ? '도구가 보고한 파일 작업만 보여 줍니다. 추측해서 채우지 않습니다.'
    : '이번 세션에는 파일을 고치는 도구 실행이 없었습니다.';
}

/** Icons are the shell's own sprite; no new asset is introduced for the timeline. */
const ACT_MARKS = { run:'ic-arrow-up', turn:'ic-timer', 'tool.start':'ic-code', 'tool.end':'ic-code', write:'ic-file', verify:'ic-gauge', delegate:'ic-robot', 'agent.end':'ic-robot', progress:'ic-list', approval:'ic-lock', 'approval.end':'ic-check', retry:'ic-branch', error:'ic-x', done:'ic-work', failed:'ic-x' };

function taskStateLabel(state) {
  return state === 'done' ? '완료' : state === 'failed' ? '실패' : state === 'waiting' ? '대기' : '진행 중';
}
function taskStateToken(state) {
  return state === 'done' ? 'done' : state === 'failed' ? 'failed' : state === 'waiting' ? 'waiting' : 'running';
}
function verifyCountsFor(events, taskId) {
  let passed = 0, failed = 0;
  for (const event of events ?? []) {
    if (event.kind !== 'verify' || event.taskId !== taskId) continue;
    if (event.facts?.state === 'passed') passed += 1;
    else if (event.facts?.state === 'failed') failed += 1;
  }
  return { passed, failed };
}

/** One journal card per task: purpose lines, category pills, time, state, verification. */
function renderJournal(current, summary, act, host) {
  for (const task of summary.tasks) {
    const card = el('li','journal-task');
    card.dataset.taskId = task.taskId;
    const head = el('div','journal-task-head');
    head.append(el('span','journal-task-name', task.taskId === 'main' ? task.taskName : `${task.taskName} · 하위 작업`));
    const state = el('span','journal-state', taskStateLabel(task.state));
    state.dataset.state = taskStateToken(task.state);
    head.append(state);
    card.append(head);

    const verify = verifyCountsFor(act?.events, task.taskId);
    const runs = (act?.events ?? []).filter(e => e.kind === 'verify' && e.taskId === task.taskId).length;
    const vOutcome = verifyStatement({ runs, passed:verify.passed, failed:verify.failed });
    const rows = el('ul','journal-rows');
    for (const row of task.rows) {
      const li = el('li','journal-row');
      li.dataset.category = row.category;
      const button = el('button','journal-main');
      button.type = 'button';
      button.setAttribute('aria-expanded','false');
      const pill = el('span','journal-pill',row.category);
      pill.dataset.cat = row.category;
      const rowText = row.category === '검증' && vOutcome ? vOutcome.text : row.text;
      const text = el('span','journal-text',rowText);
      text.title = rowText;
      const side = el('div','journal-side');
      const events = row.events ?? [];
      const first = events[0], last = events.at(-1);
      const stamp = at => Number.isFinite(at) ? actClock(at) : '—';
      const timeText = events.length > 1 && first && last
        ? `${stamp(first.at)}–${stamp(last.at)}`
        : first ? stamp(first.at) : '—';
      side.append(el('span','journal-time',timeText));
      if (events.length > 1) side.append(el('span','journal-count',`${events.length}건 묶음`));
      button.append(pill,text,side);

      const meta = el('div','journal-meta');
      const fileCount = row.paths?.length ?? 0;
      const subjects = (row.subjects ?? []).slice(0,3).join(' · ');
      const fileNote = fileCount ? `변경 대상 ${fileCount}건` : '';
      // The row source stays out of the meta line: the journal never advertises the SLM.
      const metaParts = [];
      if (fileNote) metaParts.push(fileNote);
      if (fileNote) metaParts.push(fileNote);
      if (subjects) metaParts.push(subjects);
      if (metaParts.length) {
        meta.append(el('span','',metaParts.join(' · ')));
      } else {
        meta.hidden = true;
      }

      const detail = el('div','journal-detail');
      detail.hidden = true;
      const info = actEventDetail({ events:events.some(event => event.facts?.reported) ? events.filter(event => !event.facts?.reported) : events });
      const log = el('ul');
      for (const entry of info.log) {
        const line = el('li','');
        line.append(el('span','act-time',actClock(entry.at)),el('span','',`${entry.lines[0]}${entry.lines[1] ? ` · ${entry.lines[1]}` : ''}`));
        log.append(line);
      }
      if (!log.children.length) log.append(el('li','','기록된 상세 로그가 없습니다.'));
      detail.append(log);
      const diffButton = el('button','link-btn','파일 변경 내역은 Diff 탭에서 확인 ›');
      diffButton.type = 'button';
      diffButton.addEventListener('click', () => {
        const input = $('diff-task-id');
        if (input) input.value = current?.bridgeId || '';
        switchInspectorTab('diff');
      });
      detail.append(diffButton);
      button.addEventListener('click', () => {
        const open = detail.hidden;
        detail.hidden = !open;
        button.setAttribute('aria-expanded',String(open));
        li.dataset.open = String(open);
      });
      li.append(button,meta,detail);
      rows.append(li);
    }
    card.append(rows);
    // The 검증 row carries the one verification statement; when no verification ran
    // the card states nothing about it — no placeholder line, no "검증 없음".
    host.append(card);
  }
}

/**
 * Main timeline: the journal view is the default. The raw event log stays one
 * click away (`원본`) and the file ledger lives in the expandable drawer.
 */
function renderActivity(current, mode) {
  const act = current?.activity ?? null;
  const journalHost = $('journal-rows');
  const rawHost = $('activity-rows');
  const empty = $('activity-empty');
  const summary = summarizeView(act ?? createActivity(), current?.insightModel ?? null, reportedChanges(current?.vm));
  if ($('timeline')) $('timeline').dataset.empty = String(summary.total === 0);

  if (mode === 'raw') {
    journalHost.hidden = true;
    journalHost.replaceChildren();
    rawHost.hidden = false;
    $('activity-count').textContent = `활동 ${act ? actTimelineRows(act, { grouped:false }).length : 0}건`;
    renderRawActivity(current, act, rawHost);
    return;
  }

  rawHost.hidden = true;
  rawHost.replaceChildren();
  delete rawHost.dataset.signature;
  if (empty) empty.hidden = true;
  journalHost.hidden = false;
  $('activity-count').textContent = `일지 ${summary.total}줄`;
  const signature = `journal|${current?.key ?? 'none'}|${act?.seq ?? 0}|${current?.insightRev ?? 0}|${current?.timelineOpen}`;
  if (journalHost.dataset.signature === signature && journalHost.children.length) return;
  journalHost.dataset.signature = signature;
  journalHost.replaceChildren();
  if (current?.timelineOpen === false) return;
  if (!summary.total) {
    journalHost.append(el('p','journal-empty','기록된 작업이 없습니다.'));
    return;
  }
  renderJournal(current, summary, act, journalHost);
}

/** 「자세히」 keeps the raw tool log available on request; it is never the first view. */
function renderRawActivity(current, act, host) {
  const rows = act ? actTimelineRows(act, { grouped:false }) : [];
  const signature = `raw|${current?.key ?? 'none'}|${act?.seq ?? 0}|${current?.timelineOpen}`;
  if (host.dataset.signature === signature) return;
  host.dataset.signature = signature;
  const expanded = current?.expandedEvents ?? new Set();
  host.replaceChildren();
  $('activity-count').textContent = `활동 ${rows.length}건`;
  const empty = $('activity-empty');
  empty.hidden = rows.length > 0;
  if (!empty.hidden) empty.textContent = '기록된 활동 없음';
  if (current?.timelineOpen === false) return;
  for (const row of rows) {
    const li = el('li','act-row');
    li.dataset.kind = row.kind;
    if (row.highlight) li.dataset.highlight = row.highlight;
    const button = el('button','act-main');
    button.type = 'button';
    const isOpen = expanded.has(row.key) || current?.selectedEventKey === row.key;
    button.setAttribute('aria-expanded',String(isOpen));
    if (isOpen) li.dataset.open = 'true';
    const head = el('span','act-row-head');
    head.append(el('span','act-time',actClock(row.lastAt)));
    const mark = el('span','act-mark');
    mark.append(icon(ACT_MARKS[row.kind] ?? 'ic-more'));
    head.append(mark);
    head.append(el('span','act-task',`${row.taskId === 'main' ? '메인' : row.taskName} · ${row.taskState}`));
    if (row.count > 1) head.append(el('span','act-count',`×${row.count}`));
    button.append(head,el('span','act-l1',row.lines[0]));
    if (row.lines[1]) button.append(el('span','act-l2',row.lines[1]));
    const detail = el('div','act-detail');
    detail.hidden = !isOpen;
    const info = actEventDetail(row);
    for (const entry of info.log) {
      const line = el('div','act-log');
      line.append(el('span','act-time',actClock(entry.at)),el('span','act-note',`${entry.lines[0]}${entry.lines[1] ? ` · ${entry.lines[1]}` : ''}`));
      detail.append(line);
    }
    if (info.output) detail.append(el('pre','act-output',info.output));
    button.addEventListener('click', () => {
      const nowOpen = !expanded.has(row.key) && current?.selectedEventKey !== row.key;
      if (nowOpen) expanded.add(row.key); else expanded.delete(row.key);
      if (current) current.selectedEventKey = nowOpen ? row.key : null;
      detail.hidden = !nowOpen;
      button.setAttribute('aria-expanded',String(nowOpen));
      if (nowOpen) li.dataset.open = 'true'; else delete li.dataset.open;
    });
    li.append(button,detail);
    host.append(li);
  }
}

/** Ask the local SLM for a readable Korean session title: one request per revision, keyed by session. */
function scheduleAutoTitle(current, { settled = false } = {}) {
  if (!current) return;
  // A settled session keeps its title: no later frame may run the model again.
  if (current.titleSettled) return;
  const userMsg = current.vm?.messages?.find(x => x.role === 'user');
  const prompt = (userMsg?.text ?? '').trim();
  if (!prompt) return;
  const assistantMsg = current.vm?.messages?.find(x => x.role === 'assistant' && x.text?.trim());
  const reply = (assistantMsg?.text ?? '').trim();
  const files = [...new Set([
    ...realFiles(current.vm).map(f => f.path),
    ...(current.activity?.events ?? []).filter(e => e.kind === 'write').map(e => e.facts?.path)
  ].filter(path => typeof path === 'string' && path && path !== '경로 미상'))];
  const revision = `${prompt.length}:${reply.length}:${files.length}`;
  if (settled) {
    if (current.titleSettledRequested) return;
    current.titleSettledRequested = true;
  } else {
    if (current.titlePromptRequested) return;
    current.titlePromptRequested = true;
  }
  if (current.titleResolved && current.titleRevision === revision) return;
  if (current.titleFetching) {
    if (settled) current.titlePendingRefresh = true;
    return;
  }
  current.titleRevision = revision;
  const targetKey = current.key;
  const reqSeq = ++current.titleReqSeq;
  current.titleFetching = true;
  pageWorkStart(current);
  fetch('/api/insight/title', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({ prompt, reply, files, session:String(targetKey), settled })
  }).then(async res => {
    if (!res?.ok) return null;
    return res.json();
  }).then(data => {
    if (!sessions.has(targetKey) || current.titleReqSeq !== reqSeq) return;
    const nextTitle = typeof data?.title === 'string' ? data.title.trim() : '';
    if (!nextTitle) return;
    // A refinement may replace a rule title with a model title, never the reverse:
    // the header must not oscillate between the two tiers.
    if (current.titleResolved && current.titleTier === 'local-model' && data?.tier !== 'local-model') {
      if (settled) current.titleSettled = true;
      return;
    }
    const changed = current.title !== nextTitle;
    current.title = nextTitle;
    current.titleResolved = true;
    current.titleTier = data?.tier === 'local-model' ? 'local-model' : 'rules';
    if (settled) current.titleSettled = true;
    if (!changed) return;
    if (current.activity?.main) current.activity.main.name = nextTitle;
    if (activeKey === targetKey) {
      $('head-title').textContent = nextTitle;
      $('head-title').title = nextTitle;
      renderAgents();
    }
    renderSessions();
  }).catch(() => {}).finally(() => {
    current.titleFetching = false;
    pageWorkEnd(current);
    if (!sessions.has(targetKey)) return;
    if (current.titlePendingRefresh) {
      current.titlePendingRefresh = false;
      scheduleAutoTitle(current, { settled:true });
    }
  });
}

/** Ask the local summarizer once per reported work revision; the rule rows stay until it answers. */
function scheduleInsight(current) {
  if (!current?.activity) return;
  const reported = reportedChanges(current.vm);
  const key = insightKeyOf(current.activity, reported);
  if (current.insightKey === key || current.insightFetching) return;
  current.insightKey = key;
  // Work is reported either as activity write/verify events or as tool-result file changes;
  // a session with neither of them never asks the model for a summary.
  const hasWork = current.activity.events.some(event => event.kind === 'write' || event.kind === 'verify') || reported.length > 0;
  if (!hasWork) return;
  current.insightFetching = true;
  pageWorkStart(current);
  const targetKey = current.key;
  fetchInsight(current.activity, { reported }).then(model => {
    current.insightFetching = false;
    pageWorkEnd(current);
    if (!sessions.has(targetKey)) return;
    if (model) {
      current.insightModel = model;
      current.insightRev = (current.insightRev ?? 0) + 1;
      if (activeKey === targetKey) renderTimeline();
    }
    if (insightKeyOf(current.activity, reportedChanges(current.vm)) !== key) scheduleInsight(current);
  }).catch(() => {
    current.insightFetching = false;
    pageWorkEnd(current);
    if (sessions.has(targetKey) && insightKeyOf(current.activity, reportedChanges(current.vm)) !== key) scheduleInsight(current);
  });
}

function gateRequest(current) {
  const list = current?.vm?.approvals ?? [];
  if (!list.length) return null;
  const index = Math.min(Math.max(0, current.gateIndex ?? 0), list.length - 1);
  return { request:list[index], index, total:list.length };
}

function renderApprovals() {
  const current = session(), vm = current?.vm;
  const host = $('approvals');
  if (!host) return;
  if (approvalOwner !== activeKey) { approvalOwner = activeKey; }
  const info = gateRequest(current);
  if (!info) {
    host.hidden = true;
    if (current) current.gateShownId = null;
    return;
  }
  host.hidden = false;
  current.gateIndex = info.index;
  $('gate-count').hidden = info.total < 2;
  $('gate-count').textContent = `${info.index + 1} / ${info.total}`;
  const request = info.request;
  $('gate-title').textContent = '승인이 필요합니다';
  const tool = pendingApprovalTool(vm);
  const action = approvalActionText(request);
  const reason = approvalReasonText(request);
  $('gate-target').hidden = !(action || tool?.name);
  $('gate-target').textContent = [action ?? `${tool?.name ?? '도구'} 도구를 실행하려 합니다`, tool?.files?.[0]?.path ?? ''].filter(Boolean).join(' · ');
  const preview = approvalPreview(tool);
  const previewBox = $('gate-preview');
  previewBox.replaceChildren();
  previewBox.hidden = preview.kind === 'none';
  if (preview.kind === 'diff') {
    const rows = preview.lines.length ? preview.lines : [{ kind:'keep', text:'변경 없음' }];
    for (const row of rows) {
      const line = el('span','gate-line');
      line.dataset.kind = row.kind;
      line.append(el('span','gate-mark', row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '), el('span','gate-text', row.text));
      previewBox.append(line);
    }
  } else if (preview.kind === 'command') {
    previewBox.append(el('span','gate-command-k','이 명령이 실행됩니다'), el('code','gate-command', preview.command));
  }
  const note = $('gate-note');
  const missingChange = preview.kind === 'none';
  note.hidden = !(reason || missingChange);
  note.textContent = missingChange
    ? '변경 내용을 받지 못했습니다. 그래도 승인하시겠습니까?'
    : (reason ?? '');
  const choices = approvalChoices(request);
  const radios = $('gate-radios');
  radios.replaceChildren();
  const scope = $('gate-scope');
  if (request.method === 'select' && choices.approve.length > 1) {
    scope.hidden = false;
    const picked = view.approvalPick.get(request.id) ?? defaultApprovalValue(request);
    view.approvalPick.set(request.id, picked);
    choices.approve.forEach((value, index) => {
      const label = el('label','gate-radio');
      const input = el('input');
      input.type = 'radio';
      input.name = `scope-${request.id}`;
      input.value = value;
      input.checked = value === picked;
      input.id = `scope-${request.id}-${index}`;
      const text = el('span','', approvalLabel(value));
      label.append(input, text);
      input.addEventListener('change', () => { if (input.checked) view.approvalPick.set(request.id, value); });
      radios.append(label);
    });
  } else {
    scope.hidden = true;
    if (request.method === 'select') view.approvalPick.set(request.id, choices.approve[0] ?? null);
  }
  let field = null;
  if (request.method === 'input' || request.method === 'editor') {
    const id = `gate-field-${request.id}`;
    const label = el('label','gate-field-label','보낼 내용');
    label.htmlFor = id;
    field = el('textarea','gate-field');
    field.id = id;
    field.rows = 3;
    field.value = drafts.get(`${current.key}:${request.id}`) ?? request.value;
    field.addEventListener('input', () => drafts.set(`${current.key}:${request.id}`, field.value));
    previewBox.hidden = false;
    previewBox.append(label, field);
    $('approval-approve').textContent = '보내기';
    $('approval-deny').textContent = '취소';
  } else {
    $('approval-approve').textContent = '승인';
    $('approval-deny').textContent = '거절';
  }
  current.gateField = field;
  const folderMatch = choices.approve.map(approvalLabel).find(label => label.startsWith('폴더에 대해 승인: '));
  const folder = $('gate-folder');
  folder.hidden = !folderMatch;
  folder.textContent = folderMatch ? `폴더: ${folderMatch.replace('폴더에 대해 승인: ','')}` : '';
  const rawParts = [request.title, request.message].filter(Boolean);
  $('gate-more').hidden = !rawParts.length;
  $('gate-raw').textContent = rawParts.join('\n');
  $('gate-confirm').hidden = !view.approvalConfirm.get(request.id);
  if (current.gateShownId !== request.id) {
    current.gateShownId = request.id;
    $('gate-title').focus({ preventScroll:true });
    host.scrollIntoView({ block:'nearest' });
  }
}

function answerGate(current, answer) {
  const info = gateRequest(current);
  if (!info) return;
  const request = info.request;
  if (request.method === 'select' && answer === 'approve') {
    const value = view.approvalPick.get(request.id) ?? defaultApprovalValue(request);
    if (value === null) return;
    if (approvalIsGlobal(value) && !view.approvalConfirm.get(request.id)) {
      view.approvalConfirm.set(request.id, true);
      $('gate-confirm').hidden = false;
      $('gate-confirm-yes').focus({ preventScroll:true });
      return;
    }
    view.approvalConfirm.delete(request.id);
    const label = approvalLabel(value);
    if (!send(current, approvalCommand(request, value))) return;
    rememberGateAnswer(current, `코어 요청에 답했습니다: ${label}`);
    return;
  }
  if (request.method === 'select' && answer === 'deny') {
    const { deny } = approvalChoices(request);
    if (!deny) return;
    if (!send(current, approvalCommand(request, deny))) return;
    rememberGateAnswer(current, '도구 실행을 거절했습니다.');
    return;
  }
  if (request.method === 'confirm') {
    const value = answer === 'approve';
    if (!send(current, approvalCommand(request, value))) return;
    rememberGateAnswer(current, value ? '승인했습니다.' : '거절했습니다.');
    return;
  }
  const text = current.gateField?.value ?? '';
  const value = answer === 'approve' ? text : null;
  if (!send(current, approvalCommand(request, value))) return;
  drafts.delete(`${current.key}:${request.id}`);
  rememberGateAnswer(current, answer === 'approve' ? '값을 보냈습니다.' : '취소했습니다.');
}

function rememberGateAnswer(current, message) {
  const info = gateRequest(current);
  if (info) view.approvalPick.delete(info.request.id);
  if (info) view.approvalConfirm.delete(info.request.id);
  current.vm.approvals = current.vm.approvals.filter(x => x.id !== info?.request.id);
  markApprovalAnswered(current.activity);
  if (message) {
    current.vm.messages.push({ id:`approval-${Date.now()}`, role:'assistant', text:message, blocks:{}, order:nextOrder(current.vm) });
  }
  current.gateIndex = 0;
  current.gateShownId = null;
  render();
  $('prompt').focus({ preventScroll:true });
}

function renderInspector() {
  const current = session(), vm = current?.vm;
  if (!current) return;
  const scroller = $('inspector').querySelector('.inspector-scroll:not([hidden])') ?? $('inspector').querySelector('.inspector-scroll');
  const scrollTop = scroller.scrollTop;
  const context = vm?.context;
  const contextPercent = context ? context.percent ?? (context.window ? context.tokens / context.window * 100 : null) : null;
  $('ctx-percent').textContent = context ? contextPercent === null ? '사용률 미보고' : `${Math.round(contextPercent)}% 사용` : '사용률 미확인';
  $('ctx-total').textContent = context ? `${fmtK(context.tokens)}/${context.window ? fmtK(context.window) : '전체 용량 미보고'}` : '미확인';
  const bar = $('ctx-bar');
  bar.replaceChildren();
  if (context) {
    const percent = Math.max(0,Math.min(100,contextPercent ?? 0));
    const seg = el('span');
    seg.style.setProperty('width',`${percent}%`);
    seg.style.setProperty('background','#79a7f2');
    bar.append(seg);
    bar.setAttribute('aria-label',contextPercent === null ? '컨텍스트 사용률은 보고되지 않았습니다' : `보고된 컨텍스트 용량의 ${Math.round(percent)}% 사용`);
    bar.title = context.window ? `코어 보고: ${context.window}토큰 중 ${context.tokens}토큰 사용` : '전체 컨텍스트 용량은 보고되지 않았습니다';
  } else {
    bar.setAttribute('aria-label','컨텍스트 사용량은 보고되지 않았습니다');
  }
  // No frame or endpoint reports a folder path or a branch, so neither is filled in.
  $('ws-folder').textContent = '보고 없음';
  $('ws-folder').title = '브리지는 작업 폴더 경로를 보고하지 않습니다.';
  $('ws-branch').textContent = '보고 없음';
  $('ws-branch').title = '브리지는 현재 브랜치를 보고하지 않습니다.';
  const res = resolvedModel(vm);
  if (res?.source && res.source !== '코어 보고' && res.endpoint) {
    $('ws-model').textContent = `${res.id} (${res.source}) · 엔드포인트 ${res.endpoint}`;
    $('ws-model').title = `결정 모델: ${res.id} (${res.source}) · 실행 엔드포인트: ${res.endpoint}`;
  } else if (res?.id) {
    $('ws-model').textContent = res.source === '코어 보고' ? `브리지 보고: ${res.id}` : `${res.id} (${res.source})`;
    $('ws-model').title = `사용 모델: ${res.id} (${res.source})`;
  } else {
    $('ws-model').textContent = '게이트웨이가 고름 (이 페이지 밖)';
    $('ws-model').title = '모델과 추론 등급은 이 페이지가 아니라 게이트웨이가 고릅니다.';
  }

  const files = vm ? realFiles(vm) : [];
  $('changes-count').textContent = files.length ? `파일 ${files.length}개 변경됨` : '변경된 파일 없음';
  // The overview keeps only a summary; the add/modify/delete history lives in the 변경 검토 tab.
  const totals = files.reduce((sum,file) => { const t = diffTotals(file); return { added:sum.added + t.added, removed:sum.removed + t.removed }; },{ added:0, removed:0 });
  $('changes-summary').textContent = `파일 ${files.length}개 변경 · +${totals.added} −${totals.removed}`;
  $('card-changes').hidden = !files.length;
  const changes = $('changes-rows');
  if (changes.dataset.sessionKey !== activeKey) {
    changes.replaceChildren();
    changes.dataset.sessionKey = activeKey;
  }
  const liveChanges = new Set(files.map(file => file.changeKey));
  for (const [key,item] of current.changeRows) {
    if (liveChanges.has(key)) continue;
    item.remove();
    current.changeRows.delete(key);
  }
  if (!files.length) {
    if (!changes.firstChild) changes.append(el('li','agent-empty','이번 세션에는 바뀐 파일이 없습니다.'));
  } else {
    changes.querySelector('.agent-empty')?.remove();
    for (const [index,file] of files.entries()) {
      let item = current.changeRows.get(file.changeKey);
      if (!item) {
        item = el('li');
        item.append(el('span','path'));
        current.changeRows.set(file.changeKey,item);
      }
      // Keep the live disclosure nodes: unrelated frames must not interrupt code review.
      const badge = file.deleted === true ? 'D' : (file.created === true || file.existedBefore === false) ? 'A' : file.existedBefore === true ? 'M' : '';
      const mark = item.querySelector('.mbadge');
      if (badge) {
        delete item.dataset.badge;
        if (mark) mark.textContent = badge;
        else item.prepend(el('span','mbadge',badge));
      } else {
        mark?.remove();
        item.dataset.badge = 'none';
      }
      const row = item.querySelector('.path');
      if (row.textContent !== file.path) row.textContent = file.path;
      row.title = file.path;
      let details = item.querySelector('details');
      if (file.diff) {
        if (!details) {
          details = el('details','file-badge');
          details.append(el('summary'),el('pre','file-diff'));
          item.append(details);
        }
        const summary = details.querySelector('summary');
        const label = `${diffTotals(file).added}줄 추가 · ${diffTotals(file).removed}줄 삭제`;
        if (summary.textContent !== label) summary.textContent = label;
        const diff = details.querySelector('.file-diff');
        if (diff.textContent !== file.diff) {
          const position = diff.scrollTop;
          diff.textContent = file.diff;
          diff.scrollTop = position;
        }
      } else details?.remove();
      if (changes.children[index] !== item) changes.insertBefore(item,changes.children[index] ?? null);
    }
  }

  const runningReported = agentSource(vm) === 'reported';
  const runningRows = runningReported
    ? vm.subagentList.map(entry => ({ role:entry.name, title:entry.detail ?? statusLabel(entry.status) }))
    : [];
  $('running-count').textContent = !runningReported
    ? '보고 없음'
    : vm.subagentList.length ? `하위 에이전트 ${vm.subagentList.filter(x => x.status === 'running').length}개 실행 중` : '실행 중인 하위 에이전트 없음';
  const running = $('running-rows');
  running.replaceChildren();
  if (!runningRows.length) {
    running.append(el('li','agent-empty',runningReported ? '실행 중인 하위 에이전트 없음' : '하위 에이전트 없음'));
    // Do not repeat the empty message in subline AND row; hide the duplicate row
    running.hidden = true;
  } else {
    running.hidden = false;
    for (const row of runningRows) {
      const item = el('li');
      item.append(el('span','role',row.role),el('span','ttl',row.title));
      running.append(item);
    }
  }
  $('card-running').title = runningReported ? '보고된 하위 에이전트 현황' : '하위 에이전트 없음';
  // The agents card in the thread already says there are none; an empty duplicate card is filler.
  $('card-running').hidden = !runningRows.length;

  const mcp = $('mcp-rows');
  mcp.replaceChildren();
  mcp.append(el('li','agent-empty','브리지는 MCP 서버 현황을 보고하지 않습니다.'));
  $('card-mcp').title = '브리지가 MCP 서버 목록을 보고하지 않아 연결 여부를 알 수 없습니다.';
  // The card is not reported by the bridge at all, so it carries no information: hide it.
  $('card-mcp').hidden = true;

  $('bridge-session').textContent = current?.bridgeId ?? '아직 받지 못했습니다';
  $('bridge-protocol').textContent = 'v2';
  $('bridge-consent').textContent = current?.consent ? '동의함' : '동의 안 함';
  $('bridge-tag').textContent = current?.vm.error?.code === 'transport_closed' ? '응답 없음' : refusalFor(current) ? '거부됨' : current?.ready ? '연결됨' : '미확인';
  $('harness-state').textContent = current?.vm.error?.code === 'transport_closed' ? '브리지 응답 없음' : refusalFor(current) ? '경로 거부됨' : routeGate(current) ? (routeGate(current).state === 'consent' ? '동의 필요' : '모델 사용 불가') : current?.config?.mock ? '모의 코어' : current?.ready ? '브리지 연결됨' : '연결하는 중';
  scroller.scrollTop = scrollTop;
}

/**
 * The model label is the one thing this page shows about the choice it does not make:
 * the gateway's own read-back for this session's identity and route. Until that
 * read-back exists — a brand-new session, a restart, an evicted record, a failed read
 * — the label stays exactly "자동", which claims only that the gateway chooses.
 * Nothing is composed, renamed or priced here.
 */
// The six roles the gateway classifies, in Korean. A role the gateway does not
// report stays unshown; these are labels for identifiers it did report.
const gatewayRoleLabels = { main:'조율', planner:'계획', frontend:'프론트엔드', backend:'백엔드', research:'조사', verifier:'검증' };

function renderModelLabel(current) {
  const node = $('composer-auto'), label = $('composer-auto-model'), detail = $('composer-auto-detail');
  const roleEl = $('composer-auto-role'), decisionEl = $('composer-auto-decision');
  const selection = current?.vm.selection ?? null;
  if (!selection) {
    label.textContent = '자동';
    delete node.dataset.source;
    delete node.dataset.decision;
    node.removeAttribute('aria-label');
    node.title = '모델과 추론 등급은 게이트웨이가 고릅니다. 이 페이지에서는 고를 수 없습니다.';
    roleEl.hidden = true;
    roleEl.textContent = '';
    roleEl.removeAttribute('title');
    decisionEl.hidden = true;
    decisionEl.textContent = '';
    decisionEl.removeAttribute('title');
    detail.hidden = true;
    detail.textContent = '';
    detail.removeAttribute('title');
    return;
  }
  const strength = [
    selection.grade ? `추론 ${thinkingLabel(selection.grade)}` : null,
    selection.budget !== null ? `생각 토큰 ${selection.budget}` : null
  ].filter(Boolean).join(' · ');
  label.textContent = selection.modelId;
  node.dataset.source = 'gateway';
  // The active role is a fact the gateway decides, so it is shown as read back,
  // never as a choice this page made.
  const roleLabel = selection.role ? (gatewayRoleLabels[selection.role] ?? selection.role) : null;
  roleEl.hidden = !roleLabel;
  roleEl.textContent = roleLabel ?? '';
  if (roleLabel) {
    roleEl.title = `활성 역할: ${selection.role}${selection.roleReason ? ` · ${selection.roleReason}` : ''}`;
    roleEl.setAttribute('aria-label',`활성 역할 ${roleLabel}`);
  } else { roleEl.removeAttribute('title'); roleEl.removeAttribute('aria-label'); }
  // One decision source wording for the composer, the footer and the inspector.
  const decisionText = decisionLabel(selection);
  decisionEl.hidden = !decisionText;
  decisionEl.textContent = decisionText ?? '';
  if (decisionText) {
    const chain = selection.fallbackChain?.length ? ` · 대체 순서 ${selection.fallbackChain.join(' → ')}` : '';
    const detailMsg = selection.decisionDetail ? ` (${selection.decisionDetail})` : '';
    decisionEl.title = [
      selection.decisionUpstream ? `결정 지점: ${selection.decisionUpstream}` : null,
      selection.decisionReason ? `사유: ${selection.decisionReason}${detailMsg}` : null,
    ].filter(Boolean).join(' · ') + chain;
    decisionEl.setAttribute('aria-label',decisionText);
  } else { decisionEl.removeAttribute('title'); decisionEl.removeAttribute('aria-label'); }
  if (decisionText) node.dataset.decision = selection.decisionSource === 'local_fallback' ? 'local_fallback' : (selection.decisionSource === 'local' ? 'skipped' : 'remote_decision');
  else delete node.dataset.decision;
  node.setAttribute('aria-label',`게이트웨이가 고른 모델 ${selection.modelId}${roleLabel ? `, 역할 ${roleLabel}` : ''}${decisionText ? `, ${decisionText}` : ''}${strength ? `, ${strength}` : ''}`);
  node.title = `게이트웨이가 이 세션에 고른 모델입니다: ${selection.modelId}${selection.upstream ? ` (${selection.upstream})` : ''}${decisionText ? ` · ${decisionText}` : ''}`;
  detail.hidden = !strength;
  detail.textContent = strength;
  if (strength) detail.title = `게이트웨이가 보고한 추론 강도입니다: ${strength}`;
  else detail.removeAttribute('title');
}

function renderComposer() {
  const current = session(), vm = current?.vm;
  if (!current) return;
  renderModelLabel(current);
  const config = current.config;
  const refusal = refusalFor(current) ?? policyRefusal(current);
  const gate = routeGate(current);
  const outage = routeProblem(current);
  const blocked = refusal ?? gate;
  $('route').value = current.route;
  $('cloud-consent').checked = current.consent;
  $('model-name').textContent = config?.mock ? '모의 코어라 실제 추론은 하지 않습니다' : '전송 경로와 모델 선택은 서로 별개입니다';
  let statusText, statusState;
  if (refusal) { statusText = `${refusal.title}: ${refusal.message}`; statusState = 'refused'; }
  else if (vm.error && !current.ready) { statusText = vm.error.message; statusState = 'error'; }
  else if (outage) { statusText = `${outage.title}${outage.message ? `: ${outage.message}` : ''}`; statusState = 'error'; }
  else if (gate) { statusText = `${gate.title}${gate.message ? `: ${gate.message}` : ''}`; statusState = gate.state === 'unserved' ? 'error' : 'warn'; }
  else { statusText = current.ready ? '준비됨' : '연결 중'; statusState = current.ready ? 'ready' : 'checking'; }
  $('model-status').textContent = statusText;
  $('model-status').dataset.state = statusState;
  $('route-privacy').textContent = modelRoute(current) === 'cloud'
    ? '이 대화의 코드와 요청이 이 기기 밖으로 나갑니다. 동의는 이 페이지와 로컬 브리지에서 확인하며, 게이트웨이 쪽 검증 증명은 아직 구현되지 않았습니다.'
    : '루프백 주소라고 해서 추론이 반드시 이 기기 안에서 이루어지는 것은 아닙니다. 이 페이지는 전달된 포트가 실제로 어디로 가는지 확인할 수 없습니다.';

  $('send').disabled = !!blocked || !!promptBlockReason(current);
  const busy = current.ready && !['입력 대기','턴 완료','에이전트 작업 완료','연결 준비'].includes(vm.phase);
  $('abort').disabled = !busy;
  $('abort').hidden = !busy;
  const reason = promptBlockReason(current);
  $('send-reason').hidden = !blocked && !reason;
  $('send-reason').textContent = blocked ? `${blocked.title}: ${blocked.message}` : reason ?? '';

  renderFooterMetrics(current);
}

/**
 * Bottom status bar: cumulative tokens, throughput, cache hit rate on the left;
 * orchestration mode, gateway-chosen model and a live activity spinner on the
 * right. Values are reported measurements only; an absent one prints its zero
 * or em-dash form and never a fabricated figure.
 */
function renderFooterMetrics(current) {
  const vm = current?.vm;
  const speedEl = $('stat-speed'), speedBox = $('foot-speed');
  const cacheEl = $('stat-cache'), cacheBox = $('foot-cache');
  const tokensEl = $('stat-tokens'), tokensBox = $('foot-tokens');
  const modelEl = $('stat-model'), modelBox = $('foot-model');
  const spinner = $('foot-spinner');
  if (!speedEl) return;

  // 0. Context readout: window and percent
  const context = vm?.context;
  const footCtx = $('foot-right');
  if (footCtx) {
    if (context && context.window && Number.isFinite(context.percent)) {
      footCtx.textContent = `${fmtK(context.window)} 중 ${Math.round(context.percent)}%`;
      footCtx.title = `보고된 컨텍스트 사용량: 전체 ${fmtK(context.window)} 중 ${Math.round(context.percent)}% (${context.tokens ? fmtK(context.tokens) : ''} 토큰)`;
    } else {
      footCtx.textContent = '토큰 미보고';
      footCtx.title = '보고된 컨텍스트 사용량이 없습니다.';
    }
  }

  // 1. Token speed: rolling over recent frames
  const frames = vm?.usage?.frames ?? [];
  let speedValue = null;
  if (frames.length >= 2) {
    const first = frames[0], last = frames.at(-1);
    const elapsedSec = Math.max(0.1, (last.at - first.at) / 1000);
    const deltaTokens = frames.slice(1).reduce((sum, item) => sum + item.tokens, 0);
    if (elapsedSec > 0 && deltaTokens > 0) speedValue = deltaTokens / elapsedSec;
  }
  speedEl.textContent = speedValue === null ? '미측정' : `${speedValue >= 100 ? Math.round(speedValue) : speedValue.toFixed(1)}`;
  if (speedBox) speedBox.dataset.report = speedValue === null ? 'none' : 'reported';

  // 2. Cache hit rate: cache-read tokens ÷ prompt tokens
  const cacheRead = vm?.stats?.cacheRead ?? vm?.usage?.cacheRead ?? null;
  const promptTokens = vm?.stats?.prompt ?? vm?.usage?.promptTokens ?? null;
  let cacheValue = null;
  if (Number.isFinite(cacheRead) && Number.isFinite(promptTokens) && promptTokens > 0) {
    cacheValue = Math.min(100, Math.max(0, (cacheRead / promptTokens) * 100));
  }
  cacheEl.textContent = cacheValue === null ? '미측정' : `${cacheValue.toFixed(1)}%`;
  if (cacheBox) cacheBox.dataset.report = cacheValue === null ? 'none' : 'reported';

  // 3. Session cumulative tokens (single source of truth: sessionTokens)
  const totalTokens = sessionTokens(vm);
  tokensEl.textContent = Number.isFinite(totalTokens) && totalTokens > 0 ? fmtK(totalTokens) : '토큰 미보고';
  if (tokensBox) tokensBox.dataset.report = Number.isFinite(totalTokens) && totalTokens > 0 ? 'reported' : 'none';

  // 4. Gateway-chosen model, read back via unified resolvedModel
  const res = resolvedModel(vm);
  let modelText = 'VAYEX', modelReported = false;
  if (res?.id) {
    modelText = res.id;
    modelReported = true;
  }
  modelEl.textContent = modelText;
  if (modelBox) {
    modelBox.dataset.report = modelReported ? 'reported' : 'none';
    const sourceNote = res?.source ? ` (${res.source})` : '';
    modelBox.title = modelReported ? `게이트웨이가 고른 모델: ${modelText}${sourceNote}${res.endpoint ? ` · 엔드포인트 ${res.endpoint}` : ''}` : '모델 미보고 · 게이트웨이가 자동 선택';
  }

  // 6. Spinner and the journal card: they rotate/sweep while anything this page
  //    waits on (a core turn or a request it started) is still unanswered.
  const busy = pageWorkBusy(current);
  if (spinner) spinner.dataset.spin = String(busy);
  if ($('status-bar')) $('status-bar').dataset.state = busy ? 'busy' : current?.ready ? 'ready' : 'waiting';
  renderTimelineBusy(busy);
}

/* ------------------------------------------------- live work indicator */
/* Work this page waits on lasts far longer than a core turn: the local summarizer
   and the title model each take 8-13 s, and a document render is a second request.
   The pinned journal card therefore carries `data-busy` while *either* the core turn
   is in flight *or* a request this page itself started is still unanswered. The
   sweep is CSS (styles.css), so pixels keep changing without a JavaScript frame
   loop; this timer only repaints the honest elapsed-seconds text, once per second,
   from the moment the page started waiting — no percentage, no invented figure. */
let busyTicker = null;
/** Requests (insight/title/document) this page started and has not heard back from. */
function pageWorkStart(current) {
  if (!current) return;
  current.pageWork = (current.pageWork ?? 0) + 1;
  if (current.pageWorkStartedAt == null) current.pageWorkStartedAt = Date.now();
  syncWorkIndicator(current);
}
function pageWorkEnd(current) {
  if (!current) return;
  current.pageWork = Math.max(0, (current.pageWork ?? 0) - 1);
  if (current.pageWork === 0) current.pageWorkStartedAt = null;
  syncWorkIndicator(current);
}
function coreWorkBusy(current) {
  const vm = current?.vm;
  return !!current?.ready && !['입력 대기','턴 완료','에이전트 작업 완료','연결 준비'].includes(vm?.phase ?? '');
}
/** True while this page is genuinely waiting on something it can name. */
function pageWorkBusy(current) {
  return coreWorkBusy(current) || (current?.pageWork ?? 0) > 0;
}
/** The earliest real start among the waits currently in force; never a guess. */
function workStartedAt(current) {
  const core = coreWorkBusy(current), parts = [];
  if (core && Number.isFinite(current?.promptStarted)) parts.push(current.promptStarted);
  if (core && Number.isFinite(current?.activity?.main?.startedAt)) parts.push(current.activity.main.startedAt);
  if (Number.isFinite(current?.pageWorkStartedAt)) parts.push(current.pageWorkStartedAt);
  if (parts.length) return Math.min(...parts);
  return core ? current?.createdAt ?? null : null;
}
function paintBusyElapsed() {
  const card = $('timeline'), label = $('timeline-elapsed');
  if (!card || !label) return;
  if (card.dataset.busy !== 'true') { label.hidden = true; label.textContent = ''; return; }
  const started = workStartedAt(session());
  label.hidden = false;
  label.textContent = started === null ? '작업 중' : `작업 중 · ${formatElapsed(Math.max(0, Date.now() - started))}`;
}
function renderTimelineBusy(busy) {
  const card = $('timeline');
  if (!card) return;
  if (busy) card.dataset.busy = 'true';
  else card.removeAttribute('data-busy');
  paintBusyElapsed();
  if (busy && busyTicker === null) busyTicker = setInterval(paintBusyElapsed, 1000);
  else if (!busy && busyTicker !== null) { clearInterval(busyTicker); busyTicker = null; }
}
/** A page-started request begins or settles between renders; the card follows immediately. */
function syncWorkIndicator(current) {
  if (!current || activeKey !== current.key) return;
  renderTimelineBusy(pageWorkBusy(current));
}

/* --------------------------------------------------------------- interaction */
/** Desktop columns can be collapsed by the layout toggle; a jump target reopens the inspector first. */
function showInspector() {
  // Narrow: the inspector is a drawer, so only an explicit jump target opens it.
  if (narrowShell.matches) return;
  if (document.body.dataset.inspector !== 'closed') return;
  setInspectorMode(inspectorMode(), { closed:false });
}

function inspectorMode() {
  const mode = document.body.dataset.inspectorMode;
  return mode === 'fullscreen' ? 'fullscreen' : mode === 'expanded' ? 'expanded' : 'normal';
}

const INSPECTOR_MODE_LABELS = { normal:'표준', expanded:'확장', fullscreen:'전체 화면' };

function setInspectorMode(mode, { closed = false } = {}) {
  const next = ['normal','expanded','fullscreen'].includes(mode) ? mode : 'normal';
  document.body.dataset.inspectorMode = next;
  document.body.dataset.inspector = closed ? 'closed' : '';
  $('toggle-inspector')?.setAttribute('aria-pressed', String(!closed));
  const chip = $('insp-mode-label');
  if (chip) chip.textContent = closed ? '접힘' : INSPECTOR_MODE_LABELS[next];
  $('insp-expand')?.setAttribute('aria-pressed', String(next === 'expanded' && !closed));
  $('insp-fullscreen')?.setAttribute('aria-pressed', String(next === 'fullscreen' && !closed));
  if (closed) closeMenu();
}

function focusComposer() {
  if (narrowShell.matches && currentDrawer()) setDrawer('');
  if (inspectorMode() === 'fullscreen') setInspectorMode('normal');
  showInspector();
  $('inspector').querySelectorAll('.inspector-scroll').forEach(pane => { pane.scrollTop = 0; });
  $('prompt').focus();
}

function initInspectorModes() {
  setInspectorMode('normal');
  $('insp-collapse')?.addEventListener('click', () => {
    // Narrow: the inspector is a drawer, so its collapse control closes the drawer.
    if (narrowShell.matches) { setDrawer('', { restoreFocus:true }); return; }
    setInspectorMode(inspectorMode(), { closed:true });
  });
  $('insp-expand')?.addEventListener('click', () => {
    if (document.body.dataset.inspector === 'closed') { setInspectorMode('expanded'); return; }
    setInspectorMode(inspectorMode() === 'expanded' ? 'normal' : 'expanded');
  });
  $('insp-fullscreen')?.addEventListener('click', () => {
    setInspectorMode(inspectorMode() === 'fullscreen' ? 'normal' : 'fullscreen');
  });
  $('insp-chat')?.addEventListener('click', focusComposer);
}

/* ---------------------------------------------- narrow shell: side drawers */
/* Guides `responsive-design` and `navigation-drawer`: below 1180px the three tracks
   no longer fit, so the center keeps the whole width and each side panel opens as a
   modal drawer over it. The desktop column collapse (`data-sidebar`/`data-inspector`)
   is untouched — it only runs at and above the breakpoint. */
const narrowShell = window.matchMedia('(width < 1180px)');
const DRAWER_PANELS = { sidebar:'sidebar', inspector:'inspector' };
let drawerReturnFocus = null;
function currentDrawer() { return document.body.dataset.drawer ?? ''; }

/** Nodes this module made inert, so closing never clears inertness set elsewhere. */
const drawerInerted = new Set();
/** Everything outside the open drawer leaves the tab order and the accessibility tree:
    every shell column and every page-level sibling of the shell (skip link, dialog),
    except the scrim and the layers the drawer itself opens (menus, hint popovers). */
function applyDrawerModality() {
  const drawer = currentDrawer(), narrow = narrowShell.matches;
  for (const node of drawerInerted) node.inert = false;
  drawerInerted.clear();
  const panel = narrow && drawer ? $(DRAWER_PANELS[drawer]) : null;
  if (panel) {
    const shell = $('app');
    for (const node of [...document.body.children, ...shell.children]) {
      if (node === shell || node === panel || node.id === 'scrim' || node.inert || node.matches('script,.menu-pop,.hint-copy')) continue;
      node.inert = true;
      drawerInerted.add(node);
    }
  }
  for (const [key, id] of Object.entries(DRAWER_PANELS)) {
    const panel = $(id);
    if (!panel) continue;
    const open = narrow && drawer === key;
    // Guide `navigation-drawer`: a panel that is only a drawer while narrow is a modal
    // dialog; as a desktop column it is an ordinary aside and must not claim that role.
    if (open) { panel.setAttribute('role','dialog'); panel.setAttribute('aria-modal','true'); }
    else { panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); }
  }
  // Wide: the triggers stay the column toggles they always were (aria-pressed).
  // Narrow: they open a drawer, so they become disclosure buttons (aria-expanded).
  for (const [key, flag] of [['sidebar','sidebar'],['inspector','inspector']]) {
    const trigger = $(`toggle-${key}`);
    if (!trigger) continue;
    if (narrow) {
      trigger.removeAttribute('aria-pressed');
      trigger.setAttribute('aria-expanded', String(drawer === key));
      trigger.setAttribute('aria-controls', DRAWER_PANELS[key]);
    } else {
      trigger.removeAttribute('aria-expanded');
      trigger.removeAttribute('aria-controls');
      trigger.setAttribute('aria-pressed', String(document.body.dataset[flag] !== 'closed'));
    }
  }
}

function setDrawer(name, { restoreFocus = false } = {}) {
  const next = Object.hasOwn(DRAWER_PANELS, name) ? name : '';
  const previous = currentDrawer();
  if (previous === next) return;
  // Switching drawer to drawer keeps the original trigger as the return target: the
  // control that asked for the switch is inside the drawer that is closing.
  if (next && !previous) drawerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (next) document.body.dataset.drawer = next;
  else delete document.body.dataset.drawer;
  // Fullscreen is a mode of the open inspector drawer, not a way to keep it on screen
  // once the drawer has closed.
  if (previous === 'inspector' && inspectorMode() === 'fullscreen') {
    setInspectorMode('normal', { closed:document.body.dataset.inspector === 'closed' });
  }
  applyDrawerModality();
  if (next) {
    const panel = $(DRAWER_PANELS[next]);
    const target = panel?.querySelector('.drawer-close') ?? panel?.querySelector('button:not([disabled])');
    target?.focus({ preventScroll:true });
    return;
  }
  const back = drawerReturnFocus;
  drawerReturnFocus = null;
  if (restoreFocus && back?.isConnected) back.focus({ preventScroll:true });
}

/** The drawer's own sequential focus stops, in document order. */
function drawerTabStops(panel) {
  return [...panel.querySelectorAll('a[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable=true]')].filter(node => {
    if (node.tabIndex < 0 || node.disabled || node.closest('[inert]') || !node.getClientRects().length) return false;
    if (node.checkVisibility && !node.checkVisibility({ visibilityProperty:true })) return false;
    // A radio group is one stop: its checked member, or the first when none is checked.
    if (node.type === 'radio' && node.name) {
      const group = [...panel.querySelectorAll('input[type=radio]')].filter(radio => radio.name === node.name);
      return node === (group.find(radio => radio.checked) ?? group[0]);
    }
    return true;
  });
}

/** Leaving the sidebar for a destination elsewhere closes the sidebar drawer first,
    so the destination is visible and focusable. Returns whether a drawer closed. */
function leaveSidebarDrawer() {
  if (!narrowShell.matches || currentDrawer() !== 'sidebar') return false;
  setDrawer('');
  return true;
}

function initNarrowDrawers() {
  $('scrim')?.addEventListener('click', () => setDrawer('', { restoreFocus:true }));
  $('sidebar-close')?.addEventListener('click', () => setDrawer('', { restoreFocus:true }));
  document.addEventListener('keydown', event => {
    if (!currentDrawer() || !narrowShell.matches || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setDrawer('', { restoreFocus:true });
      return;
    }
    // Guide `navigation-drawer`: a modal drawer wraps Tab at both ends instead of
    // handing focus to the browser chrome past the inert page.
    if (event.key !== 'Tab') return;
    const panel = $(DRAWER_PANELS[currentDrawer()]);
    const stops = drawerTabStops(panel);
    if (!stops.length) return;
    const active = document.activeElement, inside = panel.contains(active);
    const atEdge = event.shiftKey ? active === stops[0] : active === stops.at(-1);
    if (inside && !atEdge) return;
    event.preventDefault();
    (event.shiftKey ? stops.at(-1) : stops[0]).focus();
  });
  // Crossing the breakpoint never leaves a drawer stranded over the desktop grid, and
  // a desktop fullscreen inspector never lands on the narrow shell as an overlay.
  narrowShell.addEventListener('change', () => {
    setDrawer('');
    if (inspectorMode() === 'fullscreen') setInspectorMode('normal', { closed:document.body.dataset.inspector === 'closed' });
    applyDrawerModality();
  });
  applyDrawerModality();
}

function openWorkspaceCard() {
  showInspector();
  if (narrowShell.matches) setDrawer('inspector');
  $('card-workspace').scrollIntoView({ block:'nearest' });
}
function openChangesCard() {
  showInspector();
  if (narrowShell.matches) setDrawer('inspector');
  switchInspectorTab('diff');
  $('card-session-changes').scrollIntoView({ block:'nearest' });
  const first = $('changes-rows').querySelector('details');
  if (first) first.open = true;
}
function setAgentsView(mode) {
  view.agents = mode;
  $('agents-list').setAttribute('aria-pressed',String(mode === 'list'));
  $('agents-graph').setAttribute('aria-pressed',String(mode === 'graph'));
  renderAgents();
}
function submitPrompt() {
  const current = session();
  if (!current) return;
  const message = $('prompt').value.trim();
  if (!message || refusalFor(current) || routeGate(current) || promptBlockReason(current)) return;
  if (!send(current,promptCommand(message))) return;
  current.vm.error = null;
  addPendingPrompt(current.vm, message);
  if (current.title === '새 작업') current.title = message.split('\n')[0].slice(0,48);
  if (!current.activity) current.activity = createActivity(current.createdAt);
  markPrompt(current.activity, message);
  current.promptStarted = Date.now(); current.durationMs = null;
  $('prompt').value = '';
  render();
  if (!current.titlePromptRequested) scheduleAutoTitle(current, { settled:false });
}

$('approval-approve')?.addEventListener('click', () => { const current = session(); if (current) answerGate(current,'approve'); });
$('approval-deny')?.addEventListener('click', () => { const current = session(); if (current) answerGate(current,'deny'); });
$('gate-confirm-yes')?.addEventListener('click', () => {
  const current = session(); if (!current) return;
  const info = gateRequest(current);
  if (!info) return;
  view.approvalConfirm.delete(info.request.id);
  const value = view.approvalPick.get(info.request.id) ?? defaultApprovalValue(info.request);
  if (value === null || !send(current, approvalCommand(info.request, value))) return;
  rememberGateAnswer(current, `코어 요청에 답했습니다: ${approvalLabel(value)}`);
});
$('gate-confirm-no')?.addEventListener('click', () => {
  const current = session(); if (!current) return;
  const info = gateRequest(current);
  if (!info) return;
  view.approvalConfirm.delete(info.request.id);
  $('gate-confirm').hidden = true;
});

$('composer').addEventListener('submit',event => { event.preventDefault(); submitPrompt(); });
$('prompt').addEventListener('keydown',event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
});
$('abort').addEventListener('click',() => {
  const current = session(); if (!current) return;
  if (!send(current,command('abort'))) return;
  current.vm.approvals = [];
  pruneDrafts(current);
  render();
});
for (const id of ['new-session','sidebar-new']) $(id).addEventListener('click',() => {
  const left = leaveSidebarDrawer();
  newSession();
  if (left) $('prompt').focus();
});
for (const id of ['sidebar-search','menu-search']) $(id).addEventListener('click',() => { leaveSidebarDrawer(); $('search-bar').hidden = false; $('search-input').focus(); });
$('search-close').addEventListener('click',() => { $('search-bar').hidden = true; $('search-input').value = ''; view.search = ''; renderThread(); });
$('search-input').addEventListener('input',event => { view.search = event.target.value; renderThread(); });
$('menu-agents').addEventListener('click',() => {
  const left = leaveSidebarDrawer();
  showInspector();
  if (narrowShell.matches) setDrawer('inspector');
  switchInspectorTab('agents');
  $('agents-collapse')?.setAttribute('aria-expanded','true');
  if ($('agents-body')) $('agents-body').hidden = false;
  if (left) $('tab-agents')?.focus({ preventScroll:true });
});
$('menu-more').addEventListener('click',event => openMenu(event.currentTarget,[
  { label:'데스크톱 앱 전용 기능', disabled:true, title:'일부 데스크톱 앱 전용 기능은 이 웹 브리지에서 사용할 수 없습니다. 이 브리지는 대화와 작업 정보만 다룹니다.' },
  { label:'문서', disabled:true, title:'브리지 설명 문서는 이 페이지에 들어 있지 않습니다.' }
]));
$('agents-collapse').addEventListener('click',event => {
  const open = event.currentTarget.getAttribute('aria-expanded') === 'true';
  event.currentTarget.setAttribute('aria-expanded',String(!open));
  $('agents-body').hidden = open;
});
$('agents-list').addEventListener('click',() => setAgentsView('list'));
$('agents-graph').addEventListener('click',() => setAgentsView('graph'));
/** The timeline view mode and collapse state belong to the session, not the page. */
function setTimelineMode(mode) {
  const current = session();
  if (!current) return;
  current.timelineMode = 'journal';
  renderTimeline();
  paintTimelineSwap();
}
$('timeline-collapse').addEventListener('click',event => {
  const current = session();
  if (!current) return;
  const open = event.currentTarget.getAttribute('aria-expanded') === 'true';
  current.timelineOpen = !open;
  event.currentTarget.setAttribute('aria-expanded',String(!open));
  $('timeline-body').hidden = open;
});
$('timeline-grouped')?.addEventListener('click',() => setTimelineMode('journal'));
$('toggle-inspector').addEventListener('click',() => {
  if (narrowShell.matches) { setDrawer(currentDrawer() === 'inspector' ? '' : 'inspector', { restoreFocus:true }); return; }
  const closed = document.body.dataset.inspector === 'closed';
  setInspectorMode(closed ? inspectorMode() : 'normal', { closed:!closed });
  applyDrawerModality();
});
$('toggle-sidebar').addEventListener('click',() => {
  if (narrowShell.matches) { setDrawer(currentDrawer() === 'sidebar' ? '' : 'sidebar', { restoreFocus:true }); return; }
  const closed = document.body.dataset.sidebar === 'closed';
  document.body.dataset.sidebar = closed ? '' : 'closed';
  $('toggle-sidebar').setAttribute('aria-pressed',String(closed));
  applyDrawerModality();
});
$('changes-review').addEventListener('click',openChangesCard);
$('project-chip-head').addEventListener('click',openWorkspaceCard);
$('thread-project').addEventListener('click',openWorkspaceCard);
$('head-more').addEventListener('click',event => openMenu(event.currentTarget,[
  { label:'새 작업', run:() => newSession() },
  { label:'대화에서 찾기', run:() => { $('search-bar').hidden = false; $('search-input').focus(); } },
  { label:'정보 패널 접기/펼치기', run:() => $('toggle-inspector').click() },
  { label:'응답 멈추기', disabled:!session()?.ready, title:'브리지가 준비되면 쓸 수 있습니다.', run:() => $('abort').click() }
]));
$('chip-more').addEventListener('click',event => openMenu(event.currentTarget,[
  { label:'작업 공간 정보', run:openWorkspaceCard },
  { label:'바뀐 파일', run:openChangesCard },
  { label:'프로젝트 바꾸기', disabled:true, title:'이 브리지는 작업마다 작업 공간을 하나만 씁니다.' }
]));
$('route').addEventListener('change',event => {
  const current = session(); if (!current) return;
  current.route = event.target.value;
  current.routeManuallySet = true;
  current.consent = false;
  connect(current);
});
$('cloud-consent').addEventListener('change',event => {
  const current = session(); if (!current) return;
  current.consent = event.target.checked;
  connect(current);
});
document.addEventListener('pointerdown',event => {
  if (openMenuNode && !openMenuNode.contains(event.target)) closeMenu();
});
window.addEventListener('keydown',event => {
  if (event.key !== 'Escape') return;
  // Guide `dialog`: the modal studio owns its own Escape, so the page-level Escape
  // handlers stay out of the way while it is open.
  if ($('theme-studio')?.open) return;
  if (inspectorMode() === 'fullscreen') setInspectorMode('normal');
  closeMenu();
});
window.addEventListener('pagehide',() => { for (const current of sessions.values()) current.socket?.close(); });

/* ============================================================== Workbench features
   Orca/Paseo integration: M3 theme, resizable 3 panes, DX diff viewer, live preview & design mode */

const STORAGE_KEYS = {
  theme: 'student-omp:theme',
  studio: 'student-omp:theme-studio',
  sidebarWidth: 'student-omp:col-sidebar-w',
  inspectorWidth: 'student-omp:col-inspector-w'
};

function safeStorageGet(key, fallback = null) {
  try {
    const val = window.localStorage?.getItem(key);
    return val !== null && val !== undefined ? val : fallback;
  } catch {
    return fallback;
  }
}

function safeStorageSet(key, value) {
  try {
    window.localStorage?.setItem(key, String(value));
  } catch {}
}

/* 1. Theme Studio — layered backdrop + stable, high-contrast reading surfaces */
const STUDIO_DEFAULT = { preset:'daylight', accent:null, intensity:70, alpha:92, motion:true };
const LEGACY_THEME_IDS = { dark:'obsidian', light:'daylight', navy:'maritime', teal:'aurora', 'high-contrast':'contrast' };
const THEME_PRESETS = [
  { id:'obsidian', label:'옵시디언 다크', short:'옵시디언', hint:'Linear 스타일의 차분한 다크 표면', accent:'#8ab4ff', mode:'dark',
    preview:'radial-gradient(120% 90% at 16% 0%, rgb(76 125 255 / .38), transparent 68%), linear-gradient(150deg,#101114,#21242a 68%,#31343c)' },
  { id:'daylight', label:'소프트 데이라이트', short:'데이라이트', hint:'따뜻하고 깨끗한 고대비 라이트', accent:'#0b6e5f', mode:'light',
    preview:'radial-gradient(120% 90% at 12% 0%, #f7d9b6, transparent 70%), linear-gradient(150deg,#fbf8f2,#efe9df 70%,#ded4c4)' },
  { id:'aurora', label:'오로라 글로우', short:'오로라', hint:'에메랄드·시안·바이올렛 오로라', accent:'#5eead4', mode:'dark',
    preview:'radial-gradient(85% 120% at 8% 0%, rgb(16 185 129 / .75), transparent 62%), radial-gradient(85% 120% at 88% 0%, rgb(34 211 238 / .6), transparent 64%), radial-gradient(100% 120% at 56% 110%, rgb(139 92 246 / .6), transparent 70%)' },
  { id:'lavender', label:'라벤더 미스트', short:'라벤더', hint:'파스텔 라벤더·로즈, 다크/라이트 적응', accent:'#6d4bd8', mode:'light',
    preview:'radial-gradient(95% 110% at 10% 0%, #e8d9ff, transparent 66%), radial-gradient(95% 110% at 90% 0%, #ffd9e6, transparent 70%), linear-gradient(150deg,#fcfaff,#e9dff5)' },
  { id:'coral', label:'코랄 선셋', short:'코랄', hint:'따뜻한 피치·앰버 그라데이션', accent:'#c2410c', mode:'light',
    preview:'radial-gradient(100% 110% at 8% 0%, #ffe0bd, transparent 66%), radial-gradient(100% 110% at 92% 2%, #ffc9b3, transparent 70%), linear-gradient(150deg,#fffaf6,#f0dccd)' },
  { id:'maritime', label:'마리타임 보야지', short:'마리타임', hint:'심해 파도 일러스트와 청록 표면', accent:'#67d4f5', mode:'dark',
    preview:'radial-gradient(90% 110% at 20% 0%, rgb(56 189 248 / .55), transparent 64%), radial-gradient(90% 110% at 84% 6%, rgb(14 116 144 / .6), transparent 68%), linear-gradient(180deg,#0a202c,#061620)' },
  { id:'contrast', label:'하이 콘트라스트', short:'고대비', hint:'WCAG AAA 검정·노랑 표면', accent:'#ffe100', mode:'dark',
    preview:'linear-gradient(150deg,#000000,#121212 70%,#202020)' }
];
const ACCENT_SWATCHES = ['#8ab4ff','#5eead4','#a78bfa','#fb7185','#fbbf24','#7dd3fc','#34d399','#f472b6','#ff6b35'];

function clampNumber(value,min,max,fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max,Math.max(min,number)) : fallback;
}
function sanitizeStudio(raw) {
  return {
    preset: THEME_PRESETS.some(item => item.id === raw?.preset) ? raw.preset : STUDIO_DEFAULT.preset,
    accent: typeof raw?.accent === 'string' && /^#[0-9a-f]{6}$/i.test(raw.accent) ? raw.accent.toLowerCase() : null,
    intensity: clampNumber(raw?.intensity,0,100,STUDIO_DEFAULT.intensity),
    alpha: clampNumber(raw?.alpha,75,100,STUDIO_DEFAULT.alpha),
    motion: raw?.motion !== false
  };
}
function readStudioState() {
  try {
    const raw = safeStorageGet(STORAGE_KEYS.studio);
    if (raw) return sanitizeStudio(JSON.parse(raw));
    const legacy = safeStorageGet(STORAGE_KEYS.theme);
    if (legacy) return sanitizeStudio({ ...STUDIO_DEFAULT, preset:LEGACY_THEME_IDS[legacy] ?? legacy });
  } catch {}
  return { ...STUDIO_DEFAULT };
}
let studioState = readStudioState();

function presetById(id) { return THEME_PRESETS.find(item => item.id === id) ?? THEME_PRESETS.find(item => item.id === STUDIO_DEFAULT.preset) ?? THEME_PRESETS[0]; }
function hexToRgbTriplet(hex) {
  const value = hex.replace('#','');
  const full = value.length === 3 ? value.split('').map(char => char + char).join('') : value;
  const number = Number.parseInt(full,16);
  return `${(number >> 16) & 255} ${(number >> 8) & 255} ${number & 255}`;
}

function applyStudio(next = studioState, { persist = true } = {}) {
  studioState = sanitizeStudio(next);
  const root = document.documentElement;
  const preset = presetById(studioState.preset);
  root.dataset.theme = studioState.preset;
  root.style.colorScheme = preset.mode;
  const accent = studioState.accent || preset.accent;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-rgb', hexToRgbTriplet(accent));
  root.style.setProperty('--bg-intensity', String(studioState.intensity / 100));
  root.style.setProperty('--surface-alpha', String(studioState.alpha / 100));
  document.body.dataset.motion = studioState.motion ? 'on' : 'off';
  document.querySelector('meta[name=color-scheme]')?.setAttribute('content', preset.mode === 'light' ? 'light dark' : 'dark light');
  const btn = $('theme-toggle');
  if (btn) {
    btn.title = `테마 스튜디오 · ${preset.label}`;
    btn.setAttribute('aria-label', `테마 스튜디오 열기 · 현재 ${preset.label}`);
    const use = btn.querySelector('use');
    if (use) use.setAttribute('href','#ic-palette');
  }
  const label = $('theme-label');
  if (label) label.textContent = preset.short ?? preset.label;
  if (persist) safeStorageSet(STORAGE_KEYS.studio, JSON.stringify(studioState));
  reflectStudioControls();
}

/* Guide `accessibility` (focus management): the preset and swatch lists are rebuilt on
   every selection, which removes the button that was just activated and drops keyboard
   focus to <body>. Focus moves to the same-position replacement only when it was already
   inside that list, so a pointer click in a browser that does not focus buttons on click
   is never handed focus it did not have. */
function rerenderKeepingFocus(hostId, render) {
  const host = $(hostId);
  const index = host ? [...host.children].indexOf(document.activeElement) : -1;
  render();
  if (index !== -1) host.children[index]?.focus();
}

function renderStudioPresets() {
  const host = $('studio-presets');
  if (!host) return;
  host.replaceChildren();
  for (const preset of THEME_PRESETS) {
    const card = el('button','preset-card');
    card.type = 'button';
    card.dataset.preset = preset.id;
    card.setAttribute('role','radio');
    card.setAttribute('aria-checked', String(studioState.preset === preset.id));
    card.setAttribute('aria-label', `${preset.label} — ${preset.hint}`);
    const preview = el('div','preset-preview');
    preview.style.background = preset.preview;
    const dot = el('span','preset-dot');
    dot.style.background = preset.accent;
    preview.append(dot);
    const copy = el('span','preset-copy');
    copy.append(el('span','preset-name',preset.label), el('span','preset-hint',preset.hint));
    card.append(preview, copy);
    if (studioState.preset === preset.id) {
      const check = icon('ic-check');
      check.classList.add('preset-check');
      card.append(check);
    }
    card.addEventListener('click', () => {
      applyStudio({ ...studioState, preset:preset.id });
      rerenderKeepingFocus('studio-presets', renderStudioPresets);
      renderStudioSwatches();
    });
    host.append(card);
  }
}

function renderStudioSwatches() {
  const host = $('studio-swatches');
  if (!host) return;
  const preset = presetById(studioState.preset);
  host.replaceChildren();
  const auto = el('button','studio-swatch');
  auto.type = 'button';
  auto.dataset.auto = 'true';
  auto.dataset.selected = String(!studioState.accent);
  auto.style.background = preset.accent;
  auto.title = `${preset.label} 기본 강조 색`;
  auto.setAttribute('aria-label', `${preset.label} 기본 강조 색`);
  auto.addEventListener('click', () => { applyStudio({ ...studioState, accent:null }); rerenderKeepingFocus('studio-swatches', renderStudioSwatches); });
  host.append(auto);
  for (const color of ACCENT_SWATCHES) {
    const swatch = el('button','studio-swatch');
    swatch.type = 'button';
    swatch.style.background = color;
    swatch.dataset.selected = String(studioState.accent === color.toLowerCase());
    swatch.setAttribute('aria-label', `강조 색 ${color}`);
    swatch.addEventListener('click', () => { applyStudio({ ...studioState, accent:color }); rerenderKeepingFocus('studio-swatches', renderStudioSwatches); });
    host.append(swatch);
  }
}

function reflectStudioControls() {
  const preset = presetById(studioState.preset);
  const intensity = $('studio-intensity');
  if (intensity) intensity.value = String(studioState.intensity);
  const intensityLabel = $('studio-intensity-label');
  if (intensityLabel) intensityLabel.textContent = `${studioState.intensity}%`;
  const alpha = $('studio-alpha');
  if (alpha) alpha.value = String(studioState.alpha);
  const alphaLabel = $('studio-alpha-label');
  if (alphaLabel) alphaLabel.textContent = `${studioState.alpha}%`;
  const motion = $('studio-motion');
  if (motion) motion.checked = studioState.motion;
  const accent = $('studio-accent');
  const accentValue = $('studio-accent-value');
  const accentHex = studioState.accent || preset.accent;
  if (accent) accent.value = accentHex;
  if (accentValue) accentValue.textContent = studioState.accent ? `${accentHex} · 사용자 지정` : `${accentHex} · 프리셋 기본`;
  const note = $('studio-note');
  if (note) note.textContent = `${preset.label} · 배경 ${studioState.intensity}% · 표면 ${studioState.alpha}% · 변경은 즉시 적용되고 이 기기에 저장됩니다.`;
}

function openThemeStudio() {
  const box = $('theme-studio');
  if (!box || box.open) return;
  renderStudioPresets();
  renderStudioSwatches();
  reflectStudioControls();
  // Guides `dialog` + `accessibility`: showModal() promotes the panel to the top layer,
  // makes the page behind it inert and returns focus to this trigger on close, so there
  // is no manual focus trap, no inert toggling and no aria-modal here.
  box.showModal();
  $('theme-toggle')?.setAttribute('aria-expanded','true');
  $('theme-studio-close')?.focus();
}

function closeThemeStudio() {
  const box = $('theme-studio');
  if (!box || !box.open) return;
  box.close();
  $('theme-toggle')?.setAttribute('aria-expanded','false');
}

function initTheme() {
  applyStudio(studioState);
  const studioBox = $('theme-studio');
  $('theme-toggle')?.addEventListener('click', () => {
    if (studioBox?.open) closeThemeStudio();
    else openThemeStudio();
  });
  $('theme-studio-close')?.addEventListener('click', () => closeThemeStudio());
  // Esc, the mobile back gesture and the close button all land here, so the trigger's
  // expanded state is synced from the dialog's real state instead of from each path.
  studioBox?.addEventListener('close', () => $('theme-toggle')?.setAttribute('aria-expanded','false'));
  studioBox?.addEventListener('pointerdown', event => { if (event.target === studioBox) closeThemeStudio(); });
  $('studio-intensity')?.addEventListener('input', event => applyStudio({ ...studioState, intensity:Number(event.target.value) }));
  $('studio-alpha')?.addEventListener('input', event => applyStudio({ ...studioState, alpha:Number(event.target.value) }));
  $('studio-accent')?.addEventListener('input', event => {
    applyStudio({ ...studioState, accent:event.target.value });
    renderStudioSwatches();
  });
  $('studio-motion')?.addEventListener('change', event => applyStudio({ ...studioState, motion:event.target.checked }));
  $('studio-reset')?.addEventListener('click', () => {
    applyStudio({ ...STUDIO_DEFAULT });
    renderStudioPresets();
    renderStudioSwatches();
  });
  // Guide `dialog`: no Escape handler here — on a modal <dialog> the browser closes the
  // dialog on Escape (and the back gesture) itself and fires `close`, which the listener
  // above already uses to sync the trigger's aria-expanded.
  $('foot-model')?.addEventListener('click', event => {
    const current = session();
    const selection = current?.vm?.selection;
    openMenu(event.currentTarget,[
      { label:selection?.modelId ?? current?.vm?.coreModel ?? 'VAYEX', hint:'게이트웨이가 고른 모델', disabled:true, title:'모델은 게이트웨이가 고르며 이 페이지에서는 바꾸지 않습니다.' },
      { label:'Auto', hint:'게이트웨이 자동 선택', disabled:true, title:'이 페이지는 모델 지정 명령을 보내지 않습니다.' },
      { label:'모델 선택 정보', hint:'읽기 전용', run:() => switchInspectorTab('overview') }
    ]);
  });
}

/* 2. Resizable 3-pane layout */
const SPLIT_LIMITS = {
  sidebar: { min:200, max:420, cssVar:'--col-sidebar', aliasVar:'--sidebar-w', storage:STORAGE_KEYS.sidebarWidth },
  inspector: { min:300, max:560, cssVar:'--col-inspector', aliasVar:'--inspector-w', storage:STORAGE_KEYS.inspectorWidth }
};
/** The one clamp every applied width goes through: drag, keyboard and boot restore. */
function clampSplitWidth(target, width) {
  const { min, max } = SPLIT_LIMITS[target];
  return Math.max(min, Math.min(max, Math.round(width)));
}
function initResizablePanes() {
  const rootStyle = document.documentElement.style;
  // Restore through the same clamp the drag uses: a width stored on a wider window
  // must not re-apply verbatim after the window shrinks.
  for (const [target, limits] of Object.entries(SPLIT_LIMITS)) {
    const saved = safeStorageGet(limits.storage);
    if (saved === null || saved === '' || !Number.isFinite(Number(saved))) continue;
    const width = clampSplitWidth(target, Number(saved));
    rootStyle.setProperty(limits.cssVar, `${width}px`);
    rootStyle.setProperty(limits.aliasVar, `${width}px`);
    $(`split-${target}`)?.setAttribute('aria-valuenow', String(width));
    if (width !== Math.round(Number(saved))) safeStorageSet(limits.storage, width);
  }

  function bindSplit(splitEl, { target, onDone }) {
    if (!splitEl) return;
    const { cssVar } = SPLIT_LIMITS[target];
    let startX = 0, startWidth = 0;

    const onPointerMove = event => {
      const delta = target === 'sidebar' ? (event.clientX - startX) : (startX - event.clientX);
      const nextWidth = clampSplitWidth(target, startWidth + delta);
      rootStyle.setProperty(cssVar, `${nextWidth}px`);
      if (target === 'sidebar') rootStyle.setProperty('--sidebar-w', `${nextWidth}px`);
      if (target === 'inspector') rootStyle.setProperty('--inspector-w', `${nextWidth}px`);
      splitEl.setAttribute('aria-valuenow', String(Math.round(nextWidth)));
    };

    const onPointerUp = () => {
      document.body.removeAttribute('data-dragging');
      splitEl.removeAttribute('data-dragging');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      const finalW = Math.round(Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)));
      if (!Number.isNaN(finalW)) onDone(finalW);
    };

    splitEl.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      startX = event.clientX;
      startWidth = Math.round(Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)));
      document.body.setAttribute('data-dragging', 'true');
      splitEl.setAttribute('data-dragging', 'true');
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    });

    splitEl.addEventListener('keydown', event => {
      const step = event.shiftKey ? 20 : 5;
      let cur = Math.round(Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)));
      let next = cur;
      if (target === 'sidebar') {
        if (event.key === 'ArrowRight') next = cur + step;
        else if (event.key === 'ArrowLeft') next = cur - step;
      } else {
        if (event.key === 'ArrowLeft') next = cur + step;
        else if (event.key === 'ArrowRight') next = cur - step;
      }
      if (next !== cur) {
        event.preventDefault();
        next = clampSplitWidth(target, next);
        rootStyle.setProperty(cssVar, `${next}px`);
        splitEl.setAttribute('aria-valuenow', String(next));
        onDone(next);
      }
    });
  }

  bindSplit($('split-sidebar'), {
    target: 'sidebar',
    onDone: w => safeStorageSet(STORAGE_KEYS.sidebarWidth, w)
  });

  bindSplit($('split-inspector'), {
    target: 'inspector',
    onDone: w => safeStorageSet(STORAGE_KEYS.inspectorWidth, w)
  });
}

const TAB_HINTS = {
  overview: '지금 단계와 바뀐 파일, 실행 중인 작업.',
  agents: '메인 작업과 하위 에이전트 실행 현황.',
  visualize: '세션 기록으로 결과 문서를 만들고 내보냅니다.',
  stats: '에이전트 관계, 토큰·비용, 기억 구성.',
  preview: '화면을 열어 확인하고 요소를 골라 수정 요청을 작성합니다.',
  diff: '바뀐 코드를 줄 단위로 비교하고 되돌립니다.',
  memory: 'AI가 저장한 규칙과 세션 기억.'
};

/* 3. Tabbed inspector */
const inspectorPanes = ['overview', 'agents', 'visualize', 'stats', 'preview', 'diff', 'memory'];
function switchInspectorTab(name) {
  if (!inspectorPanes.includes(name)) name = 'overview';
  const changed = document.querySelector('.insp-tab[aria-selected=true]')?.dataset.tab !== name;
  showInspector();
  for (const pane of inspectorPanes) {
    const tab = $(`tab-${pane}`);
    const panel = $(`pane-${pane}`);
    const active = pane === name;
    if (tab) {
      tab.setAttribute('aria-selected', String(active));
      // Guide `tabs`: the Tab key must land on the selected tab, so every other tab
      // leaves the sequential focus order and arrows move within the group.
      tab.tabIndex = active ? 0 : -1;
      tab.classList.toggle('active', active);
    }
    if (panel) {
      panel.hidden = !active;
    }
  }
  const hint = $('insp-hint');
  if (hint && TAB_HINTS[name]) hint.textContent = TAB_HINTS[name];
  if (name === 'diff') loadActiveDiff();
  if (name === 'preview') loadPreview();
  if (name === 'visualize') renderDocTab();
  if (name === 'stats') renderStatsTab();
  if (name === 'memory') loadMemoryStatus();
  if (changed) paintInspectorSwap($(`pane-${name}`));
}

function initInspectorTabs() {
  $('insp-tabs')?.addEventListener('click', event => {
    const tab = event.target.closest('.insp-tab');
    if (!tab) return;
    const name = tab.dataset.tab;
    if (name) switchInspectorTab(name);
  });
  $('insp-tabs')?.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const active = inspectorPanes.indexOf(document.querySelector('.insp-tab[aria-selected=true]')?.dataset.tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? inspectorPanes.length - 1 : (active + (event.key === 'ArrowRight' ? 1 : -1) + inspectorPanes.length) % inspectorPanes.length;
    switchInspectorTab(inspectorPanes[next]);
    $(`tab-${inspectorPanes[next]}`)?.focus();
  });
}

/* ---------------------------------------------------------- hint tooltips */
/* Guides `interest-triggered-tooltips` and `position-aware-tooltips`: every hint is a
   `popover="hint"` layer, so the platform owns light dismiss, Escape and layering,
   the trigger keeps its accessible name and `aria-describedby` carries the hint text.
   Browsers without interest invokers get the same hover/focus/tap behaviour from the
   listeners below; the hint never takes focus or the click away from its control. */
function initHintTips() {
  const hints = new Map([...document.querySelectorAll('.hint-tip')].map(tip => [tip.id, tip]));
  if (!hints.size) return;
  const describedBy = node => (node.getAttribute('aria-describedby') ?? '').trim();
  const triggers = [...document.querySelectorAll('[aria-describedby]')].filter(node => hints.has(describedBy(node)));
  const probe = document.createElement('div');
  probe.setAttribute('popover','hint');
  const supportsPopover = probe.popover === 'hint' && typeof probe.showPopover === 'function';
  const supportsAnchor = typeof CSS !== 'undefined' && CSS.supports?.('position-anchor','--x');
  const tipFor = trigger => hints.get(describedBy(trigger));
  let shown = null;

  const hide = tip => {
    if (!tip) return;
    if (supportsPopover) { if (tip.matches(':popover-open')) tip.hidePopover(); }
    else tip.removeAttribute('data-open');
    if (shown === tip) shown = null;
  };
  // A visually hidden radio is described by the hint, but the pointer and the eye are
  // on its label, so the label is the hover target and the anchor.
  const hostOf = trigger => trigger.closest('label') ?? trigger;
  const place = (trigger, tip) => {
    const host = hostOf(trigger);
    if (supportsAnchor) {
      host.style.setProperty('anchor-name', `--hint-${tip.id}`);
      tip.style.setProperty('position-anchor', `--hint-${tip.id}`);
      return;
    }
    // Fallback placement: below the trigger and kept inside the viewport.
    const box = host.getBoundingClientRect();
    const width = tip.offsetWidth || 220;
    tip.style.top = `${Math.round(box.bottom + 6)}px`;
    tip.style.left = `${Math.round(Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - width - 8)))}px`;
  };
  const show = trigger => {
    const tip = tipFor(trigger);
    if (!tip) return;
    if (shown && shown !== tip) hide(shown);
    place(trigger, tip);
    if (supportsPopover) { if (!tip.matches(':popover-open')) tip.showPopover(); }
    else tip.dataset.open = 'true';
    shown = tip;
  };

  for (const trigger of triggers) {
    const host = hostOf(trigger);
    host.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') show(trigger); });
    host.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') hide(tipFor(trigger)); });
    trigger.addEventListener('focus', () => show(trigger));
    trigger.addEventListener('blur', () => hide(tipFor(trigger)));
    // Touch and pen have no hover: the tap shows the hint and still reaches the control,
    // so the tab or radio behaves exactly as before.
    host.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      const tip = tipFor(trigger);
      if (shown === tip) hide(tip);
      else show(trigger);
    });
  }
  // WCAG 1.4.13 dismissible: Escape closes the hint before anything else reacts to it.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !shown) return;
    event.stopPropagation();
    hide(shown);
  }, true);
  document.addEventListener('pointerdown', event => {
    if (!shown || shown.contains(event.target) || event.target.closest?.('[aria-describedby],.doc-type')) return;
    hide(shown);
  }, true);
  window.addEventListener('scroll', () => { if (shown) hide(shown); }, true);
}

/* ------------------------------------------------------ scoped transitions */
/* The state is applied synchronously first; the swapped-in pane then animates on
   its own element, so the effect only changes how the swap looks. An element-scoped
   View Transition is not used: while it runs, Chrome takes the whole scope subtree
   out of hit-testing (presses land on its parent even with `pointer-events:none` on
   the pseudo-elements), so controls would ignore taps for the animation's length. */
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function paintScopedSwap(target) {
  // A closed <details> still reports client rects for its content, so check the
  // disclosure itself: nothing on screen would swap.
  if (!target || target.hidden || !target.getClientRects().length || target.closest('details:not([open])')) return null;
  if (typeof target.animate !== 'function' || reducedMotion.matches) return null;
  return target.animate([{ opacity:.6, transform:'translateY(6px)' }, { opacity:1, transform:'none' }], { duration:180, easing:'ease' });
}
function paintInspectorSwap(pane) {
  return paintScopedSwap(pane);
}
function paintTimelineSwap() {
  return paintScopedSwap($('timeline-groups'));
}

/* 4. Diff Review Panel (Orca / Paseo style) */
let activeDiffData = null;
function currentTaskId() {
  const current = session();
  const input = $('diff-task-id');
  if (input?.value?.trim()) return input.value.trim();
  return current?.bridgeId || 'demo-task';
}

function parseUnifiedLines(rawDiff) {
  if (!rawDiff) return [];
  const lines = rawDiff.split('\n');
  const result = [];
  let lineA = 0, lineB = 0;
  for (const raw of lines) {
    if (raw.startsWith('---') || raw.startsWith('+++')) {
      result.push({ kind: 'meta', text: raw, numA: '', numB: '' });
      continue;
    }
    const hunkMatch = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      lineA = Number(hunkMatch[1]);
      lineB = Number(hunkMatch[2]);
      result.push({ kind: 'hunk', text: raw, numA: '…', numB: '…' });
      continue;
    }
    if (raw.startsWith('+')) {
      result.push({ kind: 'add', text: raw.slice(1), numA: '', numB: lineB });
      lineB++;
    } else if (raw.startsWith('-')) {
      result.push({ kind: 'del', text: raw.slice(1), numA: lineA, numB: '' });
      lineA++;
    } else {
      result.push({ kind: 'keep', text: raw.startsWith(' ') ? raw.slice(1) : raw, numA: lineA || '', numB: lineB || '' });
      if (lineA) lineA++;
      if (lineB) lineB++;
    }
  }
  return result;
}

function renderDiffFileCard(file, taskId) {
  const card = el('div', 'diff-file');
  card.dataset.path = file.path;

  const head = el('div', 'diff-file-head');
  const badge = el('span', 'diff-badge', file.status === 'reverted' ? '되돌림' : file.fileType);
  badge.dataset.badge = file.status === 'reverted' ? 'reverted' : file.fileType;

  const path = el('span', 'diff-path', file.path);
  path.title = file.path;

  const stat = el('span', 'diff-stat');
  stat.append(el('span', 'add', `+${file.additions}`), document.createTextNode(' '), el('span', 'del', `-${file.deletions}`));

  const actions = el('div', 'diff-file-actions');
  const btnRevert = el('button', 'icon-btn revert');
  btnRevert.type = 'button';
  btnRevert.setAttribute('aria-label', `${file.path} 이전 상태로 되돌리기`);
  btnRevert.title = '이 파일만 원래대로 되돌리기';
  btnRevert.append(icon('ic-undo'));
  btnRevert.disabled = file.status === 'reverted';
  btnRevert.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/dx/snapshot/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, filePath: file.path })
      });
      if (res.ok) loadActiveDiff();
    } catch {}
  });

  actions.append(btnRevert);
  head.append(badge, path, stat, actions);
  card.append(head);

  const body = el('div', 'diff-body');
  const lines = parseUnifiedLines(file.diff);
  if (!lines.length) {
    body.append(el('p', 'agent-empty diff-empty', '내용 변경 없음 (동일한 파일)'));
  } else {
    for (const line of lines) {
      const row = el('div', 'dl');
      row.dataset.kind = line.kind;
      const numA = el('span', 'dln', String(line.numA));
      const numB = el('span', 'dln', String(line.numB));
      const mark = el('span', 'dmark', line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ');
      const text = el('span', 'dtext', line.text);
      row.append(numA, numB, mark, text);
      body.append(row);
    }
  }
  card.append(body);
  return card;
}

async function loadActiveDiff() {
  const taskId = currentTaskId();
  const input = $('diff-task-id');
  if (input && !input.value) input.value = taskId;
  const host = $('diff-files');
  const summary = $('diff-summary');
  const btnRollback = $('diff-rollback');

  /* Guide `accessibility` (live regions + status messages): a failed read must leave
     the panel saying what is on screen. The previous task's cards are removed here so
     a mistyped id can never be mistaken for the diff that was just asked for, and the
     empty-state text replaces them inside #diff-files, the polite live region. */
  const showDiffFailure = message => {
    activeDiffData = null;
    if (summary) summary.textContent = message;
    if (btnRollback) btnRollback.disabled = true;
    if (host) {
      host.replaceChildren();
      host.append(el('p', 'agent-empty', message));
    }
  };

  try {
    const res = await fetch(`/api/dx/snapshot/diff?taskId=${encodeURIComponent(taskId)}`);
    if (!res.ok) {
      showDiffFailure(`작업 ID "${taskId}"의 스냅샷 없음 (HTTP ${res.status})`);
      return;
    }
    const data = await res.json();
    activeDiffData = data;
    const files = data.files || [];
    if (summary) {
      summary.textContent = files.length
        ? `파일 ${files.length}개 변경됨 (+${data.summary?.totalAdditions ?? 0}줄 / -${data.summary?.totalDeletions ?? 0}줄)`
        : '기록된 파일 변경이 없습니다.';
    }
    if (btnRollback) btnRollback.disabled = !files.length;

    host.replaceChildren();
    if (!files.length) {
      host.append(el('p', 'agent-empty', '이 작업에는 아직 기록된 파일 스냅샷이 없습니다.'));
    } else {
      for (const file of files) {
        host.append(renderDiffFileCard(file, taskId));
      }
    }
  } catch (err) {
    showDiffFailure(`Diff 조회 오류: ${err.message}`);
  }
}

function initDiffPanel() {
  $('diff-load')?.addEventListener('click', () => loadActiveDiff());
  $('diff-task-id')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      // Guide `ime-safe-enter-submit`: prevent the default (form) submit first, then
      // ignore the Enter that confirms a Hangul/Japanese/Chinese candidate — Safari
      // reports that keystroke as keyCode 229 after resetting isComposing.
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) return;
      loadActiveDiff();
    }
  });

  $('diff-rollback')?.addEventListener('click', async () => {
    const taskId = currentTaskId();
    if (!window.confirm?.(`작업 "${taskId}"의 모든 변경 사항을 원래대로 되돌리시겠습니까?`)) return;
    try {
      const res = await fetch('/api/dx/snapshot/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId })
      });
      if (res.ok) loadActiveDiff();
    } catch {}
  });

  $('review-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const noteEl = $('review-note');
    const note = noteEl?.value?.trim();
    if (!note) return;
    const prompt = $('prompt');
    const prefix = prompt.value.trim() ? `${prompt.value.trim()}\n\n` : '';
    prompt.value = `${prefix}[코드 검토 의견]\n${note}`;
    prompt.focus();
    noteEl.value = '';
    const hint = $('review-hint');
    if (hint) {
      hint.textContent = '입력창에 검토 의견을 반영했습니다. 확인 후 전송하세요.';
      setTimeout(() => {
        if (hint) hint.textContent = '의견을 보내면 입력창에 이어 붙입니다.';
      }, 3500);
    }
  });
}

/* 5. Live Web Preview & Design Mode (Orca style) */
let designModeActive = false;

/** Inject the postMessage inspector into a same-origin preview frame by script tag,
 *  so the preview page keeps its own strict CSP: no inline eval, no parent DOM reads. */
function injectDesignInspector(iframe) {
  const note = $('preview-note');
  try {
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;
    if (!doc.getElementById('omp-inspector-script')) {
      const script = doc.createElement('script');
      script.id = 'omp-inspector-script';
      script.src = '/preview-inspector.js';
      doc.documentElement.appendChild(script);
    }
    iframe.contentWindow?.postMessage({ type: 'omp:design-mode', enabled: designModeActive }, location.origin);
    if (note) note.textContent = '디자인 모드를 켜고 요소를 클릭하면 입력창에 수정 요청이 채워집니다.';
  } catch {
    if (note) note.textContent = '미리보기 페이지가 같은 출처가 아니어서 요소 선택 검사기를 넣을 수 없습니다.';
  }
}

function previewUrl() { return $('preview-url')?.value?.trim() || '/preview/index.html'; }

function loadPreview(force = false) {
  const frame = $('preview-frame');
  if (!frame) return;
  const target = previewUrl();
  if (force || !frame.getAttribute('src')) {
    frame.setAttribute('src', target);
  }
}

function setDesignMode(enabled) {
  designModeActive = Boolean(enabled);
  const btn = $('design-toggle');
  const label = $('design-label');
  const tag = $('preview-tag');
  if (btn) btn.setAttribute('aria-pressed', String(designModeActive));
  if (label) label.textContent = designModeActive ? '디자인 모드 켜짐 (요소 클릭)' : '디자인 모드 (요소 선택)';
  if (tag) {
    tag.textContent = designModeActive ? '선택 모드' : '미리보기';
    tag.className = 'panel-tag' + (designModeActive ? ' active' : '');
  }
  const frame = $('preview-frame');
  try {
    frame?.contentWindow?.postMessage({ type: 'omp:design-mode', enabled: designModeActive }, location.origin);
  } catch {}
}

function handleElementSelected(data) {
  const res = $('inspect-result');
  if (res) res.hidden = false;
  const sel = $('inspect-selector');
  const tag = $('inspect-tag');
  const txt = $('inspect-text');
  const st = $('inspect-styles');
  if (sel) sel.textContent = data.selector || '—';
  if (tag) tag.textContent = `<${data.tag || ''}>`;
  if (txt) txt.textContent = data.text ? `"${data.text}"` : '(텍스트 없음)';
  if (st) {
    st.replaceChildren();
    for (const [k, v] of Object.entries(data.attributes || {})) {
      if (!v) continue;
      const chip = el('span', 'style-chip', `${k}="${v}"`);
      chip.dataset.kind = 'attr';
      st.append(chip);
    }
    for (const [k, v] of Object.entries(data.styles || {})) {
      if (v && v !== 'none' && v !== 'normal') {
        st.append(el('span', 'style-chip', `${k}: ${v}`));
      }
    }
  }

  // Populate prompt textarea with a structured request built from the picked element
  const prompt = $('prompt');
  if (!prompt) return;
  const attrs = Object.entries(data.attributes || {})
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  const block = [
    `[요소] ${data.selector || `<${data.tag || '요소'}>`}`,
    data.tag ? `- 태그: ${data.tag}` : '',
    attrs ? `- 속성: ${attrs}` : '',
    data.text ? `- 현재 문구: "${data.text}"` : '',
    '- 요청: '
  ].filter(Boolean).join('\n');
  const existing = prompt.value.trim();
  prompt.value = existing ? `${existing}\n\n${block}` : block;
  prompt.focus();
  prompt.setSelectionRange(prompt.value.length, prompt.value.length);
}

function initLivePreview() {
  const frame = $('preview-frame');
  frame?.addEventListener('load', () => {
    const src = frame.getAttribute('src');
    if (!src || src === 'about:blank') return;
    injectDesignInspector(frame);
    const tag = $('preview-tag');
    if (tag && !designModeActive) {
      tag.textContent = src.includes('/preview/') ? '샘플 웹 미리보기' : '프로젝트 화면';
    }
  });

  $('preview-reload')?.addEventListener('click', () => {
    if (!frame) return;
    try {
      frame.contentWindow?.location.reload();
    } catch {
      loadPreview(true);
    }
  });

  $('preview-url')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      // Same IME guard as the diff task-id field (guide `ime-safe-enter-submit`):
      // the Enter that confirms a composition candidate must not reload the frame.
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) return;
      loadPreview(true);
    }
  });

  $('design-toggle')?.addEventListener('click', () => {
    setDesignMode(!designModeActive);
  });

  $('design-clear')?.addEventListener('click', () => {
    const res = $('inspect-result');
    if (res) res.hidden = true;
    setDesignMode(false);
  });

  window.addEventListener('message', event => {
    if (event.data?.type !== 'omp:element-selected') return;
    if (event.source !== frame?.contentWindow || event.origin !== location.origin) return;
    handleElementSelected(event.data);
  });
}

/* 6. Long-term memory viewer */
/** Korean labels for the stored memory types; an unreported type stays as it came. */
const MEMORY_TYPE_LABEL = {
  'error-fix':'오류 수정',
  'failure-analysis':'실패 원인',
  'exploration-finding':'탐색 메모',
  'past-task':'이전 작업',
  'rule':'규칙'
};
function memoryTypeLabel(type) {
  const key = typeof type === 'string' ? type.trim() : '';
  if (!key) return '기억';
  return MEMORY_TYPE_LABEL[key] ?? key;
}
async function loadMemoryStatus() {
  const summary = $('memory-summary');
  const rows = $('memory-rows');
  try {
    const res = await fetch('/api/memory/status');
    if (!res.ok) {
      if (summary) summary.textContent = `메모리 상태 조회 불가 (HTTP ${res.status})`;
      return;
    }
    const data = await res.json();
    $('memory-active').textContent = `${data.active ?? 0}건`;
    $('memory-superseded').textContent = `${data.superseded ?? 0}건`;
    $('memory-quarantined').textContent = `${data.quarantined ?? 0}건`;
    $('memory-embedding').textContent = data.embedding?.model || (data.embedding?.resident ? '활성' : '대기');
    if (summary) summary.textContent = `총 ${data.total ?? 0}개 기억 (드라이버: ${data.driver || 'sqlite'})`;

    const listRes = await fetch('/api/memory/list?limit=15');
    if (listRes.ok) {
      const listData = await listRes.json();
      rows.replaceChildren();
      const items = listData.items || [];
      if (!items.length) {
        rows.append(el('li', 'agent-empty', '저장된 장기 기억 항목이 없습니다.'));
      } else {
        for (const item of items) {
          const li = el('li', 'mem-row');
          const label = memoryTypeLabel(item.type);
          const type = el('span', 'mem-type', label);
          type.dataset.type = item.type || 'rule';
          li.append(type, el('span', 'mem-title', item.title || item.body || '제목 없음'));
          li.title = item.body || item.title || '';
          rows.append(li);
        }
      }
    }
  } catch (err) {
    if (summary) summary.textContent = `메모리 API 연결 오류: ${err.message}`;
  }
}

function initMemoryPanel() {
  $('memory-refresh')?.addEventListener('click', () => loadMemoryStatus());
  $('menu-memory')?.removeAttribute('disabled');
  $('menu-memory')?.removeAttribute('title');
  $('menu-memory')?.addEventListener('click', () => {
    // Same path as the other inspector jump targets: reopen the column, or on the
    // narrow shell switch the open sidebar drawer for the inspector drawer.
    showInspector();
    if (narrowShell.matches) setDrawer('inspector');
    switchInspectorTab('memory');
    // Plain focus scrolls the overflowing tab strip so the selected tab is on screen.
    if (narrowShell.matches) $('tab-memory')?.focus();
  });
  loadMemoryStatus();
}

/* 6. Document visualization — session deliverable generator */
const DOC_TYPES = [
  { id:'report', label:'작업 결과 보고서' },
  { id:'study', label:'선행 연구·기술 검토' },
  { id:'spec', label:'시스템 아키텍처 명세서' },
  { id:'summary', label:'경영진·심사위원 1장 요약' }
];
const DOC_STORE = 'student-omp:viz-docs';
let docType = 'report';
let docHtml = '';
let docGenerated = false;
let docHash = null;
let docSessionKey = null;
/** Rows the server reported for this session; merged with the local ones on render. */
let docServerEntries = [];
let docServerKey = null;
let docServerRequest = null;
/* Live document mode: one quiet-period refresh after each revision that added
   write/verify work, keyed to the session the pane is showing. */
const DOC_LIVE_QUIET_MS = 1200;
const docLive = { key:null, seen:0, version:0, hashes:new Set(), timer:null, inFlight:false, dirty:false };
/** Bumped per swap and by every blank, so a superseded reveal can never paint late. */
let docShowSeq = 0;

/** Load the document into the hidden buffer, then hand it the shown frame's identity.
 *  The pane therefore goes from the old document straight to the new one: the shown
 *  frame keeps its previous (full) content for the whole request, and the swap happens
 *  on one already-painted buffer instead of a fresh, momentarily empty navigation. */
function showDocHtml(html) {
  const shown = $('viz-doc-frame'), buffer = docBuffer();
  if (!shown || !buffer) return Promise.resolve(false);
  const token = ++docShowSeq;
  return new Promise(resolve => {
    let settled = false;
    const settle = value => { if (settled) return; settled = true; buffer.removeEventListener('load', onLoad); resolve(value); };
    const onLoad = () => {
      // Two frames after load: the buffer has been rendered at least once while it
      // sat behind the visible document, so revealing it shows the finished page.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (token !== docShowSeq) return settle(false);
        shown.id = 'viz-doc-staging';
        shown.className = 'viz-doc-buffer';
        shown.setAttribute('aria-hidden', 'true');
        buffer.id = 'viz-doc-frame';
        buffer.className = '';
        buffer.removeAttribute('aria-hidden');
        settle(true);
      }));
    };
    buffer.addEventListener('load', onLoad);
    buffer.srcdoc = html;
  });
}

function docStatus(text) {
  const status = $('viz-doc-status');
  if (status) status.textContent = text;
  return text;
}
/** The stage keeps one shown frame and one ready buffer, so a new document never has
 *  to be loaded into the frame the operator is looking at: the buffer loads behind it
 *  and the two exchange identity only after it is painted. Returns the hidden buffer,
 *  creating it on first use. */
function docBuffer() {
  const existing = $('viz-doc-staging');
  if (existing) return existing;
  const stage = $('viz-doc-stage');
  if (!stage) return null;
  const buffer = document.createElement('iframe');
  buffer.id = 'viz-doc-staging';
  buffer.className = 'viz-doc-buffer';
  buffer.title = '세션 결과 문서 준비 화면';
  buffer.setAttribute('sandbox', 'allow-scripts allow-popups');
  buffer.setAttribute('referrerpolicy', 'no-referrer');
  buffer.setAttribute('aria-hidden', 'true');
  stage.append(buffer);
  return buffer;
}
/** The pane's own empty state: no document is on screen, so both frames are cleared. */
function blankDocStage() {
  docShowSeq += 1;
  for (const frame of document.querySelectorAll('#viz-doc-stage iframe')) {
    if (frame.getAttribute('srcdoc')) frame.srcdoc = '';
  }
}
/** An empty or failed request clears the preview instead of leaving the last document looking current. */
function clearDocFrame(note, statusText) {
  docGenerated = false;
  docHtml = '';
  docHash = null;
  blankDocStage();
  setDocButtons(false);
  const empty = $('viz-doc-empty');
  if (empty) empty.hidden = false;
  const emptyNote = $('viz-doc-empty-note');
  if (emptyNote) emptyNote.textContent = note;
  if (statusText !== undefined) docStatus(statusText);
}
function resetDocLive(key = null) {
  if (docLive.timer) clearTimeout(docLive.timer);
  docLive.key = key;
  docLive.seen = 0;
  docLive.version = 0;
  docLive.hashes = new Set();
  docLive.timer = null;
  docLive.inFlight = false;
  docLive.dirty = false;
}
/** Another session's frames never touch this pane: only the active session is followed. */
function watchDocLive(current) {
  if (!current || current.key !== activeKey) return false;
  if (docLive.key !== current.key) resetDocLive(current.key);
  return true;
}
function docWorkCount(activity) {
  return activity ? activity.events.reduce((count, event) => count + (event.kind === 'write' || event.kind === 'verify' ? 1 : 0), 0) : 0;
}
/** An activity revision that added a write/verify event queues one refresh after a quiet period. */
function scheduleDocLive(current) {
  if ($('pane-visualize')?.hidden) return;
  if (!watchDocLive(current)) return;
  const count = docWorkCount(current.activity);
  if (!count || count <= docLive.seen) return;
  docLive.seen = count;
  const generate = $('viz-doc-generate');
  if (generate) generate.disabled = false;
  docStatus('자동 갱신 · 갱신 중…');
  if (docLive.timer) clearTimeout(docLive.timer);
  docLive.timer = setTimeout(() => { docLive.timer = null; refreshVizDocLive(current.key); }, DOC_LIVE_QUIET_MS);
}
/** Opening the pane or changing the type asks for the current document once, immediately. */
function kickDocLive() {
  const current = session();
  if (!current || !sessionHasActivity()) return;
  watchDocLive(current);
  docLive.seen = Math.max(docLive.seen, docWorkCount(current.activity));
  if (docLive.timer) { clearTimeout(docLive.timer); docLive.timer = null; }
  refreshVizDocLive(current.key);
}
async function refreshVizDocLive(key) {
  if (docLive.inFlight) { docLive.dirty = true; return; }
  if (!key || key !== activeKey || !sessionHasActivity()) return;
  // Capture session + type once: a response may only land in the pane it was asked for.
  const sessionId = docSessionId(), type = docType;
  docLive.inFlight = true;
  docLive.dirty = false;
  docStatus('자동 갱신 · 갱신 중…');
  try {
    const response = await fetch(`${docUrl('html')}&t=${Date.now()}`, { cache:'no-store' });
    if (key !== activeKey || sessionId !== docSessionId() || type !== docType) { docLive.dirty = true; return; }
    if (response.status === 400) {
      // The server recorded no work. With no document on screen that is the pane's
      // empty state; with one on screen the earlier document stays put and is never
      // replaced by a blank, and the status line says what the server answered.
      docLive.version = 0;
      docLive.hashes = new Set();
      if (docGenerated && docHtml) docStatus(`기록된 작업 없음 · 서버가 문서를 만들지 않았습니다`);
      else clearDocFrame(DOC_EMPTY_NOTE, '기록된 작업 없음');
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const hash = response.headers.get('X-Document-Hash') || null;
    const html = await response.text();
    if (key !== activeKey || sessionId !== docSessionId() || type !== docType) { docLive.dirty = true; return; }
    // Identical content is already on screen: no reload, no version, no flicker.
    if (html && html === docHtml && hash === docHash) {
      docStatus(`자동 갱신 · ${docLive.version || 1}번째 버전 · ${docTypeLabel()}`);
      return;
    }
    docHash = hash;
    docHtml = html;
    docSessionKey = key;
    await showDocHtml(html);
    if (key !== activeKey || sessionId !== docSessionId() || type !== docType) { docLive.dirty = true; return; }
    docGenerated = true;
    const empty = $('viz-doc-empty');
    if (empty) empty.hidden = true;
    setDocButtons(true);
    if (hash && !docLive.hashes.has(hash)) { docLive.hashes.add(hash); docLive.version = docLive.hashes.size; }
    docStatus(`자동 갱신 · ${docLive.version || 1}번째 버전 · ${docTypeLabel()}`);
    recordDoc(hash);
  } catch (error) {
    if (key !== activeKey || sessionId !== docSessionId()) return;
    // A failure is stated as one. The earlier document may stay visible, but never as
    // if it were the current version: no blank is flashed over it either.
    if (docGenerated && docHtml) docStatus(`자동 갱신 실패: ${error.message} · 이전 버전 표시 중`);
    else clearDocFrame('문서를 만들지 못했습니다.', `자동 갱신 실패: ${error.message}`);
  } finally {
    docLive.inFlight = false;
    if (docLive.dirty && key === activeKey) {
      docLive.dirty = false;
      if (docLive.timer) clearTimeout(docLive.timer);
      docLive.timer = setTimeout(() => { docLive.timer = null; refreshVizDocLive(activeKey); }, DOC_LIVE_QUIET_MS);
    }
  }
}

function docSessionId() {
  const current = session();
  return current?.bridgeId || activeKey || 'current';
}
function docSessionTitle() { return session()?.title || 'VAYEX 세션'; }
/** A deliverable needs a record to describe: without messages or events there is nothing to generate. */
function sessionHasActivity() {
  const current = session(), vm = current?.vm, act = current?.activity;
  return Boolean((vm && (vm.messages.length > 0 || vm.tools.length > 0)) || (act && act.events.length > 0));
}
function docTypeLabel(id = docType) { return DOC_TYPES.find(item => item.id === id)?.label ?? id; }
/** The server's definition: no recorded work means no document, and never a failure. */
const DOC_EMPTY_NOTE = '기록된 작업이 없어 문서를 만들지 않았습니다.';
function docUrl(kind, hash = null) {
  const params = new URLSearchParams({ session:docSessionId(), type:docType, title:docSessionTitle() });
  if (hash) params.set('hash', hash);
  return `/api/visualize/${kind}?${params.toString()}`;
}
function readDocStore() {
  try { return JSON.parse(safeStorageGet(DOC_STORE, '{}')) ?? {}; } catch { return {}; }
}
/** Stored rows are deduped on read: an artifact appears once, keyed by session+type+hash. */
function docEntries() {
  const store = readDocStore();
  const list = store[docSessionId()];
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.filter(entry => {
    if (!entry || typeof entry !== 'object') return false;
    const key = `${entry.type}:${entry.hash ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function saveDocEntries(list) {
  const store = readDocStore();
  store[docSessionId()] = list.slice(0,6);
  safeStorageSet(DOC_STORE, JSON.stringify(store));
}
function recordDoc(hash = docHash) {
  // One row per artifact (session + type + hash). A new version adds its own row
  // instead of overwriting the older one, and re-recording the same version is a
  // no-op, so the list never shows the same artifact twice.
  const key = (entry) => `${entry.type}:${entry.hash ?? ''}`;
  const list = docEntries().filter(entry => key(entry) !== `${docType}:${hash ?? ''}`);
  list.unshift({ type:docType, at:Date.now(), title:docSessionTitle(), hash: hash ?? null });
  saveDocEntries(list);
  renderDocList();
}
/**
 * The documented list endpoint is the source of truth for the artifacts on disk:
 * a document made in another browser or profile is not in this localStorage.
 * Local rows stay first, server rows fill in what is missing.
 */
function loadDocServerEntries() {
  const key = docSessionId();
  if (docServerKey !== key) {
    docServerKey = key;
    docServerEntries = [];
    docServerRequest = null;
  }
  if (docServerRequest) return docServerRequest;
  const params = new URLSearchParams({ session:key });
  const workOwner = session();
  pageWorkStart(workOwner);
  docServerRequest = (async () => {
    try {
      const response = await fetch(`/api/visualize/list?${params.toString()}`, { cache:'no-store' });
      if (!response.ok) {
        docServerRequest = null;
        return;
      }
      const data = await response.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      if (docServerKey !== key) return;
      // One row per artifact: the HTML and PDF of a version share type + hash.
      docServerEntries = items
        .filter(item => item && item.hash && item.type && (item.format ?? 'html') === 'html')
        .map(item => ({
          type:String(item.type),
          hash:String(item.hash).toLowerCase(),
          at:Number(item.modifiedAt) || Date.now(),
          title:item.session ?? null,
          origin:'server'
        }));
      renderDocList();
    } catch {
      // A list that cannot be read leaves the local rows in place; nothing is removed.
      docServerRequest = null;
    } finally {
      pageWorkEnd(workOwner);
    }
  })();
  return docServerRequest;
}
/** The download name for the artifact currently open: title + type + its full content hash. */
function docFileName(format) {
  const name = reportFileName({ title:docSessionTitle(), type:docType, hash:docHash });
  return name.replace(/\.html$/, `.${format}`);
}
function setDocButtons(enabled) {
  for (const id of ['viz-doc-fullscreen','viz-doc-open','viz-doc-save','viz-doc-pdf']) {
    const button = $(id);
    if (button) button.disabled = !enabled;
  }
}
/** Guides `forms` + `style-parent-with-has`: the four pills are the labels of one native
 *  radio group, so selection is the radio's own `checked` state. `data-selected` mirrors it
 *  for the documented `:has()` fallback and so the pill is styleable without scripting. */
function reflectDocType() {
  for (const pill of document.querySelectorAll('[data-doc-type]')) {
    const selected = pill.dataset.docType === docType;
    const input = pill.querySelector('input[type=radio]');
    if (input) input.checked = selected;
    pill.dataset.selected = String(selected);
  }
}
function setDocType(type) {
  if (!DOC_TYPES.some(item => item.id === type)) return;
  docType = type;
  reflectDocType();
  if (!sessionHasActivity()) {
    docStatus('기록된 작업 없음');
    return;
  }
  docStatus(docGenerated
    ? `${docTypeLabel()} 유형으로 다시 생성합니다…`
    : `${docTypeLabel()} 유형이 선택되었습니다. ‘문서 생성’을 누르거나 기록이 이어지면 자동으로 열립니다.`);
  // The live pane follows the current type; an in-flight request for the old type is discarded.
  if (docGenerated) kickDocLive();
}
async function refreshVizDoc(options = {}) {
  const frame = $('viz-doc-frame');
  if (!frame) return;
  // A pinned hash opens that exact version; no hash asks the server for the
  // current content of this session + type.
  const pinned = options.hash ?? null;
  if (!sessionHasActivity()) {
    clearDocFrame('세션 작업 기록이 없습니다. 작업이 수행된 후 문서가 생성됩니다.', '기록된 작업 없음');
    return;
  }

  // Capture session + type once: a late response must never paint another session or type.
  const requestSession = docSessionId(), requestType = docType;
  docSessionKey = requestSession;
  docStatus(`${docTypeLabel()}${pinned ? ` · 버전 ${pinned.slice(0, 6)}` : ''} · 문서를 여는 중…`);
  const workOwner = session();
  pageWorkStart(workOwner);
  try {
    const response = await fetch(`${docUrl('html', pinned)}&t=${Date.now()}`, { cache:'no-store' });
    if (requestSession !== docSessionId() || requestType !== docType) return;
    if (response.status === 400) {
      // The server refused because no work was recorded. That is an empty state,
      // not a failure, and it wrote nothing.
      clearDocFrame(DOC_EMPTY_NOTE, '기록된 작업 없음');
      return;
    }
    if (response.status === 404) {
      // The pinned version is no longer on disk. Its document must not stay on screen
      // looking current, but the row is kept so the operator can pick another version.
      clearDocFrame('요청한 버전이 서버에 남아 있지 않습니다. 다른 버전을 선택하세요.', `요청한 버전(${pinned ?? ''})이 서버에 남아 있지 않습니다. 다른 버전을 선택하세요.`);
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (requestSession !== docSessionId() || requestType !== docType) return;
    docHash = response.headers.get('X-Document-Hash') || pinned;
    docHtml = html;
    await showDocHtml(docHtml);
    docGenerated = true;
    const empty = $('viz-doc-empty');
    if (empty) empty.hidden = true;
    setDocButtons(true);
    docStatus(`수동 생성 · ${docTypeLabel()} 버전 ${String(docHash ?? '').slice(0, 6)} · ${docSessionTitle()}`);
    recordDoc(docHash);
  } catch (error) {
    clearDocFrame('문서를 만들지 못했습니다.', `문서를 만들지 못했습니다: ${error.message}. 서버의 문서 생성 API를 확인해 주세요.`);
  } finally {
    pageWorkEnd(workOwner);
  }
}
function openDocTab() {
  if (!docHtml) {
    if (!sessionHasActivity()) return;
    refreshVizDoc();
    return;
  }
  const blob = new Blob([docHtml], { type:'text/html; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) alert('팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요.');
  else setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function saveDocHtml() {
  if (!docHtml) {
    if (!sessionHasActivity()) return;
    refreshVizDoc();
    return;
  }
  const fileName = docFileName('html');
  const blob = new Blob([docHtml], { type:'text/html; charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  const status = $('viz-doc-status');
  if (status) status.textContent = `HTML 저장 완료 · ${fileName}`;
}
async function exportDocPdf() {
  const status = $('viz-doc-status');
  if (!sessionHasActivity()) {
    if (status) status.textContent = '세션 작업 기록이 없습니다. 작업이 수행된 후 PDF를 내보낼 수 있습니다.';
    return;
  }
  const workOwner = session();
  pageWorkStart(workOwner);
  try {
    const response = await fetch(`${docUrl('pdf', docHash)}&t=${Date.now()}`, { cache:'no-store' });
    if (response.status === 404) {
      if (status) status.textContent = '요청한 버전이 서버에 남아 있지 않습니다. 문서를 다시 생성하세요.';
      return;
    }
    if (response.status === 503) {
      let reason = '';
      try { reason = (await response.json())?.reason ?? ''; } catch { reason = ''; }
      if (status) status.textContent = `PDF 렌더러(Edge)를 사용할 수 없어 PDF를 만들지 않았습니다${reason ? ` · ${reason}` : ''}. HTML 저장을 사용하세요.`;
      return;
    }
    if (!response.ok) {
      if (status) status.textContent = `PDF 내보내기 응답 ${response.status} — 서버가 PDF 생성을 아직 제공하지 않습니다. HTML 저장을 사용하세요.`;
      return;
    }
    const fileName = docFileName('pdf');
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    if (status) status.textContent = `PDF 내보내기 완료 · ${fileName}`;
  } catch (error) {
    if (status) status.textContent = `PDF 내보내기 오류: ${error.message}`;
  } finally {
    pageWorkEnd(workOwner);
  }
}
/** Local rows first (their order is the order they were generated in), server-only rows after. */
function mergedDocEntries() {
  const merged = docEntries().slice();
  const seen = new Set(merged.map(entry => `${entry.type}:${entry.hash ?? ''}`));
  for (const entry of docServerEntries) {
    const key = `${entry.type}:${entry.hash ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}
function renderDocList() {
  const host = $('viz-doc-list');
  const count = $('viz-doc-count');
  if (!host) return;
  const entries = mergedDocEntries();
  if (count) count.textContent = `${entries.length}개`;
  host.replaceChildren();
  if (!entries.length) {
    host.append(el('li','agent-empty','생성한 문서가 없습니다.'));
    return;
  }
  for (const entry of entries) {
    const row = el('li','doc-list-row');
    row.append(el('span','doc-kind', entry.type === docType ? '현재 유형' : '보존'));
    const meta = el('span','doc-meta');
    const versionLabel = entry.hash ? ` · v-${entry.hash.slice(0, 6)}` : '';
    meta.append(
      el('b','',`${docTypeLabel(entry.type)}${versionLabel}`),
      el('span','',`${new Date(entry.at).toLocaleString('ko-KR')} · ${entry.title ?? ''}`)
    );
    const preview = el('button','link-btn','미리보기');
    preview.type = 'button';
    preview.addEventListener('click', () => {
      docType = entry.type;
      reflectDocType();
      // Open the version that was clicked, not whatever is current right now.
      refreshVizDoc({ hash: entry.hash ?? null });
    });
    row.append(meta, preview);
    host.append(row);
  }
}
function renderDocTab() {
  const key = docSessionId();
  if (docSessionKey !== key) {
    docSessionKey = key;
    docGenerated = false;
    docHtml = '';
    docHash = null;
    docServerKey = null;
    docServerEntries = [];
    docServerRequest = null;
    resetDocLive(activeKey);
    blankDocStage();
    const empty = $('viz-doc-empty');
    if (empty) empty.hidden = false;
    setDocButtons(false);
  }
  renderDocList();
  // Opening the tab reads the documented list endpoint once: the local rows are
  // already on screen and stay there while the server rows arrive.
  loadDocServerEntries();
  const empty = $('viz-doc-empty');
  const emptyNote = $('viz-doc-empty-note');
  const generate = $('viz-doc-generate');
  if (!sessionHasActivity()) {
    clearDocFrame('세션 작업 기록이 없습니다. 작업이 수행된 후 문서가 생성됩니다.', '기록된 작업 없음');
    if (generate) generate.disabled = true;
    return;
  }
  if (generate) generate.disabled = false;
  if (emptyNote && empty && !empty.hidden) emptyNote.textContent = '세션 작업이 기록되면 문서 미리보기가 자동으로 열립니다.';
  // The pane is live: opening it with recorded work shows the current document
  // without a click, then every later write/verify revision refreshes it.
  if (!docGenerated || docLive.key !== activeKey) kickDocLive();
}
function initDocPanel() {
  // Guides `forms` + `tabs`: the pills are a native radio group, so `change` fires for a
  // click, a Space press and the arrow-key walk through the group, and there is no
  // hand-rolled Enter/Space or arrow handler to keep in sync with the checked state.
  document.getElementById('viz-doc-types')?.addEventListener('change', event => {
    const value = event.target?.value;
    if (value) setDocType(value);
  });
  reflectDocType();
  $('viz-doc-generate')?.addEventListener('click', () => refreshVizDoc());
  $('viz-doc-open')?.addEventListener('click', openDocTab);
  $('viz-doc-save')?.addEventListener('click', saveDocHtml);
  $('viz-doc-pdf')?.addEventListener('click', exportDocPdf);
  $('viz-doc-fullscreen')?.addEventListener('click', () => {
    setInspectorMode('fullscreen');
    if (!docGenerated) refreshVizDoc();
  });
  setDocButtons(false);
  renderDocList();
}

/* 7. Stats tab — relationship graph, token/cost bars, memory composition */
async function renderStatsTab() {
  const current = session(), vm = current?.vm;
  const act = current?.activity;
  if ($('pane-stats')) $('pane-stats').dataset.empty = String(!act?.events?.length && !vm?.usage?.seen);

  // 1. Task Relationship Graph
  const graphStage = $('viz-graph');
  const graphEmpty = $('viz-graph-empty');
  if (graphStage) {
    const mainTask = act?.main
      ? { id:act.main.id, name:act.main.name, state:act.main.status || 'waiting' }
      : { id:'main', name:current?.title || '메인 작업', state:'waiting' };
    const subs = (act?.tasks ?? []).map(task => ({
      id:task.id,
      name:task.name,
      state:task.status || 'waiting',
      lane:task.lane ?? null,
      dependsOn:task.dependsOn ?? null,
      elapsed:task.startedAt ? formatElapsed(Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt)) : null
    }));
    const graphSvg = document.createElementNS(NS, 'svg');
    renderTaskGraph(graphSvg, { main:mainTask, subagents:subs });
    graphStage.replaceChildren(graphSvg);
    if (graphEmpty) graphEmpty.hidden = subs.length > 0;
  }

  // 2. Cost & Token Chart
  const costStage = $('viz-cost');
  const costTag = $('viz-cost-tag');
  if (costStage) {
    const tasks = [];
    if (act?.main) {
      tasks.push({ name:act.main.name || '메인 작업', tokens:act.main.tokens, cost:act.main.cost });
    }
    for (const task of act?.tasks ?? []) {
      tasks.push({ name:task.name, tokens:task.tokens, cost:task.cost });
    }
    if (!tasks.length && vm?.usage?.seen) {
      tasks.push({ name:current?.title || '현재 세션', tokens:vm.usage.tokens, cost:vm.usage.cost });
    }
    if (!tasks.length) tasks.push({ name:'현재 세션', tokens:null, cost:null });

    let dxData = null;
    try {
      const dxRes = await fetch('/api/dx/cost/overview');
      if (dxRes.ok) {
        const overview = await dxRes.json();
        if (overview?.totalTokens > 0) {
          dxData = {
            label:`플랫폼 누적: ${Math.round(overview.totalTokens).toLocaleString()} 토큰 (₩${(overview.totalSavedKrw ?? 0).toLocaleString()} 절감)`,
            tokens:overview.totalTokens,
            cost:overview.totalSpendKrw
          };
          if (costTag) costTag.textContent = 'DX 누적 연동';
        }
      }
    } catch {}

    const costSvg = document.createElementNS(NS, 'svg');
    renderCostChart(costSvg, { tasks, dx:dxData });
    costStage.replaceChildren(costSvg);
  }

  // 3. Memory Composition
  const memoryStage = $('viz-memory');
  if (memoryStage) {
    let memStatus = memoryChartData(null);
    try {
      const memRes = await fetch('/api/memory/status');
      if (memRes.ok) memStatus = memoryChartData(await memRes.json());
    } catch {}
    const memSvg = document.createElementNS(NS, 'svg');
    renderMemoryChart(memSvg, memStatus);
    memoryStage.replaceChildren(memSvg);
  }
}

function initStatsPanel() {
  $('viz-refresh')?.addEventListener('click', () => renderStatsTab());
}

function initQuickActions() {
  document.querySelectorAll('[data-goto]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.goto;
      if (target === 'chat') { focusComposer(); return; }
      if (target) switchInspectorTab(target);
    });
  });
}

function initConsentToggle() {
  $('consent-toggle')?.addEventListener('click', () => {
    const current = session();
    if (!current) return;
    current.consent = !current.consent;
    operatorConsent = current.consent;
    $('cloud-consent').checked = current.consent;
    connect(current);
  });
}

// Boot workbench features
initTheme();
initResizablePanes();
initInspectorModes();
initNarrowDrawers();
initInspectorTabs();
initHintTips();
initDiffPanel();
initLivePreview();
initDocPanel();
initStatsPanel();
initMemoryPanel();
initQuickActions();
initConsentToggle();

newSession();

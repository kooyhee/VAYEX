// Observable stall detection: "is this turn loading forever?"
//
// Every verdict here is a timestamp comparison over signals the harness really
// received — RPC frame arrivals, heartbeat frames, tool_execution_start/end,
// progress-state transitions and terminal frames. There is no model call, no
// prompt, no text interpretation and no network: a turn that is merely slow
// stays `running`, and only an observable absence of signals is `stalled`.
//
// The status object is exposed verbatim by `GET /api/insight/metrics` under
// `watchdog`, and by `GET /api/insight/watchdog`.

export const DEFAULT_THRESHOLDS = Object.freeze({
  // No frame and no heartbeat for this long while the core is not terminal.
  stallMs: 45000,
  // One tool call admitted but never ended for this long.
  toolMs: 180000,
  // A progress state reported as running with no further advance.
  progressMs: 45000,
  // Core never reached ready after its first frame (mirrors the launch timer).
  readyMs: 15000,
  // Convenience window carried into the status for the metrics UI.
  windowMs: 60000,
});

const HEARTBEAT_TYPES = new Set(['heartbeat', 'keepalive', 'keep_alive', 'ping', 'pong', 'rpc_heartbeat']);
const TOOL_START_TYPES = new Set(['tool_execution_start']);
const TOOL_END_TYPES = new Set(['tool_execution_end', 'tool_execution_result', 'tool_result']);
const PROGRESS_TYPES = new Set([
  'turn_start', 'turn_end', 'agent_start', 'agent_end', 'prompt', 'prompt_result',
  'task.start', 'task.status', 'task.update', 'task.end', 'task.finish',
  'subagent_progress', 'subagent_lifecycle', 'progress', 'session_settled', 'ready',
]);
const DONE_WORDS = new Set(['completed', 'complete', 'done', 'success', 'succeeded', 'finished', 'ok', 'settled']);
const FAILED_WORDS = new Set(['failed', 'failure', 'error', 'aborted', 'cancelled', 'canceled', 'timeout', 'blocked']);

function stamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function eventAt(event, fallback) {
  return stamp(event?.ts ?? event?.timestamp ?? event?.time ?? event?.data?.ts) ?? fallback;
}

function eventType(event) {
  return String(event?.type ?? event?.event?.type ?? '');
}

function toolName(event) {
  const value = event?.toolName ?? event?.tool_name ?? event?.name ?? event?.tool ?? event?.data?.toolName ?? event?.data?.name ?? null;
  return typeof value === 'string' && value ? value : '도구 이름 미보고';
}

function toolId(event) {
  const value = event?.toolId ?? event?.tool_id ?? event?.id ?? event?.data?.toolId ?? event?.data?.id ?? null;
  return value === null || value === undefined ? null : String(value);
}

function statusWord(event) {
  const value = event?.status ?? event?.data?.status ?? event?.payload?.status ?? null;
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

/** One status word, normalized to running/done/failed, or null when absent. */
export function statusOf(value) {
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase();
  if (DONE_WORDS.has(word)) return 'done';
  if (FAILED_WORDS.has(word)) return 'failed';
  return 'running';
}

/**
 * A watchdog over one conversation. `observe` is fed every frame the core sends;
 * `status(now)` reads nothing but the timestamps it has already recorded.
 */
export function createWatchdog({ thresholds = {}, now = () => Date.now() } = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  let frames = 0, frameAt = null, firstFrameAt = null;
  let heartbeat = 0, heartbeatAt = null;
  let progressAt = null, progressState = null, progressCount = 0;
  let terminalAt = null, terminalState = null;
  let failedAt = null;
  let readyAt = null;
  const openTools = new Map();

  function observe(event) {
    if (!event || typeof event !== 'object') return null;
    const type = eventType(event);
    if (!type) return null;
    const at = eventAt(event, now());
    frames += 1;
    frameAt = Math.max(frameAt ?? at, at);
    firstFrameAt = firstFrameAt === null ? at : Math.min(firstFrameAt, at);

    if (HEARTBEAT_TYPES.has(type)) {
      heartbeat += 1;
      heartbeatAt = Math.max(heartbeatAt ?? at, at);
      return { type: 'heartbeat', at };
    }
    if (['ready', 'bridge_ready', 'turn_start', 'agent_start', 'tool_execution_start'].includes(type)) {
      readyAt = Math.max(readyAt ?? at, at);
    }

    if (TOOL_START_TYPES.has(type)) {
      const id = toolId(event) ?? `${toolName(event)}#${openTools.size}`;
      openTools.set(id, { id, tool: toolName(event), startedAt: at });
      progressAt = Math.max(progressAt ?? at, at);
      progressState = 'running';
      progressCount += 1;
      return { type: 'tool_start', at, tool: toolName(event) };
    }
    if (TOOL_END_TYPES.has(type)) {
      const id = toolId(event);
      if (id !== null) openTools.delete(id);
      else {
        // No id reported: close the oldest matching admission, never a guess at which
        // call it belongs to beyond FIFO order.
        const firstKey = openTools.keys().next().value;
        if (firstKey !== undefined) openTools.delete(firstKey);
      }
      const word = event?.result?.isError === true || event?.isError === true ? 'failed' : 'done';
      progressAt = Math.max(progressAt ?? at, at);
      progressState = word === 'failed' ? 'running' : null;
      progressCount += 1;
      if (word === 'failed') failedAt = Math.max(failedAt ?? at, at);
      return { type: 'tool_end', at, tool: toolName(event), state: word };
    }
    if (PROGRESS_TYPES.has(type)) {
      progressAt = Math.max(progressAt ?? at, at);
      progressCount += 1;
      const word = statusOf(statusWord(event));
      const terminal = ['turn_end', 'agent_end', 'prompt_result', 'session_settled', 'task.end', 'task.finish'].includes(type);
      if (terminal || word === 'done' || word === 'failed') {
        const settled = word ?? (terminal ? 'done' : null);
        if (settled) {
          terminalAt = Math.max(terminalAt ?? at, at);
          terminalState = settled;
        }
      }
      if (word === 'failed') failedAt = Math.max(failedAt ?? at, at);
      progressState = word ?? (terminal ? null : 'running');
      if (terminal && (word === null || word === 'done')) progressState = null;
      return { type: 'progress', at };
    }
    return { type: 'frame', at };
  }

  function status(at = now()) {
    const lastSignalAt = Math.max(frameAt ?? -Infinity, heartbeatAt ?? -Infinity);
    const lastSignal = Number.isFinite(lastSignalAt) ? lastSignalAt : null;
    const silentMs = lastSignal === null ? null : Math.max(0, at - lastSignal);
    const open = [...openTools.values()].map((tool) => ({
      id: tool.id,
      tool: tool.tool,
      startedAt: tool.startedAt,
      elapsedMs: Math.max(0, at - tool.startedAt),
    }));
    const base = {
      source: 'observable',
      frames,
      heartbeat,
      windowMs: limits.windowMs,
      thresholds: { ...limits },
      firstFrameAt,
      lastFrameAt: frameAt,
      lastSignalAt: lastSignal,
      silentMs,
      thresholdMs: limits.stallMs,
      ready: readyAt !== null,
      readyAt,
      progress: { count: progressCount, state: progressState, lastAt: progressAt },
      terminal: { state: terminalState, at: terminalAt },
      tools: { started: frames && open.length, open },
      stalled: false,
      state: 'idle',
      reason: null,
    };
    if (terminalState === 'failed' || failedAt !== null) {
      return { ...base, state: 'failed', reason: 'reported_failure' };
    }
    if (terminalState === 'done' && open.length === 0) {
      return { ...base, state: 'done', reason: 'terminal_frame' };
    }
    if (firstFrameAt !== null && readyAt === null && at - firstFrameAt > limits.readyMs) {
      return { ...base, state: 'stalled', stalled: true, reason: 'ready_not_reached', observedMs: at - firstFrameAt };
    }
    const stuckTool = open.find((tool) => tool.elapsedMs > limits.toolMs);
    if (stuckTool) {
      return { ...base, state: 'stalled', stalled: true, reason: 'tool_without_terminal', stuckTool };
    }
    if (progressState === 'running' && progressAt !== null && at - progressAt > limits.progressMs) {
      return { ...base, state: 'stalled', stalled: true, reason: 'progress_without_advance', observedMs: at - progressAt };
    }
    if (lastSignal !== null && silentMs !== null && silentMs > limits.stallMs) {
      return { ...base, state: 'stalled', stalled: true, reason: 'no_signal_within_threshold', observedMs: silentMs };
    }
    if (frames === 0) return { ...base, state: 'idle', reason: 'no_signals' };
    return { ...base, state: 'running', reason: 'signals_present' };
  }

  function reset() {
    frames = 0; frameAt = null; firstFrameAt = null;
    heartbeat = 0; heartbeatAt = null;
    progressAt = null; progressState = null; progressCount = 0;
    terminalAt = null; terminalState = null; failedAt = null; readyAt = null;
    openTools.clear();
  }

  return { observe, status, reset, thresholds: { ...limits } };
}

/**
 * One-shot evaluation over a stream, for the HTTP routes that only have events.
 * @param {{events?:object[], session?:string|null, now?:number, thresholds?:object}} input
 */
export function evaluateWatchdog({ events = [], session = null, now = Date.now(), thresholds = {} } = {}) {
  const watchdog = createWatchdog({ thresholds, now: () => now });
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (session && String(event.session ?? event.data?.session ?? '') !== session) continue;
    watchdog.observe(event);
  }
  return { session, ...watchdog.status(now) };
}

/** UI-ready Korean sentence for one status; the numbers above stay authoritative. */
export function formatWatchdog(status) {
  if (!status || status.state === 'idle') return '관찰 신호 없음';
  if (status.state === 'done') return '턴 완료';
  if (status.state === 'failed') return '실패 보고됨';
  if (status.state === 'stalled') {
    const reasons = {
      ready_not_reached: '코어가 준비 신호를 보내지 않아 멈춘 것으로 판정',
      tool_without_terminal: '도구 실행이 끝났다고 보고되지 않아 멈춘 것으로 판정',
      progress_without_advance: '진행 상태가 갱신되지 않아 멈춘 것으로 판정',
      no_signal_within_threshold: '하트비트와 프레임이 끊겨 멈춘 것으로 판정',
    };
    return reasons[status.reason] ?? '멈춘 것으로 판정';
  }
  return `실행 중 · 침묵 ${Math.round((status.silentMs ?? 0) / 1000)}초`;
}

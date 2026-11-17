// Capture path: real agent events → screened, typed memories.
//
// One writer owns every write (single process, one SQLite connection), and every
// candidate passes `guard.screen` before it reaches the store. Failures here never
// propagate into the agent loop: a memory layer that crashes a coding session is
// worse than one that forgets.
import { screen } from './guard.mjs';
import {
  errorFix,
  errorSignature,
  explorationFinding,
  explicitMemories,
  failureAnalysis,
  statedPreferences,
  taskSummary,
} from './extract.mjs';

export class MemoryCapture {
  constructor(store, { embedder = null, logger = () => {} } = {}) {
    this.store = store;
    this.embedder = embedder;
    this.log = logger;
    this.pendingFailure = null;
    this.turnTools = [];
    this.turnFiles = [];
    this.embedded = 0;
  }

  /** Screened write. Returns the store's result plus the guard's verdict. */
  write(candidate) {
    const verdict = screen(candidate);
    if (!verdict.ok) {
      this.store.audit('reject', verdict.reason, null, candidate.sessionId ?? null, candidate.title?.slice(0, 120));
      return { action: 'rejected', reason: verdict.reason };
    }
    // The screened text is what gets stored: the redacted title and body, never the raw candidate.
    const result = this.store.add({
      ...candidate,
      title: verdict.title || verdict.body,
      body: verdict.body,
      trust: verdict.trust.trust,
      trustScore: verdict.trust.score,
      injectionFlagged: verdict.injection.flagged,
      secretsRedacted: verdict.masked > 0,
    });
    if (verdict.reason) this.store.audit('guard', verdict.reason, result.id, candidate.sessionId, candidate.type);
    return { ...result, guard: verdict };
  }

  /** Explicit "remember …" in the user's prompt, plus passing preference statements. */
  onPrompt({ prompt, sessionId, at }) {
    const results = [];
    for (const candidate of explicitMemories({ prompt, sessionId, at })) results.push(this.write(candidate));
    for (const candidate of statedPreferences({ prompt, sessionId, at })) results.push(this.write(candidate));
    if (results.length) this.store.audit('capture', 'prompt', null, sessionId, `${results.length} candidate(s)`);
    return results;
  }

  /**
   * Tool completion. Two jobs: track failures waiting for a fix, and record reusable
   * exploration findings. A success that follows a failure of the same tool/command
   * is the only accepted proof of a fix.
   */
  onToolEnd({ toolName, args, result, isError, sessionId, at }) {
    const results = [];
    if (isError) {
      const signature = errorSignature(toolName, result, args);
      this.pendingFailure = { ...signature, tool: toolName, at };
      const candidate = failureAnalysis({ toolName, result, args, sessionId, at });
      if (candidate) results.push(this.write(candidate));
      return results;
    }
    if (this.pendingFailure) {
      const fixed = this.pendingFailure;
      this.pendingFailure = null;
      const fixCandidate = errorFix({
        failure: fixed,
        fix: { command: describeCall(toolName, args), key: fixed.key },
        sessionId,
        at,
      });
      if (fixCandidate) results.push(this.write(fixCandidate));
    }
    const finding = explorationFinding({ toolName, args, result, sessionId, at });
    if (finding) results.push(this.write(finding));
    this.turnTools.push({ name: toolName, args });
    return results;
  }

  /** Called by `tool_execution_start` for edits, so the task summary can name the files. */
  onToolStart({ toolName, args }) {
    const target = args?.file_path ?? args?.path;
    if (typeof target === 'string' && /^(?:edit|write|str_replace)/.test(toolName)) {
      this.turnFiles.push(target.replace(/\\/g, '/'));
    }
  }

  /** End of a turn: a bounded, tool-derived task summary. No model narration. */
  onAgentEnd({ sessionId, at }) {
    const candidate = taskSummary({
      sessionId,
      at,
      tools: this.turnTools,
      files: [...new Set(this.turnFiles)].slice(0, 6),
    });
    this.turnTools = [];
    this.turnFiles = [];
    this.pendingFailure = null;
    return candidate ? [this.write(candidate)] : [];
  }

  /** Best-effort embedding of newly written memories; failures are silent by design. */
  async embedPending(ids) {
    if (!this.embedder || !this.store) return 0;
    let count = 0;
    for (const id of ids) {
      const memory = this.store.get(id);
      if (!memory) continue;
      try {
        const result = await this.embedder.embed([`${memory.title}\n${memory.body}`], { kind: 'passage' });
        this.store.putVector(id, result.model, result.vectors[0]);
        count += 1;
      } catch {
        return count;
      }
    }
    this.embedded += count;
    return count;
  }
}

function describeCall(toolName, args = {}) {
  const command = args?.command ?? args?.cmd ?? args?.file_path ?? args?.path ?? args?.pattern ?? args?.query;
  return command ? `${toolName}(${String(command).slice(0, 100)})` : toolName;
}

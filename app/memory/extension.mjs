// OMP extension: the live seam that makes memory cross sessions.
//
// Loaded by the `omp` child with `--extension app/memory/extension.mjs` (an exported
// default factory receiving `ExtensionAPI`, per
// `.omp-runtime/.../extensibility/extensions/loader.ts`). It does three things:
//   1. `before_agent_start` — capture explicit "remember" requests, and prepend the
//      retrieved memory block ONCE per session. The block is frozen, so every later
//      request repeats the identical system-prompt suffix and the provider's prompt
//      prefix cache stays valid.
//   2. tool/agent events — rule-based capture of failures, error→fix pairs,
//      exploration findings and task summaries.
//   3. `memory_search` — an agent-callable tool for retrieval after the frozen block.
// Every handler is failure-isolated: a memory bug never breaks the coding session.
import { getMemoryLayer } from './index.mjs';
import { sanitizeForPrompt } from './guard.mjs';
import { buildMemoryBlock } from './retrieve.mjs';
import { clip } from './text.mjs';

/**
 * The one place a memory block reaches the system prompt. Sanitized against the
 * shared privacy catalogue at the moment of injection, so a row written before the
 * write gate existed — or by another writer — still cannot carry an original value
 * into the prompt. `sanitizeText` is deterministic, so the frozen block stays
 * byte-identical on every turn and the provider's prefix cache stays valid.
 * @param {string[]} base the system prompt the host already assembled
 * @param {string} blockText the frozen memory block
 * @returns {string[]}
 */
export function withMemoryBlock(base, blockText) {
  if (!blockText) return base;
  return [...base, sanitizeForPrompt(blockText)];
}

export default function memoryExtension(pi) {
  let layerPromise = null;
  let frozen = null; // { sessionId, block }
  let sessionId = null;
  const argsByCall = new Map();

  const log = (level, message, detail) => {
    try {
      pi.logger[level](`[memory] ${message}`, detail);
    } catch {}
  };

  async function layer() {
    if (!layerPromise) layerPromise = getMemoryLayer({ logger: log }).then(async (pending) => {
      const resolved = await pending;
      log('debug', 'memory layer opened', { db: resolved.config.dbPath, project: resolved.config.project });
      return resolved;
    }).catch((error) => {
      log('error', 'memory layer failed to open', { error: error.message });
      layerPromise = null;
      throw error;
    });
    return layerPromise;
  }

  function currentSession(ctx) {
    try {
      return sessionId ?? ctx?.sessionManager?.getSessionId?.() ?? 'session-unknown';
    } catch {
      return sessionId ?? 'session-unknown';
    }
  }

  pi.on('session_start', async (event, ctx) => {
    sessionId = (() => {
      try {
        return ctx?.sessionManager?.getSessionId?.() ?? event?.sessionId ?? 'session-unknown';
      } catch {
        return 'session-unknown';
      }
    })();
    frozen = null;
    argsByCall.clear();
    // Opening the store at session start means a brand-new session sees memories
    // written by any earlier process without a restart.
    await layer().catch(() => {});
  });

  pi.on('before_agent_start', async (event, ctx) => {
    try {
      const memory = await layer();
      const sid = currentSession(ctx);
      const prompt = typeof event?.prompt === 'string' ? event.prompt : '';
      const at = new Date().toISOString();
      if (event?.reason === 'prompt' && prompt) {
        const writes = memory.capture.onPrompt({ prompt, sessionId: sid, at });
        const ids = writes.filter((write) => write.id).map((write) => write.id);
        if (ids.length) void memory.capture.embedPending(ids);
        if (!frozen) {
          const result = await buildMemoryBlock(memory.store, memory.embedder, prompt, { backfill: true });
          frozen = { sessionId: sid, block: result.block, mode: result.mode, count: result.block.count };
          if (result.block.ids.length) memory.store.recordUse(result.block.ids);
          log('debug', 'memory block frozen', { count: frozen.count, mode: frozen.mode, chars: result.block.text.length });
        }
      }
      if (!frozen?.block?.text) return undefined;
      const base = Array.isArray(event?.systemPrompt) ? event.systemPrompt : [];
      // Identical suffix on every request: same bytes, same position, every turn.
      return { systemPrompt: withMemoryBlock(base, frozen.block.text) };
    } catch (error) {
      log('error', 'before_agent_start capture failed', { error: error.message });
      return undefined;
    }
  });

  pi.on('tool_execution_start', async (event, ctx) => {
    try {
      const memory = await layer();
      if (event?.toolCallId) argsByCall.set(event.toolCallId, event.args ?? {});
      memory.capture.onToolStart({ toolName: event?.toolName, args: event?.args });
    } catch (error) {
      log('error', 'tool_execution_start failed', { error: error.message });
    }
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    try {
      const memory = await layer();
      const sid = currentSession(ctx);
      const args = argsByCall.get(event?.toolCallId) ?? {};
      argsByCall.delete(event?.toolCallId);
      if (event?.toolName === 'memory_search') return;
      const writes = memory.capture.onToolEnd({
        toolName: event?.toolName ?? 'unknown',
        args,
        result: event?.result,
        isError: Boolean(event?.isError),
        sessionId: sid,
        at: new Date().toISOString(),
      });
      const ids = writes.filter((write) => write.id).map((write) => write.id);
      if (ids.length) void memory.capture.embedPending(ids);
    } catch (error) {
      log('error', 'tool_execution_end failed', { error: error.message });
    }
  });

  pi.on('agent_end', async (event, ctx) => {
    try {
      const memory = await layer();
      const sid = currentSession(ctx);
      const writes = memory.capture.onAgentEnd({ sessionId: sid, at: new Date().toISOString() });
      const ids = writes.filter((write) => write.id).map((write) => write.id);
      if (ids.length) void memory.capture.embedPending(ids);
    } catch (error) {
      log('error', 'agent_end failed', { error: error.message });
    }
  });

  pi.on('session_shutdown', async () => {
    try {
      const memory = await layer();
      memory.embedder.release();
      frozen = null;
    } catch {}
  });

  pi.registerTool({
    name: 'memory_search',
    label: 'Long-term memory',
    description:
      'Search long-term memories recorded in earlier sessions (project rules, user preferences, past tasks, error fixes). Use it when the answer may have been learned before. Every hit carries its type, date and trust tier.',
    parameters: pi.zod.object({
      query: pi.zod.string().describe('Natural-language or keyword query, Korean or English.'),
      limit: pi.zod.number().int().min(1).max(10).default(5).describe('Maximum memories to return.'),
      type: pi.zod
        .array(pi.zod.enum(['user-preference', 'project-rule', 'past-task', 'error-fix', 'exploration-finding', 'failure-analysis']))
        .optional()
        .describe('Restrict to one or more memory types.'),
    }),
    approval: 'read',
    async execute(_toolCallId, params) {
      const memory = await layer();
      const result = await buildMemoryBlock(memory.store, memory.embedder, params.query, {
        limit: params.limit ?? 5,
        types: params.type,
        backfill: true,
      });
      const ids = result.block.ids;
      if (ids.length) memory.store.recordUse(ids);
      const lines = result.items.slice(0, params.limit ?? 5).map((item, index) => {
        const entry = item.memory;
        return `${index + 1}. [${entry.type}] ${clip(entry.title, 100)} (${entry.updatedAt.slice(0, 10)}, trust=${entry.trust})\n   ${clip(entry.body, 240)}\n   id=${entry.id} session=${entry.sessionId}`;
      });
      const text = lines.length
        ? `Found ${lines.length} memories (mode=${result.mode}, vector=${result.vector.count}).\n${lines.join('\n')}`
        : `No matching memory (mode=${result.mode}).`;
      return {
        content: [{ type: 'text', text }],
        details: {
          mode: result.mode,
          count: lines.length,
          ids,
          vectorModel: result.vector.model,
          degraded: result.vector.degraded,
        },
      };
    },
  });
}

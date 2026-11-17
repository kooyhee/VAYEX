// Resume state for `app/dx/task-resume.mjs`.
//
// `memoryResumeState` is the function to hand to `setMemoryHook(async (sessionKey) => …)`.
// It answers, in a bounded shape, "what from earlier sessions does a resumed task need?",
// with no model call: standing rules and preferences first, then the most recent task
// and error-fix memories, all size-capped so the caller can splice it into a prompt.
import { searchMemories } from './retrieve.mjs';
import { clip } from './text.mjs';

const RESUME_TYPES = ['project-rule', 'user-preference', 'error-fix', 'past-task'];
const MAX_ITEMS = 6;
const MAX_CHARS = 900;

/**
 * @param {object} layer memory layer from `createMemoryLayer`/`getMemoryLayer`
 * @param {string} [sessionKey] opaque task/session key used only as the retrieval query
 * @param {object} [options] `{ query, project, limit }`
 */
export async function memoryResumeState(layer, sessionKey = '', options = {}) {
  const store = layer.store;
  const query = options.query ?? sessionKey ?? '';
  const project = options.project ?? store.config.project;
  // A resume key is often a task id, not prose: fall back to the most important active
  // memories when the query yields nothing, so the hook is never empty for a real task.
  let items = [];
  if (query) {
    const result = await searchMemories(store, layer.embedder ?? null, query, {
      project,
      limit: MAX_ITEMS * 2,
      types: RESUME_TYPES,
    });
    items = result.items;
  }
  if (items.length < 3) {
    const fallback = store
      .list({ status: 'active', project, limit: MAX_ITEMS })
      .filter((row) => RESUME_TYPES.includes(row.type));
    const known = new Set(items.map((item) => item.memory.id));
    for (const row of fallback) {
      if (!known.has(row.id)) items.push({ memory: row, score: row.importance * row.trustScore, signals: {} });
    }
  }
  const bounded = items.slice(0, MAX_ITEMS).map((item) => ({
    id: item.memory.id,
    type: item.memory.type,
    title: clip(item.memory.title, 100),
    body: clip(item.memory.body, 200),
    score: Number(item.score?.toFixed?.(4) ?? item.score),
    updatedAt: item.memory.updatedAt,
  }));
  const text = bounded
    .map((item) => `- (${item.type}) ${item.title}`)
    .join('\n')
    .slice(0, MAX_CHARS);
  return { sessionKey, project, count: bounded.length, items: bounded, text, source: 'app/memory' };
}

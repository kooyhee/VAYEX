// Module API: the list / view / edit / delete surface plus search and injection helpers.
// `routes.mjs` is the thin HTTP adapter over exactly these functions.
import { MEMORY_TYPES } from './config.mjs';
import { screen } from './guard.mjs';
import { buildMemoryBlock, backfillEmbeddings, searchMemories } from './retrieve.mjs';

export function listMemories(layer, options = {}) {
  const { store } = layer;
  return {
    total: store.count({ type: options.type, status: options.status ?? 'active', project: options.project }),
    items: store.list(options),
    stats: store.stats(),
  };
}

export function getMemory(layer, id) {
  return layer.store.get(id);
}

/** Manual add (UI or CLI). Provenance is required, exactly like the automatic path. */
export function addMemory(layer, input, { sessionId = 'api', sourceEvent = 'api:add' } = {}) {
  const verdict = screen({
    sessionId: input.sessionId ?? sessionId,
    sourceEvent: input.sourceEvent ?? sourceEvent,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sourceKind: input.sourceKind ?? 'user',
    title: input.title,
    body: input.body,
    explicit: true,
  });
  if (!verdict.ok) {
    layer.store.audit('reject', verdict.reason, null, input.sessionId ?? sessionId, (input.title ?? '').slice(0, 120));
    return { ok: false, reason: verdict.reason, code: verdict.code ?? null, status: verdict.status ?? 200 };
  }
  const result = layer.store.add({
    type: MEMORY_TYPES.includes(input.type) ? input.type : 'project-rule',
    title: verdict.title || verdict.body,
    body: verdict.body,
    project: input.project,
    importance: input.importance ?? 0.7,
    trust: verdict.trust.trust,
    trustScore: verdict.trust.score,
    injectionFlagged: verdict.injection.flagged,
    secretsRedacted: verdict.masked > 0,
    sessionId: input.sessionId ?? sessionId,
    sourceEvent: input.sourceEvent ?? sourceEvent,
    sourceKind: input.sourceKind ?? 'user',
    subjectKey: input.subjectKey,
  });
  return { ok: true, ...result };
}

export function updateMemory(layer, id, patch = {}) {
  const verdict = screen({
    sessionId: layer.store.get(id)?.sessionId ?? 'api',
    sourceEvent: 'api:update',
    createdAt: new Date().toISOString(),
    sourceKind: 'user',
    title: patch.title ?? 'edit',
    body: patch.body ?? 'edit',
    explicit: true,
  });
  if (!verdict.ok) {
    layer.store.audit('reject', verdict.reason, id, layer.store.get(id)?.sessionId ?? null, 'update');
    return { ok: false, reason: verdict.reason, code: verdict.code ?? null, status: verdict.status ?? 200 };
  }
  const screened = { ...patch };
  if (patch.title !== undefined) screened.title = verdict.title;
  if (patch.body !== undefined) screened.body = verdict.body;
  const updated = layer.store.update(id, screened);
  return updated ? { ok: true, memory: updated } : { ok: false, reason: 'not found' };
}

export function deleteMemory(layer, id, { hard = false, actor = 'api' } = {}) {
  return { ok: layer.store.remove(id, { hard, actor }) };
}

export async function searchMemory(layer, query, options = {}) {
  return searchMemories(layer.store, layer.embedder, query, options);
}

/** The exact block the extension injects, for inspection and tests. */
export async function memoryBlock(layer, query, options = {}) {
  return buildMemoryBlock(layer.store, layer.embedder, query, options);
}

export async function reindex(layer, options = {}) {
  return backfillEmbeddings(layer.store, layer.embedder, options);
}

/**
 * Status for the UI. `types` keeps its name-array shape for existing callers;
 * `typeCounts` is the real per-type aggregate (active rows) so a chart never has to
 * invent a bar height, and every one of the six memory types is present even at 0.
 */
export function memoryStatus(layer) {
  const stats = layer.store.stats();
  const typeCounts = Object.fromEntries(MEMORY_TYPES.map((type) => [type, 0]));
  for (const [type, count] of Object.entries(stats.byType ?? {})) typeCounts[type] = Number(count);
  return {
    ...stats,
    embedding: layer.embedder.status(),
    types: MEMORY_TYPES,
    typeCounts,
    typeBreakdown: MEMORY_TYPES.map((type) => ({ type, count: typeCounts[type] })),
  };
}

export function auditLog(layer, limit = 100) {
  return layer.store.auditLog(limit);
}

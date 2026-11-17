// Hybrid retrieval: FTS5 keyword ranks + local-embedding vector ranks, fused with
// Reciprocal Rank Fusion (k=60), then re-weighted by importance, recency and project
// scope. The injected block is bounded in items and characters, and is deliberately
// placed at the *end* of the system prompt so the cached prefix above it never moves.
import { clip } from './text.mjs';
import { UNTRUSTED_PREAMBLE } from './guard.mjs';

export const BLOCK_START = '<!-- omp-memory:block v1 (session-frozen) -->';
export const BLOCK_END = '<!-- /omp-memory:block -->';

const TYPE_LABEL = {
  'user-preference': '선호',
  'project-rule': '규칙',
  'past-task': '작업',
  'error-fix': '오류수정',
  'exploration-finding': '탐색',
  'failure-analysis': '실패원인',
};

function recencyScore(updatedAt, now, halfLifeDays) {
  const ageDays = Math.max(0, (now - Date.parse(updatedAt)) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function fuse(keyword, vector, k) {
  const fused = new Map();
  for (const row of keyword) {
    const current = fused.get(row.id) ?? { id: row.id, keyword: 0, vector: 0 };
    current.keyword += 1 / (k + row.rank);
    fused.set(row.id, current);
  }
  for (const row of vector) {
    const current = fused.get(row.id) ?? { id: row.id, keyword: 0, vector: 0 };
    current.vector += 1 / (k + row.rank);
    fused.set(row.id, current);
  }
  const rows = [...fused.values()];
  const max = Math.max(...rows.map((row) => row.keyword + row.vector), 0);
  for (const row of rows) row.relevance = max ? (row.keyword + row.vector) / max : 0;
  return rows;
}

/**
 * Search memories. `vector` participates only when the query embedding matches the
 * stored vector model/dimension; otherwise the result reports `keyword` mode instead
 * of pretending a vector signal exists.
 */
export async function searchMemories(store, embedder, query, options = {}) {
  const config = store.config;
  const { project = config.project, limit = config.topK * 3, types, minTrust } = options;
  const now = options.now ?? Date.now();
  // A caller that names a project is asking for that scope: those rows only. With no
  // explicit scope the search still sees every project and ranks a foreign row with
  // the cross-project weight below — a penalty, which is what the config documents.
  const scope = options.project === undefined ? undefined : project;
  const rows = store.candidates({ project: scope, limit: config.candidateLimit * 10 }).filter((row) => (types?.length ? types.includes(row.type) : true));
  const keywordRanked = store.keywordRank(query, { project: scope, limit: config.candidateLimit }).filter((hit) => rows.some((row) => row.id === hit.id));
  let vectorRanked = [];
  let vectorInfo = { model: null, degraded: false };
  if (embedder) {
    const embedded = await embedder.embed([query], { kind: 'query' });
    vectorInfo = { model: embedded.model, degraded: embedded.degraded, reason: embedded.reason };
    if (embedded.vectors[0]) {
      const ranked = store.cosineRank(embedded.vectors[0], { model: embedded.model, limit: config.candidateLimit });
      const byId = new Map(rows.map((row) => [row.id, row]));
      vectorRanked = ranked.filter((hit) => byId.has(hit.id));
    }
  }
  const mode = vectorRanked.length && keywordRanked.length ? 'hybrid' : vectorRanked.length ? 'vector' : 'keyword';
  const fused = fuse(keywordRanked, vectorRanked, config.rrfK);

  const weight = config.weights;
  const scored = fused
    .map((entry) => {
      const row = rows.find((candidate) => candidate.id === entry.id);
      if (!row) return null;
      if (minTrust && row.trustScore < minTrust) return null;
      const importance = Math.min(1, row.importance);
      const recency = recencyScore(row.updatedAt, now, config.recencyHalfLifeDays);
      const projectMatch = row.project === project ? 1 : 0.55;
      const relevance = Math.min(1, entry.relevance + (row.useCount ? 0.02 : 0));
      const score =
        (weight.relevance * relevance + weight.importance * importance + weight.recency * recency + weight.project * projectMatch) *
        row.trustScore;
      return { memory: row, score, signals: { relevance, importance, recency, projectMatch, trust: row.trustScore } };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { mode, query, items: scored, vector: { ...vectorInfo, count: vectorRanked.length }, keywordCount: keywordRanked.length };
}

/** Embed memories that have no vector yet for the active model. Lazy, batched, bounded. */
export async function backfillEmbeddings(store, embedder, { limit = 200, kind = 'passage', batch = 16 } = {}) {
  if (!embedder) return { embedded: 0 };
  const { model } = await embedder.embed(['probe'], { kind });
  const ids = store.unembedded(model, limit);
  let embedded = 0;
  for (let i = 0; i < ids.length; i += batch) {
    const slice = ids.slice(i, i + batch);
    const texts = slice.map((id) => {
      const memory = store.get(id);
      return memory ? `${memory.title}\n${memory.body}` : '';
    });
    if (texts.every((text) => !text)) continue;
    const result = await embedder.embed(texts, { kind });
    slice.forEach((id, index) => {
      const vector = result.vectors[index];
      if (texts[index] && vector) store.putVector(id, result.model, vector);
    });
    embedded += slice.length;
  }
  return { embedded, model };
}

function lineFor(memory) {
  const label = TYPE_LABEL[memory.type] ?? memory.type;
  const day = (memory.updatedAt ?? '').slice(0, 10);
  return `- (${label}${day ? ` ${day}` : ''}) ${clip(memory.title, 100)} — ${clip(memory.body, 220)}`;
}

/**
 * Render the bounded memory block. Stable placement is the caller's job; this only
 * guarantees the block is small (top `minTopK`..`topK` entries, hard char ceiling),
 * deterministic (same inputs → same string) and framed as data rather than orders.
 */
export function renderMemoryBlock(items, config) {
  const budget = config.maxBlockChars;
  const header = `${BLOCK_START}\n## 장기 메모리 (프로젝트: ${config.project})\n${UNTRUSTED_PREAMBLE}`;
  if (!items.length) {
    return { text: '', ids: [], count: 0 };
  }
  const lines = [];
  let used = header.length + BLOCK_END.length + 8;
  for (const item of items.slice(0, config.topK)) {
    const line = lineFor(item.memory);
    if (used + line.length + 1 > budget && lines.length >= config.minTopK) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return { text: '', ids: [], count: 0 };
  const text = `${header}\n${lines.join('\n')}\n${BLOCK_END}`;
  return { text, ids: items.slice(0, lines.length).map((item) => item.memory.id), count: lines.length };
}

/** Convenience: search then render, the exact call the extension makes. */
export async function buildMemoryBlock(store, embedder, query, options = {}) {
  // Memories written since the last search have no vector yet; embedding them here is
  // the only place the model runs on the read path, and it is bounded and local.
  if (options.backfill && embedder) {
    try {
      await backfillEmbeddings(store, embedder, { limit: options.backfillLimit ?? 32 });
    } catch {
      // A failed backfill degrades to keyword ranking; it never fails the search.
    }
  }
  const result = await searchMemories(store, embedder, query, options);
  const block = renderMemoryBlock(result.items, store.config);
  return { ...result, block };
}

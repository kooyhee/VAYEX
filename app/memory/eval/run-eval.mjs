// Retrieval quality measurement: recall@k and MRR on a labelled, hand-built set.
//
// Two runs are reported: hybrid (local embeddings + FTS5) and keyword-only (FTS5
// alone). The gap between them is the measured contribution of the vector signal;
// reporting a single "good" number without the baseline would hide it.
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createMemoryLayer } from '../index.mjs';
import { searchMemories } from '../retrieve.mjs';
import { CORPUS, QUERIES } from './dataset.mjs';

export async function seedCorpus(layer) {
  const labels = new Map();
  for (const item of CORPUS) {
    const result = layer.store.add({
      type: item.type,
      title: item.title,
      body: item.body,
      importance: 0.7,
      trust: 'high',
      trustScore: 0.85,
      sessionId: 'eval-seed',
      sourceEvent: 'eval:seed',
      sourceKind: 'user',
      subjectKey: `eval:${item.label}`,
      createdAt: new Date().toISOString(),
    });
    labels.set(item.label, result.id);
  }
  return labels;
}

async function measure(store, embedder, labels, { backfill = true } = {}) {
  if (backfill && embedder) {
    const { backfillEmbeddings } = await import('../retrieve.mjs');
    await backfillEmbeddings(store, embedder, { limit: 200 });
  }
  const hits = { 1: 0, 3: 0, 5: 0 };
  let mrr = 0;
  const perQuery = [];
  for (const query of QUERIES) {
    const expected = query.expect.map((label) => labels.get(label));
    const result = await searchMemories(store, embedder, query.q, { limit: 10 });
    const ids = result.items.map((item) => item.memory.id);
    const rank = ids.findIndex((id) => expected.includes(id));
    if (rank === 0) hits[1] += 1;
    if (rank >= 0 && rank < 3) hits[3] += 1;
    if (rank >= 0 && rank < 5) hits[5] += 1;
    if (rank >= 0) mrr += 1 / (rank + 1);
    perQuery.push({ q: query.q, mode: result.mode, rank: rank + 1 || null, top: (result.items[0]?.memory.title ?? '').slice(0, 60) });
  }
  const n = QUERIES.length;
  return {
    mode: embedder ? 'hybrid' : 'keyword',
    queries: n,
    recallAt1: Number((hits[1] / n).toFixed(3)),
    recallAt3: Number((hits[3] / n).toFixed(3)),
    recallAt5: Number((hits[5] / n).toFixed(3)),
    mrr: Number((mrr / n).toFixed(3)),
    perQuery,
  };
}

export async function runEval({ layer = null, print = false, dbPath } = {}) {
  const target = dbPath ?? path.resolve(layer?.config.dataDir ?? path.join('app', 'memory', 'data'), 'eval.db');
  if (existsSync(target)) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true });
  }
  const own = !layer;
  const evalLayer = layer ?? (await createMemoryLayer({ dbPath: target, root: path.resolve(path.dirname(target), '..', '..', '..') }));
  const { backfillEmbeddings } = await import('../retrieve.mjs');
  try {
    evalLayer.store.init();
    await backfillEmbeddings(evalLayer.store, evalLayer.embedder, { limit: 1 }).catch(() => {});
    const labels = await seedCorpus(evalLayer);
    // Warm the embedder once so the first query is not measured against a cold load.
    const warm = await evalLayer.embedder.embed(['probe'], { kind: 'passage' });
    const results = {
      embeddingModel: warm.model,
      embeddingDim: warm.dim,
      embeddingDegraded: Boolean(warm.degraded),
      hybrid: await measure(evalLayer.store, evalLayer.embedder, labels),
      keyword: await measure(evalLayer.store, null, labels, { backfill: false }),
    };
    if (print) console.log(JSON.stringify(results, null, 2));
    return results;
  } finally {
    if (own) await evalLayer.close();
    if (own && existsSync(target)) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  runEval({ print: true }).then(() => process.exit(0));
}

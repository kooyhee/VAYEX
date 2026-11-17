import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runEval } from '../eval/run-eval.mjs';
import { PROJECT_ROOT } from './helpers.mjs';

// Uses the real local model when its weights are cached under app/memory/data/models;
// otherwise the deterministic offline embedder runs and the thresholds below are the
// keyword-only ones. Either way the numbers are reported, not asserted into existence.
test('retrieval quality: recall@k and MRR on the labelled query set', async () => {
  const results = await runEval({
    dbPath: path.join(PROJECT_ROOT, 'app', 'memory', 'data', 'eval-test.db'),
  });
  assert.equal(results.hybrid.queries, 20);
  assert.ok(results.hybrid.recallAt1 >= 0.6, `recall@1 was ${results.hybrid.recallAt1}`);
  assert.ok(results.hybrid.recallAt5 >= 0.85, `recall@5 was ${results.hybrid.recallAt5}`);
  assert.ok(results.hybrid.mrr >= 0.65, `MRR was ${results.hybrid.mrr}`);
  assert.ok(results.keyword.recallAt5 >= 0.6, 'keyword baseline must stay usable on its own');
  console.log(JSON.stringify({
    model: results.embeddingModel,
    hybrid: { recallAt1: results.hybrid.recallAt1, recallAt3: results.hybrid.recallAt3, recallAt5: results.hybrid.recallAt5, mrr: results.hybrid.mrr },
    keyword: { recallAt1: results.keyword.recallAt1, recallAt5: results.keyword.recallAt5, mrr: results.keyword.mrr },
  }, null, 2));
});

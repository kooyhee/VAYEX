// Composition root. One process owns one store (SQLite WAL, single writer) and one
// embedder (a self-releasing sidecar), so the host bridge and the `omp` extension each
// create the layer once and share it through the exported singleton.
import { memoryConfig } from './config.mjs';
import { EmbeddingClient } from './embedder.mjs';
import { MemoryStore } from './store.mjs';
import { MemoryCapture } from './capture.mjs';

export async function createMemoryLayer(overrides = {}) {
  const config = memoryConfig(overrides);
  const store = await MemoryStore.open({ ...overrides, root: config.root, dataDir: config.dataDir, dbPath: config.dbPath });
  const embedder = new EmbeddingClient(store.config);
  const capture = new MemoryCapture(store, { embedder, logger: overrides.logger });
  return {
    config: store.config,
    store,
    embedder,
    capture,
    async close() {
      embedder.release();
      store.close();
    },
  };
}

let singleton = null;

/** Process-wide layer: opened lazily on first use, reused afterwards. */
export function getMemoryLayer(overrides = {}) {
  if (!singleton) singleton = createMemoryLayer(overrides);
  return singleton;
}

export async function closeMemoryLayer() {
  if (!singleton) return;
  const pending = await singleton;
  singleton = null;
  await pending.close();
}

// Local, in-project configuration for the long-term memory layer.
//
// Every path resolves inside the project so the layer never writes outside it: the
// SQLite file, the embedding model cache and the audit log all live under
// `app/memory/data` (gitignored-style local data, never committed).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(MODULE_DIR, '..', '..');

/** Memory types the layer stores. Each type has its own importance floor and trust rules. */
export const MEMORY_TYPES = Object.freeze([
  'user-preference',
  'project-rule',
  'past-task',
  'error-fix',
  'exploration-finding',
  'failure-analysis',
]);

export const DEFAULT_EMBED_MODEL = 'Xenova/multilingual-e5-small';
/** Deterministic offline stand-in. Recorded as its own model id so it is never mistaken for semantics. */
export const HASH_EMBED_MODEL = 'local-hash-3gram-v1';

export function memoryConfig(overrides = {}) {
  const root = path.resolve(overrides.root ?? process.env.OMP_MEMORY_ROOT ?? DEFAULT_ROOT);
  const dataDir = path.resolve(
    overrides.dataDir ?? process.env.OMP_MEMORY_DATA_DIR ?? path.join(root, 'app', 'memory', 'data'),
  );
  return {
    root,
    dataDir,
    dbPath: path.resolve(overrides.dbPath ?? path.join(dataDir, 'memory.db')),
    modelsDir: path.resolve(overrides.modelsDir ?? path.join(dataDir, 'models')),
    auditPath: path.resolve(overrides.auditPath ?? path.join(dataDir, 'audit.jsonl')),
    // Project scope. Memories tagged with another project are retrieved with a penalty,
    // never silently promoted to this project's rank.
    project: overrides.project ?? process.env.OMP_MEMORY_PROJECT ?? path.basename(root),
    embedModel: overrides.embedModel ?? process.env.OMP_MEMORY_EMBED_MODEL ?? DEFAULT_EMBED_MODEL,
    embedIdleMs: Number(overrides.embedIdleMs ?? process.env.OMP_MEMORY_EMBED_IDLE_MS ?? 60_000),
    embedTimeoutMs: Number(overrides.embedTimeoutMs ?? process.env.OMP_MEMORY_EMBED_TIMEOUT_MS ?? 120_000),
    // Retrieval budgets. The injected block is bounded (top 3-5, char ceiling).
    topK: Number(overrides.topK ?? 5),
    minTopK: Number(overrides.minTopK ?? 3),
    maxBlockChars: Number(overrides.maxBlockChars ?? 1_600),
    rrfK: Number(overrides.rrfK ?? 60),
    candidateLimit: Number(overrides.candidateLimit ?? 50),
    // Ranking weights (sum 1.0). Relevance comes from fused RRF, the rest are multipliers.
    weights: { relevance: 0.55, importance: 0.2, recency: 0.15, project: 0.1 },
    recencyHalfLifeDays: Number(overrides.recencyHalfLifeDays ?? 45),
  };
}

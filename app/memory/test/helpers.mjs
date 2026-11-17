// Test helpers: every test gets its own SQLite file under the in-project data dir,
// and the deterministic offline embedder unless a test opts into the real model.
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');

// Every test gets its own SQLite file under the in-project data dir. Tests choose
// their embedder explicitly (`embedModel: 'local-hash-3gram-v1'`) so only the eval
// test pays for the real model.
process.env.OMP_MEMORY_EMBED_IDLE_MS ??= '5000';

export function tempDir(prefix = 'test') {
  const dir = mkdtempSync(path.join(PROJECT_ROOT, 'app', 'memory', 'data', `${prefix}-`));
  return {
    dir,
    dbPath: path.join(dir, 'memory.db'),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const NOW = '2026-11-18T09:00:00.000Z';

export function candidate(overrides = {}) {
  return {
    type: 'project-rule',
    title: '빌드는 bun run build로 실행한다',
    body: '이 프로젝트의 빌드 명령은 bun run build 이다.',
    importance: 0.7,
    sessionId: 'session-a',
    sourceEvent: 'prompt:remember',
    sourceKind: 'user',
    createdAt: NOW,
    ...overrides,
  };
}

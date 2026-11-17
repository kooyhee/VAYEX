// Cross-session demo scenario (A → B):
//
// In Session A:
//   1. The user asks the agent to remember project rules (e.g. build command).
//   2. The agent runs a failing command (port in use) followed by a successful fix.
//   3. The agent ends its turn.
// Process restart / new session:
//   Session B is created with zero shared in-memory state.
//   The agent receives a new query about how to build and fix the port issue.
//   The injected context block and memory_search tool surface the facts learned
//   in session A.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryLayer } from '../index.mjs';
import { buildMemoryBlock } from '../retrieve.mjs';
import { tempDir } from './helpers.mjs';

test('cross-session long-term memory: session A learns facts & fix, session B retrieves them', async () => {
  const tmp = tempDir('cross-session');

  // ==========================================
  // PHASE 1: SESSION A
  // ==========================================
  const layerA = await createMemoryLayer({ dbPath: tmp.dbPath, project: 'lab-platform' });
  const sessionAId = 'session-20261118-A';

  // 1-1. User prompt: explicit project facts
  const promptA = '기억해줘: 이 프로젝트의 빌드는 bun run build 로 실행한다. 항상 한국어 존댓말로 답한다.';
  layerA.capture.onPrompt({
    prompt: promptA,
    sessionId: sessionAId,
    at: '2026-11-18T09:00:00.000Z',
  });

  // 1-2. Agent tool run: failure event
  layerA.capture.onToolStart({ toolName: 'bash', args: { command: 'node ../gateway/stub/stub-upstream.mjs' } });
  layerA.capture.onToolEnd({
    toolName: 'bash',
    args: { command: 'node ../gateway/stub/stub-upstream.mjs' },
    result: { stdout: '', stderr: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:8799' },
    isError: true,
    sessionId: sessionAId,
    at: '2026-11-18T09:01:00.000Z',
  });

  // 1-3. Agent tool run: successful fix
  layerA.capture.onToolStart({ toolName: 'bash', args: { command: 'Get-Process -Id (Get-NetTCPConnection -LocalPort 8799).OwningProcess | Stop-Process; node stub.mjs' } });
  layerA.capture.onToolEnd({
    toolName: 'bash',
    args: { command: 'Get-Process -Id (Get-NetTCPConnection -LocalPort 8799).OwningProcess | Stop-Process; node stub.mjs' },
    result: { stdout: 'stub upstream listening on http://127.0.0.1:8799', stderr: '' },
    isError: false,
    sessionId: sessionAId,
    at: '2026-11-18T09:02:00.000Z',
  });

  // 1-4. Turn ends
  layerA.capture.onAgentEnd({ sessionId: sessionAId, at: '2026-11-18T09:02:30.000Z' });

  // Verify Session A stored active memories with full provenance
  const statsA = layerA.store.stats();
  assert.ok(statsA.active >= 2, `Session A must have stored at least 2 memories, got ${statsA.active}`);
  const errorFixMemory = layerA.store.list({ type: 'error-fix' });
  assert.ok(errorFixMemory.length >= 1, 'Error fix must be recorded');
  assert.match(errorFixMemory[0].body, /EADDRINUSE/);
  assert.equal(errorFixMemory[0].sessionId, sessionAId);

  // Close Session A completely (simulating process exit)
  await layerA.close();

  // ==========================================
  // PHASE 2: BRAND-NEW SESSION B
  // ==========================================
  const layerB = await createMemoryLayer({ dbPath: tmp.dbPath, project: 'lab-platform' });
  const sessionBId = 'session-20261118-B';

  // 2-1. Session B starts fresh without in-memory state from Session A
  const promptB = '빌드가 안 되고 8799 포트 오류가 나는데 어떻게 해결하지?';

  // 2-2. Prompt injection path: build bounded memory block for agent system prompt
  const injectionResult = await buildMemoryBlock(layerB.store, layerB.embedder, promptB, {
    project: 'lab-platform',
    backfill: true,
  });

  assert.ok(injectionResult.block.count >= 2, 'Injected block must contain matching memories');
  assert.match(injectionResult.block.text, /bun run build/, 'Injected block must contain session A build rule');
  assert.match(injectionResult.block.text, /EADDRINUSE/, 'Injected block must contain session A error-fix experience');
  assert.match(injectionResult.block.text, /<!-- omp-memory:block v1/, 'Block must have stable framing');

  // Verify stable placement and size constraint
  assert.ok(injectionResult.block.text.length <= layerB.config.maxBlockChars + 150);

  // 2-3. Agent-callable tool path: memory_search tool query
  const toolSearchResult = await buildMemoryBlock(layerB.store, layerB.embedder, 'bun build', {
    project: 'lab-platform',
  });
  assert.ok(toolSearchResult.items.length >= 1);
  assert.equal(toolSearchResult.items[0].memory.sessionId, sessionAId, 'Must trace provenance back to Session A');

  await layerB.close();
  tmp.cleanup();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import {
  detectProject,
  SnapshotManager,
  generateUnifiedDiff,
  runVerification,
  explainError,
  TaskResumeManager,
  CostAnalytics,
  createDxRouter
} from '../index.mjs';

/**
 * Creates an isolated temp directory for test fixtures.
 */
async function createTempDir(prefix = 'dx-test-') {
  return await mkdtemp(join(tmpdir(), prefix));
}

// =========================================================================
// 1. Project Auto-Detection Tests
// =========================================================================
test('Feature 1: Auto-detects Node.js / TypeScript project with Next.js and pnpm', async () => {
  const dir = await createTempDir('dx-node-');
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'sample-next-app',
      scripts: {
        build: 'next build',
        test: 'vitest run'
      },
      dependencies: {
        next: '14.2.0',
        react: '18.3.0',
        typescript: '^5.0.0'
      }
    }));
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    await writeFile(join(dir, 'tsconfig.json'), '{}');

    const result = await detectProject(dir);
    assert.equal(result.detected, true);
    assert.equal(result.language, 'typescript');
    assert.equal(result.framework, 'next');
    assert.equal(result.frameworkLabel, 'Next.js');
    assert.equal(result.packageManager, 'pnpm');
    assert.equal(result.buildCommand, 'pnpm build');
    assert.equal(result.testCommand, 'pnpm test');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Feature 1: Auto-detects Python project with FastAPI and pytest', async () => {
  const dir = await createTempDir('dx-py-');
  try {
    await writeFile(join(dir, 'pyproject.toml'), `
[tool.poetry]
name = "demo-fastapi"
dependencies = [
    "fastapi",
    "uvicorn"
]
`);
    await writeFile(join(dir, 'poetry.lock'), '');
    await writeFile(join(dir, 'main.py'), '# entry');

    const result = await detectProject(dir);
    assert.equal(result.detected, true);
    assert.equal(result.language, 'python');
    assert.equal(result.framework, 'fastapi');
    assert.equal(result.packageManager, 'poetry');
    assert.equal(result.testCommand, 'poetry run pytest');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Feature 1: Auto-detects Rust Cargo project with Axum', async () => {
  const dir = await createTempDir('dx-rust-');
  try {
    await writeFile(join(dir, 'Cargo.toml'), `
[package]
name = "demo-rust"
version = "0.1.0"

[dependencies]
axum = "0.7"
tokio = { version = "1.0", features = ["full"] }
`);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'main.rs'), 'fn main() {}');

    const result = await detectProject(dir);
    assert.equal(result.detected, true);
    assert.equal(result.language, 'rust');
    assert.equal(result.framework, 'axum');
    assert.equal(result.packageManager, 'cargo');
    assert.equal(result.buildCommand, 'cargo build');
    assert.equal(result.testCommand, 'cargo test');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Feature 1: Auto-detects Go module and Java Gradle project', async () => {
  const goDir = await createTempDir('dx-go-');
  const jvmDir = await createTempDir('dx-jvm-');
  try {
    await writeFile(join(goDir, 'go.mod'), 'module demo\n\nrequire github.com/gin-gonic/gin v1.9.0\n');
    await writeFile(join(goDir, 'main.go'), 'package main');
    const goInfo = await detectProject(goDir);
    assert.equal(goInfo.detected, true);
    assert.equal(goInfo.language, 'go');
    assert.equal(goInfo.framework, 'gin');
    assert.equal(goInfo.testCommand, 'go test ./...');

    await writeFile(join(jvmDir, 'build.gradle.kts'), 'dependencies { implementation("org.springframework.boot:spring-boot-starter-web") }');
    const jvmInfo = await detectProject(jvmDir);
    assert.equal(jvmInfo.detected, true);
    assert.equal(jvmInfo.language, 'kotlin');
    assert.equal(jvmInfo.framework, 'spring-boot');
    assert.equal(jvmInfo.testCommand, 'gradle test');
  } finally {
    await rm(goDir, { recursive: true, force: true });
    await rm(jvmDir, { recursive: true, force: true });
  }
});

// =========================================================================
// 2. Change Preview & Recovery Tests (Git-free snapshots & diffs)
// =========================================================================
test('Feature 2: Generates unified diff correctly with additions and deletions', () => {
  const before = 'function add(a, b) {\n  return a - b;\n}';
  const after = 'function add(a, b) {\n  return a + b;\n}';

  const diffResult = generateUnifiedDiff(before, after, 'src/math.js');
  assert.equal(diffResult.additions, 1);
  assert.equal(diffResult.deletions, 1);
  assert.match(diffResult.diff, /--- a\/src\/math\.js/);
  assert.match(diffResult.diff, /\+  return a \+ b;/);
  assert.match(diffResult.diff, /-  return a - b;/);
});

test('Feature 2: SnapshotManager handles modify, create, single-file revert, and rollback', async () => {
  const projectDir = await createTempDir('dx-proj-');
  const snapshotStorage = await createTempDir('dx-snap-');

  try {
    const existingFile = join(projectDir, 'src', 'index.js');
    await mkdir(join(projectDir, 'src'), { recursive: true });
    await writeFile(existingFile, 'const original = true;\n', 'utf8');

    const sm = new SnapshotManager({
      projectRoot: projectDir,
      storageDir: snapshotStorage
    });
    await sm.init();

    const taskId = 'task-demo-001';

    // 1. Snapshot existing file before agent edits it
    await sm.recordSnapshot(taskId, 'src/index.js');
    // Agent modifies existing file
    await writeFile(existingFile, 'const original = false;\nconst updated = true;\n', 'utf8');

    // 2. Snapshot newly created file (did not exist before)
    await sm.recordSnapshot(taskId, 'src/utils.js');
    // Agent writes new file
    await writeFile(join(projectDir, 'src', 'utils.js'), 'export const helper = 42;\n', 'utf8');

    // Check task diff
    const diffData = await sm.getTaskDiff(taskId);
    assert.equal(diffData.files.length, 2);
    assert.equal(diffData.summary.totalFiles, 2);

    const indexDiff = diffData.files.find(f => f.path === 'src/index.js');
    assert.equal(indexDiff.fileType, 'modified');
    assert.match(indexDiff.diff, /\+const updated = true;/);

    const utilsDiff = diffData.files.find(f => f.path === 'src/utils.js');
    assert.equal(utilsDiff.fileType, 'created');

    // 3. A changed file needs no approval: the snapshot status stays 'changed'
    assert.equal(indexDiff.status, 'changed');

    // 4. Revert single file (revert new file -> it should be unlinked/deleted)
    const revertRes = await sm.revertFile(taskId, 'src/utils.js');
    assert.equal(revertRes.action, 'deleted');
    let utilsExists = true;
    try {
      await stat(join(projectDir, 'src', 'utils.js'));
    } catch {
      utilsExists = false;
    }
    assert.equal(utilsExists, false, 'Newly created file should be deleted on revert');

    // 5. Rollback task (reverts src/index.js back to original content)
    await sm.rollbackTask(taskId);
    const restoredContent = await readFile(existingFile, 'utf8');
    assert.equal(restoredContent, 'const original = true;\n');
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    await rm(snapshotStorage, { recursive: true, force: true });
  }
});

// =========================================================================
// 3. Auto-Verify Runner Tests
// =========================================================================
test('Feature 3: Auto-verify runs passing test and summarizes in Korean', async () => {
  const dir = await createTempDir('dx-verify-pass-');
  try {
    await writeFile(join(dir, 'test.js'), 'if (1 + 1 !== 2) process.exit(1); console.log("OK - 3 tests passed");');
    const result = await runVerification({
      projectRoot: dir,
      command: 'node test.js',
      timeoutMs: 5000
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'passed');
    assert.equal(result.exitCode, 0);
    assert.match(result.summary, /검증 통과/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Feature 3: Auto-verify captures failure and attaches Korean explanation', async () => {
  const dir = await createTempDir('dx-verify-fail-');
  try {
    await writeFile(join(dir, 'test.js'), 'console.error("AssertionError: Expected 42 but received 0"); process.exit(1);');
    const result = await runVerification({
      projectRoot: dir,
      command: 'node test.js',
      timeoutMs: 5000
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /검증 실패/);
    assert.equal(result.explanation.category, 'assertion_failure');
    assert.match(result.explanation.cause, /테스트 검증 조건 불일치/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Feature 3: Auto-verify terminates timed-out process', async () => {
  const dir = await createTempDir('dx-verify-timeout-');
  try {
    // Infinite loop
    await writeFile(join(dir, 'hang.js'), 'setInterval(() => {}, 1000);');
    const result = await runVerification({
      projectRoot: dir,
      command: 'node hang.js',
      timeoutMs: 800 // Quick timeout
    });

    assert.equal(result.success, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.status, 'timeout');
    assert.match(result.summary, /제한 시간을 초과했습니다/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// 4. Plain Korean Error Explainer Tests (Rule-based, 7 categories)
// =========================================================================
test('Feature 4: Korean error explainer correctly identifies all 7 common error categories', () => {
  // 1. Syntax
  const syntaxExp = explainError('SyntaxError: Unexpected token "}" at src/app.js:14:2');
  assert.equal(syntaxExp.category, 'syntax');
  assert.match(syntaxExp.cause, /문법/);

  // 2. Module not found
  const modExp = explainError("Error: Cannot find module 'lodash'");
  assert.equal(modExp.category, 'module_not_found');
  assert.match(modExp.fix, /npm install lodash/);

  // 3. Type error
  const typeExp = explainError("TypeError: Cannot read properties of undefined (reading 'map')");
  assert.equal(typeExp.category, 'type_error');
  assert.match(typeExp.cause, /타입/);

  // 4. Test assertion
  const assertExp = explainError('AssertionError: Expected: 100\nReceived: 50');
  assert.equal(assertExp.category, 'assertion_failure');
  assert.match(assertExp.cause, /기대값: 100, 실제값: 50/);

  // 5. Port in use
  const portExp = explainError('Error: listen EADDRINUSE: address already in use :::3000');
  assert.equal(portExp.category, 'port_in_use');
  assert.match(portExp.cause, /3000/);

  // 6. Permission
  const permExp = explainError("Error: EACCES: permission denied, open 'dist/bundle.js'");
  assert.equal(permExp.category, 'permission');
  assert.match(permExp.cause, /접근하거나 쓸 권한이 없습니다/);

  // 7. Timeout
  const timeExp = explainError('Error: ETIMEDOUT: command timed out after 30000ms');
  assert.equal(timeExp.category, 'timeout');
  assert.match(timeExp.cause, /제한 시간/);
});

// =========================================================================
// 5. Task Resume Tests
// =========================================================================
test('Feature 5: TaskResumeManager saves, marks interrupted, and restores state with prompt and memory hook', async () => {
  const dir = await createTempDir('dx-tasks-');
  try {
    const tm = new TaskResumeManager({ storageDir: dir });
    await tm.init();

    // Hook to test session memory integration
    tm.setMemoryHook(async (sessionKey) => ({
      restoredSessionKey: sessionKey,
      contextData: { visitorLang: 'ko', vibeScore: 98 }
    }));

    const taskId = 'task-vibe-42';
    await tm.saveTaskState({
      taskId,
      sessionId: 'sess-abc-123',
      request: '학생용 계산기 컴포넌트에 나눗셈 예외처리를 추가해줘',
      plan: [
        { step: 1, title: '나눗셈 0 체크 추가', status: 'completed' },
        { step: 2, title: '단위 테스트 작성', status: 'pending' }
      ],
      progress: { currentStep: 1, totalSteps: 2, percent: 50 },
      changedFiles: [{ path: 'src/calc.js', status: 'pending' }]
    });

    // Mark interrupted (simulating sudden drop)
    await tm.markInterrupted(taskId, '브라우저 탭 종료됨');
    const interrupted = await tm.getTaskState(taskId);
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.interruptReason, '브라우저 탭 종료됨');

    // Resume task
    const resumeRes = await tm.restoreTask(taskId);
    assert.equal(resumeRes.restored, true);
    assert.equal(resumeRes.task.status, 'running');
    assert.match(resumeRes.resumePrompt, /\[중단된 작업 복원\]/);
    assert.match(resumeRes.resumePrompt, /다음 단계: 단위 테스트 작성/);
    assert.match(resumeRes.resumePrompt, /진행 상황: 총 2단계 중 1단계 완료/);
    assert.equal(resumeRes.memoryState.restoredSessionKey, 'sess-abc-123');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// =========================================================================
// 6. Cost Analytics & Visualization Tests
// =========================================================================
test('Feature 6: CostAnalytics aggregates local offloading savings and prompt compaction in KRW/USD', () => {
  const ca = new CostAnalytics({ krwPerUsd: 1400 });

  const taskId = 'task-cost-01';

  // Turn 1: 1000 prompt tokens, 200 completion tokens on local model (100% free)
  ca.recordEvent({
    taskId,
    type: 'llm_turn',
    route: 'local_only',
    promptTokens: 1000,
    completionTokens: 200,
    cachedTokens: 300
  });

  // Turn 2: Optimization event (prompt compaction saved 500 tokens)
  ca.recordEvent({
    taskId,
    type: 'optimization',
    strategy: 'prompt_compaction',
    tokensSaved: 500
  });

  const costData = ca.getTaskCost(taskId);

  assert.equal(costData.tokens.total, 1200);
  assert.equal(costData.tokens.optimizationSaved, 500);
  assert.equal(costData.cost.actualKrw, 0, 'Local only route costs 0 KRW');
  assert.ok(costData.cost.baselineKrw > 0, 'Baseline cloud cost should be calculated');
  assert.equal(costData.cost.savingsPercent, 100, '100% savings with local harness');
  assert.match(costData.koreanSummary, /로컬 하네스 100% 처리로 클라우드 비용 전액/);

  // Platform overview check
  const overview = ca.getOverview();
  assert.equal(overview.totalTasks, 1);
  assert.equal(overview.totalTokens, 1200);
  assert.equal(overview.savingsPercent, 100);
  assert.match(overview.koreanReport, /학생 로컬 코딩 플랫폼 누적 비용 절감액/);
});

// =========================================================================
// 7. HTTP Route Handler Integration Tests
// =========================================================================
test('Feature 7: DX Router handles HTTP endpoints correctly', async () => {
  const testRoot = await createTempDir('dx-http-root-');
  const testState = await createTempDir('dx-http-state-');

  try {
    // Setup minimal project in testRoot
    await writeFile(join(testRoot, 'package.json'), JSON.stringify({
      name: 'router-test',
      scripts: { test: 'node -e "process.exit(0)"' }
    }));
    await writeFile(join(testRoot, 'demo.js'), 'console.log("hello");\n');

    const router = createDxRouter({
      projectRoot: testRoot,
      stateDir: testState
    });

    const server = http.createServer(async (req, res) => {
      const handled = await router.handle(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. GET /api/dx/project/detect
      const detectRes = await fetch(`${baseUrl}/api/dx/project/detect`);
      assert.equal(detectRes.status, 200);
      const detectData = await detectRes.json();
      assert.equal(detectData.detected, true);
      assert.equal(detectData.language, 'javascript');

      // 2. POST /api/dx/snapshot/record
      const recRes = await fetch(`${baseUrl}/api/dx/snapshot/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 't-10', filePath: 'demo.js' })
      });
      assert.equal(recRes.status, 200);
      const recData = await recRes.json();
      assert.equal(recData.success, true);

      // Modify file
      await writeFile(join(testRoot, 'demo.js'), 'console.log("hello world!");\n');

      // 3. GET /api/dx/snapshot/diff
      const diffRes = await fetch(`${baseUrl}/api/dx/snapshot/diff?taskId=t-10`);
      assert.equal(diffRes.status, 200);
      const diffData = await diffRes.json();
      assert.equal(diffData.files.length, 1);
      assert.match(diffData.files[0].diff, /\+console\.log\("hello world!"\);/);

      // 4. POST /api/dx/verify/run
      const verifyRes = await fetch(`${baseUrl}/api/dx/verify/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot: testRoot })
      });
      assert.equal(verifyRes.status, 200);
      const verifyData = await verifyRes.json();
      assert.equal(verifyData.success, true);
      assert.equal(verifyData.status, 'passed');

      // 5. POST /api/dx/explain-error
      const explainRes = await fetch(`${baseUrl}/api/dx/explain-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'TypeError: x is not a function' })
      });
      assert.equal(explainRes.status, 200);
      const expData = await explainRes.json();
      assert.equal(expData.category, 'type_error');

      // 6. POST /api/dx/tasks/save & GET /api/dx/tasks/get
      const saveRes = await fetch(`${baseUrl}/api/dx/tasks/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 't-10', request: 'UI 버튼 추가', status: 'running' })
      });
      assert.equal(saveRes.status, 200);

      const getRes = await fetch(`${baseUrl}/api/dx/tasks/get?taskId=t-10`);
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.equal(getData.request, 'UI 버튼 추가');

      // 7. POST /api/dx/cost/event & GET /api/dx/cost/task
      await fetch(`${baseUrl}/api/dx/cost/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 't-10', type: 'llm_turn', route: 'local_only', promptTokens: 500, completionTokens: 100 })
      });

      const costRes = await fetch(`${baseUrl}/api/dx/cost/task?taskId=t-10`);
      assert.equal(costRes.status, 200);
      const costData = await costRes.json();
      assert.equal(costData.tokens.total, 600);
      assert.equal(costData.cost.savingsPercent, 100);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  } finally {
    await rm(testRoot, { recursive: true, force: true });
    await rm(testState, { recursive: true, force: true });
  }
});

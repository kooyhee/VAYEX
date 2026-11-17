import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInference } from '../lib/inference.mjs';
import { localRuntime } from '../server.mjs';

const RPC_INPUT = JSON.stringify({ id: '1', type: 'negotiate_protocol', protocolVersion: 2 }) + '\n' +
  JSON.stringify({ id: '2', type: 'get_available_models' }) + '\n';

// A hang detector, not a deadline. The core exits on its own once stdin closes:
// measured ~3s alone and ~19s while twelve cores start in parallel. The budget
// only fires when the child genuinely never exits, and that case is reported as
// the string 'timeout' so a hang can never be read as an exit status.
const CORE_HANG_BUDGET_MS = 60000;

// Runs one real core to its own exit. The exit is awaited rather than raced
// against a short deadline, so a slow machine makes this test slower instead of
// failing it; a child that never exits is reported as a timeout.
function runCore(cwd, agentDir) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(localRuntime.bun, [localRuntime.cli, '--mode', 'rpc'], {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        USERPROFILE: cwd,
        PI_CONFIG_DIR: '.omp',
        PI_CODING_AGENT_DIR: agentDir,
        OMP_PROFILE: '',
        PI_PROFILE: '',
        PI_CONFIG_FILES: ''
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', rejectRun);
    const hang = setTimeout(() => {
      child.kill('SIGKILL');
      resolveRun({ status: 'timeout', signal: null, stdout, stderr });
    }, CORE_HANG_BUDGET_MS);
    hang.unref();
    child.on('close', (status, signal) => {
      clearTimeout(hang);
      resolveRun({ status, signal, stdout, stderr });
    });
    child.stdin.end(RPC_INPUT);
  });
}

test('Background model unset: generated models.yml contains only default model and launch behaves as before', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'omp-bg-unset-'));
  try {
    const rawInference = {
      upstreams: [{
        id: 'stub-main',
        class: 'server_local',
        kind: 'openai',
        base_url: 'http://127.0.0.1:8799/local/v1',
        auth_mode: 'none',
        models: [{
          id: 'stub-chat',
          capabilities: ['chat'],
          zero_data_retention: true,
          training_opt_out: true,
          context_window: 32768,
          thinking_limit: 8192
        }]
      }]
    };
    const inference = createInference({
      raw: rawInference,
      appRoot: resolve('.'),
      stateDir: scratch,
      identity: 'test-user',
      sessions: new Map(),
      stdout: { write() {} }
    });

    inference.prepareRuntime('http://127.0.0.1:4317/v1', null);

    const generated = JSON.parse(readFileSync(inference.modelsFile, 'utf8'));
    assert.ok(generated.providers['harness-local']);
    assert.equal(generated.providers['harness-local'].models.length, 1);
    assert.equal(generated.providers['harness-local'].models[0].id, 'auto');
    assert.equal(generated.providers['harness-local'].models[0].compactionModel, undefined);
    assert.equal(generated.providers['harness-local-small'], undefined);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('Background model configured: generated models.yml registers small background model and compactionModel', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'omp-bg-set-'));
  try {
    const rawInference = {
      upstreams: [{
        id: 'stub-main',
        class: 'server_local',
        kind: 'openai',
        base_url: 'http://127.0.0.1:8799/local/v1',
        auth_mode: 'none',
        models: [{
          id: 'stub-chat',
          capabilities: ['chat'],
          zero_data_retention: true,
          training_opt_out: true,
          context_window: 32768,
          thinking_limit: 8192
        }]
      }]
    };
    const inference = createInference({
      raw: rawInference,
      appRoot: resolve('.'),
      stateDir: scratch,
      identity: 'test-user',
      sessions: new Map(),
      stdout: { write() {} }
    });

    const bgConfig = {
      enabled: true,
      provider: 'harness-local-small',
      model: 'small-background',
      endpoint: 'http://127.0.0.1:11434/v1',
      contextWindow: 16384,
      maxTokens: 2048
    };

    inference.prepareRuntime('http://127.0.0.1:4317/v1', bgConfig);

    const generated = JSON.parse(readFileSync(inference.modelsFile, 'utf8'));
    assert.ok(generated.providers['harness-local']);
    assert.equal(generated.providers['harness-local'].models[0].compactionModel, 'harness-local-small/small-background');
    assert.ok(generated.providers['harness-local-small']);
    assert.equal(generated.providers['harness-local-small'].baseUrl, 'http://127.0.0.1:11434/v1');
    assert.equal(generated.providers['harness-local-small'].models[0].id, 'small-background');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// The core is a real bun process: it must be awaited to its own exit. A
// spawnSync deadline kills it mid-shutdown while the rest of the suite spawns
// other cores in parallel (a cold model cache alone costs seconds), so the
// child's exit is awaited and only a genuine hang runs into the test budget.
test('Missing local background endpoint degrades gracefully without failing launch', { timeout: 120000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'omp-bg-degrade-'));
  try {
    const rawInference = {
      upstreams: [{
        id: 'stub-main',
        class: 'server_local',
        kind: 'openai',
        base_url: 'http://127.0.0.1:8799/local/v1',
        auth_mode: 'none',
        models: [{
          id: 'stub-chat',
          capabilities: ['chat'],
          zero_data_retention: true,
          training_opt_out: true,
          context_window: 32768,
          thinking_limit: 8192
        }]
      }]
    };
    const inference = createInference({
      raw: rawInference,
      appRoot: resolve('.'),
      stateDir: scratch,
      identity: 'test-user',
      sessions: new Map(),
      stdout: { write() {} }
    });

    // Points at a local port where nothing is listening (e.g. 59999)
    const bgConfig = {
      enabled: true,
      provider: 'harness-local-small',
      model: 'small-background',
      endpoint: 'http://127.0.0.1:59999/v1'
    };

    inference.prepareRuntime('http://127.0.0.1:4317/v1', bgConfig);

    // Test real OMP launch with this models.yml
    const res = await runCore(scratch, inference.agentDir);

    // A child that never exits is reported as 'timeout', never as a clean exit,
    // so a hang can never be mistaken for the degraded launch this test covers.
    assert.notEqual(res.status, 'timeout',
      `the core did not exit within ${CORE_HANG_BUDGET_MS} ms; stderr: ${res.stderr.slice(0, 2000)}`);
    assert.equal(res.status, 0, `the unreachable background endpoint must not break launch; stderr: ${res.stderr.slice(0, 2000)}`);
    const availableModelsFrame = res.stdout.split('\n')
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .find(f => f?.id === '2');

    assert.equal(availableModelsFrame?.success, true);
    const models = availableModelsFrame.data.models;
    assert.ok(models.some(m => m.provider === 'harness-local' && m.id === 'auto'));
    assert.ok(models.some(m => m.provider === 'harness-local-small' && m.id === 'small-background'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

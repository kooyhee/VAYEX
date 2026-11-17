import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const origJson = path.join(PROJECT_ROOT, 'output', 'benchmark-live-4env-result.json');
const taskfixJson = path.join(PROJECT_ROOT, 'output', 'benchmark-live-4env-taskfix-result.json');

const orig = JSON.parse(fs.readFileSync(origJson, 'utf8'));

// Retain all 39 runs that are NOT task-b in live environments
// (or retain all runs except task-b for claude, deepseek, vayex)
const preservedRuns = orig.runs.filter((r) => {
  const isTaskB = r.taskId === 'task-b-frontend-component';
  const isLiveCapable = ['claude-opus-5-5', 'deepseek-v4.1-flash-1017', 'vayex-harness'].includes(r.envId);
  return !(isTaskB && isLiveCapable);
});

console.log(`Preserving ${preservedRuns.length} runs into taskfix baseline (excluding 9 task-b live runs for re-measurement).`);

const taskfixPayload = {
  ...orig,
  lane: 'live_4env_taskfix',
  promptMode: 'corrected_spec',
  taskbContractLabel: '과제 명세 정정 후 재측정 (공정 비교)',
  runs: preservedRuns,
  recordedRuns: preservedRuns.length,
};

fs.writeFileSync(taskfixJson, JSON.stringify(taskfixPayload, null, 2), 'utf8');
console.log(`Seeded ${taskfixJson} with ${preservedRuns.length} prior runs.`);

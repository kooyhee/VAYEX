import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createWatchdog, evaluateWatchdog, formatWatchdog, DEFAULT_THRESHOLDS } from '../watchdog.mjs';

const frame = (at, extra = {}) => ({ type: 'message', ts: at, ...extra });
const toolStart = (at, toolName, toolId) => ({ type: 'tool_execution_start', ts: at, toolName, toolId });
const toolEnd = (at, toolId, isError = false) => ({ type: 'tool_execution_end', ts: at, toolId, result: { isError } });

test('watchdog: a quiet but healthy turn stays running, never stalled', () => {
  const watchdog = createWatchdog({ thresholds: { stallMs: 10000 } });
  watchdog.observe(frame(1000));
  watchdog.observe(frame(9000));
  const status = watchdog.status(9500);
  assert.equal(status.state, 'running');
  assert.equal(status.stalled, false);
  assert.equal(status.silentMs, 500);
  assert.equal(status.source, 'observable');
});

test('watchdog: silence beyond the threshold while non-terminal is a stall', () => {
  const watchdog = createWatchdog({ thresholds: { stallMs: 10000 } });
  watchdog.observe({ type: 'turn_start', ts: 1000, status: 'running' });
  watchdog.observe(frame(2000));
  const status = watchdog.status(20000);
  assert.equal(status.state, 'stalled');
  assert.equal(status.stalled, true);
  assert.equal(status.reason, 'no_signal_within_threshold');
  assert.equal(status.observedMs, 18000);
});

test('watchdog: a heartbeat alone clears the stall verdict', () => {
  const watchdog = createWatchdog({ thresholds: { stallMs: 10000 } });
  watchdog.observe({ type: 'turn_start', ts: 1000, status: 'running' });
  watchdog.observe({ type: 'heartbeat', ts: 9000 });
  watchdog.observe({ type: 'heartbeat', ts: 14000 });
  assert.equal(watchdog.status(15000).state, 'running');
  assert.equal(watchdog.status(15000).silentMs, 1000);
});

test('watchdog: an admitted tool with no terminal result is a stall', () => {
  const watchdog = createWatchdog({ thresholds: { toolMs: 30000 } });
  watchdog.observe({ type: 'turn_start', ts: 1000, status: 'running' });
  watchdog.observe(toolStart(2000, 'read_file', 'tool-1'));
  watchdog.observe({ type: 'heartbeat', ts: 50000 });
  const status = watchdog.status(51000);
  assert.equal(status.state, 'stalled');
  assert.equal(status.reason, 'tool_without_terminal');
  assert.equal(status.stuckTool.tool, 'read_file');
  assert.equal(status.stuckTool.elapsedMs, 49000);
});

test('watchdog: a closed tool and a terminal frame reach done, not stalled', () => {
  const watchdog = createWatchdog({ thresholds: { stallMs: 10000 } });
  watchdog.observe(toolStart(1000, 'read_file', 'tool-1'));
  watchdog.observe(toolEnd(2000, 'tool-1'));
  watchdog.observe({ type: 'prompt_result', ts: 3000, status: 'completed' });
  const status = watchdog.status(120000);
  assert.equal(status.state, 'done');
  assert.equal(status.stalled, false);
  assert.equal(status.tools.open.length, 0);
});

test('watchdog: a reported failure is final and never reported as a stall', () => {
  const watchdog = createWatchdog({ thresholds: { stallMs: 10000 } });
  watchdog.observe({ type: 'prompt_result', ts: 1000, status: 'error' });
  const status = watchdog.status(60000);
  assert.equal(status.state, 'failed');
  assert.equal(status.stalled, false);
  assert.equal(status.reason, 'reported_failure');
});

test('watchdog: ready never reached is its own stall reason', () => {
  const watchdog = createWatchdog({ thresholds: { readyMs: 5000, stallMs: 60000 } });
  watchdog.observe(frame(1000));
  const status = watchdog.status(9000);
  assert.equal(status.state, 'stalled');
  assert.equal(status.reason, 'ready_not_reached');
});

test('watchdog: no signals at all is idle with an honest reason', () => {
  const status = evaluateWatchdog({ events: [], now: 1000 });
  assert.equal(status.state, 'idle');
  assert.equal(status.reason, 'no_signals');
  assert.equal(status.silentMs, null);
  assert.equal(formatWatchdog(status), '관찰 신호 없음');
});

test('watchdog: evaluation filters by session and reports Korean text', () => {
  const events = [
    { type: 'turn_start', session: 's-1', ts: 1000, status: 'running' },
    { type: 'turn_start', session: 's-2', ts: 9000, status: 'running' },
  ];
  const status = evaluateWatchdog({ events, session: 's-1', now: 20000, thresholds: { stallMs: 10000 } });
  assert.equal(status.session, 's-1');
  assert.equal(status.state, 'stalled');
  assert.match(formatWatchdog(status), /멈춘 것으로 판정/);
});

test('watchdog: thresholds are overridable and echoed in the status', () => {
  const watchdog = createWatchdog({ thresholds: { stallMs: 1 } });
  assert.equal(watchdog.thresholds.stallMs, 1);
  assert.equal(watchdog.thresholds.toolMs, DEFAULT_THRESHOLDS.toolMs);
  const status = evaluateWatchdog({ events: [frame(0)], now: 5, thresholds: { stallMs: 1 } });
  assert.equal(status.thresholds.stallMs, 1);
  assert.equal(status.thresholdMs, 1);
});

test('watchdog: no model, no prompt and no network module is involved', () => {
  const root = join(import.meta.dirname, '..');
  const source = readFileSync(join(root, 'watchdog.mjs'), 'utf8');
  assert.ok(!/from ['"]node:(http|https|net|dgram)/.test(source), 'watchdog must not open a socket');
  assert.ok(!/fetch\(/.test(source), 'watchdog must not call a provider');
  const offenders = [];
  for (const file of readdirSync(root).filter((name) => name.endsWith('.mjs'))) {
    const text = readFileSync(join(root, file), 'utf8');
    if (/from ['"]node:(http|https|net|dgram)/.test(text) || /globalThis\.fetch|fetch\(/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

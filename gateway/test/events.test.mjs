import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEventShape, createEventBus, emitEvent, events, resetEvents, EVENT_TYPES, EVENT_SCHEMA_VERSION } from '../lib/events.mjs';

test('events: the envelope is stamped, sequenced and schema-versioned', () => {
  const bus = createEventBus({ now: () => Date.parse('2026-11-08T00:00:00Z') });
  const first = bus.emit('task.start', { session: 's-1', task: 't-1', role: 'implementer' });
  const second = bus.emit('task.done', { session: 's-1', task: 't-1' });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.v, EVENT_SCHEMA_VERSION);
  assert.equal(first.ts, '2026-11-08T00:00:00.000Z');
  assert.equal(assertEventShape(first), true);
  assert.equal(assertEventShape(second), true);
});

test('events: an unknown type is refused rather than recorded', () => {
  const bus = createEventBus();
  assert.throws(() => bus.emit('task.exploded', {}), /unknown event type/);
});

test('events: token figures stay null when the provider reported nothing', () => {
  const bus = createEventBus();
  const record = bus.emit('llm_turn', { tokens: { input: 10, cacheRead: null, cacheWrite: null, total: 10 } });
  assert.equal(record.tokens.input, 10);
  assert.equal(record.tokens.cacheRead, null);
  assert.equal(record.tokens.total, 10);
  const empty = bus.emit('llm_turn', { tokens: {} });
  assert.equal(empty.tokens, null);
});

test('events: a sink failure never breaks the caller', () => {
  const bus = createEventBus({ sink: () => { throw new Error('disk full'); } });
  assert.doesNotThrow(() => bus.emit('decision', { data: { track: 'direct_execute' } }));
  assert.equal(bus.events({ type: 'decision' }).length, 1);
});

test('events: the ring buffer is filtered by session, task and run', () => {
  const bus = createEventBus({ limit: 10 });
  bus.emit('task.start', { session: 'a', task: 't1', run: 'r1' });
  bus.emit('task.start', { session: 'b', task: 't2', run: 'r1' });
  assert.equal(bus.events({ session: 'a' }).length, 1);
  assert.equal(bus.events({ run: 'r1' }).length, 2);
  assert.equal(bus.events({ task: 't2' }).length, 1);
  assert.equal(bus.events().length, 2);
});

test('events: the ring buffer drops the oldest records beyond its limit', () => {
  const bus = createEventBus({ limit: 3 });
  for (let index = 0; index < 5; index += 1) bus.emit('decision', { data: { index } });
  const kept = bus.events();
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map((record) => record.data.index), [2, 3, 4]);
});

test('events: every documented type is declared once', () => {
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length, 'no type appears twice');
  for (const type of ['run.start', 'run.done', 'task.start', 'task.delegate', 'task.file_change', 'task.verify', 'task.retry', 'task.done', 'llm_turn', 'optimization', 'decision', 'model.select', 'pin.set', 'pin.expire', 'cache.report', 'tool.compress', 'tool.recover', 'background.skipped']) {
    assert.equal(EVENT_TYPES.includes(type), true, `${type} is documented`);
  }
});

test('events: the process bus is what the gateway emits through', () => {
  resetEvents();
  emitEvent('cache.report', { session: 's', data: { hit: true } });
  assert.equal(events({ type: 'cache.report' }).length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinStore, segmentKey, DEFAULT_PIN_TTL_MS } from '../lib/session-pin.mjs';
import { events, resetEvents } from '../lib/events.mjs';

function storeWithClock() {
  let clock = 1000;
  const store = createPinStore({ ttlMs: DEFAULT_PIN_TTL_MS, now: () => clock });
  return { store, advance: (ms) => { clock += ms; }, at: () => clock };
}

test('session-pin: a pinned model is returned for the same segment', () => {
  const { store } = storeWithClock();
  store.pin({ key: 's-1|zdr_cloud|chat|-', session: 's-1', model: 'local-a' });
  assert.equal(store.get('s-1|zdr_cloud|chat|-').model, 'local-a');
  assert.equal(store.get('s-1|zdr_cloud|chat|-').stale, false);
});

test('session-pin: a segment change is a new pin, not a stale hit', () => {
  const { store } = storeWithClock();
  const first = segmentKey({ session: 's-1', route: 'zdr_cloud', capability: 'chat', segment: 'alpha' });
  const second = segmentKey({ session: 's-1', route: 'zdr_cloud', capability: 'chat', segment: 'beta' });
  store.pin({ key: first, session: 's-1', model: 'local-a' });
  assert.equal(store.get(second), null);
  store.pin({ key: second, session: 's-1', model: 'local-b' });
  assert.equal(store.get(second).model, 'local-b');
});

test('session-pin: the pin goes stale after the cache TTL and expires loudly', () => {
  const { store, advance } = storeWithClock();
  const key = 's-2|zdr_cloud|chat|-';
  store.pin({ key, session: 's-2', model: 'local-a' });
  advance(DEFAULT_PIN_TTL_MS - 1);
  assert.equal(store.get(key).stale, false);
  advance(1);
  assert.equal(store.get(key).stale, true, 'the provider cache window is over, so the pin is not cache-protecting');
  resetEvents();
  store.expire(key, 'pin:ttl_expired_before_use');
  assert.equal(store.get(key), null);
  assert.equal(events({ type: 'pin.expire' }).length, 1);
});

test('session-pin: activity extends the window, idleness does not', () => {
  const { store, advance } = storeWithClock();
  const key = 's-3|zdr_cloud|chat|-';
  store.pin({ key, session: 's-3', model: 'local-a' });
  for (let i = 0; i < 4; i += 1) {
    advance(DEFAULT_PIN_TTL_MS - 60_000);
    store.noteActivity(key);
    assert.equal(store.get(key).stale, false);
  }
  advance(DEFAULT_PIN_TTL_MS + 1);
  assert.equal(store.get(key).stale, true);
});

test('session-pin: a pin change emits pin.set with the replaced pin', () => {
  resetEvents();
  const { store } = storeWithClock();
  const key = 's-4|zdr_cloud|chat|-';
  store.pin({ key, session: 's-4', model: 'local-a' });
  store.pin({ key, session: 's-4', model: 'local-b', reason: 'pin:escalated' });
  const changed = events({ type: 'pin.set' }).filter((event) => event.data?.replaced);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].model, 'local-b');
  assert.equal(changed[0].data.replaced.model, 'local-a');
});

test('session-pin: a caller inventing new session ids cannot grow the store without bound', () => {
  // `x-app-session` is caller-supplied and production never sweeps on a clock,
  // so a new id per request used to be a new pin per request — including from
  // requests the quota ledger had already refused.
  const { store } = storeWithClock();
  const bounded = createPinStore({ capacity: 4, now: () => 1000 });
  for (let i = 0; i < 40; i += 1) bounded.pin({ key: `s${i}|any_cloud|chat|-`, session: `s${i}`, model: 'm' });
  assert.equal(bounded.size(), 4, 'the store is capped, not grown by the caller');
  assert.equal(bounded.get('s39|any_cloud|chat|-').model, 'm', 'the most recent pin survives');
  assert.equal(bounded.get('s0|any_cloud|chat|-'), null, 'the least recently pinned entry is the one evicted');
  assert.equal(store.capacity > 4, true, 'the default capacity is larger than the test one');
});

test('session-pin: a re-pin moves an entry to the tail, so eviction is LRU on pins', () => {
  // Bounded monotonic inserts alone would also pass under plain FIFO. This case
  // fails under FIFO: `k0` is the oldest insert, but re-pinning it makes `k1` the
  // least recently pinned entry, and a FIFO drain would evict `k0` instead.
  //
  // Scope, so a reader does not over-claim: eviction order follows pin events
  // only. `noteActivity()` restarts the TTL window but does not reorder the map.
  //
  // Related, not asserted here: capacity is global, not per identity, so one
  // caller spraying session ids can evict another caller's pins. That costs
  // cache hits (a cold re-pin), not data exposure.
  const bounded = createPinStore({ capacity: 4, now: () => 1000 });
  for (const id of ['k0', 'k1', 'k2', 'k3']) bounded.pin({ key: `${id}|any_cloud|chat|-`, session: id, model: 'm' });
  bounded.pin({ key: 'k0|any_cloud|chat|-', session: 'k0', model: 'm' });
  bounded.pin({ key: 'k4|any_cloud|chat|-', session: 'k4', model: 'm' });
  assert.equal(bounded.size(), 4);
  assert.equal(bounded.get('k1|any_cloud|chat|-'), null, 'the least recently pinned entry is evicted, not the oldest insert');
  assert.equal(bounded.get('k0|any_cloud|chat|-').model, 'm', 'the re-pinned entry survived');
  assert.equal(bounded.get('k4|any_cloud|chat|-').model, 'm');
});

test('session-pin: sweep removes only stale pins', () => {
  const { store, advance } = storeWithClock();
  store.pin({ key: 'old|zdr_cloud|chat|-', session: 'old', model: 'm1' });
  store.pin({ key: 'new|zdr_cloud|chat|-', session: 'new', model: 'm2' });
  advance(DEFAULT_PIN_TTL_MS - 1000);
  store.noteActivity('new|zdr_cloud|chat|-');
  advance(1500);
  assert.equal(store.sweep(), 1);
  assert.equal(store.size(), 1);
});

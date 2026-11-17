// Session (work segment) pinning.
//
// A provider's prompt cache lives on a prefix the provider hashed: change the
// model and the prefix is a cold cache for that model, change the reasoning grade
// and the sampling/thinking envelope of the request changes with it. So the model
// and the reasoning grade are pinned per session *and* per work segment, and the
// pin is dropped when the segment changes or when the provider-side cache it
// protects has provably expired.
//
// TTL is the provider's documented idle window, not a guess: `cacheTtlMs` default
// 5 minutes (Anthropic's ephemeral prompt cache window and the same order of
// magnitude as OpenAI/DeepSeek prefix caches). A pin older than the TTL is not a
// cache-protecting pin any more, so `get()` reports `stale: true` and the caller
// re-pins instead of silently forcing a cold-model request onto a warm cache.
// `noteActivity()` extends the window only while turns keep arriving: an idle
// session must not keep a pin alive.
//
// Every pin change emits a `pin.set` / `pin.expire` event, so the reason a model
// stopped being sticky is readable after the fact.

import { randomUUID } from 'node:crypto';
import { emitEvent } from './events.mjs';

export const DEFAULT_PIN_TTL_MS = 5 * 60 * 1000;

// The pin key is built from a caller-supplied session id (`x-app-session`, or
// `body.user`), and `sweep()` is only ever called by a test — production never
// expires a pin on a clock. Without a capacity, a caller that invents a new
// session id per request grows this map without limit, and it did: 300 requests
// with 300 session ids left 300 pins, 299 of them from requests the quota ledger
// had already refused. A fixed capacity makes a new id cost an eviction instead.
export const PIN_CAPACITY = 1024;

// Cheap, deterministic segment identity: the workspace/route/capability triple
// plus the caller's own segment label when it sends one. No clock, no counter.
export function segmentKey({ session, route, capability, segment = null }) {
  if (!session) return null;
  return [session, route ?? '-', capability ?? '-', segment ?? '-'].join('|');
}

export function createPinStore({ ttlMs = DEFAULT_PIN_TTL_MS, now = () => Date.now(), emit = emitEvent, capacity = PIN_CAPACITY } = {}) {
  const pins = new Map();
  const limit = Number.isInteger(capacity) && capacity > 0 ? capacity : PIN_CAPACITY;

  function note(tag, record, data) {
    emit(tag, {
      session: record.session,
      model: record.model,
      role: record.capability,
      data: { ...data, segment: record.segment, ttlMs: record.ttlMs },
    });
  }

  return {
    ttlMs,
    capacity: limit,
    size() {
      return pins.size;
    },
    // The configured window (`optimization.pin_cache_ttl_ms`) is applied to the
    // store the chat path uses, at handler construction. A pin written after
    // this takes the new window; nothing keeps a window the operator removed.
    setTtlMs(ms) {
      if (!Number.isInteger(ms) || ms <= 0) return ttlMs;
      ttlMs = ms;
      this.ttlMs = ms;
      return ttlMs;
    },
    get(key) {
      if (!key) return null;
      const record = pins.get(key);
      if (!record) return null;
      const age = now() - record.touchedAt;
      const stale = age >= record.ttlMs;
      return { ...record, ageMs: age, stale };
    },
    pin({ key, session, model, reasoning = null, capability = 'chat', role = null, reason = 'pin:first_turn' }) {
      if (!key || !model) return null;
      const previous = pins.get(key);
      const record = {
        key,
        session,
        segment: key.split('|').slice(1).join('|'),
        model,
        reasoning,
        capability,
        role: role ?? previous?.role ?? null,
        reason,
        pinnedAt: previous?.model === model && previous?.reasoning === reasoning ? previous.pinnedAt : now(),
        touchedAt: now(),
        ttlMs,
        pinId: previous?.model === model && previous?.reasoning === reasoning ? previous.pinId : randomUUID(),
      };
      // Re-inserted, not just overwritten: Map order is insertion order, so
      // deleting first is what makes the first key the least recently pinned one
      // and the eviction below a real LRU rather than "oldest first seen".
      pins.delete(key);
      pins.set(key, record);
      while (pins.size > limit) {
        const oldest = pins.keys().next();
        if (oldest.done) break;
        pins.delete(oldest.value);
      }
      if (!previous || previous.model !== model || previous.reasoning !== reasoning) {
        note('pin.set', record, { reason, replaced: previous ? { model: previous.model, reasoning: previous.reasoning } : null });
      }
      return record;
    },
    // A turn arrived on the pinned segment: the provider cache window restarts.
    noteActivity(key) {
      const record = pins.get(key);
      if (!record) return null;
      record.touchedAt = now();
      return record;
    },
    expire(key, reason = 'pin:ttl_expired') {
      const record = pins.get(key);
      if (!record) return false;
      pins.delete(key);
      note('pin.expire', record, { reason, ageMs: now() - record.pinnedAt });
      return true;
    },
    sweep() {
      let expired = 0;
      for (const [key, record] of pins) {
        if (now() - record.touchedAt >= record.ttlMs) {
          this.expire(key, 'pin:ttl_expired');
          expired += 1;
        }
      }
      return expired;
    },
    clear() {
      pins.clear();
    },
  };
}

// The process-wide store the chat path uses. Tests construct their own store
// with an injected clock instead of touching this one. Its TTL is the
// configured one: `createGatewayHandler` calls `setTtlMs` with
// `optimization.pin_cache_ttl_ms`, so the parsed value is what expires pins.
export const SESSION_PINS = createPinStore();

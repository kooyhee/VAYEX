import fs from 'node:fs';
import path from 'node:path';
import { GatewayError } from './errors.mjs';

// Ledger on disk:
//   { "version": 1, "users": { "<identity>": { "<YYYY-MM-DD>": { requests, ... } } } }
// `tokens` only ever counts tokens the provider actually reported. A response
// with no usable usage block increments `unknown_usage` and leaves `tokens`
// alone, so an unknown amount is visible as unknown and never passes for zero.

const KEEP_DAYS = 7;
// Two settles in the same millisecond must not share a temp path: on Windows a
// rename can fail with EPERM when another write still holds that name. The
// sequence makes each atomic replacement own its temp file.
let tempSequence = 0;

// Windows also refuses to replace a ledger another handle holds open without
// FILE_SHARE_DELETE — a scanner mid-scan, an operator's `type`, a concurrent
// reader — and that lock lasts milliseconds. Without a retry the EPERM escapes
// as an unhandled error: a request that already succeeded upstream answers 500
// and its accounting is lost. The wait is short and the write is small, so a
// bounded synchronous retry is the only portable fix; past the budget the error
// is still raised instead of swallowed.
const TRANSIENT_REPLACE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOENT']);
const REPLACE_ATTEMPT_DELAYS_MS = [5, 10, 15, 20, 25, 30, 35];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The identity is whatever the caller put in the header, and it is used here as
// an object key. On a plain object that makes `constructor`, `toString` or
// `__proto__` resolve to an inherited member instead of a bucket: `users
// .constructor` reads back the builtin `Object`, so the counters are written onto
// it — visible to the whole process — and `persist()` serialises no bucket at
// all, which means a restart forgets the cap. `users.__proto__ = {}` is worse
// still: it replaces the map's own prototype. A null-prototype map has no
// inherited members, so every identity is an own key and no caller-chosen name
// can reach an object outside the ledger.
function emptyUsers() {
  return Object.create(null);
}

function usersFrom(source) {
  const users = emptyUsers();
  for (const [identity, days] of Object.entries(source)) users[identity] = days;
  return users;
}

function emptyCounters() {
  return {
    requests: 0,
    tokens: 0,
    unknown_usage: 0,
    reserved_requests: 0,
    reserved_tokens: 0,
    images: 0,
    video_submissions: 0,
    video_completions: 0,
  };
}

export class QuotaLedger {
  // `fileSystem` exists so a test can make the atomic replace fail without an
  // external handle holding the ledger open; production always gets node:fs.
  // `requestsPerDay` / `tokensPerDay` are `null` when the operator asked for no
  // cap. Counting, reservations and persistence do not depend on the cap, so an
  // uncapped ledger is the same ledger minus the two refusal branches.
  constructor({ ledgerPath, requestsPerDay, tokensPerDay, clock = () => new Date(), fileSystem = fs }) {
    this.ledgerPath = ledgerPath;
    this.requestsPerDay = requestsPerDay;
    this.tokensPerDay = tokensPerDay;
    this.clock = clock;
    this.fs = fileSystem;
    this.data = { version: 1, users: emptyUsers() };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.ledgerPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.users || typeof parsed.users !== 'object') {
        throw new Error('ledger root must be an object with a users map');
      }
      this.data = { version: 1, users: usersFrom(parsed.users) };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // A corrupt ledger is a hard stop: silently restarting from empty would
        // reset every cap and quietly let usage through.
        throw new Error(`quota ledger ${this.ledgerPath} is unreadable: ${error.message}`);
      }
      this.data = { version: 1, users: emptyUsers() };
    }
  }

  persist() {
    const payload = `${JSON.stringify(this.data, null, 2)}\n`;
    const temp = `${this.ledgerPath}.tmp-${process.pid}-${++tempSequence}`;
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          this.fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
          this.fs.writeFileSync(temp, payload);
          this.fs.renameSync(temp, this.ledgerPath);
          return;
        } catch (error) {
          if (!TRANSIENT_REPLACE_CODES.has(error.code) || attempt >= REPLACE_ATTEMPT_DELAYS_MS.length) throw error;
          sleepSync(REPLACE_ATTEMPT_DELAYS_MS[attempt]);
        }
      }
    } finally {
      try { this.fs.unlinkSync(temp); } catch {}
    }
  }

  prune() {
    const cutoff = new Date(this.clock().getTime() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    let changed = false;
    for (const [identity, days] of Object.entries(this.data.users)) {
      for (const day of Object.keys(days)) {
        if (day < cutoff) {
          delete days[day];
          changed = true;
        }
      }
      if (Object.keys(days).length === 0) {
        delete this.data.users[identity];
        changed = true;
      }
    }
    return changed;
  }

  today() {
    return this.clock().toISOString().slice(0, 10);
  }

  bucket(identity, { create = false } = {}) {
    const day = this.today();
    if (!this.data.users[identity]) {
      if (!create) return emptyCounters();
      this.data.users[identity] = {};
    }
    const user = this.data.users[identity];
    if (!user[day]) {
      if (!create) return emptyCounters();
      user[day] = emptyCounters();
    }
    for (const [key, value] of Object.entries(emptyCounters())) {
      if (typeof user[day][key] !== 'number') user[day][key] = value;
    }
    return user[day];
  }

  secondsUntilReset() {
    const now = this.clock();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
  }

  snapshot(identity) {
    const counters = this.bucket(identity);
    return {
      identity,
      day: this.today(),
      limits: { requests_per_day: this.requestsPerDay, tokens_per_day: this.tokensPerDay },
      used: {
        requests: counters.requests,
        tokens: counters.tokens,
        unknown_usage: counters.unknown_usage,
        images: counters.images,
        video_submissions: counters.video_submissions,
        video_completions: counters.video_completions,
      },
      remaining: {
        requests: this.requestsPerDay === null ? null : Math.max(0, this.requestsPerDay - counters.requests),
        tokens: this.tokensPerDay === null ? null : Math.max(0, this.tokensPerDay - counters.tokens),
      },
    };
  }

  exceeded(identity, counters, message, limitHeader) {
    const error = new GatewayError(429, 'quota_exceeded', message,
      { type: 'rate_limit_error', detail: this.snapshot(identity) });
    // A refusal can only come from a capped dimension, so an uncapped dimension
    // is reported by omitting its headers rather than by inventing a number.
    const headers = {
      [limitHeader]: '0',
      'retry-after': String(this.secondsUntilReset()),
    };
    if (this.requestsPerDay !== null) {
      headers['x-ratelimit-limit-requests'] = String(this.requestsPerDay);
      headers['x-ratelimit-remaining-requests'] = String(Math.max(0, this.requestsPerDay - counters.requests));
    }
    if (this.tokensPerDay !== null) headers['x-ratelimit-limit-tokens'] = String(this.tokensPerDay);
    error.headers = headers;
    return error;
  }

  // Reserved tokens are an upper bound the caller expects the response to use.
  // They stop a second concurrent request from spending the same headroom and
  // are released once the real usage is settled. If available quota is less
  // than the requested reservation (the admitted upper bound), the request is
  // rejected immediately with a 429 quota_exceeded before touching the upstream,
  // rather than clamping the reservation and forwarding an unbacked budget.
  reserve(identity, { tokens = 0 } = {}) {
    const counters = this.bucket(identity, { create: true });
    // `null` is an uncapped dimension: no refusal branch is evaluated for it, but
    // the reservation below is still taken and persisted exactly as before.
    const requestRemaining = this.requestsPerDay === null
      ? null
      : this.requestsPerDay - counters.requests - counters.reserved_requests;
    if (requestRemaining !== null && requestRemaining <= 0) {
      throw this.exceeded(identity, counters,
        `daily request cap reached for identity ${identity}: ${counters.requests} of ${this.requestsPerDay} requests used today; resets at 00:00 UTC`,
        'x-ratelimit-remaining-requests');
    }
    const tokenRemaining = this.tokensPerDay === null
      ? null
      : this.tokensPerDay - counters.tokens - counters.reserved_tokens;
    const requestedTokens = tokens > 0 ? tokens : 0;
    if (tokenRemaining !== null && (tokenRemaining <= 0 || tokenRemaining < requestedTokens)) {
      throw this.exceeded(identity, counters,
        `daily token cap reached for identity ${identity}: ${counters.tokens} of ${this.tokensPerDay} tokens used today (with ${counters.reserved_tokens} reserved, ${tokenRemaining} available, ${requestedTokens} requested); resets at 00:00 UTC`,
        'x-ratelimit-remaining-tokens');
    }
    const reservedTokens = requestedTokens;
    counters.requests += 1;
    counters.reserved_requests += 1;
    counters.reserved_tokens += reservedTokens;
    this.persist();
    return { identity, reservedTokens };
  }

  // outcome: 'reported' when the provider gave a token count, 'unknown' when it
  // gave none, 'none' when the request failed and produced no usage at all.
  settle(reservation, { outcome = 'none', tokens = null, kind = 'chat', extraRequests = 0 } = {}) {
    const counters = this.bucket(reservation.identity, { create: true });
    counters.reserved_requests = Math.max(0, counters.reserved_requests - 1);
    counters.reserved_tokens = Math.max(0, counters.reserved_tokens - reservation.reservedTokens);
    if (kind === 'images') counters.images += 1;
    if (kind === 'video_submit') counters.video_submissions += 1;
    if (kind === 'video_complete') counters.video_completions += 1;
    counters.requests += extraRequests;
    if (outcome === 'reported' && Number.isFinite(tokens) && tokens >= 0) counters.tokens += Math.trunc(tokens);
    else if (outcome === 'unknown') counters.unknown_usage += 1;
    this.persist();
    return counters;
  }

  // A metered event outside a reservation: a video job that has just reached a
  // terminal state is charged once, on the poll that first observes it.
  charge(identity, { kind, tokens = null } = {}) {
    const counters = this.bucket(identity, { create: true });
    counters.requests += 1;
    if (kind === 'video_complete') counters.video_completions += 1;
    if (kind === 'video_submit') counters.video_submissions += 1;
    if (kind === 'images') counters.images += 1;
    if (tokens === null) counters.unknown_usage += 1;
    else counters.tokens += tokens;
    this.persist();
    return counters;
  }

  // Counters were written by an earlier process; reload so a restart is visible
  // to any code still holding an old ledger object.
  reload() {
    this.load();
    return this;
  }
}

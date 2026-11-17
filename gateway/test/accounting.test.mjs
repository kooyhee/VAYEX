import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountRequest, costOf, recordOptimization, usageBreakdown } from '../lib/accounting.mjs';
import { events, resetEvents } from '../lib/events.mjs';
import { QuotaLedger } from '../lib/quota.mjs';
import { ConfigError, parseConfig } from '../lib/config.mjs';
import { stubConfig, tempDir } from './helpers.mjs';

// A ledger write can fail with a Windows replace error while another handle
// holds the file open without FILE_SHARE_DELETE. That trigger needs a real
// external handle, so the ledger's file system is injected here and the replace
// is made to fail on chosen attempts instead.
function replaceFailingFileSystem({ failOn, code = 'EPERM' }) {
  const attempts = { rename: 0, write: 0 };
  const fileSystem = {
    readFileSync: (...args) => fs.readFileSync(...args),
    mkdirSync: (...args) => fs.mkdirSync(...args),
    writeFileSync: (...args) => {
      attempts.write += 1;
      return fs.writeFileSync(...args);
    },
    renameSync: (...args) => {
      attempts.rename += 1;
      if (failOn(attempts.rename)) {
        const error = new Error(`simulated replace failure: ${code}`);
        error.code = code;
        throw error;
      }
      return fs.renameSync(...args);
    },
    unlinkSync: (...args) => fs.unlinkSync(...args),
  };
  return { fileSystem, attempts };
}

function ledgerAt(t, ledgerPath, fileSystem) {
  const dir = path.dirname(ledgerPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new QuotaLedger({
    ledgerPath,
    requestsPerDay: 10,
    tokensPerDay: 1000,
    clock: () => new Date('2026-11-14T00:00:00Z'),
    fileSystem,
  });
}

function dayCounters(ledgerPath, identity) {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const day = Object.keys(ledger.users[identity])[0];
  return ledger.users[identity][day];
}

test('accounting: an injected read failure raises without resetting or corrupting the ledger', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ledger-read-'));
  const ledgerPath = path.join(dir, 'quota-ledger.json');
  let failRead = false;
  const fileSystem = {
    ...fs,
    readFileSync: (...args) => {
      if (failRead) throw Object.assign(new Error('simulated read failure'), { code: 'EIO' });
      return fs.readFileSync(...args);
    },
  };
  const ledger = ledgerAt(t, ledgerPath, fileSystem);
  const reservation = ledger.reserve('user-a', { tokens: 100 });
  ledger.settle(reservation, { outcome: 'reported', tokens: 42 });
  const before = ledger.snapshot('user-a');
  const persisted = fs.readFileSync(ledgerPath, 'utf8');

  failRead = true;
  assert.throws(() => ledger.reload(), /is unreadable: simulated read failure/);
  assert.deepEqual(ledger.snapshot('user-a'), before, 'a failed reload must retain existing accounting');
  assert.throws(() => ledgerAt(t, ledgerPath, fileSystem), /is unreadable: simulated read failure/);
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), persisted, 'a failed load must not alter persisted accounting');
  assert.deepEqual(ledgerAt(t, ledgerPath).snapshot('user-a'), before);
});

test('accounting: a transient replace failure is retried and the settled counters land on disk', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ledger-transient-'));
  const ledgerPath = path.join(dir, 'quota-ledger.json');
  const { fileSystem, attempts } = replaceFailingFileSystem({ failOn: (n) => n <= 2 });
  const ledger = ledgerAt(t, ledgerPath, fileSystem);

  const reservation = ledger.reserve('user-a', { tokens: 100 });
  ledger.settle(reservation, { outcome: 'reported', tokens: 42, kind: 'video_submit' });

  assert.ok(attempts.rename > 1, 'the replace was attempted more than once before it succeeded');
  const counters = dayCounters(ledgerPath, 'user-a');
  assert.equal(counters.requests, 1);
  assert.equal(counters.tokens, 42);
  assert.equal(counters.reserved_tokens, 0, 'the reservation was released by the settled write');
  assert.equal(counters.video_submissions, 1);
});

test('accounting: a replace failure past the retry budget raises instead of losing the accounting', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ledger-persistent-'));
  const ledgerPath = path.join(dir, 'quota-ledger.json');
  // The reservation lands; the settle that follows the accepted upstream job hits
  // a handle that never releases, so every later replace fails.
  const { fileSystem, attempts } = replaceFailingFileSystem({ failOn: (n) => n > 1 });
  const ledger = ledgerAt(t, ledgerPath, fileSystem);
  const reservation = ledger.reserve('user-a', { tokens: 100 });

  assert.throws(
    () => ledger.settle(reservation, { outcome: 'reported', tokens: 42 }),
    (error) => error.code === 'EPERM',
    'a write that never succeeds must surface its error, not swallow it',
  );
  assert.ok(attempts.rename > 2, 'the failing replace was retried before the budget ran out');
  const counters = dayCounters(ledgerPath, 'user-a');
  assert.equal(counters.requests, 1);
  assert.equal(counters.tokens, 0, 'nothing was written that claims usage the ledger does not hold');
});

test('accounting: a non-transient write error is raised on the first attempt, not retried', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ledger-fatal-'));
  const ledgerPath = path.join(dir, 'quota-ledger.json');
  const { fileSystem, attempts } = replaceFailingFileSystem({ failOn: () => true, code: 'EINVAL' });
  const ledger = ledgerAt(t, ledgerPath, fileSystem);

  assert.throws(
    () => ledger.reserve('user-a', { tokens: 100 }),
    (error) => error.code === 'EINVAL',
  );
  assert.equal(attempts.rename, 1, 'a non-transient error is a bug or a hard failure, so it is not retried');
  assert.equal(fs.existsSync(ledgerPath), false, 'no ledger is claimed to exist');
});

test('accounting: an identity named after an Object member gets its own bucket', (t) => {
  // `x-user-id` is caller-chosen and used as a map key. On a plain object,
  // `constructor`/`toString` resolve to inherited members instead of a bucket,
  // so the counters land on the builtin object and persist() writes no user at
  // all — the cap then vanished on the next restart.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ledger-reserved-'));
  const ledgerPath = path.join(dir, 'quota-ledger.json');
  const ledger = new QuotaLedger({
    ledgerPath,
    requestsPerDay: 2,
    tokensPerDay: 1000,
    clock: () => new Date('2026-11-14T00:00:00Z'),
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (let i = 0; i < 2; i += 1) {
    const reservation = ledger.reserve('constructor', { tokens: 10 });
    ledger.settle(reservation, { outcome: 'reported', tokens: 10 });
  }
  assert.equal(
    Object.getOwnPropertyNames(Object).some((key) => /^\d{4}-\d{2}-\d{2}$/.test(key)),
    false,
    'counters must never be written onto the builtin Object',
  );
  const persisted = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  assert.deepEqual(Object.keys(persisted.users), ['constructor'], 'the identity is persisted as a real bucket');

  const reloaded = new QuotaLedger({
    ledgerPath,
    requestsPerDay: 2,
    tokensPerDay: 1000,
    clock: () => new Date('2026-11-14T00:00:00Z'),
  });
  assert.equal(reloaded.snapshot('constructor').used.requests, 2, 'the cap survives a restart');
  assert.throws(() => reloaded.reserve('constructor', { tokens: 10 }),
    (error) => error.code === 'quota_exceeded');

  // `__proto__` is the sharper case: assigning it on a plain object replaces the
  // map's prototype, so no bucket would exist at all.
  const protoLedger = new QuotaLedger({
    ledgerPath: path.join(dir, 'proto.json'),
    requestsPerDay: 5,
    tokensPerDay: 1000,
    clock: () => new Date('2026-11-14T00:00:00Z'),
  });
  protoLedger.reserve('__proto__', { tokens: 10 });
  assert.equal(Object.getPrototypeOf(protoLedger.data.users), null, 'the user map keeps its null prototype');
  const persistedProto = JSON.parse(fs.readFileSync(path.join(dir, 'proto.json'), 'utf8'));
  // `JSON.parse` gives `users` an ordinary prototype, so `users.__proto__` reads
  // `Object.prototype` whatever was written. Own keys are the only honest check:
  // with a plain map the `__proto__` assignment replaced the prototype and no
  // bucket was serialised at all.
  assert.deepEqual(Object.keys(persistedProto.users), ['__proto__'], 'the __proto__ identity is an own bucket key');
  assert.equal(persistedProto.users['__proto__']['2026-11-14'].requests, 1, 'the bucket holds the reserved request');
  const protoReloaded = new QuotaLedger({
    ledgerPath: path.join(dir, 'proto.json'),
    requestsPerDay: 5,
    tokensPerDay: 1000,
    clock: () => new Date('2026-11-14T00:00:00Z'),
  });
  assert.equal(protoReloaded.snapshot('__proto__').used.requests, 1, 'the __proto__ bucket survives a reload');
});

test('accounting: anthropic usage keeps cached input apart from input', () => {
  const tokens = usageBreakdown({
    input_tokens: 100,
    output_tokens: 40,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 25,
  });
  assert.equal(tokens.input, 100);
  assert.equal(tokens.cacheRead, 900);
  assert.equal(tokens.cacheWrite, 25);
  assert.equal(tokens.output, 40);
  assert.equal(tokens.total, 1065);
  assert.equal(tokens.reported, true);
  assert.equal(tokens.source, 'anthropic');
});

test('accounting: openai prompt_tokens already include the cached ones', () => {
  const tokens = usageBreakdown({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } });
  assert.equal(tokens.input, 200);
  assert.equal(tokens.cacheRead, 800);
  assert.equal(tokens.output, 50);
  assert.equal(tokens.total, 1050);
  assert.equal(tokens.source, 'openai');
});

test('accounting: deepseek hit and miss tokens are read, not inferred', () => {
  const tokens = usageBreakdown({ prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 300, completion_tokens: 20 });
  assert.equal(tokens.cacheRead, 700);
  assert.equal(tokens.input, 300);
  assert.equal(tokens.total, 1020);
});

test('accounting: a provider that reported nothing is unknown, never free', () => {
  const tokens = usageBreakdown({});
  assert.equal(tokens.reported, false);
  assert.equal(tokens.total, null);
  assert.equal(tokens.input, null);
  assert.equal(costOf('gpt-4o', tokens).usd, 0);
});

test('accounting: cost splits cache read, cache write and output', () => {
  const tokens = { input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 500 };
  const cost = costOf('claude-3-5-sonnet', tokens);
  // 1000*3 + 10000*0.3 + 500*3.75 + 100*15 = 3000 + 3000 + 1875 + 1500 -> 0.009375 USD
  assert.equal(cost.usd, 0.009375);
  assert.equal(cost.baselineUsd, 0.036,
    'the baseline charges every prompt token at the input rate: (11500*3 + 1500)/1e6');
  assert.equal(cost.savedUsd, 0.026625);
});

test('accounting: an llm_turn event carries the flat fields cost analytics reads', () => {
  resetEvents();
  accountRequest({
    model: 'gpt-4o-mini',
    usage: { prompt_tokens: 500, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 400 } },
    route: 'zdr_cloud',
    provider: 'openai-upstream',
    taskId: 'task-42',
    session: 's-9',
    stream: false,
  });
  const [record] = events({ type: 'llm_turn' });
  assert.equal(record.type, 'llm_turn');
  assert.equal(record.taskId, 'task-42');
  assert.equal(record.route, 'zdr_cloud');
  assert.equal(record.promptTokens, 100);
  assert.equal(record.completionTokens, 30);
  assert.equal(record.cachedTokens, 400);
  assert.equal(record.model, 'gpt-4o-mini');
  assert.equal(record.provider, 'openai-upstream');
  assert.equal(record.tokens.cacheRead, 400);
  assert.ok(record.cost.usd >= 0);
  assert.equal(record.data.stream, false);
});

test('accounting: an optimization event is flat and names its strategy', () => {
  resetEvents();
  recordOptimization({ taskId: 'task-7', strategy: 'tool_output_compression', tokensSaved: 2400, costSavedUsd: 0.0003 });
  const [record] = events({ type: 'optimization' });
  assert.equal(record.taskId, 'task-7');
  assert.equal(record.strategy, 'tool_output_compression');
  assert.equal(record.tokensSaved, 2400);
  assert.equal(record.costSavedUsd, 0.0003);
});

test('accounting: an optimization without a strategy is refused', () => {
  assert.throws(() => recordOptimization({ tokensSaved: 5 }), /strategy/);
});

test('config: a null daily cap means no cap, a missing key keeps the default, and an explicit integer stays bounded', (t) => {
  const dir = tempDir('quota-config-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = stubConfig({
    stubPort: 1,
    dir,
    overrides: { quota: { requests_per_day: null, tokens_per_day: null } },
  });

  const unlimited = parseConfig(raw, { baseDir: dir });
  assert.equal(unlimited.quota.requestsPerDay, null);
  assert.equal(unlimited.quota.tokensPerDay, null);
  assert.equal(unlimited.quota.identityHeader, 'x-user-id');
  assert.equal(unlimited.quota.ledgerPath, path.join(dir, 'quota-ledger.json'));

  delete raw.quota.requests_per_day;
  delete raw.quota.tokens_per_day;
  const defaults = parseConfig(raw, { baseDir: dir });
  assert.equal(defaults.quota.requestsPerDay, 200, 'a missing requests key keeps the old default');
  assert.equal(defaults.quota.tokensPerDay, 200000, 'a missing tokens key keeps the old default');

  raw.quota.requests_per_day = 10;
  raw.quota.tokens_per_day = 1000;
  const bounded = parseConfig(raw, { baseDir: dir });
  assert.equal(bounded.quota.requestsPerDay, 10);
  assert.equal(bounded.quota.tokensPerDay, 1000);

  for (const value of [0, -1, 1.5, '200']) {
    raw.quota.tokens_per_day = value;
    assert.throws(
      () => parseConfig(raw, { baseDir: dir }),
      (error) => error instanceof ConfigError && /quota\.tokens_per_day/.test(error.message),
      `${JSON.stringify(value)} is not a valid cap`,
    );
  }
});

test('accounting: null caps never refuse, still count past the old defaults, and report limits and remaining as null', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ledger-unlimited-'));
  const ledgerPath = path.join(dir, 'quota-ledger.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new QuotaLedger({
    ledgerPath,
    requestsPerDay: null,
    tokensPerDay: null,
    clock: () => new Date('2026-11-14T00:00:00Z'),
  });

  // 201 requests and 201,000 tokens cross both old defaults (200 / 200,000).
  for (let i = 0; i < 201; i += 1) {
    const reservation = ledger.reserve('user-a', { tokens: 1000 });
    assert.equal(reservation.reservedTokens, 1000, 'reservation accounting is unchanged when uncapped');
    const counters = ledger.settle(reservation, { outcome: 'reported', tokens: 1000 });
    assert.equal(counters.requests, i + 1);
    assert.equal(counters.tokens, (i + 1) * 1000);
  }
  const snapshot = ledger.snapshot('user-a');
  assert.equal(snapshot.used.requests, 201);
  assert.equal(snapshot.used.tokens, 201000);
  assert.equal(snapshot.limits.requests_per_day, null);
  assert.equal(snapshot.limits.tokens_per_day, null);
  assert.equal(snapshot.remaining.requests, null);
  assert.equal(snapshot.remaining.tokens, null);

  const persisted = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const day = persisted.users['user-a']['2026-11-14'];
  assert.equal(day.requests, 201);
  assert.equal(day.tokens, 201000);
  assert.equal(day.reserved_requests, 0);
  assert.equal(day.reserved_tokens, 0);

  // Unknown usage is still counted, and never rendered as zero tokens.
  const unknown = ledger.reserve('user-b', { tokens: 0 });
  const unknownCounters = ledger.settle(unknown, { outcome: 'unknown' });
  assert.equal(unknownCounters.requests, 1);
  assert.equal(unknownCounters.tokens, 0);
  assert.equal(unknownCounters.unknown_usage, 1);
  assert.equal(ledger.snapshot('user-b').remaining.tokens, null);
});

test('accounting: a null cap disables only that dimension, the other cap still refuses at its boundary', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-ledger-mixed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = () => new Date('2026-11-14T00:00:00Z');

  const requestsCapped = new QuotaLedger({
    ledgerPath: path.join(dir, 'requests-capped.json'),
    requestsPerDay: 2,
    tokensPerDay: null,
    clock,
  });
  for (let i = 0; i < 2; i += 1) {
    const reservation = requestsCapped.reserve('user-a', { tokens: 5000 });
    requestsCapped.settle(reservation, { outcome: 'reported', tokens: 5000 });
  }
  assert.equal(requestsCapped.snapshot('user-a').used.tokens, 10000, 'an uncapped token dimension never refuses');
  assert.equal(requestsCapped.snapshot('user-a').limits.tokens_per_day, null);
  assert.equal(requestsCapped.snapshot('user-a').remaining.tokens, null);
  assert.equal(requestsCapped.snapshot('user-a').remaining.requests, 0);
  assert.throws(() => requestsCapped.reserve('user-a', { tokens: 5000 }),
    (error) => error.code === 'quota_exceeded', 'the capped request dimension still refuses');

  const tokensCapped = new QuotaLedger({
    ledgerPath: path.join(dir, 'tokens-capped.json'),
    requestsPerDay: null,
    tokensPerDay: 1,
    clock,
  });
  const reservation = tokensCapped.reserve('user-a', { tokens: 1 });
  tokensCapped.settle(reservation, { outcome: 'reported', tokens: 1 });
  assert.equal(tokensCapped.snapshot('user-a').limits.requests_per_day, null);
  assert.equal(tokensCapped.snapshot('user-a').remaining.requests, null);
  assert.equal(tokensCapped.snapshot('user-a').remaining.tokens, 0);
  assert.throws(() => tokensCapped.reserve('user-a', { tokens: 1 }),
    (error) => error.code === 'quota_exceeded', 'the capped token dimension still refuses');
});

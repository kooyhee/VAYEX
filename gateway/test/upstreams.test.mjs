import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig, ConfigError } from '../lib/config.mjs';
import { call, startHarness, stubConfig, tempDir, STUB_KEY, BYOK_KEY } from './helpers.mjs';

const ID = { 'x-user-id': 'user-a' };

test('each upstream class is reported for the model it serves', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const models = await call(h.baseUrl, '/v1/models');
  const byId = new Map(models.json.data.map((m) => [m.id, m]));
  assert.equal(byId.get('qwen3:32b').gateway.upstream_class, 'server_local');
  assert.equal(byId.get('server/qwen3-coder-30b').gateway.upstream_class, 'server_local');
  assert.equal(byId.get('deepseek/deepseek-v4.1-flash-1017').gateway.upstream_class, 'proxy');
  assert.equal(byId.get('a6api/deepseek-chat-v3.1').gateway.upstream_class, 'proxy');
  assert.equal(byId.get('baseten/mammoth-1').gateway.upstream_class, 'direct');

  // server_local means the bytes never left the host: no credential is sent.
  await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { model: 'server/qwen3-coder-30b', messages: [{ role: 'user', content: 'local plane' }] },
  });
  const local = h.stub.lastRequest((r) => r.path.startsWith('/local/'));
  assert.equal(local.headers.authorization, undefined);

  // A proxy upstream gets the operator's key for that upstream only.
  await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { model: 'deepseek/deepseek-v4.1-flash-1017', messages: [{ role: 'user', content: 'proxy' }] },
  });
  const proxied = h.stub.lastRequest((r) => r.path.startsWith('/openrouter/'));
  assert.equal(proxied.headers.authorization, `Bearer ${STUB_KEY}`);
});

test('a model id served by two upstreams makes the config invalid, not ambiguous', () => {
  const dir = tempDir();
  const raw = stubConfig({ stubPort: 12345, dir });
  // Same id twice under one upstream.
  raw.upstreams[1].models.push({ ...raw.upstreams[1].models[0] });
  assert.throws(
    () => parseConfig(raw, { configPath: path.join(dir, 'config.json'), baseDir: dir }),
    (error) => error instanceof ConfigError && /appears twice under upstream/.test(error.message),
  );

  // The same id under a different upstream: there is no "first one wins".
  const duplicatedAcross = stubConfig({ stubPort: 12345, dir });
  duplicatedAcross.upstreams[2].models.push({
    id: 'qwen3:32b',
    capabilities: ['chat'],
    zero_data_retention: true,
    training_opt_out: true,
  });
  assert.throws(
    () => parseConfig(duplicatedAcross, { configPath: path.join(dir, 'c2.json'), baseDir: dir }),
    (error) => error instanceof ConfigError && /exactly one upstream/.test(error.message),
  );
});

test('a server_local upstream must point at loopback', () => {
  const dir = tempDir();
  const raw = stubConfig({ stubPort: 12345, dir });
  raw.upstreams[0].base_url = 'http://192.168.0.21:8080/v1';
  assert.throws(
    () => parseConfig(raw, { configPath: path.join(dir, 'config.json'), baseDir: dir }),
    (error) => error instanceof ConfigError && /must point at a loopback host/.test(error.message),
  );
});

test('an ollama upstream must be server_local', () => {
  const dir = tempDir();
  const raw = stubConfig({ stubPort: 12345, dir });
  raw.upstreams[2].kind = 'ollama';
  assert.throws(
    () => parseConfig(raw, { configPath: path.join(dir, 'config.json'), baseDir: dir }),
    (error) => error instanceof ConfigError && /an ollama upstream is server_local/.test(error.message),
  );
});

test('a non-loopback bind is refused unless explicitly allowed', () => {
  const dir = tempDir();
  const raw = stubConfig({ stubPort: 12345, dir });
  raw.listen = { host: '0.0.0.0', port: 0 };
  assert.throws(
    () => parseConfig(raw, { configPath: path.join(dir, 'config.json'), baseDir: dir }),
    (error) => error instanceof ConfigError && /refusing to bind 0.0.0.0/.test(error.message),
  );

  raw.listen = { host: '192.168.0.21', port: 0, allow_non_loopback_bind: true };
  const config = parseConfig(raw, { configPath: path.join(dir, 'config.json'), baseDir: dir });
  assert.equal(config.listen.host, '192.168.0.21');
  assert.equal(config.listen.allowNonLoopbackBind, true);
});

test('an ollama upstream is probed through its own API and reports residency', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const health = await call(h.baseUrl, '/healthz');
  assert.equal(health.status, 200);
  const ollama = health.json.upstreams.find((u) => u.id === 'ollama');
  assert.equal(ollama.upstream_kind, 'ollama');
  assert.equal(ollama.reachable, true);
  assert.deepEqual(ollama.advertised_models, ['qwen2.5:72b', 'qwen3:32b', 'qwen2.5:32b', 'qwen3-embedding:0.6b']);
  assert.equal(ollama.loaded_models.length, 1);
  assert.equal(ollama.gpu.state, 'reported');
  assert.equal(ollama.gpu.vram_in_use_bytes, 19500000000);

  // It was probed via /api/tags and /api/ps, never the OpenAI surface.
  assert.ok(h.stub.requests.some((r) => r.path === '/ollama/api/tags'));
  assert.ok(h.stub.requests.some((r) => r.path === '/ollama/api/ps'));
  assert.equal(h.stub.requests.some((r) => r.path === '/ollama/api/models'), false);

  // Chat still goes through the OpenAI-compatible surface of the same upstream.
  const reply = await call(h.baseUrl, '/v1/chat/completions', {
    method: 'POST',
    headers: ID,
    body: { model: 'qwen3:32b', messages: [{ role: 'user', content: 'via ollama shim' }] },
  });
  assert.equal(reply.status, 200);
  assert.match(reply.json.choices[0].message.content, /via ollama shim/);
});

test('GPU state is unknown, never zero, when the residency source does not report it', async (t) => {
  process.env.STUB_OLLAMA_OMIT_VRAM = '1';
  const h = await startHarness();
  t.after(async () => {
    delete process.env.STUB_OLLAMA_OMIT_VRAM;
    await h.stop();
  });

  h.gateway.healthProbe.invalidate();
  const health = await call(h.baseUrl, '/healthz');
  const ollama = health.json.upstreams.find((u) => u.id === 'ollama');
  assert.equal(ollama.gpu.state, 'unknown');
  assert.equal(ollama.gpu.vram_in_use_bytes, undefined);
  assert.match(ollama.gpu.note, /unknown/);
  assert.match(ollama.gpu.note, /nvidia-smi is not used/);
  // Every non-Ollama upstream reports unknown too: the gateway never shells out.
  for (const upstream of health.json.upstreams.filter((u) => u.upstream_kind !== 'ollama')) {
    assert.equal(upstream.gpu.state, 'unknown');
  }
  assert.equal(health.json.gpu.state, 'unknown');
});

test('an unreachable ollama upstream is reported unreachable, not assumed up', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  await h.stub.close();
  h.gateway.healthProbe.invalidate();
  const health = await call(h.baseUrl, '/healthz');
  assert.equal(health.status, 503);
  const ollama = health.json.upstreams.find((u) => u.id === 'ollama');
  assert.equal(ollama.reachable, false);
  assert.equal(ollama.gpu.state, 'unknown');
  assert.equal(health.json.gpu.state, 'unknown');

  const models = await call(h.baseUrl, '/v1/models');
  assert.ok(models.json.data.some((m) => m.id === 'qwen3:32b'), 'configured models stay listed');
});

test('health probes are cached within the TTL and re-probed once it lapses', async (t) => {
  const h = await startHarness({ configOverrides: { health: { cache_ms: 60000 } } });
  t.after(() => h.stop());
  const countProbes = () =>
    h.stub.requests.filter((r) => r.path.endsWith('/models') || r.path.endsWith('/api/tags')).length;

  const first = await call(h.baseUrl, '/healthz');
  assert.equal(first.status, 200);
  const probesAfterFirst = countProbes();
  assert.ok(probesAfterFirst >= h.config.upstreams.length);

  const second = await call(h.baseUrl, '/healthz');
  assert.equal(second.status, 200);
  assert.equal(countProbes(), probesAfterFirst, 'cached probes must not re-hit the upstreams');
  assert.equal(second.json.upstreams.every((u) => u.cached === true), true);

  h.gateway.healthProbe.invalidate();
  await call(h.baseUrl, '/healthz');
  assert.ok(countProbes() > probesAfterFirst, 'an invalidated cache must be re-probed for real');
});

test('the fd-limit reporter reads the real kernel values, or says unknown', async () => {
  const { parseProcLimits, readProcLimits, raiseFdLimit } = await import('../lib/fdlimit.mjs');

  // A real /proc/self/limits excerpt from Ubuntu 24.04, where the soft limit is
  // 1024 against a hard limit of 1048576.
  const sample = [
    'Limit                     Soft Limit           Hard Limit           Units     ',
    'Max cpu time              unlimited            unlimited            seconds   ',
    'Max open files            1024                 1048576              files     ',
    'Max locked memory         8388608              8388608              bytes     ',
  ].join('\n');
  assert.deepEqual(parseProcLimits(sample), { soft: 1024, hard: 1048576, source: '/proc/self/limits' });
  assert.equal(parseProcLimits('no such line'), null);

  // A missing file is not an error: the reporter says unknown instead of guessing.
  assert.equal(readProcLimits('/nonexistent/proc/self/limits'), null);

  const report = raiseFdLimit({ target: 65535 });
  assert.equal(typeof report.supported, 'boolean');
  assert.ok(report.soft === null || Number.isInteger(report.soft));
  assert.ok(report.hard === null || Number.isInteger(report.hard));
  // Whatever the platform, a null soft limit must never be presented as healthy.
  if (report.soft === null) assert.match(report.note, /unknown|ulimit|setrlimit/i);
});

test('a zero cache TTL probes every upstream on every health check', async (t) => {
  const h = await startHarness({ configOverrides: { health: { cache_ms: 0 } } });
  t.after(() => h.stop());
  const countProbes = () =>
    h.stub.requests.filter((r) => r.path.endsWith('/models') || r.path.endsWith('/api/tags')).length;

  await call(h.baseUrl, '/healthz');
  const first = countProbes();
  await call(h.baseUrl, '/healthz');
  assert.ok(countProbes() > first, 'with cache_ms 0 each check must really probe');
  const third = await call(h.baseUrl, '/healthz');
  assert.equal(third.json.upstreams.some((u) => u.cached === true), false);
});

test('the shipped example config parses and keeps the audited A6API flags', async () => {
  const { loadConfig } = await import('../lib/config.mjs');
  const { fileURLToPath } = await import('node:url');
  const config = loadConfig(fileURLToPath(new URL('../gateway.config.example.json', import.meta.url)));

  // The README tells an operator to copy this file as a starting point, so a
  // config that does not parse would be a broken instruction.
  assert.equal(config.listen.host, '127.0.0.1');
  assert.equal(config.listen.allowNonLoopbackBind, false);
  assert.equal(config.upstreams.length, 5);
  assert.deepEqual(
    config.upstreams.map((u) => [u.id, u.class]),
    [
      ['ollama', 'server_local'],
      ['server_gpu', 'server_local'],
      ['openrouter', 'proxy'],
      ['a6api', 'proxy'],
      ['baseten', 'direct'],
    ],
  );

  const ollama = config.upstreams.find((u) => u.id === 'ollama');
  assert.equal(ollama.kind, 'ollama');
  assert.equal(ollama.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.deepEqual(
    ollama.models.map((m) => m.id),
    ['qwen2.5:72b', 'qwen3:32b', 'qwen2.5:32b'],
    'the README names these Ollama models, so the example config must carry exactly them',
  );

  // The audit recorded A6API as non-ZDR; a config that quietly upgraded those
  // flags would let a zdr_cloud request through to a provider that retains data.
  const a6 = config.upstreams.find((u) => u.id === 'a6api');
  assert.equal(a6.authMode, 'pass_through');
  assert.equal(a6.models[0].zeroDataRetention, false);
  assert.equal(a6.models[0].trainingOptOut, false);

  const ids = config.upstreams.flatMap((u) => u.models.map((m) => m.id));
  assert.equal(new Set(ids).size, ids.length, 'a model id may resolve to only one upstream');
  assert.equal(ids.length, 11, 'unverified 27B model must NOT be active in shipped example config');
  assert.equal(ids.includes('server/qwen3.5-27b-iq3s'), false, 'guessed alias qwen3.5 must be absent from active catalogue');
  assert.equal(ids.includes('server/qwen3.8-27b-iq3s'), false, 'candidate alias qwen3.8 must be absent from active catalogue');
  assert.equal(config.modelIndex.has('server/qwen3.5-27b-iq3s'), false);
  assert.equal(config.modelIndex.has('server/qwen3.8-27b-iq3s'), false);
});


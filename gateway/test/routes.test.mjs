import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '../lib/config.mjs';
import { call, readLog, startHarness, tempDir, STUB_KEY } from './helpers.mjs';

const ID = { 'x-user-id': 'user-a' };

test('an image request is proxied, allowlisted and metered', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, '/v1/images/generations', {
    method: 'POST',
    headers: ID,
    body: {
      model: 'server/flux-schnell',
      prompt: 'a tower in the rain',
      n: 1,
      size: '1024x1024',
      unsupported: 'dropped',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-gateway-upstream'), 'server_gpu');
  assert.equal(Buffer.from(res.json.data[0].b64_json, 'base64').toString(), 'stub-image:a tower in the rain');
  assert.equal(res.json.usage.total_tokens, 12);

  const upstream = h.stub.lastRequest((r) => r.path.endsWith('/images/generations'));
  assert.equal(upstream.body.model, 'server/flux-schnell');
  assert.equal(upstream.body.unsupported, undefined, 'non-allowlisted fields never reach the upstream');
  assert.equal(upstream.body.route, undefined);

  const ledger = JSON.parse(fs.readFileSync(h.config.quota.ledgerPath, 'utf8'));
  const day = Object.values(ledger.users['user-a'])[0];
  assert.equal(day.images, 1);
  assert.equal(day.requests, 1);
  assert.equal(day.tokens, 12);
});

test('an image model outside the image allowlist is refused', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  // A chat model is on the allowlist but does not serve images.
  const wrongCapability = await call(h.baseUrl, '/v1/images/generations', {
    method: 'POST',
    headers: ID,
    body: { model: 'deepseek/deepseek-v4.1-flash-1017', prompt: 'x' },
  });
  assert.equal(wrongCapability.status, 400);
  assert.equal(wrongCapability.json.error.code, 'model_capability_unsupported');

  const notListed = await call(h.baseUrl, '/v1/images/generations', {
    method: 'POST',
    headers: ID,
    body: { model: 'dall-e-9-not-real', prompt: 'x' },
  });
  assert.equal(notListed.status, 404);
  assert.equal(notListed.json.error.code, 'model_not_allowed');
  assert.equal(h.stub.requests.length, before);
});

test('the image route enforces the route policy', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const before = h.stub.requests.length;

  const local = await call(h.baseUrl, '/v1/images/generations', {
    method: 'POST',
    headers: { ...ID, 'x-route': 'local_only' },
    body: { model: 'server/flux-schnell', prompt: 'x' },
  });
  assert.equal(local.status, 400);
  assert.equal(local.json.error.code, 'local_only_not_served');
  assert.equal(h.stub.requests.length, before);
});

test('a rejected image request still charges one request unit', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await call(h.baseUrl, '/v1/images/generations', {
    method: 'POST',
    headers: ID,
    body: { model: 'server/flux-schnell', prompt: 'FAIL_500' },
  });
  assert.equal(res.status, 500);
  assert.equal(res.json.error.code, 'upstream_error');
  assert.match(res.json.error.message, /stub image backend exploded/);
  const ledger = JSON.parse(fs.readFileSync(h.config.quota.ledgerPath, 'utf8'));
  assert.equal(Object.values(ledger.users['user-a'])[0].requests, 1);
});

test('the video job contract reports queued, running and succeeded, then serves bytes', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const submit = await call(h.baseUrl, '/v1/videos', {
    method: 'POST',
    headers: ID,
    body: { model: 'server/wan-2.2-t2v', prompt: 'a slow pan over a lab bench', duration_s: 4 },
  });
  assert.equal(submit.status, 202);
  assert.match(submit.json.id, /^vid_/);
  assert.equal(submit.json.object, 'video.job');
  assert.ok(['queued', 'running'].includes(submit.json.status));
  assert.equal(submit.headers.get('location'), `/v1/videos/${submit.json.id}`);

  const jobId = submit.json.id;
  const first = await call(h.baseUrl, `/v1/videos/${jobId}`, { headers: ID });
  const second = await call(h.baseUrl, `/v1/videos/${jobId}`, { headers: ID });
  const third = await call(h.baseUrl, `/v1/videos/${jobId}`, { headers: ID });
  const states = [first.json.status, second.json.status, third.json.status];
  assert.deepEqual(states, ['running', 'succeeded', 'succeeded']);
  assert.ok(second.json.progress > 0 && second.json.progress <= 1);
  assert.equal(third.json.artifact.url, `stub://artifact/${h.stub.jobs.get(third.json.upstream_job_id).id}`);

  const content = await fetch(`${h.baseUrl}/v1/videos/${jobId}/content`, { headers: ID });
  assert.equal(content.status, 200);
  const bytes = Buffer.from(await content.arrayBuffer()).toString();
  assert.match(bytes, /^stub-video-bytes:/);

  const ledger = JSON.parse(fs.readFileSync(h.config.quota.ledgerPath, 'utf8'));
  const day = Object.values(ledger.users['user-a'])[0];
  assert.equal(day.video_submissions, 1);
  assert.equal(day.video_completions, 1, 'completion is charged once, on the first terminal poll');
  assert.equal(day.requests, 2, 'submission plus completion');
  assert.ok(day.unknown_usage >= 1, 'the stub reports no video tokens, so usage is unknown rather than zero');

  // Polling a finished job again must not charge a second completion.
  await call(h.baseUrl, `/v1/videos/${jobId}`, { headers: ID });
  const after = JSON.parse(fs.readFileSync(h.config.quota.ledgerPath, 'utf8'));
  assert.equal(Object.values(after.users['user-a'])[0].video_completions, 1);
});

test('video poll and fetch enforce incoming x-route and refuse local_only with zero upstream calls', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  // Submit a video job on an allowed route (default zdr_cloud)
  const submit = await call(h.baseUrl, '/v1/videos', {
    method: 'POST',
    headers: ID,
    body: { model: 'server/wan-2.2-t2v', prompt: 'route policy test', duration_s: 2 },
  });
  assert.equal(submit.status, 202);
  const jobId = submit.json.id;

  const countBefore = h.stub.requests.length;

  // 1. Poll with x-route: local_only must be refused with 400 local_only_not_served and zero upstream requests
  const pollLocal = await call(h.baseUrl, `/v1/videos/${jobId}`, {
    headers: { ...ID, 'x-route': 'local_only' },
  });
  assert.equal(pollLocal.status, 400);
  assert.equal(pollLocal.json.error.code, 'local_only_not_served');
  assert.equal(h.stub.requests.length, countBefore, 'poll with local_only must not touch upstream');

  // 2. Fetch content with x-route: local_only must be refused with 400 local_only_not_served and zero upstream requests
  const fetchLocal = await call(h.baseUrl, `/v1/videos/${jobId}/content`, {
    headers: { ...ID, 'x-route': 'local_only' },
  });
  assert.equal(fetchLocal.status, 400);
  assert.equal(fetchLocal.json.error.code, 'local_only_not_served');
  assert.equal(h.stub.requests.length, countBefore, 'fetch with local_only must not touch upstream');
});

test('a video job is not readable by another identity', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const submit = await call(h.baseUrl, '/v1/videos', {
    method: 'POST',
    headers: ID,
    body: { model: 'server/wan-2.2-t2v', prompt: 'private', duration_s: 2 },
  });
  assert.equal(submit.status, 202);
  const stranger = await call(h.baseUrl, `/v1/videos/${submit.json.id}`, {
    headers: { 'x-user-id': 'user-z' },
  });
  assert.equal(stranger.status, 404);
  assert.equal(stranger.json.error.code, 'video_job_not_found');
});

test('content is refused before the job succeeds, with the current state named', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const submit = await call(h.baseUrl, '/v1/videos', {
    method: 'POST',
    headers: ID,
    body: { model: 'server/wan-2.2-t2v', prompt: 'still cooking', duration_s: 2 },
  });
  const early = await call(h.baseUrl, `/v1/videos/${submit.json.id}/content`, { headers: ID });
  assert.equal(early.status, 409);
  assert.equal(early.json.error.code, 'video_not_ready');
  assert.equal(early.json.error.detail.status, 'queued');
});

test('video endpoints answer "not configured" when no video upstream exists', async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  // Rebuild the same config with every video model removed.
  const withoutVideo = JSON.parse(fs.readFileSync(path.join(h.dir, 'config.json'), 'utf8'));
  for (const upstream of withoutVideo.upstreams) {
    upstream.models = upstream.models.filter((m) => !m.capabilities.includes('video'));
    if (upstream.models.length === 0) delete upstream.video;
  }
  withoutVideo.upstreams = withoutVideo.upstreams.filter((u) => u.models.length > 0);
  const dir = tempDir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(withoutVideo, null, 2));
  const config = parseConfig(withoutVideo, { configPath, baseDir: dir });
  const { createGateway } = await import('../lib/gateway.mjs');
  const { createLogger } = await import('../lib/log.mjs');
  const { createRedactor } = await import('../lib/redact.mjs');
  const view = createGateway({
    config,
    env: h.env,
    logger: createLogger({ level: 'error', filePath: null, redactor: createRedactor([STUB_KEY]), stdout: { write() {} } }),
  });
  t.after(() => view.close());
  const address = await view.listen();
  const base = `http://127.0.0.1:${address.port}`;

  const submit = await call(base, '/v1/videos', {
    method: 'POST',
    headers: ID,
    body: { model: 'server/wan-2.2-t2v', prompt: 'nobody can serve this', duration_s: 4 },
  });
  assert.equal(submit.status, 503);
  assert.equal(submit.json.error.code, 'video_not_configured');
  assert.match(submit.json.error.message, /no video upstream is configured/);

  const poll = await call(base, '/v1/videos/vid_doesnotexist', { headers: ID });
  assert.equal(poll.status, 503);
  assert.equal(poll.json.error.code, 'video_not_configured');

  const models = await call(base, '/v1/models');
  assert.equal(models.json.data.some((m) => m.gateway.capabilities.includes('video')), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseConfig } from '../../gateway/lib/config.mjs';
import { gatewaySelection } from '../public/protocol.js';
import { createInference } from '../lib/inference.mjs';

test('protocol.js: gatewaySelection maps new decision and role fields accurately', () => {
  const fullPayload = {
    sequence: 42,
    decided_at: '2026-11-08T11:00:00Z',
    plan_mode: 'direct_execute',
    plan_tier: 'fast',
    model: {
      id: 'combo/front-worker',
      upstream: 'opencodex-nace',
      source: 'gateway',
      reason: 'auto:route_conforming',
      role: 'frontend',
      role_reason: 'role:intent_frontend',
      primary: 'combo/front-worker',
      fallback_chain: ['combo/front-worker', 'combo/gemini-4-argon', 'demo-chat'],
      decision_source: 'remote_decision',
      decision_reason: 'decision_plane_ready',
      decision_upstream: 'opencodex-nace',
    },
    reasoning: {
      grade: 'medium',
      thinking_budget: 4096,
    },
  };

  const sel = gatewaySelection(fullPayload);
  assert.ok(sel !== null);
  assert.equal(sel.modelId, 'combo/front-worker');
  assert.equal(sel.upstream, 'opencodex-nace');
  assert.equal(sel.role, 'frontend');
  assert.equal(sel.roleReason, 'role:intent_frontend');
  assert.equal(sel.decisionSource, 'remote_decision');
  assert.equal(sel.decisionReason, 'decision_plane_ready');
  assert.equal(sel.decisionUpstream, 'opencodex-nace');
  assert.equal(sel.primaryModel, 'combo/front-worker');
  assert.deepEqual(sel.fallbackChain, ['combo/front-worker', 'combo/gemini-4-argon', 'demo-chat']);
  assert.equal(sel.grade, 'medium');
  assert.equal(sel.budget, 4096);
});

test('protocol.js: gatewaySelection handles missing decision fields gracefully', () => {
  const legacyPayload = {
    model: {
      id: 'demo-chat',
      upstream: 'demo-stub',
    },
  };
  const sel = gatewaySelection(legacyPayload);
  assert.ok(sel !== null);
  assert.equal(sel.modelId, 'demo-chat');
  assert.equal(sel.role, null);
  assert.equal(sel.decisionSource, null);
  assert.equal(sel.decisionReason, null);
  assert.equal(sel.decisionUpstream, null);
  assert.deepEqual(sel.fallbackChain, []);
  assert.equal(gatewaySelection(null), null);
});

test('unconditional secret canary: source and doc text must never commit live secrets or bearer keys', () => {
  const projectRoot = path.resolve(import.meta.dirname, '../..');
  const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.ruff_cache', '.omp-runtime']);
  // These are local runtime stores, not source/fixture trees. Resolve from this file, never CWD.
  const RUNTIME_DIRS = new Set(['data', path.normalize('app/data')]);

  // Exempt only the reviewed synthetic values in their owning tests, not entire fixture files.
  const FIXTURE_BEARERS = new Map([
    [path.normalize('app/test/privacy-benchmark.test.mjs'), 'tokenValueForApiKey1234567890abcdef'],
    [path.normalize('app/test/privacy-findings.test.mjs'), 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSig12'],
  ]);

  // Known binary extensions skipped from text pattern matching
  const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.pptx', '.docx', '.xlsx',
    '.sqlite', '.sqlite-journal', '.tar', '.gz', '.zip', '.bin', '.onnx',
    '.woff', '.woff2', '.ttf', '.eot', '.pyc',
  ]);

  // Known public non-secret SHA-256 fixture hashes:
  const ALLOWLISTED_HASHES = new Set([
    'd847e2c1e4aa276e4b7b8e9ad7628050e61e165d49ab995407bc36677a6f3864', // Hugging Face Qwen UD-IQ3_S LFS commit OID
  ]);

  // A 64-hex string is artifact checksum metadata only when a checksum word names it,
  // either as a JSON field ("sha256": "<hex>") or inline in prose ("... sha256 <hex>").
  // A bare 64-hex string stays a violation, so a key pasted anywhere else is still caught.
  const CHECKSUM_WORD = /(sha256|sha-256|sha_256|checksum|hash)["']?\s*[:=]?\s*["']?$/i;

  function isChecksum(text, index) {
    return CHECKSUM_WORD.test(text.slice(Math.max(0, index - 40), index));
  }

  function findSecrets(text, sourcePath) {
    const violations = [];
    if (/nace_sk_[a-zA-Z0-9_-]+/.test(text)) violations.push('nace_sk_ secret literal');
    for (const match of text.matchAll(/[0-9a-f]{64}/gi)) {
      const lower = match[0].toLowerCase();
      if (ALLOWLISTED_HASHES.has(lower) || isChecksum(text, match.index)) continue;
      violations.push('64-hex secret');
    }
    for (const match of text.matchAll(/Bearer\s+([a-zA-Z0-9_\-\.]{32,})/gi)) {
      if (FIXTURE_BEARERS.get(sourcePath) !== match[1]) violations.push('Bearer token');
    }
    return violations;
  }

  function isBinaryBuffer(buf) {
    const len = Math.min(buf.length, 1024);
    for (let i = 0; i < len; i += 1) {
      if (buf[i] === 0) return true; // NUL byte indicates binary
    }
    return false;
  }

  function scanDir(dir) {
    const violations = [];
    for (const entry of readdirSync(path.join(projectRoot, dir), { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry.name) && !RUNTIME_DIRS.has(full)) {
          violations.push(...scanDir(full));
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;

        const buf = readFileSync(path.join(projectRoot, full));
        if (isBinaryBuffer(buf)) continue;
        violations.push(...findSecrets(buf.toString('utf8'), full).map(kind => `${full}: contains ${kind}`));
      }
    }
    return violations;
  }

  // Construct controls so the canary does not mistake its own positive inputs for committed keys.
  const opaque = ['K7m9Q2v4X6z8B1d3', 'F5h7J9l2N4p6R8t0'].join('');
  const hex = ['a17f93c0e62bd548', '8c4a1e7f902bd365', 'd0f6a28b743c9e15', '6b3e8d2a571fc094'].join('');
  const bearer = 'Authorization: ' + 'Bearer ' + opaque;
  const nace = 'nace' + '_sk_' + opaque;
  for (const sourcePath of ['app/config.json', ...FIXTURE_BEARERS.keys()]) {
    assert.deepEqual(findSecrets(`${nace}\n${hex}\n${bearer}`, sourcePath),
      ['nace_sk_ secret literal', '64-hex secret', 'Bearer token']);
  }
  for (const [sourcePath, fixture] of FIXTURE_BEARERS) {
    const fixtureText = 'Bearer ' + fixture;
    assert.deepEqual(findSecrets(fixtureText, sourcePath), []);
    assert.deepEqual(findSecrets(`${fixtureText}\n${bearer}`, sourcePath), ['Bearer token']);
    assert.deepEqual(findSecrets(fixtureText, 'app/config.json'), ['Bearer token']);
  }

  // Checksum metadata is not a secret; the same hash outside a checksum context still is.
  assert.deepEqual(findSecrets(`{"sha256":"${hex}"}`, 'manifest.json'), []);
  assert.deepEqual(findSecrets(`{"checksum":"${hex}"}`, 'manifest.json'), []);
  assert.deepEqual(findSecrets(`produced at sha256 ${hex};`, 'manifest.json'), []);
  assert.deepEqual(findSecrets(`{"note":"${hex}"}`, 'manifest.json'), ['64-hex secret']);
  assert.deepEqual(findSecrets(`key: ${hex}`, 'manifest.json'), ['64-hex secret']);
  assert.deepEqual(findSecrets(hex, 'manifest.json'), ['64-hex secret']);

  const foundViolations = scanDir('');
  assert.deepEqual(foundViolations, [], `Found committed secret patterns in source:\n${foundViolations.join('\n')}`);
});

const appRoot = path.resolve(import.meta.dirname, '..');

test('app/config.json: parses through gateway config parser with opencodex models and no prompt-body logging', () => {
  const configText = readFileSync(new URL('../config.json', import.meta.url), 'utf8');
  const rawConfig = JSON.parse(configText);
  const parsed = parseConfig(rawConfig.inference, { baseDir: appRoot });
  assert.equal(parsed.route.default, 'any_cloud');
  assert.equal(parsed.logging.logRequestBodies, false);

  const opencodex = parsed.upstreams.find(u => u.id === 'opencodex-nace');
  assert.ok(opencodex, 'opencodex-nace upstream must be configured');
  assert.equal(opencodex.class, 'proxy');
  assert.equal(opencodex.kind, 'openai');
  assert.equal(opencodex.authMode, 'gateway_key');
  assert.equal(opencodex.keyEnv, 'OPENCODEX_API_KEY');
  assert.equal(opencodex.baseUrl, 'https://49.173.53.4/v1');

  // Verify the declared list matches what the upstream serves (GET /v1/models: nine ids)
  assert.equal(opencodex.models.length, 9);
  assert.deepEqual(opencodex.models.map(m => m.id).sort(), [
    'combo/advisor',
    'combo/front-worker',
    'combo/heavy-worker',
    'combo/lead',
    'combo/reviewer',
    'combo/security',
    'combo/worker',
    'combo/writer',
    'infron/qwen/qwen3.8-27b:free',
  ]);
  const comboModels = opencodex.models.filter(m => m.id.startsWith('combo/'));
  assert.equal(comboModels.length, 8);
  for (const cm of comboModels) {
    assert.equal(cm.metadata?.decision_model, true, `${cm.id} must have metadata.decision_model: true`);
    assert.equal(cm.zeroDataRetention, false);
    assert.equal(cm.trainingOptOut, false);
  }
});

test('app/lib/inference.mjs: createInference initializes decisionPlane correctly', () => {
  const configText = readFileSync(new URL('../config.json', import.meta.url), 'utf8');
  const rawConfig = JSON.parse(configText);
  const inf = createInference({
    raw: rawConfig.inference,
    appRoot,
    stateDir: path.join(appRoot, 'data'),
    identity: 'test-user',
    sessions: new Map(),
    env: { OPENCODEX_API_KEY: 'test-env-key-12345678' },
  });

  assert.ok(inf.decisionPlane, 'createInference must expose decisionPlane');
  assert.equal(inf.decisionPlane.configured, true);
  assert.equal(inf.decisionPlane.upstream, 'opencodex-nace');
  const snap = inf.decisionPlane.snapshot();
  assert.equal(snap.available, null, 'snapshot must be unchecked before check()');
  assert.equal(snap.reason, 'decision_plane_unchecked');
  assert.equal(inf.config.route.default, 'any_cloud', 'inference.mjs must follow config.json route.default instead of overriding to local_only');
});

test('protocol.js: gatewaySelection maps request_id and routed_model for composer chip surface', () => {
  const sel = gatewaySelection({
    request_id: 'req_abc123',
    routed_model: 'opendesign/deepseek-v4.1-flash-eco',
    model: {
      id: 'combo/main',
      upstream: 'opencodex-nace',
      decision_source: 'remote_decision',
      decision_reason: 'decision_plane_ready',
    },
  });
  assert.equal(sel.requestId, 'req_abc123');
  assert.equal(sel.routedModel, 'opendesign/deepseek-v4.1-flash-eco');
});

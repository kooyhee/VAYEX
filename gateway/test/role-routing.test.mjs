import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_ROLES,
  DECISION_MODEL_IDS,
  ROLE_IDS,
  resolveRoleModelChain,
} from '../lib/decision-planner.mjs';
import {
  selectModel,
  selectionHeaders,
  selectionReport,
} from '../lib/selection.mjs';

test('role-routing: all 6 roles define primary combo models and localFallback demo-chat', () => {
  // Every primary is an id the upstream serves; a curated chain names only served ids.
  const expectedPrimary = {
    main: 'combo/lead',
    planner: 'combo/advisor',
    frontend: 'combo/front-worker',
    backend: 'combo/worker',
    research: 'combo/advisor',
    verifier: 'combo/reviewer',
  };

  for (const role of ROLE_IDS) {
    const def = AGENT_ROLES[role];
    assert.equal(def.primaryModel, expectedPrimary[role]);
    assert.equal(def.candidates[0], expectedPrimary[role]);
    assert.deepEqual(def.localFallback, ['demo-chat']);
    assert.ok(def.decisionModels.length > 0);
    for (const m of def.decisionModels) {
      assert.ok(DECISION_MODEL_IDS.includes(m), `${m} must be in DECISION_MODEL_IDS`);
    }
  }
});

test('role-routing: resolveRoleModelChain selects combo/front-worker when available', () => {
  const entries = [
    { model: { id: 'combo/front-worker', metadata: { decision_model: true } } },
    { model: { id: 'combo/lead', metadata: { decision_model: true } } },
    { model: { id: 'demo-chat', zeroDataRetention: true, trainingOptOut: true } },
  ];
  const res = resolveRoleModelChain('frontend', { availableEntries: entries, route: 'any_cloud' });
  assert.equal(res.selectedModel, 'combo/front-worker');
  assert.equal(res.fallbackBasis, 'remote_decision');
  assert.deepEqual(res.decisionModels, AGENT_ROLES.frontend.decisionModels);
});

test('role-routing: resolveRoleModelChain falls back to demo-chat when decisionGate is down', () => {
  const entries = [
    { model: { id: 'combo/front-worker', metadata: { decision_model: true } } },
    { model: { id: 'demo-chat', zeroDataRetention: true, trainingOptOut: true } },
  ];
  const res = resolveRoleModelChain('frontend', {
    availableEntries: entries,
    route: 'any_cloud',
    decisionGate: { available: false },
  });
  assert.equal(res.selectedModel, 'demo-chat');
  assert.deepEqual(res.fallbackChain, ['demo-chat']);
  assert.equal(res.fallbackBasis, 'local_fallback');
});

test('role-routing: selectModel reports remote_decision vs local_fallback', () => {
  const fakeConfig = {
    chatModels: [
      {
        model: { id: 'combo/front-worker', capabilities: ['chat'], zeroDataRetention: false, trainingOptOut: false, metadata: { decision_model: true } },
        upstream: { id: 'opencodex-nace', class: 'proxy', authMode: 'none' },
      },
      {
        model: { id: 'demo-chat', capabilities: ['chat'], zeroDataRetention: true, trainingOptOut: true },
        upstream: { id: 'demo-stub', class: 'server_local', authMode: 'none' },
      },
    ],
    imageModels: [],
    videoModels: [],
    optimization: {},
  };

  // Case 1: decision plane ready
  const readyPlane = {
    snapshot: () => ({
      configured: true,
      upstream: 'opencodex-nace',
      available: true,
      checked_at: '2026-11-08T10:00:00Z',
      reason: 'decision_plane_ready',
    }),
  };
  const pick1 = selectModel({
    route: 'any_cloud',
    capability: 'chat',
    config: fakeConfig,
    request: { messages: [{ role: 'user', content: 'UI 컴포넌트 화면을 구현해줘' }] },
    role: 'frontend',
    decisionPlane: readyPlane,
  });
  assert.equal(pick1.entry.model.id, 'combo/front-worker');
  assert.equal(pick1.selection.decision.source, 'remote_decision');
  assert.equal(pick1.selection.decision.reason, 'decision_plane_ready');
  assert.equal(pick1.selection.decision.upstream, 'opencodex-nace');

  const report1 = selectionReport({ entry: pick1.entry, selection: pick1.selection });
  assert.equal(report1.model.decision_source, 'remote_decision');
  assert.equal(report1.model.decision_reason, 'decision_plane_ready');

  const headers1 = selectionHeaders({ entry: pick1.entry, selection: pick1.selection });
  assert.equal(headers1['x-gateway-decision-source'], 'remote_decision');
  assert.equal(headers1['x-gateway-decision-reason'], 'decision_plane_ready');
  assert.equal(headers1['x-gateway-decision-plane'], 'true');

  // Case 2: decision plane down -> local fallback
  const downPlane = {
    snapshot: () => ({
      configured: true,
      upstream: 'opencodex-nace',
      available: false,
      checked_at: '2026-11-08T10:00:00Z',
      reason: 'decision_plane_unreachable',
    }),
  };
  const pick2 = selectModel({
    route: 'any_cloud',
    capability: 'chat',
    config: fakeConfig,
    request: { messages: [{ role: 'user', content: 'UI 컴포넌트 화면을 구현해줘' }] },
    role: 'frontend',
    decisionPlane: downPlane,
  });
  assert.equal(pick2.entry.model.id, 'demo-chat');
  assert.equal(pick2.selection.decision.source, 'local_fallback');
  assert.equal(pick2.selection.decision.reason, 'decision_plane_unreachable');

  const headers2 = selectionHeaders({ entry: pick2.entry, selection: pick2.selection });
  assert.equal(headers2['x-gateway-decision-source'], 'local_fallback');
  assert.equal(headers2['x-gateway-decision-plane'], 'false');
});

test('role-routing: all 6 roles select combo/* decision model against real app/config.json with ready plane', async () => {
  const { readFileSync } = await import('node:fs');
  const { parseConfig } = await import('../lib/config.mjs');
  const rawText = readFileSync('app/config.json', 'utf8');
  const rawJson = JSON.parse(rawText);
  const realConfig = parseConfig(rawJson.inference, { baseDir: 'app' });

  const readyPlane = {
    snapshot: () => ({
      configured: true,
      upstream: 'opencodex-nace',
      available: true,
      checked_at: '2026-11-08T11:00:00Z',
      reason: 'decision_plane_ready',
    }),
  };

  // The ids `app/config.json` declares for opencodex-nace are exactly the nine the
  // upstream serves (GET /v1/models), and every role's curated primary is one of
  // them: each role resolves to its own declared primary, not a silent skip.
  const expectedRoleModels = {
    main: { primary: 'combo/lead', selected: 'combo/lead' },
    planner: { primary: 'combo/advisor', selected: 'combo/advisor' },
    frontend: { primary: 'combo/front-worker', selected: 'combo/front-worker' },
    backend: { primary: 'combo/worker', selected: 'combo/worker' },
    research: { primary: 'combo/advisor', selected: 'combo/advisor' },
    verifier: { primary: 'combo/reviewer', selected: 'combo/reviewer' },
  };
  const servedIds = new Set(
    realConfig.upstreams
      .find(u => u.id === 'opencodex-nace')
      .models
      .map(m => m.id),
  );

  // The registry must not advertise an id the upstream does not serve, and no
  // role may curate one: both would resolve by silently skipping an id.
  for (const id of DECISION_MODEL_IDS) {
    assert.ok(servedIds.has(id), `DECISION_MODEL_IDS advertises an id the upstream does not serve: ${id}`);
  }
  for (const role of ROLE_IDS) {
    for (const id of AGENT_ROLES[role].candidates) {
      assert.ok(servedIds.has(id), `role ${role} curates an id the upstream does not serve: ${id}`);
    }
  }

  for (const [role, { primary, selected }] of Object.entries(expectedRoleModels)) {
    const pick = selectModel({
      route: 'any_cloud',
      capability: 'chat',
      config: realConfig,
      request: { messages: [{ role: 'user', content: `Task execution for role ${role}` }] },
      role,
      decisionPlane: readyPlane,
    });
    assert.equal(pick.selection.primary_model, primary, `Role ${role} primary model`);
    assert.equal(pick.entry.model.id, selected, `Role ${role} must resolve to ${selected}`);
    assert.ok(servedIds.has(selected), `Role ${role} must resolve to an id the upstream serves (${selected})`);
    assert.equal(pick.selection.decision.source, 'remote_decision');
    assert.equal(pick.selection.decision.reason, 'decision_plane_ready');
    assert.equal(pick.selection.decision.upstream, 'opencodex-nace');
  }

  // Complex multi-step prompt on planner/backend triggers high_intelligence tier
  const complexPrompt = '1. 아키텍처 스키마를 점검하고 2. 데이터베이스를 리팩토링한 뒤 3. 성능 벤치마크를 수행해줘';
  for (const role of ['planner', 'backend']) {
    const complexPick = selectModel({
      route: 'any_cloud',
      capability: 'chat',
      config: realConfig,
      request: { messages: [{ role: 'user', content: complexPrompt }] },
      role,
      decisionPlane: readyPlane,
    });
    assert.equal(complexPick.entry.model.id, expectedRoleModels[role].selected, `Complex ${role} must retain its served combo model`);
    assert.equal(complexPick.selection.decision.source, 'remote_decision');
    assert.equal(complexPick.selection.plan_tier, 'high_intelligence');
  }

  // Unclassified production prompts without explicit role (OMP core default behavior)
  const unclassifiedPrompts = [
    'app/a.mjs 와 app/b.mjs 를 봐줘',
    '이 코드베이스를 audit 하고 리팩토링 대상 목록을 뽑아줘',
  ];
  for (const prompt of unclassifiedPrompts) {
    const unclassifiedPick = selectModel({
      route: 'any_cloud',
      capability: 'chat',
      config: realConfig,
      request: { messages: [{ role: 'user', content: prompt }] },
      decisionPlane: readyPlane,
    });
    // An unclassified turn is role `main`, whose declared primary `combo/lead` is
    // served: nothing is substituted behind the caller's back.
    assert.equal(unclassifiedPick.entry.model.id, 'combo/lead');
    assert.equal(unclassifiedPick.selection.role, 'main');
    assert.equal(unclassifiedPick.selection.decision.source, 'remote_decision');
    assert.equal(unclassifiedPick.selection.decision.reason, 'decision_plane_ready');
    assert.equal(unclassifiedPick.selection.reasoning_required, false, 'decision models delegate thinking');
  }
});


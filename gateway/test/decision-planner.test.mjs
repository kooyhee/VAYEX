import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_ROLES,
  MODEL_REGISTRY,
  ROLE_IDS,
  classifyAgentRole,
  evaluateModelCandidate,
  lookupModelRegistry,
  normalizeRole,
  planTurnExecution,
  resolveRoleModelChain,
} from '../lib/decision-planner.mjs';

test('decision-planner: routes simple prompt to direct_execute', () => {
  const plan = planTurnExecution('함수 foo의 반환값을 42로 변경해줘');
  assert.equal(plan.track, 'direct_execute');
  assert.equal(plan.thinkingBudget, 0);
  assert.equal(plan.suggestedWorkers, 1);
  assert.equal(plan.planDirective, null);
});

test('decision-planner: routes multi-file architecture prompt to survey_and_plan', () => {
  const prompt = 'src/app.ts와 src/router.ts의 라우팅 구조를 리팩토링하고 벤치마크 테스트를 추가해줘';
  const plan = planTurnExecution(prompt);
  assert.equal(plan.track, 'survey_and_plan');
  assert.equal(plan.recommendedTier, 'high_intelligence');
  assert.ok(plan.thinkingBudget > 0);
  assert.ok(plan.suggestedWorkers >= 2);
  assert.ok(plan.planDirective.includes('조사 (Survey)'));
});

test('decision-planner: routes multi-step long task to survey_and_plan', () => {
  const prompt = `
1. 먼저 데이터베이스 스키마를 점검하고,
2. 그리고 캐시 계층을 설계하여 적용한 뒤,
3. 마지막으로 부하 테스트를 수행하여 결과를 검증해줘.
  `.repeat(3);
  const plan = planTurnExecution(prompt);
  assert.equal(plan.track, 'survey_and_plan');
  assert.ok(plan.planDirective !== null);
});

test('6-role engine: defines all 6 distinct agent roles with primary models and candidate chains', () => {
  assert.deepEqual(ROLE_IDS, ['main', 'planner', 'frontend', 'backend', 'research', 'verifier']);
  assert.equal(AGENT_ROLES.main.primaryModel, 'combo/lead');
  assert.equal(AGENT_ROLES.planner.primaryModel, 'combo/advisor');
  assert.equal(AGENT_ROLES.frontend.primaryModel, 'combo/front-worker');
  assert.equal(AGENT_ROLES.backend.primaryModel, 'combo/worker');
  assert.equal(AGENT_ROLES.research.primaryModel, 'combo/advisor');
  assert.equal(AGENT_ROLES.verifier.primaryModel, 'combo/reviewer');
  // Every role's curated order is the remote decision-routed ids, and the declared
  // local fallback is the one loopback stub this harness actually serves.
  for (const roleId of ROLE_IDS) {
    const role = AGENT_ROLES[roleId];
    assert.equal(role.candidates[0], role.primaryModel);
    assert.ok(role.decisionModels.length > 0, `${roleId} must declare its decision-routed ids`);
    assert.deepEqual(role.localFallback, ['demo-chat']);
  }
});

test('6-role engine: auto-classifies task intent across all 6 roles with zero external LLM calls', () => {
  const mainRes = classifyAgentRole('서브에이전트 작업을 조율하고 하위 에이전트에게 위임한 뒤 결과를 통합해줘');
  assert.equal(mainRes.role, 'main');
  assert.equal(mainRes.matched, true);

  const plannerRes = classifyAgentRole('전체 마이크로서비스 아키텍처 설계와 단계별 마이그레이션 계획을 수립해줘');
  assert.equal(plannerRes.role, 'planner');
  assert.equal(plannerRes.matched, true);

  const frontendRes = classifyAgentRole('반응형 웹 프론트엔드 대시보드 화면과 다크모드 UI 컴포넌트를 CSS로 구현해줘');
  assert.equal(frontendRes.role, 'frontend');
  assert.equal(frontendRes.matched, true);

  const backendRes = classifyAgentRole('REST API 서버 엔드포인트와 데이터베이스 트랜잭션 비즈니스 로직을 구현해줘');
  assert.equal(backendRes.role, 'backend');
  assert.equal(backendRes.matched, true);

  const researchRes = classifyAgentRole('메모리 누수 에러 원인을 규명하고 관련 기술 문서를 조사·분석해줘');
  assert.equal(researchRes.role, 'research');
  assert.equal(researchRes.matched, true);

  const verifierRes = classifyAgentRole('단위 테스트를 실행하고 코드 리뷰 및 정합성 검증을 수행해줘');
  assert.equal(verifierRes.role, 'verifier');
  assert.equal(verifierRes.matched, true);

  // Explicit role / subagent aliases normalize deterministically
  assert.equal(normalizeRole('orchestrator'), 'main');
  assert.equal(normalizeRole('frontend_worker'), 'frontend');
  assert.equal(normalizeRole('backend_worker'), 'backend');
  assert.equal(normalizeRole('researcher'), 'research');
  assert.equal(normalizeRole('reviewer'), 'verifier');
});

test('model registry & candidate evaluation: checks availability, pricing, ZDR, tool calling, latency, and prefix caching', () => {
  const requiredModels = [
    'anthropic/claude-opus-5.5',
    'openai/gpt-6-astra',
    'google/gemini-4-carbon',
    'anthropic/claude-sonnet-5.5',
    'openai/gpt-6-luna',
    'google/gemini-2.5-flash',
    'deepseek/deepseek-v4.1-flash-1017',
    'zhipu/glm-4-flash',
  ];

  for (const id of requiredModels) {
    const reg = lookupModelRegistry(id);
    assert.ok(reg, `registry must contain ${id}`);
    const evaluated = evaluateModelCandidate(id, { role: 'planner', route: 'zdr_cloud' });
    assert.equal(evaluated.available, true);
    assert.equal(evaluated.zdrSupported, true);
    assert.equal(evaluated.routeConforms, true);
    assert.equal(evaluated.toolCalling, true);
    assert.equal(evaluated.prefixCaching, true);
    assert.ok(evaluated.latencyMs > 0);
    assert.ok(evaluated.pricing.input > 0);
    assert.ok(evaluated.ecps > 0);
  }

  // Deterministic fallback chain when the role's primary decision model is down:
  // only ids the upstream really serves can appear, in the role's declared order.
  const chainWhenPrimaryDown = resolveRoleModelChain('planner', {
    availableEntries: [
      { model: { id: 'combo/heavy-worker' } },
      { model: { id: 'combo/worker' } },
    ],
    isServable: () => true,
  });
  assert.equal(chainWhenPrimaryDown.primaryModel, 'combo/advisor');
  assert.equal(chainWhenPrimaryDown.selectedModel, 'combo/heavy-worker');
  assert.deepEqual(chainWhenPrimaryDown.fallbackChain, ['combo/heavy-worker', 'combo/worker']);
  assert.equal(chainWhenPrimaryDown.fallbackBasis, 'remote_decision');

  // The declared local chain is what serves the role when the remote decision plane
  // reports itself unreachable: a report, not a silent swap.
  const localChain = resolveRoleModelChain('frontend', {
    availableEntries: [
      { model: { id: 'combo/front-worker' } },
      { model: { id: 'demo-chat' } },
    ],
    decisionGate: { available: false },
  });
  assert.equal(localChain.selectedModel, 'demo-chat');
  assert.deepEqual(localChain.fallbackChain, ['demo-chat']);
  assert.equal(localChain.fallbackBasis, 'local_fallback');
  assert.deepEqual(localChain.decisionModels, AGENT_ROLES.frontend.decisionModels);
});


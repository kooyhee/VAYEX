// 6-Role Intelligent Model Auto-Selection & 2-Track Execution Decision Planner.
//
// Determines both:
//   1. The active agent role (`main`, `planner`, `frontend`, `backend`, `research`, `verifier`)
//      from prompt/task intent with zero external LLM calls.
//   2. The optimal model candidate and deterministic fallback order for that role,
//      evaluated on real availability, pricing, ZDR support, tool calling support,
//      response latency, and prefix caching support.
//   3. The 2-Track execution plan (`direct_execute` vs `survey_and_plan`).

const FILE_PATTERN = /[\w./\\-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|md|json|ya?ml|sql|html|css|scss|vue|svelte|toml)\b/g;

const COMPLEXITY_KEYWORDS = [
  '설계', '아키텍처', '리팩토링', '전수 조사', '마이그레이션', '벤치마크', '구조 개편',
  'refactor', 'architecture', 'migrate', 'benchmark', 'investigate', 'audit',
  'end-to-end', 'multi-agent', 'orchestrat',
];

const STEP_PATTERNS = [
  /(?:^|\n)\s*(?:1[.)]|step\s*1|첫\s*번째)/i,
  /(?:^|\n)\s*(?:2[.)]|step\s*2|두\s*번째)/i,
  /(?:^|\n)\s*(?:3[.)]|step\s*3|세\s*번째)/i,
  /(?:그리고|그\s*다음|이어서|완료\s*후)\s+/,
];

export const ROLE_IDS = Object.freeze([
  'main',
  'planner',
  'frontend',
  'backend',
  'research',
  'verifier',
]);

// The six role chains are curated onto the ids the upstream actually serves. The
// four ids they named before and the upstream no longer does are handled on
// purpose, not by guesswork:
//   * `combo/main` → `combo/lead`: the alias table below already resolves `lead`
//     to `main`, so `lead` is the served id for the orchestrating role.
//   * `combo/claude-opus-5-5`, `combo/gemini-4-argon`, `combo/deepseek-v4.1-flash`
//     have no served counterpart, so they are dropped and the remaining declared
//     order kept.
export const AGENT_ROLES = Object.freeze({
  main: Object.freeze({
    id: 'main',
    label: '작업 조율·위임·결과 통합 (Orchestrator)',
    tier: 'fast',
    defaultReasoningGrade: 'medium',
    // The upstream has no `combo/main`. `combo/lead` is the id it serves for the
    // orchestrating role: this file's own alias table already resolves `lead` to
    // `main`, and no other role claims the id.
    primaryModel: 'combo/lead',
    candidates: Object.freeze([
      'combo/lead',
      'combo/worker',
      'combo/front-worker',
      'combo/reviewer',
    ]),
    decisionModels: Object.freeze([
      'combo/lead',
      'combo/worker',
      'combo/front-worker',
      'combo/reviewer',
    ]),
    localFallback: Object.freeze(['demo-chat']),
  }),
  planner: Object.freeze({
    id: 'planner',
    label: '복잡한 작업의 아키텍처 설계·계획 수립',
    tier: 'high_intelligence',
    defaultReasoningGrade: 'high',
    primaryModel: 'combo/advisor',
    candidates: Object.freeze([
      'combo/advisor',
      'combo/lead',
      'combo/heavy-worker',
      'combo/worker',
    ]),
    decisionModels: Object.freeze([
      'combo/advisor',
      'combo/lead',
      'combo/heavy-worker',
      'combo/worker',
    ]),
    localFallback: Object.freeze(['demo-chat']),
  }),
  frontend: Object.freeze({
    id: 'frontend',
    label: 'UI·UX·웹 프론트엔드·반응형 구현',
    tier: 'high_intelligence',
    defaultReasoningGrade: 'medium',
    primaryModel: 'combo/front-worker',
    candidates: Object.freeze([
      'combo/front-worker',
      'combo/lead',
    ]),
    decisionModels: Object.freeze([
      'combo/front-worker',
      'combo/lead',
    ]),
    localFallback: Object.freeze(['demo-chat']),
  }),
  backend: Object.freeze({
    id: 'backend',
    label: '서버·API·데이터 처리·비즈니스 로직',
    tier: 'fast',
    defaultReasoningGrade: 'medium',
    primaryModel: 'combo/worker',
    candidates: Object.freeze([
      'combo/worker',
      'combo/heavy-worker',
      'combo/lead',
    ]),
    decisionModels: Object.freeze([
      'combo/worker',
      'combo/heavy-worker',
      'combo/lead',
    ]),
    localFallback: Object.freeze(['demo-chat']),
  }),
  research: Object.freeze({
    id: 'research',
    label: '기술 조사·문서 분석·에러 원인 규명',
    tier: 'fast',
    defaultReasoningGrade: 'low',
    // `combo/gemini-4-argon` is not served and has no served research counterpart.
    // `combo/advisor` was already its next candidate — and what it resolved to — so
    // that is the declaration, not a new mapping.
    primaryModel: 'combo/advisor',
    candidates: Object.freeze([
      'combo/advisor',
      'combo/lead',
    ]),
    decisionModels: Object.freeze([
      'combo/advisor',
      'combo/lead',
    ]),
    localFallback: Object.freeze(['demo-chat']),
  }),
  verifier: Object.freeze({
    id: 'verifier',
    label: '테스트 실행·코드 리뷰·정합성 검증',
    tier: 'fast',
    defaultReasoningGrade: 'low',
    primaryModel: 'combo/reviewer',
    candidates: Object.freeze([
      'combo/reviewer',
      'combo/security',
      'combo/lead',
      'combo/worker',
    ]),
    decisionModels: Object.freeze([
      'combo/reviewer',
      'combo/security',
      'combo/lead',
      'combo/worker',
    ]),
    localFallback: Object.freeze(['demo-chat']),
  }),
});

// The ids served by the remote opencodex gateway whose concrete worker is chosen
// per request by the remote decision model (`nace` → `drex-max-v1.1`). A local
// gateway cannot know which model the remote picked, so these entries carry no
// measured price, latency or success rate: `realMetrics: false` says so, and the
// role chain order — not a score — is what decides the pick.
const DECISION_MODEL_SUCCESS = Object.freeze({
  main: 0.90,
  planner: 0.90,
  frontend: 0.90,
  backend: 0.90,
  research: 0.90,
  verifier: 0.90,
});

// Exactly the `combo/*` ids the upstream serves (`GET /v1/models`, mirrored by the
// opencodex-nace allowlist in `app/config.json`). A curated chain must name only
// these, or the role would resolve by silently skipping ids nothing can serve.
export const DECISION_MODEL_IDS = Object.freeze([
  'combo/advisor',
  'combo/front-worker',
  'combo/heavy-worker',
  'combo/lead',
  'combo/reviewer',
  'combo/security',
  'combo/worker',
  'combo/writer',
]);

function remoteDecisionRegistry() {
  const entries = {};
  for (const id of DECISION_MODEL_IDS) {
    entries[id] = Object.freeze({
      id,
      displayName: id.replace('combo/', 'combo · '),
      provider: 'opencodex-nace',
      category: 'remote_decision',
      aliases: Object.freeze([]),
      available: true,
      realMetrics: false,
      pricing: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      // Nothing about the remote's retention posture is declared for it, so the
      // registry claims neither flag, and `zdr_cloud` cannot select these ids.
      zdr: Object.freeze({ zeroDataRetention: false, trainingOptOut: false }),
      toolCalling: true,
      prefixCaching: false,
      latencyMs: null,
      contextWindow: null,
      thinkingLimit: null,
      arenaWebDevRank: null,
      successRates: DECISION_MODEL_SUCCESS,
    });
  }
  return entries;
}

// Curated Model Registry with real-world operational metrics:
// availability, pricing (USD / 1M tokens), ZDR support, tool calling support,
// response latency (ms), prefix caching support, Arena WebDev ranking, and per-role prior success rates.
export const MODEL_REGISTRY = Object.freeze({
  ...remoteDecisionRegistry(),
  // The declared local fallback. It is the loopback stub this harness serves when
  // no model can think on its own; its prior is low on purpose and it is never
  // reported as an inference result.
  'demo-chat': Object.freeze({
    id: 'demo-chat',
    displayName: 'demo-chat (로컬 스텁)',
    provider: 'harness-local',
    category: 'local_fallback',
    aliases: Object.freeze([]),
    available: true,
    realMetrics: false,
    pricing: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    zdr: Object.freeze({ zeroDataRetention: true, trainingOptOut: true }),
    toolCalling: true,
    prefixCaching: false,
    latencyMs: 50,
    contextWindow: 32768,
    thinkingLimit: 8192,
    arenaWebDevRank: null,
    successRates: Object.freeze({
      main: 0.60,
      planner: 0.60,
      frontend: 0.60,
      backend: 0.60,
      research: 0.60,
      verifier: 0.60,
    }),
  }),
  'anthropic/claude-opus-5.5': Object.freeze({
    id: 'anthropic/claude-opus-5.5',
    displayName: 'Claude Opus 5.5',
    provider: 'anthropic',
    category: 'high_difficulty',
    aliases: Object.freeze(['claude-opus-5.5', 'anthropic/claude-opus']),
    available: true,
    pricing: Object.freeze({ input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 }),
    zdr: Object.freeze({ zeroDataRetention: true, trainingOptOut: true }),
    toolCalling: true,
    prefixCaching: true,
    latencyMs: 1150,
    contextWindow: 200000,
    thinkingLimit: 16384,
    arenaWebDevRank: 2,
    successRates: Object.freeze({
      main: 0.95,
      planner: 0.98,
      frontend: 0.96,
      backend: 0.96,
      research: 0.95,
      verifier: 0.96,
    }),
  }),
  'openai/gpt-6-astra': Object.freeze({
    id: 'openai/gpt-6-astra',
    displayName: 'GPT-6 Astra',
    provider: 'openai',
    category: 'high_difficulty',
    aliases: Object.freeze(['gpt-6-astra', 'openai/gpt-4o', 'gpt-4o']),
    available: true,
    pricing: Object.freeze({ input: 3.5, output: 14.0, cacheRead: 0.35, cacheWrite: 3.5 }),
    zdr: Object.freeze({ zeroDataRetention: true, trainingOptOut: true }),
    toolCalling: true,
    prefixCaching: true,
    latencyMs: 920,
    contextWindow: 400000,
    thinkingLimit: 16384,
    arenaWebDevRank: 3,
    successRates: Object.freeze({
      main: 0.95,
      planner: 0.96,
      frontend: 0.94,
      backend: 0.97,
      research: 0.94,
      verifier: 0.95,
    }),
  }),
  'google/gemini-4-carbon': Object.freeze({
    id: 'google/gemini-4-carbon',
    displayName: 'Gemini 4 Carbon',
    provider: 'google',
    category: 'high_difficulty',
    aliases: Object.freeze(['gemini-4-carbon', 'google/gemini-pro']),
    available: true,
    pricing: Object.freeze({ input: 2.5, output: 10.0, cacheRead: 0.25, cacheWrite: 2.5 }),
    zdr: Object.freeze({ zeroDataRetention: true, trainingOptOut: true }),
    toolCalling: true,
    prefixCaching: true,
    latencyMs: 780,
    contextWindow: 1048576,
    thinkingLimit: 16384,
    arenaWebDevRank: 4,
    successRates: Object.freeze({
      main: 0.93,
      planner: 0.95,
      frontend: 0.93,
      backend: 0.93,
      research: 0.97,
      verifier: 0.93,
    }),
  }),
  'anthropic/claude-sonnet-5.5': Object.freeze({
    id: 'anthropic/claude-sonnet-5.5',
    displayName: 'Claude Sonnet 5.5',
    provider: 'anthropic',
    category: 'frontend_webdev',
    aliases: Object.freeze([
      'claude-sonnet-5.5',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-3.5-sonnet',
      'claude-3-5-sonnet',
    ]),
    available: true,
    pricing: Object.freeze({ input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 }),
    zdr: Object.freeze({ zeroDataRetention: true, trainingOptOut: true }),
    toolCalling: true,
    prefixCaching: true,
    latencyMs: 640,
    contextWindow: 200000,
    thinkingLimit: 8192,
    arenaWebDevRank: 1,
    successRates: Object.freeze({
      main: 0.95,
      planner: 0.94,
      frontend: 0.98,
      backend: 0.96,
      research: 0.93,
      verifier: 0.95,
    }),
  }),
  'openai/gpt-6-luna': Object.freeze({
    id: 'openai/gpt-6-luna',
    displayName: 'GPT-6 Luna',
    provider: 'openai',
    category: 'cost_speed',
    aliases: Object.freeze(['gpt-6-luna', 'openai/gpt-4o-mini', 'gpt-4o-mini']),
    available: true,
    pricing: Object.freeze({ input: 0.20, output: 0.80, cacheRead: 0.02, cacheWrite: 0.20 }),
    zdr: Object.freeze({ zeroDataRetention: true, trainingOptOut: true }),
    toolCalling: true,
    prefixCaching: true,
    latencyMs: 310,
    contextWindow: 200000,
    thinkingLimit: 8192,
    arenaWebDevRank: 6,
    successRates: Object.freeze({
      main: 0.93,
      planner: 0.86,
      frontend: 0.88,
      backend: 0.92,
      research: 0.92,
      verifier: 0.95,
    }),
  }),
  'google/gemini-2.5-flash': Object.freeze({
    id: 'google/gemini-2.5-flash',
    displayName: 'Gemini Flash',
    provider: 'google',
    category: 'cost_speed',
    aliases: Object.freeze(['gemini-flash', 'google/gemini-flash', 'gemini-2.5-flash']),
    available: true,
    pricing: Object.freeze({ input: 0.15, output: 0.60, cacheRead: 0.015, cacheWrite: 0.15 }),
    zdr: Object.freeze({ zeroDataRetention: true, trainingOptOut: true }),
    toolCalling: true,
    prefixCaching: true,
    latencyMs: 280,
    contextWindow: 1048576,
    thinkingLimit: 8192,
    arenaWebDevRank: 7,
    successRates: Object.freeze({
      main: 0.91,
      planner: 0.85,
      frontend: 0.87,
      backend: 0.90,
      research: 0.95,
      verifier: 0.93,
    }),
  }),
  'deepseek/deepseek-v4.1-flash-1017': Object.freeze({
    id: 'deepseek/deepseek-v4.1-flash-1017',
    displayName: 'DeepSeek V4.1 Flash',
    provider: 'deepseek',
    category: 'cost_speed',
    aliases: Object.freeze([
      'deepseek/deepseek-v4.1-flash',
      'deepseek-v4.1-flash',
      'deepseek/deepseek-chat',
      'deepseek-chat',
    ]),
    available: true,
    pricing: Object.freeze({ input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 }),
    zdr: Object.freeze({ zeroDataRetention: true, trainingOptOut: true }),
    toolCalling: true,
    prefixCaching: true,
    latencyMs: 340,
    contextWindow: 131072,
    thinkingLimit: 8192,
    arenaWebDevRank: 5,
    successRates: Object.freeze({
      main: 0.95,
      planner: 0.89,
      frontend: 0.90,
      backend: 0.94,
      research: 0.92,
      verifier: 0.94,
    }),
  }),
  'zhipu/glm-4-flash': Object.freeze({
    id: 'zhipu/glm-4-flash',
    displayName: 'GLM Flash',
    provider: 'zhipu',
    category: 'cost_speed',
    aliases: Object.freeze(['glm-flash', 'glm-4-flash', 'thudm/glm-4-flash']),
    available: true,
    pricing: Object.freeze({ input: 0.10, output: 0.20, cacheRead: 0.01, cacheWrite: 0.10 }),
    zdr: Object.freeze({ zeroDataRetention: true, trainingOptOut: true }),
    toolCalling: true,
    prefixCaching: true,
    latencyMs: 260,
    contextWindow: 128000,
    thinkingLimit: 4096,
    arenaWebDevRank: 8,
    successRates: Object.freeze({
      main: 0.89,
      planner: 0.82,
      frontend: 0.84,
      backend: 0.88,
      research: 0.90,
      verifier: 0.91,
    }),
  }),
});

const ROLE_ALIASES = Object.freeze({
  main: 'main',
  orchestrator: 'main',
  coordinator: 'main',
  lead: 'main',
  planner: 'planner',
  plan: 'planner',
  architect: 'planner',
  architecture: 'planner',
  frontend: 'frontend',
  frontend_worker: 'frontend',
  ui: 'frontend',
  ux: 'frontend',
  webdev: 'frontend',
  vision_worker: 'frontend',
  backend: 'backend',
  backend_worker: 'backend',
  server: 'backend',
  api: 'backend',
  worker: 'backend',
  heavy_worker: 'backend',
  light_worker: 'backend',
  implementer: 'backend',
  research: 'research',
  researcher: 'research',
  survey: 'research',
  surveyor: 'research',
  explore: 'research',
  explorer: 'research',
  investigator: 'research',
  verifier: 'verifier',
  verify: 'verifier',
  reviewer: 'verifier',
  security_reviewer: 'verifier',
  tester: 'verifier',
  qa: 'verifier',
});

const ROLE_SIGNALS = Object.freeze({
  verifier: Object.freeze({
    keywords: Object.freeze([
      '테스트 실행', '코드 리뷰', '정합성 검증', '단위 테스트', '통합 테스트', '회귀 테스트',
      '테스트 작성', '테스트 코드', '테스트 통과', '검증 실행', '린트 검사', '타입 체크', '타입체크',
      '정합성 확인', '검증해', '리뷰해', '테스트해',
      'run test', 'unit test', 'integration test', 'regression test', 'code review',
      'verify', 'verification', 'pytest', 'vitest', 'jest', 'node --test', 'typecheck', 'eslint', 'ruff',
    ]),
    weakKeywords: Object.freeze(['테스트', '검증', '리뷰', '정합성', '린트', 'test', 'review', 'lint', 'assert']),
    filePattern: /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[\\/])(?:tests?|__tests__)[\\/]|test_[\w]+\.py|[\w]+_test\.py)/i,
  }),
  frontend: Object.freeze({
    keywords: Object.freeze([
      '프론트엔드', '웹 프론트엔드', '반응형 구현', '반응형 웹', '반응형 레이아웃', '화면 구현',
      '컴포넌트 구현', '스타일시트', '다크모드', '라이트모드', '테마 전환', '웹 디자인', '퍼블리싱',
      '사용자 인터페이스', '사용자 경험', '모달 창', '애니메이션', '접근성 개선',
      'frontend', 'front-end', 'webdev', 'responsive', 'ui/ux', 'ui 구현', 'ux 개선',
      'react', 'nextjs', 'vue', 'svelte', 'tailwind', 'stylesheet', 'css grid', 'flexbox', 'dom', 'svg',
    ]),
    weakKeywords: Object.freeze([
      '프론트', '화면', '반응형', '스타일', '레이아웃', '컴포넌트', '디자인', '테마', '버튼', '모달', '메뉴', '탭', '여백', '폰트',
      'ui', 'ux', 'css', 'html', 'jsx', 'tsx', 'layout', 'component', 'theme', 'modal', 'button',
    ]),
    filePattern: /\.(?:css|scss|sass|less|html|jsx|tsx|vue|svelte)$/i,
  }),
  backend: Object.freeze({
    keywords: Object.freeze([
      '비즈니스 로직', '데이터 처리', '서버 구현', '백엔드', '데이터베이스', '엔드포인트',
      '라우터 구현', '미들웨어', '트랜잭션', '웹소켓', '인증 로직', '인가 처리', '세션 관리',
      '큐 처리', '배치 처리', '쿼리 최적화', '스키마 변경',
      'backend', 'back-end', 'business logic', 'data processing', 'rest api', 'graphql', 'grpc',
      'database', 'sql', 'sqlite', 'postgres', 'redis', 'endpoint', 'middleware', 'webhook', 'authentication',
    ]),
    weakKeywords: Object.freeze([
      '서버', '라우터', '라우팅', '쿼리', '스키마', '핸들러', '소켓', '스트림', '인증', '페이로드',
      'server', 'api', 'db', 'route', 'router', 'handler', 'query', 'schema', 'socket', 'stream', 'auth',
    ]),
    filePattern: /(?:server|routes?|api|controller|service|store|sqlite|db|gateway|handler|middleware)\.[cm]?[jt]s$|\.sql$/i,
  }),
  research: Object.freeze({
    keywords: Object.freeze([
      '기술 조사', '문서 분석', '에러 원인 규명', '원인 규명', '에러 원인', '오류 원인', '원인 분석',
      '근본 원인', '스택트레이스 분석', '레퍼런스 조사', '사양 조사', '비교 분석', '문서 요약', '장애 원인',
      'root cause', 'technical research', 'document analysis', 'error analysis', 'stack trace',
      'traceback', 'diagnose', 'investigate error', 'research', 'survey',
    ]),
    weakKeywords: Object.freeze([
      '조사', '문서', '규명', '디버깅', '디버그', '탐색', '파악', '이유', '왜 발생', '왜 안',
      'investigate', 'analyze', 'analysis', 'debug', 'explore', 'why does', 'cause',
    ]),
    filePattern: /\.(?:md|mdx|txt|rst|pdf|log)$/i,
  }),
  planner: Object.freeze({
    keywords: Object.freeze([
      '아키텍처 설계', '계획 수립', '시스템 설계', '구조 설계', '구조 개편', '마이그레이션 계획',
      '설계 명세', '단계별 계획', '전체 아키텍처', '모듈 분리 설계', '로드맵 수립',
      'architecture design', 'system design', 'execution plan', 'migration plan',
      'architectural', 'blueprint', 'roadmap', 'specification', 'design document',
    ]),
    weakKeywords: Object.freeze([
      '설계', '아키텍처', '계획', '리팩토링', '마이그레이션', '구조', '전략', '명세',
      'architecture', 'architect', 'design', 'plan', 'planning', 'refactor', 'strategy', 'spec',
    ]),
    filePattern: /(?:설계|spec|architecture|plan|roadmap|rfc)/i,
  }),
  main: Object.freeze({
    keywords: Object.freeze([
      '작업 조율', '결과 통합', '하위 에이전트 위임', '서브에이전트 위임', '오케스트레이션',
      '오케스트레이터', '작업 분배', '병렬 위임', '전체 조율', '에이전트 조율',
      'orchestrate', 'orchestrator', 'delegate tasks', 'coordinate agents', 'integrate results',
      'subagent delegation', 'multi-agent coordination',
    ]),
    weakKeywords: Object.freeze([
      '조율', '위임', '통합', '총괄', '분배', '서브에이전트', '하위 작업',
      'delegate', 'coordinate', 'integrate', 'subagent', 'workflow',
    ]),
    filePattern: /(?:orchestrator|main|index)\.[cm]?[jt]s$/i,
  }),
});

export const ROLE_INTENT_THRESHOLD = 4;

/**
 * Normalize a role identifier or alias to one of the 6 canonical roles.
 * Returns null if the input does not map to a known role.
 * @param {unknown} value
 * @returns {'main' | 'planner' | 'frontend' | 'backend' | 'research' | 'verifier' | null}
 */
export function normalizeRole(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!cleaned) return null;
  if (ROLE_ALIASES[cleaned]) return ROLE_ALIASES[cleaned];
  for (const [alias, canonical] of Object.entries(ROLE_ALIASES)) {
    if (cleaned === `role_${alias}` || cleaned === `agent_${alias}`) return canonical;
  }
  return null;
}

/**
 * Lookup a model's registry metadata by canonical ID, alias, or provider suffix.
 * @param {string} modelId
 */
export function lookupModelRegistry(modelId) {
  if (typeof modelId !== 'string' || !modelId.trim()) return null;
  const trimmed = modelId.trim();
  const lower = trimmed.toLowerCase();
  if (MODEL_REGISTRY[lower]) return MODEL_REGISTRY[lower];
  for (const entry of Object.values(MODEL_REGISTRY)) {
    if (entry.id.toLowerCase() === lower) return entry;
    if (entry.aliases.some((alias) => alias.toLowerCase() === lower)) return entry;
  }
  for (const entry of Object.values(MODEL_REGISTRY)) {
    // Decision model ids (`combo/*`) represent distinct remote routing targets and
    // must never collide with vendor models sharing the trailing name (a vendor
    // `worker` is not the remote routing target `combo/worker`).
    if (entry.category === 'remote_decision') continue;
    const suffix = entry.id.split('/').pop()?.toLowerCase();
    if (suffix && (lower.endsWith(`/${suffix}`) || lower === suffix)) return entry;
  }
  return null;
}

/**
 * Evaluate one model candidate for a given role against operational criteria:
 * real availability, pricing, ZDR support, tool calling support, response latency,
 * and prefix caching support.
 */
export function evaluateModelCandidate(modelIdOrEntry, {
  role = 'main',
  route = 'zdr_cloud',
  isServable = null,
  requireToolCalling = true,
  promptTokens = 2000,
  outputTokens = 600,
  cacheHitRatio = 0.7,
} = {}) {
  const canonicalRole = normalizeRole(role) ?? 'main';
  const roleDef = AGENT_ROLES[canonicalRole];
  const isGatewayEntry = Boolean(modelIdOrEntry && typeof modelIdOrEntry === 'object' && modelIdOrEntry.model);
  const modelObj = isGatewayEntry ? modelIdOrEntry.model : (typeof modelIdOrEntry === 'object' ? modelIdOrEntry : null);
  const rawId = typeof modelIdOrEntry === 'string'
    ? modelIdOrEntry
    : String(modelObj?.id ?? '');
  const registryEntry = lookupModelRegistry(rawId);

  const servable = typeof isServable === 'function' && isGatewayEntry
    ? Boolean(isServable(modelIdOrEntry))
    : (modelObj?.available !== undefined ? Boolean(modelObj.available) : (registryEntry?.available ?? true));

  const zeroDataRetention = modelObj?.zeroDataRetention !== undefined
    ? Boolean(modelObj.zeroDataRetention)
    : (registryEntry?.zdr?.zeroDataRetention ?? false);
  const trainingOptOut = modelObj?.trainingOptOut !== undefined
    ? Boolean(modelObj.trainingOptOut)
    : (registryEntry?.zdr?.trainingOptOut ?? false);
  const zdrSupported = zeroDataRetention && trainingOptOut;
  const routeConforms = route === 'zdr_cloud' ? zdrSupported : true;

  const toolCalling = modelObj?.toolCalling !== undefined
    ? Boolean(modelObj.toolCalling)
    : (registryEntry?.toolCalling ?? true);
  const prefixCaching = modelObj?.prefixCaching !== undefined
    ? Boolean(modelObj.prefixCaching)
    : (registryEntry?.prefixCaching ?? true);
  const latencyMs = Number.isFinite(modelObj?.latencyMs)
    ? modelObj.latencyMs
    : (registryEntry?.latencyMs ?? 500);
  const pricing = modelObj?.pricing ?? registryEntry?.pricing ?? { input: 1.0, output: 3.0, cacheRead: 0.2, cacheWrite: 1.0 };
  const successRate = registryEntry?.successRates?.[canonicalRole] ?? 0.90;

  const effectiveCacheRatio = prefixCaching ? Math.min(1, Math.max(0, cacheHitRatio)) : 0;
  const uncachedPrompt = promptTokens * (1 - effectiveCacheRatio);
  const cachedPrompt = promptTokens * effectiveCacheRatio;
  const turnCostUsd = (
    uncachedPrompt * pricing.input
    + cachedPrompt * (pricing.cacheRead ?? pricing.input)
    + outputTokens * pricing.output
  ) / 1_000_000;

  // Expected Cost Per Success (ECPS) with retry penalty
  const ecps = (turnCostUsd / successRate) + 0.5 * turnCostUsd * ((1 - successRate) / successRate);

  const candidateIndex = roleDef.candidates.findIndex((cid) => {
    if (cid === rawId) return true;
    const reg = lookupModelRegistry(cid);
    return Boolean(reg && registryEntry && reg.id === registryEntry.id);
  });
  const inRoleCandidates = candidateIndex !== -1;
  const rolePriorityBonus = inRoleCandidates ? (roleDef.candidates.length - candidateIndex) * 20 : 0;

  // Deterministic composite score based on role priority, success rate, cost, latency, and prefix caching
  const latencyScore = Math.max(0, 10 - latencyMs / 200);
  const costScore = Math.max(0, 10 - turnCostUsd * 200);
  const cacheBonus = prefixCaching ? 2 : 0;
  const score = Number((
    rolePriorityBonus
    + successRate * 100
    + latencyScore
    + costScore
    + cacheBonus
  ).toFixed(4));

  const eligible = servable && routeConforms && (!requireToolCalling || toolCalling);

  return {
    id: rawId,
    canonicalId: registryEntry?.id ?? rawId,
    displayName: registryEntry?.displayName ?? rawId,
    role: canonicalRole,
    available: servable,
    zdrSupported,
    routeConforms,
    toolCalling,
    prefixCaching,
    latencyMs,
    pricing,
    successRate,
    turnCostUsd: Number(turnCostUsd.toFixed(6)),
    ecps: Number(ecps.toFixed(6)),
    inRoleCandidates,
    roleCandidateRank: inRoleCandidates ? candidateIndex : Number.MAX_SAFE_INTEGER,
    arenaWebDevRank: registryEntry?.arenaWebDevRank ?? null,
    eligible,
    score,
  };
}

/**
 * Resolve the optimal primary model and deterministic fallback chain for a role.
 * Evaluates both the role's curated candidate list and any live gateway allowlist entries.
 */
export function resolveRoleModelChain(role, {
  availableEntries = null,
  route = 'zdr_cloud',
  isServable = () => true,
  requireToolCalling = true,
  decisionGate = null,
} = {}) {
  const canonicalRole = normalizeRole(role) ?? 'main';
  const roleDef = AGENT_ROLES[canonicalRole];
  // A reported, never silent gate: `available === false` is the remote decision
  // plane saying it cannot answer, and a decision model is then not a choice —
  // not even one the credential check would let through.
  const gateDown = Boolean(decisionGate) && decisionGate.available === false;
  const entryId = (entry) => entry?.model?.id ?? entry?.id ?? null;
  const isDecisionId = (id) => typeof id === 'string' && DECISION_MODEL_IDS.includes(id);

  // Evaluate curated role candidates first
  const curatedEvaluations = roleDef.candidates.map((candidateId) => {
    let matchedEntry = null;
    if (Array.isArray(availableEntries)) {
      const targetReg = lookupModelRegistry(candidateId);
      matchedEntry = availableEntries.find((entry) => {
        const entryId = entry?.model?.id ?? entry?.id;
        if (entryId === candidateId) return true;
        const entryReg = lookupModelRegistry(entryId);
        return Boolean(targetReg && entryReg && targetReg.id === entryReg.id);
      }) ?? null;
    }
    const evalTarget = matchedEntry ?? candidateId;
    const evaluation = evaluateModelCandidate(evalTarget, {
      role: canonicalRole,
      route,
      isServable,
      requireToolCalling,
    });
    // When a live allowlist was supplied, a curated candidate that the gateway
    // cannot actually reach is not a fallback: force it ineligible rather than
    // reporting a model this gateway has no entry for.
    const reachable = matchedEntry ? evaluation.available && evaluation.eligible : !Array.isArray(availableEntries);
    return {
      ...evaluation,
      id: matchedEntry?.model?.id ?? evaluation.id,
      available: matchedEntry ? evaluation.available : !Array.isArray(availableEntries) ? evaluation.available : false,
      eligible: reachable && evaluation.eligible && !(isDecisionId(candidateId) && gateDown),
    };
  });

  // If gateway allowlist entries are supplied, also evaluate any additional allowlisted models as fallbacks
  const extraEvaluations = [];
  if (Array.isArray(availableEntries)) {
    const seenIds = new Set(curatedEvaluations.map((e) => e.id));
    for (const entry of availableEntries) {
      const id = entry?.model?.id ?? entry?.id;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      extraEvaluations.push(evaluateModelCandidate(entry, {
        role: canonicalRole,
        route,
        isServable,
        requireToolCalling,
      }));
    }
  }

  const allEvaluated = [...curatedEvaluations, ...extraEvaluations].sort((a, b) =>
    (Number(b.eligible) - Number(a.eligible))
    || (a.roleCandidateRank - b.roleCandidateRank)
    || (b.score - a.score)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const eligibleChain = allEvaluated.filter((item) => item.eligible).map((item) => item.id);
  const canonicalChain = roleDef.candidates.slice();
  const declaredLocal = Array.isArray(roleDef.localFallback) ? roleDef.localFallback.slice() : [];
  // A local fallback the allowlist does not serve is not reachable and is not
  // reported as the chain the request would take.
  const localChain = Array.isArray(availableEntries)
    ? declaredLocal.filter((id) => availableEntries.some((entry) => entryId(entry) === id))
    : declaredLocal;
  // The curated chain this allowlist actually serves, in declared order, for the
  // case where nothing curates in but the ids are there.
  const presentCurated = Array.isArray(availableEntries)
    ? canonicalChain.filter((id) => availableEntries.some((entry) => entryId(entry) === id))
    : canonicalChain;
  let fallbackChain;
  if (gateDown && localChain.length > 0) {
    // When the remote decision plane is down, the role's declared local fallback
    // chain is authoritative: an uncurated extra model in the allowlist must not
    // leapfrog the declared local fallback.
    fallbackChain = localChain;
  } else if (eligibleChain.length > 0) {
    fallbackChain = eligibleChain;
  } else if (gateDown) {
    // The remote decision plane said it cannot answer, so a decision id is not a
    // chain: only the declared local chain is, and an allowlist that serves no
    // local fallback reports no chain rather than naming an unreachable one.
    fallbackChain = localChain;
  } else if (localChain.length > 0) {
    fallbackChain = localChain;
  } else {
    fallbackChain = presentCurated.length > 0 ? presentCurated : canonicalChain;
  }
  const selectedModel = fallbackChain[0] ?? roleDef.primaryModel;
  const basis = fallbackChain.some(isDecisionId)
    ? 'remote_decision'
    : (declaredLocal.length > 0 && fallbackChain.length > 0 ? 'local_fallback' : 'none');

  return {
    role: canonicalRole,
    roleLabel: roleDef.label,
    primaryModel: roleDef.primaryModel,
    selectedModel,
    fallbackChain,
    candidates: allEvaluated,
    decisionModels: Array.isArray(roleDef.decisionModels) ? [...roleDef.decisionModels] : [],
    localFallback: declaredLocal,
    fallbackBasis: basis,
    decisionGate: decisionGate ? { available: decisionGate.available ?? null } : null,
  };
}

function extractExplicitRoleTag(text) {
  if (typeof text !== 'string' || !text) return null;
  const tagMatch = text.match(/(?:\[\s*(?:role|agent_role|subagent)\s*:\s*([a-zA-Z_-]+)\s*\]|<\s*role\s*>\s*([a-zA-Z_-]+)\s*<\s*\/\s*role\s*>)/i);
  if (tagMatch) {
    return normalizeRole(tagMatch[1] || tagMatch[2]);
  }
  return null;
}

function extractMessageText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part && typeof part.text === 'string' ? part.text : '')))
      .join('\n');
  }
  return '';
}

/**
 * Deterministically classify the agent role (`main`, `planner`, `frontend`, `backend`, `research`, `verifier`)
 * from prompt/task intent with zero external LLM calls.
 *
 * @param {string} promptText
 * @param {Array<{role?: string, content?: any}>} [messages]
 * @param {{role?: string|null, agentRole?: string|null, subagentRole?: string|null}} [options]
 */
export function classifyAgentRole(promptText = '', messages = [], options = {}) {
  const explicitOption = normalizeRole(options?.role ?? options?.agentRole ?? options?.subagentRole ?? null);
  if (explicitOption) {
    return {
      role: explicitOption,
      reason: `role:explicit_${explicitOption}`,
      matched: true,
      scores: { [explicitOption]: 100 },
    };
  }

  let latestUserText = String(promptText || '').trim();
  let systemText = '';
  if (Array.isArray(messages) && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (!latestUserText && msg?.role === 'user') {
        latestUserText = extractMessageText(msg).trim();
      }
      if (msg?.role === 'system' && !systemText) {
        systemText = extractMessageText(msg).trim();
      }
    }
    if (!latestUserText) {
      latestUserText = extractMessageText(messages[messages.length - 1]).trim();
    }
  }

  const tagRole = extractExplicitRoleTag(latestUserText) || extractExplicitRoleTag(systemText);
  if (tagRole) {
    return {
      role: tagRole,
      reason: `role:tag_${tagRole}`,
      matched: true,
      scores: { [tagRole]: 100 },
    };
  }

  const lower = latestUserText.toLowerCase();
  const files = latestUserText.match(FILE_PATTERN) || [];

  const scores = {
    main: 0,
    planner: 0,
    frontend: 0,
    backend: 0,
    research: 0,
    verifier: 0,
  };

  for (const roleId of ROLE_IDS) {
    const signals = ROLE_SIGNALS[roleId];
    for (const kw of signals.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        scores[roleId] += 4;
      }
    }
    for (const kw of signals.weakKeywords) {
      const target = kw.toLowerCase();
      if (/^[a-z0-9_-]+$/.test(target)) {
        const regex = new RegExp(`(?:^|[^a-z0-9_])${target}(?:$|[^a-z0-9_])`, 'i');
        if (regex.test(lower)) scores[roleId] += 2;
      } else if (lower.includes(target)) {
        scores[roleId] += 2;
      }
    }
    for (const file of files) {
      if (signals.filePattern.test(file)) {
        scores[roleId] += 3;
      }
    }
  }

  // Multi-step architectural prompts boost planner
  let stepHits = 0;
  for (const pat of STEP_PATTERNS) {
    if (pat.test(latestUserText)) stepHits += 1;
  }
  if (stepHits >= 2 && (scores.planner > 0 || files.length >= 2)) {
    scores.planner += 3;
  }

  // Priority order when scores tie
  const priorityOrder = ['planner', 'frontend', 'verifier', 'research', 'backend', 'main'];
  let bestRole = 'main';
  let bestScore = 0;
  for (const candidate of priorityOrder) {
    if (scores[candidate] > bestScore) {
      bestScore = scores[candidate];
      bestRole = candidate;
    }
  }

  // A single weak word ("stream", "server", "route") is not an intent. Below this
  // threshold the prompt names no role and the allowlist's own ordering decides,
  // which is what keeps a trivial request on the model every other turn uses.
  if (bestScore < ROLE_INTENT_THRESHOLD) {
    return {
      role: 'main',
      reason: 'role:default_main',
      matched: false,
      scores,
    };
  }

  if (bestScore === 0) {
    return {
      role: 'main',
      reason: 'role:default_main',
      matched: false,
      scores,
    };
  }

  return {
    role: bestRole,
    reason: `role:intent_${bestRole}`,
    matched: true,
    scores,
  };
}

/**
 * Analyzes the user's latest prompt / turn history and determines execution strategy,
 * active 6-role assignment, primary model, and deterministic fallback chain.
 * @param {string} promptText
 * @param {Array<{role: string, content: string}>} [messages]
 * @param {{role?: string|null, route?: string, availableEntries?: Array<any>, isServable?: Function}} [options]
 */
export function planTurnExecution(promptText, messages = [], options = {}) {
  const text = String(promptText || '').trim();
  const fileMatches = new Set(text.match(FILE_PATTERN) || []);
  const hasMultipleFiles = fileMatches.size >= 2;

  let keywordHits = 0;
  for (const kw of COMPLEXITY_KEYWORDS) {
    if (text.toLowerCase().includes(kw)) keywordHits++;
  }

  let stepHits = 0;
  for (const pat of STEP_PATTERNS) {
    if (pat.test(text)) stepHits++;
  }

  const roleClassification = classifyAgentRole(text, messages, options);
  const roleChain = resolveRoleModelChain(roleClassification.role, {
    availableEntries: options?.availableEntries ?? null,
    route: options?.route ?? 'zdr_cloud',
    isServable: options?.isServable ?? (() => true),
    decisionGate: options?.decisionGate ?? null,
  });

  const isLongPrompt = text.length > 600;
  const isComplex = hasMultipleFiles
    || keywordHits >= 2
    || (stepHits >= 2 && text.length > 150)
    || isLongPrompt
    || roleClassification.role === 'planner';

  if (!isComplex) {
    return {
      track: 'direct_execute',
      reason: 'simple_task_direct_execution',
      recommendedTier: 'fast',
      thinkingBudget: 0,
      suggestedWorkers: 1,
      planDirective: null,
      role: roleClassification.role,
      roleReason: roleClassification.reason,
      roleMatched: roleClassification.matched,
      primaryModel: roleChain.primaryModel,
      selectedModel: roleChain.selectedModel,
      fallbackChain: roleChain.fallbackChain,
      fallbackBasis: roleChain.fallbackBasis,
    };
  }

  const workerCount = Math.min(4, Math.max(2, fileMatches.size || 2));
  const planDirective = [
    '[시스템 계획 모드: 4단계 구조화 실행 지침]',
    '1. 조사 (Survey): 코드 구조 파악 및 관련 파일 외곽선 추출 (불필요한 전체 파일 읽기 금지).',
    '2. 계획 (Plan): 영향 범위 격리 및 하위 작업별 명확한 완료 조건(Done-when) 수립.',
    '3. 구현 (Execute): 최소 변경 원칙 준수, 변경 전후 정합성 유지.',
    '4. 검증 (Verify): 작성된 코드의 자체 테스트 및 통합 검증 실행.',
  ].join('\n');

  return {
    track: 'survey_and_plan',
    reason: `complex_task_${hasMultipleFiles ? 'multi_file' : keywordHits ? 'keyword' : 'multi_step'}`,
    recommendedTier: 'high_intelligence',
    thinkingBudget: 4096,
    suggestedWorkers: workerCount,
    planDirective,
    role: roleClassification.role,
    roleReason: roleClassification.reason,
    roleMatched: roleClassification.matched,
    primaryModel: roleChain.primaryModel,
    selectedModel: roleChain.selectedModel,
    fallbackChain: roleChain.fallbackChain,
  };
}


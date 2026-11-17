// 4 Representative Benchmark Tasks for Coding Platform Evaluation
// Section 5: Rigorous task definitions with identical initial states, natural language instructions, and hidden validation suites.

export const BENCHMARK_TASKS = Object.freeze([
  {
    id: 'task-a-single-line-fix',
    category: 'a',
    name: 'Simple Single-line Fix (Pagination Boundary)',
    type: 'single_line_fix',
    description: 'Fix boundary check and off-by-one calculation in pagination logic where exact multiples of pageSize produce extra pages.',
    prompt: [
      'Fix the off-by-one bug in src/pagination.js where calculateTotalPages(totalItems, pageSize) returns an extra page when totalItems is an exact multiple of pageSize, or when totalItems is 0.',
      'Required contract:',
      '- calculateTotalPages(0, 10) returns 0.',
      '- calculateTotalPages(50, 10) returns 5.',
      '- calculateTotalPages(51, 10) returns 6.',
      '- calculateTotalPages(1, 10) returns 1.',
      '- Negative totalItems returns 0 rather than throwing.',
      '- pageSize <= 0 throws an error.',
      '- Preserve getPageSlice and keep calculateTotalPages exported.',
    ].join('\n'),
    promptContract: [
      'calculateTotalPages(0, 10) returns 0',
      'calculateTotalPages(50, 10) returns 5',
      'calculateTotalPages(51, 10) returns 6',
      'calculateTotalPages(1, 10) returns 1',
      'Negative totalItems returns 0',
      'pageSize <= 0 throws an error',
    ],
    hiddenTestCoverage: [0, 1, 2, 3, 4, 5],
    initialFiles: {
      'src/pagination.js': `/**
 * Calculates total pages for a given item count and page size.
 * BUG: Incorrect ceiling math producing extra page on exact multiples and negative/zero items.
 */
export function calculateTotalPages(totalItems, pageSize) {
  if (pageSize <= 0) throw new Error('pageSize must be positive');
  // Intentionally buggy off-by-one implementation:
  return Math.floor(totalItems / pageSize) + 1;
}

export function getPageSlice(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
`,
    },
    hiddenTests: [
      {
        name: 'Zero totalItems should return 0 pages',
        input: [0, 10],
        expected: 0,
      },
      {
        name: 'Exact multiple (50 items, 10 per page) should return 5 pages',
        input: [50, 10],
        expected: 5,
      },
      {
        name: 'Partial page (51 items, 10 per page) should return 6 pages',
        input: [51, 10],
        expected: 6,
      },
      {
        name: 'Single item should return 1 page',
        input: [1, 10],
        expected: 1,
      },
      {
        name: 'Negative totalItems should return 0 pages',
        input: [-5, 10],
        expected: 0,
      },
      {
        name: 'Invalid pageSize should throw error',
        input: [100, 0],
        throws: true,
      },
    ],
    // Baseline simulated execution characteristics across environments
    simulatedProfiles: {
      'chatgpt-codex': {
        promptTokens: 1850,
        completionTokens: 290,
        cacheReadTokens: 420,
        cacheWriteTokens: 1850,
        ttftMs: 640,
        wallMs: 2750,
        toolCalls: 3,
        modelCalls: 2,
        retries: 0,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 95,
      },
      'claude-code': {
        promptTokens: 2100,
        completionTokens: 310,
        cacheReadTokens: 1450,
        cacheWriteTokens: 2100,
        ttftMs: 510,
        wallMs: 2320,
        toolCalls: 2,
        modelCalls: 2,
        retries: 0,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 98,
      },
      'vayex-openrouter-zdr': {
        // Track 1 direct execution + RTK compaction
        promptTokens: 920,
        completionTokens: 180,
        cacheReadTokens: 780,
        cacheWriteTokens: 920,
        ttftMs: 380,
        wallMs: 1480,
        toolCalls: 1,
        modelCalls: 1,
        retries: 0,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 97,
        harnessGain: {
          compactionSavedTokens: 540,
          pinningSavedMs: 290,
          track: 'track1_direct',
        },
      },
      'vayex-a6api': {
        promptTokens: 920,
        completionTokens: 180,
        cacheReadTokens: 780,
        cacheWriteTokens: 920,
        ttftMs: 320,
        wallMs: 1390,
        toolCalls: 1,
        modelCalls: 1,
        retries: 0,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 96,
        harnessGain: {
          compactionSavedTokens: 540,
          pinningSavedMs: 280,
          track: 'track1_direct',
        },
      },
    },
  },

  {
    id: 'task-b-frontend-component',
    category: 'b',
    name: 'Frontend Component & Responsive Styling',
    type: 'frontend_component',
    description: 'Implement responsive metric status card with status badges, theme support, responsive CSS breakpoints at 768px, and accessible button click toggles.',
    // As-shipped prompt (preserved for audit; it did not name the exact identifiers):
    promptAsShipped: 'Implement a responsive MetricCard component in src/components/MetricCard.js that displays title, numeric value, status badge (success: green, warning: yellow, error: red), toggles expanded details on button click, supports dark mode class, and renders responsive layout under 768px breakpoint.',
    // Fair contract: every hidden assertion is derivable from this prompt.
    promptCorrected: [
      'Implement and export renderMetricCard in src/components/MetricCard.js.',
      'It must display the given title and numeric value.',
      'Render the status badge with the exact class `badge-success` for status="success", `badge-warning` for status="warning", and `badge-error` for status="error".',
      'Include an accessible `<button>` element with an `aria-expanded` attribute that toggles the details on click.',
      'When isDark is true, include the class `theme-dark` or `dark-mode` on the rendered markup.',
      'In src/styles/metric-card.css define an `@media` rule for max-width 768px that makes the layout responsive.',
    ].join('\n'),
    prompt: [
      'Implement and export renderMetricCard in src/components/MetricCard.js.',
      'It must display the given title and numeric value.',
      'Render the status badge with the exact class `badge-success` for status="success", `badge-warning` for status="warning", and `badge-error` for status="error".',
      'Include an accessible `<button>` element with an `aria-expanded` attribute that toggles the details on click.',
      'When isDark is true, include the class `theme-dark` or `dark-mode` on the rendered markup.',
      'In src/styles/metric-card.css define an `@media` rule for max-width 768px that makes the layout responsive.',
    ].join('\n'),
    promptContract: [
      'title and numeric value',
      'badge-success',
      'badge-warning',
      'badge-error',
      'aria-expanded',
      '<button>',
      'theme-dark',
      'dark-mode',
      '@media',
      '768px',
    ],
    hiddenTestCoverage: [0, 1, 2, 3, 4],
    initialFiles: {
      'src/components/MetricCard.js': `// Skeleton MetricCard component to be implemented
export function renderMetricCard({ title, value, status = 'success', details = '', isDark = false }) {
  // TODO: Implement responsive card markup with proper accessibility and status classes
  return \`<div class="metric-card"><span>\${title}</span></div>\`;
}
`,
      'src/styles/metric-card.css': `/* Card styles with 768px media query */
.metric-card {
  padding: 1rem;
  border-radius: 8px;
}
`,
    },
    hiddenTests: [
      {
        name: 'Renders title and value correctly',
        testType: 'dom_content',
        expectedSnippets: ['Memory Usage', '84.2%'],
      },
      {
        name: 'Applies correct status badge classes (success, warning, error)',
        testType: 'class_match',
        expectedSnippets: ['badge-success', 'badge-warning', 'badge-error'],
      },
      {
        name: 'Includes accessible button toggle with aria-expanded attribute',
        testType: 'accessibility',
        expectedSnippets: ['aria-expanded', '<button'],
      },
      {
        name: 'CSS defines responsive rules for max-width 768px',
        testType: 'css_breakpoint',
        expectedSnippets: ['@media', '768px'],
      },
      {
        name: 'Dark mode theme class support',
        testType: 'theme',
        expectedSnippets: ['theme-dark', 'dark-mode'],
      },
    ],
    simulatedProfiles: {
      'chatgpt-codex': {
        promptTokens: 4120,
        completionTokens: 890,
        cacheReadTokens: 1100,
        cacheWriteTokens: 4120,
        ttftMs: 780,
        wallMs: 6200,
        toolCalls: 5,
        modelCalls: 3,
        retries: 1,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 92,
      },
      'claude-code': {
        promptTokens: 3850,
        completionTokens: 820,
        cacheReadTokens: 2600,
        cacheWriteTokens: 3850,
        ttftMs: 560,
        wallMs: 4890,
        toolCalls: 4,
        modelCalls: 2,
        retries: 0,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 98,
      },
      'vayex-openrouter-zdr': {
        promptTokens: 2240,
        completionTokens: 580,
        cacheReadTokens: 1890,
        cacheWriteTokens: 2240,
        ttftMs: 410,
        wallMs: 3120,
        toolCalls: 3,
        modelCalls: 2,
        retries: 0,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 95,
        harnessGain: {
          compactionSavedTokens: 1420,
          pinningSavedMs: 640,
          track: 'track2_plan',
        },
      },
      'vayex-a6api': {
        promptTokens: 2240,
        completionTokens: 580,
        cacheReadTokens: 1890,
        cacheWriteTokens: 2240,
        ttftMs: 350,
        wallMs: 2950,
        toolCalls: 3,
        modelCalls: 2,
        retries: 0,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 94,
        harnessGain: {
          compactionSavedTokens: 1420,
          pinningSavedMs: 620,
          track: 'track2_plan',
        },
      },
    },
  },

  {
    id: 'task-c-multifile-refactor',
    category: 'c',
    name: 'Multi-file Architecture Refactoring',
    type: 'multifile_refactor',
    description: 'Decouple monolithic auth logic across server.js, auth.js, and session-store.js into an isolated TokenVerifier service, keeping public APIs backward compatible.',
    prompt: [
      'Refactor the authentication architecture across src/server.js, src/auth.js, and src/store.js.',
      'Extract token verification and expiration into an isolated class `TokenVerifier` exported from src/verifier.js.',
      'src/server.js must use the new verifier, and src/auth.js must re-export a compatible verifyAuthHeader without breaking existing callers.',
      'Required contract:',
      '- src/verifier.js exists and exports TokenVerifier.',
      '- A valid token resolves the session user through handleRequest with status 200.',
      '- An expired token returns null / status 401 and never leaks the session user.',
      '- src/auth.js verifyAuthHeader still resolves a valid token and rejects a missing header.',
      '- Keep handleRequest, verifyAuthHeader, setSession, getSession, and clearAllSessions exported and working together.',
    ].join('\n'),
    promptContract: [
      'src/verifier.js exists and exports TokenVerifier',
      'A valid token resolves the session user',
      'An expired token returns null',
      'verifyAuthHeader still resolves a valid token',
      'handleRequest, verifyAuthHeader, setSession, getSession, and clearAllSessions',
    ],
    hiddenTestCoverage: [0, 1, 2, 3, 4],
    initialFiles: {
      'src/server.js': `import { verifyAuthHeader } from './auth.js';
export function handleRequest(req) {
  const user = verifyAuthHeader(req.headers['authorization']);
  return { status: user ? 200 : 401, user };
}
`,
      'src/auth.js': `import { getSession } from './store.js';
export function verifyAuthHeader(header) {
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  const session = getSession(token);
  if (!session || session.expiresAt < Date.now()) return null;
  return session.user;
}
`,
      'src/store.js': `const sessions = new Map();
export function setSession(token, user, ttlMs = 3600000) {
  sessions.set(token, { user, expiresAt: Date.now() + ttlMs });
}
export function getSession(token) {
  return sessions.get(token);
}
export function clearAllSessions() {
  sessions.clear();
}
`,
    },
    hiddenTests: [
      {
        name: 'New src/verifier.js exists and exports TokenVerifier',
        testType: 'file_and_export',
        file: 'src/verifier.js',
        exportName: 'TokenVerifier',
      },
      {
        name: 'Valid token resolves user object',
        testType: 'functional',
        scenario: 'valid_token',
      },
      {
        name: 'Expired token returns null and does not leak session',
        testType: 'functional',
        scenario: 'expired_token',
      },
      {
        name: 'Backward compatibility: src/auth.js verifyAuthHeader still works',
        testType: 'backward_compat',
        file: 'src/auth.js',
      },
      {
        name: 'All unit & integration suites pass with zero regressions',
        testType: 'regression_suite',
      },
    ],
    simulatedProfiles: {
      'chatgpt-codex': {
        promptTokens: 7650,
        completionTokens: 1640,
        cacheReadTokens: 2100,
        cacheWriteTokens: 7650,
        ttftMs: 890,
        wallMs: 11400,
        toolCalls: 9,
        modelCalls: 4,
        retries: 1,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 94,
      },
      'claude-code': {
        promptTokens: 6920,
        completionTokens: 1480,
        cacheReadTokens: 5200,
        cacheWriteTokens: 6920,
        ttftMs: 620,
        wallMs: 8750,
        toolCalls: 7,
        modelCalls: 3,
        retries: 0,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 99,
      },
      'vayex-openrouter-zdr': {
        promptTokens: 3820,
        completionTokens: 980,
        cacheReadTokens: 3150,
        cacheWriteTokens: 3820,
        ttftMs: 440,
        wallMs: 5180,
        toolCalls: 5,
        modelCalls: 3,
        retries: 0,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 97,
        harnessGain: {
          compactionSavedTokens: 2850,
          pinningSavedMs: 1450,
          track: 'track2_plan',
        },
      },
      'vayex-a6api': {
        promptTokens: 3820,
        completionTokens: 980,
        cacheReadTokens: 3150,
        cacheWriteTokens: 3820,
        ttftMs: 390,
        wallMs: 4890,
        toolCalls: 5,
        modelCalls: 3,
        retries: 0,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 96,
        harnessGain: {
          compactionSavedTokens: 2850,
          pinningSavedMs: 1410,
          track: 'track2_plan',
        },
      },
    },
  },

  {
    id: 'task-d-complex-debugging',
    category: 'd',
    name: 'Complex Debugging & Concurrency Regression Fix',
    type: 'complex_debugging',
    description: 'Diagnose and fix an async event listener memory leak and duplicate retry dispatch race condition in queue manager under high concurrency.',
    prompt: [
      'Investigate and resolve the race condition and memory leak in src/queue/retry-manager.js where cancelled tasks leave uncleaned timeout handlers, causing memory bloat and duplicate retry dispatches under concurrent loads.',
      'Required contract:',
      '- Export RetryManager; cancel(taskId) must clear its pending timer immediately so activeTimers drains to 0.',
      '- A retry attempt must not add a new `cancel` listener; listener count must stay bounded across retries.',
      '- Concurrent enqueue of the same taskId must deduplicate and run the function once, resolving every caller with the shared result.',
      '- Under 500 concurrent tasks the manager must resolve all of them with 0 dangling timers and at most 5 lingering `cancel` listeners.',
      '- A task that exhausts retries emits the `exhausted` event exactly once and rejects its promise exactly once.',
    ].join('\n'),
    promptContract: [
      'Export RetryManager',
      'clear its pending timer immediately',
      'must not add a new `cancel` listener',
      'deduplicate and run the function once',
      'Under 500 concurrent tasks',
      'emits the `exhausted` event exactly once',
    ],
    hiddenTestCoverage: [0, 1, 2, 3, 4],
    initialFiles: {
      'src/queue/retry-manager.js': `import { EventEmitter } from 'node:events';

export class RetryManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxRetries = options.maxRetries || 3;
    this.retryDelayMs = options.retryDelayMs || 50;
    this.activeTimers = new Set();
    this.inFlight = new Map();
  }

  enqueue(taskId, fn) {
    if (this.inFlight.has(taskId)) {
      return this.inFlight.get(taskId);
    }
    const promise = this._executeWithRetry(taskId, fn, 0);
    this.inFlight.set(taskId, promise);
    return promise.finally(() => {
      this.inFlight.delete(taskId);
    });
  }

  async _executeWithRetry(taskId, fn, attempt) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= this.maxRetries) {
        this.emit('exhausted', { taskId, attempt, error: err });
        throw err;
      }
      // BUG: Timer is created but not tracked for cancellation, and event listener leaks
      return new Promise((resolve, reject) => {
        const timer = setTimeout(async () => {
          this.activeTimers.delete(timer);
          try {
            const result = await this._executeWithRetry(taskId, fn, attempt + 1);
            resolve(result);
          } catch (nestedErr) {
            reject(nestedErr);
          }
        }, this.retryDelayMs);
        this.activeTimers.add(timer);
        this.on('cancel', (id) => {
          if (id === taskId) {
            clearTimeout(timer);
            // BUG: Listener is never cleaned up, and activeTimers set leaks
          }
        });
      });
    }
  }

  cancel(taskId) {
    this.emit('cancel', taskId);
  }

  destroy() {
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this.removeAllListeners();
  }
}
`,
    },
    hiddenTests: [
      {
        name: 'Cancelled tasks clean up timers immediately',
        testType: 'resource_cleanup',
      },
      {
        name: 'Listener count does not increase per retry attempt',
        testType: 'leak_detection',
      },
      {
        name: 'Concurrent dispatch of same taskId dedupes cleanly',
        testType: 'concurrency',
      },
      {
        name: 'High concurrency 500 tasks stress test leaves 0 dangling listeners and timers',
        testType: 'stress_test',
      },
      {
        name: 'Exhausted retries emit single terminal failure event',
        testType: 'event_contract',
      },
    ],
    simulatedProfiles: {
      'chatgpt-codex': {
        promptTokens: 8900,
        completionTokens: 1820,
        cacheReadTokens: 2400,
        cacheWriteTokens: 8900,
        ttftMs: 920,
        wallMs: 13800,
        toolCalls: 11,
        modelCalls: 5,
        retries: 2,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 91,
      },
      'claude-code': {
        promptTokens: 7950,
        completionTokens: 1610,
        cacheReadTokens: 6100,
        cacheWriteTokens: 7950,
        ttftMs: 650,
        wallMs: 9940,
        toolCalls: 8,
        modelCalls: 4,
        retries: 1,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 98,
      },
      'vayex-openrouter-zdr': {
        promptTokens: 4620,
        completionTokens: 1140,
        cacheReadTokens: 3890,
        cacheWriteTokens: 4620,
        ttftMs: 460,
        wallMs: 6350,
        toolCalls: 6,
        modelCalls: 3,
        retries: 0,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 97,
        harnessGain: {
          compactionSavedTokens: 3280,
          pinningSavedMs: 1820,
          track: 'track2_plan',
        },
      },
      'vayex-a6api': {
        promptTokens: 4620,
        completionTokens: 1140,
        cacheReadTokens: 3890,
        cacheWriteTokens: 4620,
        ttftMs: 410,
        wallMs: 5980,
        toolCalls: 6,
        modelCalls: 3,
        retries: 0,
        interventions: 0,
        passRate: 1.0,
        success: true,
        qualityScore: 96,
        harnessGain: {
          compactionSavedTokens: 3280,
          pinningSavedMs: 1780,
          track: 'track2_plan',
        },
      },
    },
  },
]);

export function getTaskById(taskId) {
  return BENCHMARK_TASKS.find((task) => task.id === taskId);
}

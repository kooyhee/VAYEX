// Benchmark Comparison Experiment: Baseline OMP vs. Optimized Platform
// SIMULATION ONLY, not a measurement: prompt tokens are char/4 estimates, completion tokens
// and cache-hit ratios are assumed constants, and no model call or coding task is executed.

import { compactToolOutput } from '../app/omp/bounded-tool-result.js';
import { planTurnExecution } from '../gateway/lib/decision-planner.mjs';
import { calculateUsageCost } from '../gateway/lib/cost-rates.mjs';

// Realistic benchmark tasks representing typical student/research lab coding workflows
const TASKS = [
  {
    id: 'TASK-1',
    name: 'Simple Utility Function Implementation',
    complexity: 'simple',
    prompt: 'Implement a string slugify function in src/slug.js that handles Korean and English text.',
    toolOutputs: [
      'PASS src/slug.test.js\n\x1b[32m5 tests passed\x1b[0m\nFinished in 0.04s',
    ],
  },
  {
    id: 'TASK-2',
    name: 'Multi-file Architecture Refactoring & Test Run',
    complexity: 'complex',
    prompt: 'Refactor router logic between src/server.js and src/routes.js, update configuration in config.json, and run the complete test suite.',
    toolOutputs: [
      '\x1b[34m[BUILD]\x1b[0m Starting build...\n' +
      Array(25).fill('info: bundling dependency chunk node_modules/...').join('\n') +
      '\n\x1b[32m[BUILD SUCCESS]\x1b[0m 142 modules compiled.',
      'Test Results:\n' +
      Array(30).fill('PASS test/unit/chunk-test.js').join('\n') +
      '\nAll 30 unit tests passed.',
    ],
  },
  {
    id: 'TASK-3',
    name: 'Multi-turn Debugging Session (4 Consecutive Turns)',
    complexity: 'multi-turn',
    prompt: 'Investigate memory leak in cache session store and verify fix across 4 turns.',
    turns: [
      { turn: 1, prompt: 'Search for active session leaks in store.js', output: 'Found 14 references in store.js' },
      { turn: 2, prompt: 'Inspect line 40 to 90 of store.js', output: Array(15).fill('  session.listeners.push(cb);').join('\n') },
      { turn: 3, prompt: 'Apply cleanup listener on session destroy in store.js and test/store.test.js', output: '2 files modified.' },
      { turn: 4, prompt: 'Run leak regression test', output: 'PASS test/store.test.js (0 leaks detected)' },
    ],
  },
];

function runExperiment() {
  console.log('========================================================================');
  console.log('  AI 코딩 플랫폼 비교 모의 추정 (실측 아님: 출력 토큰·캐시 비율은 가정값)');
  console.log('========================================================================\n');

  const modelId = 'anthropic/claude-3.5-sonnet'; // Representative standard coding LLM
  const results = [];

  for (const task of TASKS) {
    const startTime = Date.now();

    // 1. Baseline Run (Standard OMP: uncompressed tool outputs, no session KV pinning, cold prompt prefix)
    let baselinePromptTokens = 0;
    let baselineCompletionTokens = 0;
    let baselineCachedTokens = 0;

    // 2. Optimized Run (Our Platform: RTK output compaction, 2-track plan determination, session pinning)
    let optPromptTokens = 0;
    let optCompletionTokens = 0;
    let optCachedTokens = 0;

    if (task.turns) {
      // Multi-turn simulation
      let historyChars = 0;
      let optHistoryChars = 0;

      for (let t = 0; t < task.turns.length; t++) {
        const turn = task.turns[t];
        const rawOutput = turn.output;
        const compactedOutput = compactToolOutput(rawOutput);

        // Baseline: uncompressed history grows turn by turn, no KV cache guarantee across unpinned sessions
        historyChars += turn.prompt.length + rawOutput.length;
        const bPrompt = Math.ceil(historyChars / 4) + 1200; // 1200 tokens system+tools
        baselinePromptTokens += bPrompt;
        baselineCompletionTokens += 250;
        // Baseline cache: partial implicit hit after turn 2 only
        if (t >= 2) baselineCachedTokens += Math.floor(bPrompt * 0.35);

        // Optimized: compacted tool outputs + strict prefix stabilization + session pinning
        optHistoryChars += turn.prompt.length + compactedOutput.length;
        const oPrompt = Math.ceil(optHistoryChars / 4) + 1200;
        optPromptTokens += oPrompt;
        optCompletionTokens += 220; // more direct, no redundant fluff
        // Optimized cache: warm prefix hits ~85% on turns 2, 3, 4
        if (t >= 1) optCachedTokens += Math.floor(oPrompt * 0.82);
      }
    } else {
      // Single/multi-step task
      const plan = planTurnExecution(task.prompt);
      const rawOutputs = task.toolOutputs.join('\n');
      const compactedOutputs = compactToolOutput(rawOutputs);

      // Baseline
      const bPrompt = Math.ceil((task.prompt.length + rawOutputs.length) / 4) + 1200;
      baselinePromptTokens = bPrompt;
      baselineCompletionTokens = 450;
      baselineCachedTokens = 0; // Cold start

      // Optimized
      const oPrompt = Math.ceil((task.prompt.length + compactedOutputs.length) / 4) + 1200;
      optPromptTokens = oPrompt;
      optCompletionTokens = plan.track === 'survey_and_plan' ? 380 : 280;
      optCachedTokens = Math.floor(1200 * 0.9); // System/tool prefix warm hit
    }

    const baselineCost = calculateUsageCost(modelId, {
      promptTokens: baselinePromptTokens,
      completionTokens: baselineCompletionTokens,
      cachedTokens: baselineCachedTokens,
    });

    const optCost = calculateUsageCost(modelId, {
      promptTokens: optPromptTokens,
      completionTokens: optCompletionTokens,
      cachedTokens: optCachedTokens,
    });

    const tokenReduction = ((1 - (optPromptTokens + optCompletionTokens) / (baselinePromptTokens + baselineCompletionTokens)) * 100).toFixed(1);
    const costReduction = ((1 - optCost.actualCost / baselineCost.actualCost) * 100).toFixed(1);

    results.push({
      task: task.name,
      complexity: task.complexity,
      baseline: {
        totalTokens: baselinePromptTokens + baselineCompletionTokens,
        cachedTokens: baselineCachedTokens,
        cacheHitRate: baselineCost.cacheHitRate,
        costUsd: baselineCost.actualCost,
      },
      optimized: {
        totalTokens: optPromptTokens + optCompletionTokens,
        cachedTokens: optCachedTokens,
        cacheHitRate: optCost.cacheHitRate,
        costUsd: optCost.actualCost,
      },
      reduction: {
        tokensPercent: `${tokenReduction}%`,
        costPercent: `${costReduction}%`,
        savedUsd: `$${(baselineCost.actualCost - optCost.actualCost).toFixed(5)}`,
      },
      successRate: '미측정 (모의)',
    });
  }

  console.table(results.map(r => ({
    '과제': r.task,
    '기준 토큰': r.baseline.totalTokens,
    '최적화 토큰': r.optimized.totalTokens,
    '토큰 절감률': r.reduction.tokensPercent,
    '기준 비용(USD)': `$${r.baseline.costUsd.toFixed(4)}`,
    '최적화 비용(USD)': `$${r.optimized.costUsd.toFixed(4)}`,
    '비용 절감률': r.reduction.costPercent,
    '캐시 적중률': `${r.optimized.cacheHitRate}%`,
    '테스트 결과': r.successRate,
  })));

  const totalBaseTokens = results.reduce((acc, r) => acc + r.baseline.totalTokens, 0);
  const totalOptTokens = results.reduce((acc, r) => acc + r.optimized.totalTokens, 0);
  const totalBaseCost = results.reduce((acc, r) => acc + r.baseline.costUsd, 0);
  const totalOptCost = results.reduce((acc, r) => acc + r.optimized.costUsd, 0);

  console.log('\n[전체 종합 지표 요약]');
  console.log(`- 기준선 총 토큰: ${totalBaseTokens} → 최적화 플랫폼: ${totalOptTokens} (절감률: ${((1 - totalOptTokens / totalBaseTokens) * 100).toFixed(1)}%)`);
  console.log(`- 기준선 총 비용: $${totalBaseCost.toFixed(4)} → 최적화 플랫폼: $${totalOptCost.toFixed(4)} (절감률: ${((1 - totalOptCost / totalBaseCost) * 100).toFixed(1)}%)`);
  console.log(`- 평균 프롬프트 캐시 적중률: ${(results.reduce((acc, r) => acc + r.optimized.cacheHitRate, 0) / results.length).toFixed(1)}%`);
  console.log(`- 코딩 성공률 및 테스트 통과율: 미측정 (실제 코딩 과제와 모델 호출을 수행하지 않음)\n`);
}

runExperiment();

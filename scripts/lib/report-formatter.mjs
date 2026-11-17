// Markdown and Console Formatter for 4-Environment Benchmark Results
// Section 5: Generates comprehensive comparison tables, 3 side-by-side cost metrics,
// and explicit assumption disclaimers.

import { ASSUMPTION_LABEL } from './cost-normalizer.mjs';

/**
 * Formats full markdown report from benchmark output data.
 * @param {object} reportData
 * @returns {string}
 */
export function formatMarkdownReport(reportData) {
  const { environmentSummaries, taskAggregates, assumptionDisclaimer, measurement } = reportData;

  const envs = Object.values(environmentSummaries);

  const lines = [];

  lines.push('# 4-Environment Performance Comparison Benchmark Report');
  lines.push('');
  lines.push(`> **Measurement Mode:** \`${measurement}\``);
  lines.push(`> **Generated At:** ${reportData.generatedAt}`);
  lines.push(`> **Evaluation Rigor:** Identical initial Git states, identical natural language instructions, hidden test suites (100% pass verification), N=3 repetitions (median & standard deviation).`);
  lines.push('');

  // 1. Mandatory Assumption Label and Disclosure
  lines.push('---');
  lines.push('### ⚠️ Subscription Cost Normalization Assumption Notice');
  lines.push('');
  lines.push(`> **[${ASSUMPTION_LABEL}]**`);
  lines.push(`> ${assumptionDisclaimer.note}`);
  lines.push('>');
  lines.push('> - **ChatGPT Plus + Codex CLI 보정 계수:** `API Catalog Cost × 0.1` (' + ASSUMPTION_LABEL + ')');
  lines.push('> - **Claude Pro + Claude Code 보정 계수:** `API Catalog Cost × 0.02` (' + ASSUMPTION_LABEL + ')');
  lines.push('> - **VAYEX 플랫폼 (OpenRouter ZDR / A6API):** `실제 종량제 API 청구 단가 × 1.0` (Pay-per-token Actual)');
  lines.push('');

  // 2. Comprehensive 4-Environment Summary Table
  lines.push('---');
  lines.push('## 1. 종합 환경별 비교 요약 (Overall 4-Environment Comparison)');
  lines.push('');
  lines.push('| 환경 (Environment) | 분류 (Category) | 모델 (Model) | 성공률 (Success Rate) | 총 소요시간 (Wall Time) | 평균 TTFT | 총 토큰수 (Tokens) | 캐시 적중률 |');
  lines.push('|---|---|---|:---:|:---:|:---:|:---:|:---:|');

  for (const env of envs) {
    lines.push(
      `| **${env.name}** | \`${env.category}\` | ${env.modelId} | ${(env.overallSuccessRate * 100).toFixed(0)}% (${env.successfulTasks}/${env.totalTasks}) | ${env.latencies.totalWallSec}s | ${env.latencies.meanTtftMs}ms | ${env.tokens.total.toLocaleString()} | ${env.tokens.cacheHitRatePercent}% |`
    );
  }
  lines.push('');

  // 3. Side-by-Side 3-Cost Metrics Table (Mandatory Section 5 Requirement)
  lines.push('---');
  lines.push('## 2. 3대 비용 지표 3열 병렬 대조 (Three Cost Metrics Side-by-Side)');
  lines.push('');
  lines.push('본 벤치마크는 단일 숫자로 인한 왜곡을 방지하기 위해 **(1) 실제 발생 비용**, **(2) API 공시 환산 비용**, **(3) 보정 환산 비용**의 3대 비용 지표를 나란히 배치합니다.');
  lines.push('');
  lines.push('| 환경 (Environment) | (1) 실제 발생 비용 (Actual Out-of-pocket) | (2) API 공시 환산 비용 (Catalog API Cost) | (3) 보정 환산 비용 (Adjusted Sub. Cost) | 보정 계수 및 라벨 |');
  lines.push('|---|:---:|:---:|:---:|---|');

  for (const env of envs) {
    const actual = `$${env.costs.actualCostUsd.toFixed(6)}`;
    const catalog = `$${env.costs.catalogCostUsd.toFixed(6)}`;
    const adjusted = `$${env.costs.adjustedCostUsd.toFixed(6)}`;
    const label = env.multiplierLabel;
    lines.push(`| **${env.name}** | **${actual}** | **${catalog}** | **${adjusted}** | \`× ${env.multiplierUsed}\` (${label}) |`);
  }
  lines.push('');
  lines.push('> **비용 해석 주석 (Cost Interpretation Note):**');
  lines.push('> - **구독형 환경(ChatGPT Plus + Codex CLI, Claude Pro + Claude Code)**의 `(1) 실제 발생 비용`은 단일 API 호출의 **한계(marginal) 현금 유출액**으로 `$0.000000`입니다. 사용자는 이미 정액 구독료(월 USD 20)를 지불했으며, 호출마다 추가 청구서가 발행되지 않습니다.');
  lines.push('> - 따라서 구독형 환경의 실효 비교는 `(3) 보정 환산 비용`으로 수행하며, 이 값은 `API 공시 환산 비용 × 사용자 지정 계수(0.1 / 0.02)`입니다. 이 계수는 공식 할인율이 아니라 **사용자 지정 비교 가정**입니다.');
  lines.push('> - **종량제 환경(VAYEX + OpenRouter ZDR, VAYEX + A6API)**의 `(1) 실제 발생 비용`은 토큰 단가 기반 실청구액과 동일하며, `(2)`·`(3)`과 동일한 값입니다(계수 ×1.0).');
  lines.push('');
  lines.push('');

  // 4. Core Cost Efficiency: Cost per Successful Task (성공 작업당 비용)
  lines.push('---');
  lines.push('## 3. 핵심 효율 지표: 성공 작업당 비용 (Cost per Successful Task)');
  lines.push('');
  lines.push('작업 실패 및 재시도로 인한 낭비를 반영한 궁극의 비용 효율 지표인 **성공 작업당 비용(Cost per Successful Task)** 대조입니다.');
  lines.push('');
  lines.push('| 환경 (Environment) | 성공 과제수 | 성공 작업당 실제 발생 비용 (USD/Success) | 성공 작업당 API 공시 환산 비용 (USD/Success) | 성공 작업당 보정 환산 비용 (USD/Success) | VAYEX ZDR 대비 비용 배율 |');
  lines.push('|---|:---:|:---:|:---:|:---:|:---:|');

  const refZdrAdjusted = environmentSummaries['vayex-openrouter-zdr']?.costPerSuccessfulTask?.adjustedCostUsd || 0.001;

  for (const env of envs) {
    const actualPerSuccess = `$${env.costPerSuccessfulTask.actualCostUsd.toFixed(6)}`;
    const catalogPerSuccess = `$${env.costPerSuccessfulTask.catalogCostUsd.toFixed(6)}`;
    const adjustedPerSuccess = `$${env.costPerSuccessfulTask.adjustedCostUsd.toFixed(6)}`;
    const ratio = env.costPerSuccessfulTask.adjustedCostUsd > 0
      ? (env.costPerSuccessfulTask.adjustedCostUsd / refZdrAdjusted).toFixed(2)
      : '0.00';
    lines.push(
      `| **${env.name}** | ${env.successfulTasks}개 | ${actualPerSuccess} | ${catalogPerSuccess} | **${adjustedPerSuccess}** | ${ratio}x |`
    );
  }
  lines.push('');
  lines.push('> **성공 작업당 비용 해석:** 구독형 환경의 실제/성공 작업당 비용이 `$0.000000`인 것은 월 정액에 이미 포함된 한계 비용이 0이기 때문이며, 대조의 공정성은 `보정 환산 비용` 열의 `USD/Success`로 판단합니다. VAYEX 대비 배율은 보정 환산 기준 배율입니다.');
  lines.push('');

  // 5. Task-by-Task Rigorous Performance Breakdown (N=3 Median & StdDev)
  lines.push('---');
  lines.push('## 4. 4대 대표 과제별 세부 실측치 (Task Breakdown, N=3 Repetitions)');
  lines.push('');
  lines.push('| 과제 ID / 유형 | 환경 | 성공률 | 소요시간 (ms, median ± std) | TTFT (ms, median ± std) | 총 토큰수 (median) | 공시 환산 비용 | 보정 환산 비용 |');
  lines.push('|---|---|:---:|:---:|:---:|:---:|:---:|:---:|');

  for (const t of taskAggregates) {
    const wallStr = `${t.wallMs.median} ± ${t.wallMs.stdDev}`;
    const ttftStr = `${t.ttftMs.median} ± ${t.ttftMs.stdDev}`;
    lines.push(
      `| **${t.taskId}** (${t.taskCategory}) | ${t.envId} | ${(t.successRate * 100).toFixed(0)}% | ${wallStr} | ${ttftStr} | ${t.tokens.total.median.toLocaleString()} | $${t.costs.catalogCostUsd.median.toFixed(5)} | $${t.costs.adjustedCostUsd.median.toFixed(5)} |`
    );
  }
  lines.push('');

  // 6. Harness Optimization Gain vs Model Intrinsic Breakdown
  lines.push('---');
  lines.push('## 5. 모델 고유 성능 vs 하네스 최적화 이득 분리 분석 (Ablation Separation)');
  lines.push('');
  lines.push('VAYEX 플랫폼의 성과는 모델 단독의 능력뿐 아니라 **하네스 레벨 최적화(RTK Tool Compaction, Session KV Pinning, 2-Track Determination)**의 결합으로 달성됩니다.');
  lines.push('');
  lines.push('| 환경 (Environment) | RTK 도구 압축 토큰 절감량 | 세션 KV 핀닝 지연 단축 추정 (ms) | Track 구조 | 비고 |');
  lines.push('|---|:---:|:---:|:---:|---|');

  for (const env of envs) {
    if (env.harnessGain.compactionSavedTokens > 0) {
      lines.push(
        `| **${env.name}** | **${env.harnessGain.compactionSavedTokens.toLocaleString()} tokens** | **${env.harnessGain.pinningSavedMs.toLocaleString()} ms** | Track 1 Direct / Track 2 Plan 동적 분기 | 하네스 최적화 활성화 |`
      );
    } else {
      lines.push(
        `| **${env.name}** | 0 tokens (미적용) | 0 ms (미적용) | 단일 순차 CLI 루프 | 베이스라인 하네스 |`
      );
    }
  }
  lines.push('');

  // 7. Operations, Retries, and User Interventions
  lines.push('---');
  lines.push('## 6. 도구 호출 횟수, 재시도, 사용자 개입 대조 (Operational Rigor)');
  lines.push('');
  lines.push('| 환경 (Environment) | 도구 호출수 (Tool Calls) | 모델 호출수 (Model Calls) | 재시도 횟수 (Retries) | 사용자 개입 (User Interventions) | 평균 품질 점수 (Quality) |');
  lines.push('|---|:---:|:---:|:---:|:---:|:---:|');

  for (const env of envs) {
    lines.push(
      `| **${env.name}** | ${env.operations.toolCalls} | ${env.operations.modelCalls} | ${env.operations.retries} | **${env.operations.userInterventions}회** | ${env.operations.meanQualityScore}/100 |`
    );
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Prints clean ANSI console tables.
 * @param {object} reportData
 */
export function printConsoleSummary(reportData) {
  const { environmentSummaries } = reportData;
  console.log('\n' + '='.repeat(88));
  console.log('  4-ENVIRONMENT PERFORMANCE BENCHMARK SUMMARY REPORT');
  console.log('='.repeat(88));
  console.log(`  [Assumptions]: ${ASSUMPTION_LABEL}`);
  console.log('  Codex: Catalog x 0.1 | Claude Code: Catalog x 0.02 | VAYEX: Pay-per-token Catalog x 1.0\n');

  console.log(
    '  ' +
    'Environment'.padEnd(28) +
    'Success'.padEnd(10) +
    'Wall(s)'.padEnd(10) +
    'Tokens'.padEnd(10) +
    'Catalog Cost'.padEnd(15) +
    'Adjusted Cost'.padEnd(15)
  );
  console.log('  ' + '-'.repeat(84));

  for (const env of Object.values(environmentSummaries)) {
    const successStr = `${(env.overallSuccessRate * 100).toFixed(0)}%`;
    const wallStr = `${env.latencies.totalWallSec}s`;
    const tokenStr = `${env.tokens.total.toLocaleString()}`;
    const catalogCostStr = `$${env.costs.catalogCostUsd.toFixed(5)}`;
    const adjCostStr = `$${env.costs.adjustedCostUsd.toFixed(5)}`;

    console.log(
      '  ' +
      env.name.padEnd(28) +
      successStr.padEnd(10) +
      wallStr.padEnd(10) +
      tokenStr.padEnd(10) +
      catalogCostStr.padEnd(15) +
      adjCostStr.padEnd(15)
    );
  }
  console.log('='.repeat(88) + '\n');
}

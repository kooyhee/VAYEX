// Metrics Collector & Statistical Aggregator for 4-Environment Benchmark
// Complies with Section 5: Rigorous instrumentation, N=3 repetitions, median/stdDev,
// and Model intrinsic vs Harness optimization separation.

import { calculateThreeCosts, calculateCostPerSuccessfulTask, ASSUMPTION_LABEL, ENVIRONMENTS } from './cost-normalizer.mjs';

/**
 * Calculates standard deviation and median of an array of numbers.
 * @param {number[]} values
 * @returns {{ median: number, mean: number, min: number, max: number, stdDev: number }}
 */
export function computeStats(values) {
  if (!values || values.length === 0) {
    return { median: 0, mean: 0, min: 0, max: 0, stdDev: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;

  // Median
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;

  // Variance & Standard Deviation
  const variance = sorted.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / sorted.length;
  const stdDev = Math.sqrt(variance);

  return {
    median: Number(median.toFixed(4)),
    mean: Number(mean.toFixed(4)),
    min: Number(min.toFixed(4)),
    max: Number(max.toFixed(4)),
    stdDev: Number(stdDev.toFixed(4)),
  };
}

export class MetricsCollector {
  constructor({ mode = 'offline_stub_simulated' } = {}) {
    this.mode = mode; // 'offline_stub_simulated' | 'live_measured'
    this.runs = [];
    this.assumptionLabel = ASSUMPTION_LABEL;
  }

  /**
   * Records a single run execution.
   */
  recordRun({
    taskId,
    taskName,
    taskCategory,
    envId,
    repetition,
    success,
    passRate,
    wallMs,
    ttftMs,
    promptTokens,
    completionTokens,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    toolCalls = 0,
    modelCalls = 0,
    retries = 0,
    userInterventions = 0,
    qualityScore = 100,
    harnessGain = null,
    testResults = [],
    error = null,
  }) {
    const cost = calculateThreeCosts(envId, {
      promptTokens,
      completionTokens,
      cacheReadTokens,
      cacheWriteTokens,
    });

    const runRecord = {
      runId: `${taskId}_${envId}_rep${repetition}`,
      taskId,
      taskName,
      taskCategory,
      envId,
      repetition,
      success: Boolean(success),
      passRate: Number(passRate.toFixed(4)),
      wallMs: Number(wallMs.toFixed(2)),
      ttftMs: Number(ttftMs.toFixed(2)),
      tokens: {
        prompt: promptTokens,
        completion: completionTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        total: promptTokens + completionTokens,
        cacheHitRatePercent: cost.cacheHitRatePercent,
      },
      costs: {
        catalogCostUsd: cost.catalogCostUsd,
        adjustedCostUsd: cost.adjustedCostUsd,
        actualCostUsd: cost.actualCostUsd,
        multiplierUsed: cost.multiplierUsed,
        multiplierLabel: cost.multiplierLabel,
      },
      operations: {
        toolCalls,
        modelCalls,
        retries,
        userInterventions,
        qualityScore,
      },
      harnessGain: harnessGain || {
        compactionSavedTokens: 0,
        pinningSavedMs: 0,
        track: 'direct',
      },
      testResults,
      error,
      timestamp: new Date().toISOString(),
    };

    this.runs.push(runRecord);
    return runRecord;
  }

  /**
   * Aggregates metrics across repetitions for each task and environment.
   */
  aggregateByTaskAndEnv() {
    const groups = new Map();

    for (const run of this.runs) {
      const key = `${run.envId}:::${run.taskId}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(run);
    }

    const taskEnvAggregates = [];

    for (const [key, groupRuns] of groups.entries()) {
      const [envId, taskId] = key.split(':::');
      const first = groupRuns[0];
      const count = groupRuns.length;

      const wallMsStats = computeStats(groupRuns.map((r) => r.wallMs));
      const ttftMsStats = computeStats(groupRuns.map((r) => r.ttftMs));
      const promptTokenStats = computeStats(groupRuns.map((r) => r.tokens.prompt));
      const completionTokenStats = computeStats(groupRuns.map((r) => r.tokens.completion));
      const cacheReadStats = computeStats(groupRuns.map((r) => r.tokens.cacheRead));
      const totalTokenStats = computeStats(groupRuns.map((r) => r.tokens.total));
      const catalogCostStats = computeStats(groupRuns.map((r) => r.costs.catalogCostUsd));
      const adjustedCostStats = computeStats(groupRuns.map((r) => r.costs.adjustedCostUsd));
      const actualCostStats = computeStats(groupRuns.map((r) => r.costs.actualCostUsd));
      const qualityStats = computeStats(groupRuns.map((r) => r.operations.qualityScore));
      const passRateStats = computeStats(groupRuns.map((r) => r.passRate));

      const successes = groupRuns.filter((r) => r.success).length;

      taskEnvAggregates.push({
        envId,
        taskId,
        taskName: first.taskName,
        taskCategory: first.taskCategory,
        repetitions: count,
        successRate: Number((successes / count).toFixed(4)),
        passRate: passRateStats,
        wallMs: wallMsStats,
        ttftMs: ttftMsStats,
        tokens: {
          prompt: promptTokenStats,
          completion: completionTokenStats,
          cacheRead: cacheReadStats,
          total: totalTokenStats,
          medianCacheHitRate: Number(
            promptTokenStats.median > 0
              ? ((cacheReadStats.median / promptTokenStats.median) * 100).toFixed(2)
              : 0
          ),
        },
        costs: {
          catalogCostUsd: catalogCostStats,
          adjustedCostUsd: adjustedCostStats,
          actualCostUsd: actualCostStats,
          multiplierUsed: first.costs.multiplierUsed,
          multiplierLabel: first.costs.multiplierLabel,
        },
        operations: {
          medianToolCalls: computeStats(groupRuns.map((r) => r.operations.toolCalls)).median,
          medianModelCalls: computeStats(groupRuns.map((r) => r.operations.modelCalls)).median,
          medianRetries: computeStats(groupRuns.map((r) => r.operations.retries)).median,
          totalUserInterventions: groupRuns.reduce((acc, r) => acc + r.operations.userInterventions, 0),
          qualityScore: qualityStats,
        },
        harnessGain: first.harnessGain,
      });
    }

    return taskEnvAggregates;
  }

  /**
   * Generates overall environment-level summary with 3-cost comparison and cost per successful task.
   */
  generateEnvironmentSummaries() {
    const taskEnvAggregates = this.aggregateByTaskAndEnv();
    const envSummaries = {};

    for (const [envId, envMeta] of Object.entries(ENVIRONMENTS)) {
      const taskEntries = taskEnvAggregates.filter((a) => a.envId === envId);
      if (taskEntries.length === 0) continue;

      const totalTasks = taskEntries.length;
      const totalSuccessfulTasks = taskEntries.filter((a) => a.successRate === 1.0).length;
      const overallSuccessRate = Number((totalSuccessfulTasks / totalTasks).toFixed(4));

      // Sum of medians across tasks
      const totalWallMs = Number(taskEntries.reduce((acc, t) => acc + t.wallMs.median, 0).toFixed(2));
      const meanTtftMs = Number((taskEntries.reduce((acc, t) => acc + t.ttftMs.median, 0) / totalTasks).toFixed(2));

      const totalPromptTokens = taskEntries.reduce((acc, t) => acc + t.tokens.prompt.median, 0);
      const totalCompletionTokens = taskEntries.reduce((acc, t) => acc + t.tokens.completion.median, 0);
      const totalCacheReadTokens = taskEntries.reduce((acc, t) => acc + t.tokens.cacheRead.median, 0);
      const totalTokens = totalPromptTokens + totalCompletionTokens;

      const totalCatalogCostUsd = Number(taskEntries.reduce((acc, t) => acc + t.costs.catalogCostUsd.median, 0).toFixed(6));
      const totalAdjustedCostUsd = Number(taskEntries.reduce((acc, t) => acc + t.costs.adjustedCostUsd.median, 0).toFixed(6));
      const totalActualCostUsd = Number(taskEntries.reduce((acc, t) => acc + t.costs.actualCostUsd.median, 0).toFixed(6));

      // Core efficiency metric: 성공 작업당 비용 (Cost per Successful Task)
      const catalogCostPerSuccess = calculateCostPerSuccessfulTask(totalCatalogCostUsd, totalSuccessfulTasks);
      const adjustedCostPerSuccess = calculateCostPerSuccessfulTask(totalAdjustedCostUsd, totalSuccessfulTasks);
      const actualCostPerSuccess = calculateCostPerSuccessfulTask(totalActualCostUsd, totalSuccessfulTasks);

      const totalCompactionSavedTokens = taskEntries.reduce((acc, t) => acc + (t.harnessGain?.compactionSavedTokens || 0), 0);
      const totalPinningSavedMs = taskEntries.reduce((acc, t) => acc + (t.harnessGain?.pinningSavedMs || 0), 0);

      const meanQuality = Number((taskEntries.reduce((acc, t) => acc + t.operations.qualityScore.mean, 0) / totalTasks).toFixed(2));
      const totalToolCalls = taskEntries.reduce((acc, t) => acc + t.operations.medianToolCalls, 0);
      const totalModelCalls = taskEntries.reduce((acc, t) => acc + t.operations.medianModelCalls, 0);
      const totalRetries = taskEntries.reduce((acc, t) => acc + t.operations.medianRetries, 0);
      const totalUserInterventions = taskEntries.reduce((acc, t) => acc + t.operations.totalUserInterventions, 0);

      envSummaries[envId] = {
        envId,
        name: envMeta.name,
        category: envMeta.category,
        modelId: envMeta.modelId,
        multiplierUsed: envMeta.subscriptionMultiplier,
        multiplierLabel: envMeta.subscriptionMultiplierLabel,
        totalTasks,
        successfulTasks: totalSuccessfulTasks,
        overallSuccessRate,
        latencies: {
          totalWallMs,
          totalWallSec: Number((totalWallMs / 1000).toFixed(2)),
          meanTtftMs,
        },
        tokens: {
          prompt: totalPromptTokens,
          completion: totalCompletionTokens,
          cacheRead: totalCacheReadTokens,
          total: totalTokens,
          cacheHitRatePercent: totalPromptTokens > 0
            ? Number(((totalCacheReadTokens / totalPromptTokens) * 100).toFixed(2))
            : 0,
        },
        costs: {
          catalogCostUsd: totalCatalogCostUsd,
          adjustedCostUsd: totalAdjustedCostUsd,
          actualCostUsd: totalActualCostUsd,
        },
        costPerSuccessfulTask: {
          catalogCostUsd: catalogCostPerSuccess,
          adjustedCostUsd: adjustedCostPerSuccess,
          actualCostUsd: actualCostPerSuccess,
        },
        operations: {
          toolCalls: totalToolCalls,
          modelCalls: totalModelCalls,
          retries: totalRetries,
          userInterventions: totalUserInterventions,
          meanQualityScore: meanQuality,
        },
        harnessGain: {
          compactionSavedTokens: totalCompactionSavedTokens,
          pinningSavedMs: totalPinningSavedMs,
        },
      };
    }

    return envSummaries;
  }

  /**
   * Produces final benchmark dataset.
   */
  exportReport() {
    return {
      measurement: this.mode,
      evidence: this.mode === 'offline_stub_simulated' ? 'offline_stub_simulated' : 'live_measured',
      generatedAt: new Date().toISOString(),
      assumptionDisclaimer: {
        label: ASSUMPTION_LABEL,
        note: 'Codex 0.1 및 Claude Code 0.02 계수는 사용자 지정 비교 가정(User-Specified Comparison Assumption)이며, 공식 청구 단가나 공인 정액제 할인율이 아닙니다. 실제 발생 비용, API 공시 환산 비용, 보정 환산 비용의 3대 지표를 대조하여 해석해야 합니다.',
        codexMultiplier: 0.10,
        claudeCodeMultiplier: 0.02,
      },
      environments: ENVIRONMENTS,
      environmentSummaries: this.generateEnvironmentSummaries(),
      taskAggregates: this.aggregateByTaskAndEnv(),
      rawRuns: this.runs,
    };
  }
}

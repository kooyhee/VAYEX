import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Exchange rate & pricing baseline defaults (configurable).
 * Baseline pricing model: standard cloud LLM (~$3.00 / 1M prompt, $15.00 / 1M completion)
 * Local model: $0.00 / token.
 */
const DEFAULT_CONFIG = {
  krwPerUsd: 1400,
  pricing: {
    // USD per 1K tokens
    cloud: { prompt: 0.003, completion: 0.015 },
    local: { prompt: 0.0, completion: 0.0 }
  }
};

/** A measured count, or null when the provider reported nothing. Never coerced to 0. */
function reportedCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/** A reported money figure, or null when the record carries none. */
function reportedUsd(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Cost Visualization & Optimization Aggregator
 * Aggregates token spend, local routing offloading, prompt compaction,
 * cache hit rate and cost savings from runtime-cost events for the
 * student/vibe-coder UI.
 */
export class CostAnalytics {
  /**
   * @param {object} [options]
   * @param {string} [options.storageDir] Optional path to persist events
   * @param {number} [options.krwPerUsd=1400]
   * @param {Function} [options.eventsFrom] Live source of gateway `llm_turn` records,
   *   read on every aggregation. Passed by the router on the live path; omitted when
   *   the analyzer is fed through `recordEvent` only.
   */
  constructor(options = {}) {
    this.storageDir = options.storageDir ? resolve(options.storageDir) : null;
    this.krwPerUsd = options.krwPerUsd || DEFAULT_CONFIG.krwPerUsd;
    this.pricing = DEFAULT_CONFIG.pricing;
    this.eventsFrom = typeof options.eventsFrom === 'function' ? options.eventsFrom : null;
    // Records already folded in, so re-reading the same stream never double-counts.
    this.ingested = new Set();

    // In-memory events index: taskId -> Array<Event>
    this.taskEvents = new Map();
    // In-memory general events
    this.globalEvents = [];
  }

  async init() {
    if (this.storageDir) {
      await mkdir(this.storageDir, { recursive: true });
    }
  }

  /**
   * Ingest an accounting/telemetry event emitted by runtime-cost or gateway.
   *
   * Supported event types:
   * - 'llm_turn': { taskId, promptTokens, completionTokens, cachedTokens, route, model, provider }
   * - 'optimization': { taskId, strategy, tokensSaved, costSavedUsd }
   * - 'task_start' / 'task_end'
   *
   * @param {object} event
   */
  recordEvent(event) {
    const enriched = {
      ...event,
      timestamp: event.timestamp || Date.now()
    };

    if (enriched.taskId) {
      if (!this.taskEvents.has(enriched.taskId)) {
        this.taskEvents.set(enriched.taskId, []);
      }
      this.taskEvents.get(enriched.taskId).push(enriched);
    }

    this.globalEvents.push(enriched);
    return enriched;
  }

  _remember(key) {
    this.ingested.add(key);
    if (this.ingested.size > 4096) {
      this.ingested.delete(this.ingested.values().next().value);
    }
  }

  /**
   * Fold one live `llm_turn` record into this analyzer.
   *
   * The record arrives in the shape `gateway/lib/accounting.mjs` `accountRequest`
   * emits through `gateway/lib/events.mjs`: flat `promptTokens` / `completionTokens` /
   * `cachedTokens` / `route` / `model`, the platform's own `cost` (measured tokens ×
   * that model's published rate) and a positive `seq`.
   *
   * A turn whose provider reported no usage carries null token fields. It happened,
   * but its cost is unknown rather than free, so it is not counted at all — it is
   * never recorded as a 0-token turn.
   *
   * @param {object} record
   * @returns {object|null} the recorded event, or null when nothing was counted
   */
  ingestRecord(record) {
    if (!record || typeof record !== 'object' || record.type !== 'llm_turn') return null;

    const key = `${record.ts ?? ''}#${record.seq ?? ''}#${record.taskId ?? ''}`;
    if (this.ingested.has(key)) return null;
    this._remember(key);

    const promptTokens = reportedCount(record.promptTokens);
    const completionTokens = reportedCount(record.completionTokens);
    const cachedTokens = reportedCount(record.cachedTokens);
    if (promptTokens === null && completionTokens === null && cachedTokens === null) return null;

    const parsedTs = Date.parse(record.ts ?? '');
    return this.recordEvent({
      type: 'llm_turn',
      taskId: record.taskId ?? record.session ?? 'platform',
      route: record.route ?? null,
      model: record.model ?? null,
      provider: record.provider ?? null,
      promptTokens,
      completionTokens,
      cachedTokens,
      costUsd: reportedUsd(record.cost?.usd),
      baselineUsd: reportedUsd(record.cost?.baselineUsd),
      source: 'gateway_llm_turn',
      timestamp: Number.isNaN(parsedTs) ? Date.now() : parsedTs
    });
  }

  /**
   * Read the live turn accounting stream and fold in what has not been counted yet.
   * Called by every aggregation, so a request always reflects the turns that ran
   * before it.
   *
   * @returns {number} how many records were newly counted
   */
  syncFromSource() {
    if (!this.eventsFrom) return 0;
    let records;
    try {
      records = this.eventsFrom();
    } catch {
      return 0;
    }
    if (!Array.isArray(records)) return 0;
    let counted = 0;
    for (const record of records) {
      if (this.ingestRecord(record)) counted += 1;
    }
    return counted;
  }

  /**
   * Calculate cost in USD & KRW for given token counts and route.
   */
  calculateCost(promptTokens, completionTokens, route = 'local_only') {
    const isLocal = route === 'local_only';
    const rate = isLocal ? this.pricing.local : this.pricing.cloud;
    const cloudRate = this.pricing.cloud;

    const actualUsd = (promptTokens * rate.prompt + completionTokens * rate.completion) / 1000;
    const baselineUsd = (promptTokens * cloudRate.prompt + completionTokens * cloudRate.completion) / 1000;
    const savedUsd = Math.max(0, baselineUsd - actualUsd);

    return {
      actualUsd,
      actualKrw: Math.round(actualUsd * this.krwPerUsd),
      baselineUsd,
      baselineKrw: Math.round(baselineUsd * this.krwPerUsd),
      savedUsd,
      savedKrw: Math.round(savedUsd * this.krwPerUsd)
    };
  }

  /**
   * Returns aggregated cost and optimization metrics for a specific task.
   *
   * @param {string} taskId
   * @returns {object}
   */
  getTaskCost(taskId) {
    this.syncFromSource();
    return this._aggregateTask(taskId);
  }

  _aggregateTask(taskId) {
    const events = this.taskEvents.get(taskId) || [];

    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    let cacheReported = false;
    let optimizationTokensSaved = 0;
    let localTurns = 0;
    let cloudTurns = 0;
    let totalActualUsd = 0;
    let totalBaselineUsd = 0;

    const optimizations = [];
    const turnBreakdown = [];
    // 캐시 적중률은 모델마다 다릅니다(모델별 캐시 단가·프리픽스 정책이 다름). 그래서 모델별로
    // 누적하고, 전체 값은 그 합에서 다시 계산합니다 — 평균의 평균을 쓰지 않습니다.
    const byModel = new Map();

    for (const ev of events) {
      if (ev.type === 'llm_turn' || ev.promptTokens !== undefined || ev.completionTokens !== undefined) {
        const p = reportedCount(ev.promptTokens) ?? 0;
        const c = reportedCount(ev.completionTokens) ?? 0;
        const cached = reportedCount(ev.cachedTokens);
        const route = ev.route || 'local_only';

        promptTokens += p;
        completionTokens += c;
        if (cached !== null) {
          cachedTokens += cached;
          // A provider that reports a cache figure reported a fact, even when it is
          // zero. That is a measured 0%, not "미집계".
          cacheReported = true;
        }

        const modelKey = ev.model || 'auto';
        const bucket = byModel.get(modelKey)
          ?? { model: modelKey, cachedTokens: 0, cacheableTokens: 0, reported: false, turns: 0 };
        bucket.turns += 1;
        if (cached !== null) {
          bucket.reported = true;
          bucket.cachedTokens += cached;
          // 적중률의 분모는 "캐시로 읽힌 토큰 + 캐시 없이 보낸 프롬프트 토큰"입니다.
          bucket.cacheableTokens += p + cached;
        }
        byModel.set(modelKey, bucket);

        if (route === 'local_only') localTurns++;
        else cloudTurns++;

        // The platform's own cost is measured tokens × that model's published rate.
        // It is used when the turn carries it; the baseline default rate card is
        // only the fallback for a record that reports tokens without a cost.
        const fallback = this.calculateCost(p, c, route);
        const reportedActualUsd = reportedUsd(ev.costUsd);
        const actualUsd = reportedActualUsd !== null ? reportedActualUsd : fallback.actualUsd;
        const baselineUsd = reportedUsd(ev.baselineUsd) ?? (reportedActualUsd !== null
          ? actualUsd
          : fallback.baselineUsd);
        totalActualUsd += actualUsd;
        totalBaselineUsd += baselineUsd;

        turnBreakdown.push({
          timestamp: ev.timestamp,
          model: ev.model || 'auto',
          route,
          promptTokens: p,
          completionTokens: c,
          cachedTokens: cached,
          costUsd: Number(actualUsd.toFixed(6)),
          costKrw: Math.round(actualUsd * this.krwPerUsd),
          savedKrw: Math.round(Math.max(0, baselineUsd - actualUsd) * this.krwPerUsd)
        });
      } else if (ev.type === 'optimization') {
        const saved = ev.tokensSaved || 0;
        optimizationTokensSaved += saved;
        const extraSavedUsd = ev.costSavedUsd || ((saved * this.pricing.cloud.prompt) / 1000);
        totalBaselineUsd += extraSavedUsd;

        optimizations.push({
          strategy: ev.strategy || 'prompt_compaction',
          tokensSaved: saved,
          savedKrw: Math.round(extraSavedUsd * this.krwPerUsd)
        });
      }
    }

    const totalTokens = promptTokens + completionTokens;
    const actualKrw = Math.round(totalActualUsd * this.krwPerUsd);
    const baselineKrw = Math.round(totalBaselineUsd * this.krwPerUsd);
    const savedKrw = Math.max(0, baselineKrw - actualKrw);
    const savingsPercent = baselineKrw > 0
      ? Math.min(100, Number(((savedKrw / baselineKrw) * 100).toFixed(1)))
      : (totalTokens > 0 ? 100 : 0);

    const totalTurns = localTurns + cloudTurns;
    const localRatio = totalTurns > 0 ? Number(((localTurns / totalTurns) * 100).toFixed(1)) : 100;
    // 캐시 적중률: 캐시로 읽은 토큰 ÷ 캐시 대상이었던 프롬프트 토큰. A provider that
    // reported no cache figure at all leaves it 미집계 — never rendered as 0%.
    const cacheableTokens = promptTokens + cachedTokens;
    const cacheHitRatePercent = !cacheReported
      ? null
      : (cacheableTokens > 0 ? Number(((cachedTokens / cacheableTokens) * 100).toFixed(1)) : 0);
    const cacheHitRateLabel = !cacheReported
      ? '미집계'
      : `${cacheHitRatePercent}%`;
    // 같은 규칙을 모델별로 적용합니다: 보고가 없으면 null(미집계), 0으로 채우지 않습니다.
    const cacheByModel = [...byModel.values()].map((bucket) => {
      const hitRate = !bucket.reported
        ? null
        : (bucket.cacheableTokens > 0
          ? Number(((bucket.cachedTokens / bucket.cacheableTokens) * 100).toFixed(1))
          : 0);
      return {
        model: bucket.model,
        turns: bucket.turns,
        cachedTokens: bucket.cachedTokens,
        cacheableTokens: bucket.cacheableTokens,
        reported: bucket.reported,
        hitRate,
        label: bucket.reported ? `${hitRate}%` : '미집계'
      };
    });

    // Plain Korean vibe summary for the student UI
    let koreanSummary = '';
    if (totalTokens === 0) {
      koreanSummary = '토큰 소비 내역이 아직 없습니다.';
    } else if (actualKrw === 0) {
      koreanSummary = `로컬 하네스 100% 처리로 클라우드 비용 전액(₩${baselineKrw.toLocaleString()}) 절약`;
    } else {
      const cachePhrase = cacheReported ? `, 캐시 적중률 ${cacheHitRateLabel}` : '';
      koreanSummary = `총 ₩${actualKrw.toLocaleString()} 사용 (최적화 및 로컬 라우팅으로 ₩${savedKrw.toLocaleString()} 절감, ${savingsPercent}% 절약${cachePhrase})`;
    }

    return {
      taskId,
      tokens: {
        total: totalTokens,
        prompt: promptTokens,
        completion: completionTokens,
        cached: cachedTokens,
        cacheHitRate: cacheHitRatePercent,
        cacheHitRateLabel,
        cacheReported,
        optimizationSaved: optimizationTokensSaved
      },
      cache: {
        hitRate: cacheHitRatePercent,
        label: cacheHitRateLabel,
        reported: cacheReported,
        cachedTokens,
        cacheableTokens,
        byModel: cacheByModel
      },
      cost: {
        actualUsd: Number(totalActualUsd.toFixed(4)),
        actualKrw,
        baselineUsd: Number(totalBaselineUsd.toFixed(4)),
        baselineKrw,
        savedUsd: Number((totalBaselineUsd - totalActualUsd).toFixed(4)),
        savedKrw,
        savingsPercent
      },
      routing: {
        localTurns,
        cloudTurns,
        localRatio
      },
      optimizations,
      turnBreakdown,
      koreanSummary
    };
  }

  /**
   * Returns aggregated platform overview data for all tasks.
   *
   * The live turn stream is folded in first, so the overview answers with the turns
   * that have actually run in this process.
   *
   * @returns {object}
   */
  getOverview() {
    this.syncFromSource();

    let grandTokens = 0;
    let grandActualKrw = 0;
    let grandSavedKrw = 0;
    const grandTasks = this.taskEvents.size;
    let grandLocalTurns = 0;
    let grandCloudTurns = 0;
    let grandCachedTokens = 0;
    let grandCacheableTokens = 0;
    let anyCacheReported = false;

    const taskSummaries = [];
    // 전체 적중률은 모델별 분자를 그대로 더해 다시 계산합니다(모델 평균의 평균이 아님).
    const modelsInOverview = new Map();
    for (const taskId of this.taskEvents.keys()) {
      const summary = this._aggregateTask(taskId);
      taskSummaries.push(summary);
      grandTokens += summary.tokens.total;
      grandActualKrw += summary.cost.actualKrw;
      grandSavedKrw += summary.cost.savedKrw;
      grandLocalTurns += summary.routing.localTurns;
      grandCloudTurns += summary.routing.cloudTurns;
      grandCachedTokens += summary.cache.cachedTokens;
      grandCacheableTokens += summary.cache.cacheableTokens;
      anyCacheReported = anyCacheReported || summary.cache.reported;
      for (const bucket of summary.cache.byModel) {
        const merged = modelsInOverview.get(bucket.model)
          ?? { model: bucket.model, turns: 0, cachedTokens: 0, cacheableTokens: 0, reported: false };
        merged.turns += bucket.turns;
        merged.cachedTokens += bucket.cachedTokens;
        merged.cacheableTokens += bucket.cacheableTokens;
        merged.reported = merged.reported || bucket.reported;
        modelsInOverview.set(bucket.model, merged);
      }
    }

    const grandBaselineKrw = grandActualKrw + grandSavedKrw;
    const grandSavingsPercent = grandBaselineKrw > 0
      ? Number(((grandSavedKrw / grandBaselineKrw) * 100).toFixed(1))
      : 100;
    const cacheHitRatePercent = !anyCacheReported
      ? null
      : (grandCacheableTokens > 0 ? Number(((grandCachedTokens / grandCacheableTokens) * 100).toFixed(1)) : 0);

    return {
      totalTasks: grandTasks,
      totalTokens: grandTokens,
      totalSpendKrw: grandActualKrw,
      totalSavedKrw: grandSavedKrw,
      baselineTotalKrw: grandBaselineKrw,
      savingsPercent: grandSavingsPercent,
      localRatio: (grandLocalTurns + grandCloudTurns) > 0
        ? Number(((grandLocalTurns / (grandLocalTurns + grandCloudTurns)) * 100).toFixed(1))
        : 100,
      cachedTokens: grandCachedTokens,
      cacheHitRate: cacheHitRatePercent,
      cacheHitRateLabel: !anyCacheReported ? '미집계' : `${cacheHitRatePercent}%`,
      cacheReported: anyCacheReported,
      cacheByModel: [...modelsInOverview.values()].map((bucket) => {
        const hitRate = !bucket.reported
          ? null
          : (bucket.cacheableTokens > 0
            ? Number(((bucket.cachedTokens / bucket.cacheableTokens) * 100).toFixed(1))
            : 0);
        return { ...bucket, hitRate, label: bucket.reported ? `${hitRate}%` : '미집계' };
      }),
      koreanReport: `학생 로컬 코딩 플랫폼 누적 비용 절감액: ₩${grandSavedKrw.toLocaleString()} (${grandSavingsPercent}% 절약 달성)`
    };
  }
}

// HTTP adapter for the insight backend. Mount once in `app/server.mjs` before
// the GET-only gate:
//
//     const insightRouter = (await import('./insight/routes.mjs')).createInsightRouter({
//       eventsPath: process.env.AI_EVENTS_PATH ?? null,
//       resolveSelection: session => inference?.selection(session) ?? null,
//     });
//     if (path.startsWith('/api/insight/')) {
//       if (await insightRouter.handle(req, res)) return;
//     }
//
// Endpoints (all JSON, charset utf-8):
//   POST /api/insight/summarize {taskId?, session?, events?} →
//        {tasks:[{taskId, label, added, modified, deleted, details, tier}],
//         session:{line, counts, tasks, topDir, tier}, tier, localModel, source}
//   GET  /api/insight/summary?taskId=&session=   (same body, no events in URL)
//   GET  /api/insight/metrics?session=&windowMs= →
//        {session, windowMs, speed, cache, cumulative, model, selection}
//
// `events` in a POST body is the normal UI path while no JSONL sink is mounted;
// otherwise the configured AI_EVENTS_PATH log is read. A missing log is
// reported, never faked: `source.reported: false`.

import { summarizeEvents } from './summarize.mjs';
import { aggregateMetrics } from './metrics.mjs';
import { readEventLog, resolveEventLogPath } from './event-source.mjs';
import { evaluateWatchdog, formatWatchdog } from './watchdog.mjs';
import {
  REGISTRY,
  ROLES,
  DEFAULT_CANDIDATE,
  HIGH_QUALITY_CANDIDATE,
  detectLocalModel,
  generateSessionTitle,
  hasSummarizableTasks,
  polishJournalTasks,
} from './local-model.mjs';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export function createInsightRouter(options = {}) {
  const basePath = options.basePath ?? '/api/insight';
  const summarize = options.summarize ?? summarizeEvents;
  const metrics = options.metrics ?? aggregateMetrics;
  const watchdog = options.watchdog ?? evaluateWatchdog;
  const thresholds = options.watchdogThresholds ?? {};
  const loadEvents = options.loadEvents ?? (() => readEventLog(options.eventsPath ?? resolveEventLogPath()));
  const detectModel = options.detectModel ?? (() => detectLocalModel({
    ...(options.modelRoot !== undefined ? { root: options.modelRoot } : {}),
    ...(options.modelEnv !== undefined ? { env: options.modelEnv } : {}),
  }));
  const polishTasks = options.polishTasks ?? polishJournalTasks;
  const generateTitle = options.generateTitle ?? generateSessionTitle;

  async function sourceEvents(request) {
    if (Array.isArray(request.events)) {
      return { events: request.events, reported: true, kind: 'request', path: null, skipped: 0 };
    }
    const log = await loadEvents();
    return { events: log.events ?? [], reported: Boolean(log.reported), kind: 'event-log', path: log.path ?? null, skipped: log.skipped ?? 0, reason: log.reason ?? null };
  }

  async function summarizeRequest(request) {
    const source = await sourceEvents(request);
    const result = await summarize({
      events: source.events,
      taskId: request.taskId ?? null,
      session: request.session ?? null,
      ...(options.modelRoot !== undefined ? { modelRoot: options.modelRoot } : {}),
      ...(options.modelEnv !== undefined ? { env: options.modelEnv } : {}),
      ...(typeof options.generator === 'function' ? { generator: options.generator } : {}),
    });
    return {
      tasks: result.tasks,
      session: result.session,
      journal: result.journal ?? null,
      tier: result.tier,
      modelStatus: result.modelStatus ?? (result.localModel?.status ?? 'rule-fallback (weights not installed)'),
      fallbackReason: result.fallbackReason ?? null,
      localModel: result.localModel ?? null,
      source: { kind: source.kind, reported: source.reported, path: source.path, skipped: source.skipped, reason: source.reason ?? null, events: source.events.length },
    };
  }

  const handle = async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(basePath)) return false;
    const path = url.pathname.slice(basePath.length) || '/';
    try {
      if (path === '/summarize' && req.method === 'POST') {
        const body = await readJson(req);
        if (Array.isArray(body?.tasks) && !Array.isArray(body?.events)) {
          const localModel = detectModel();
          // Nothing writable to summarize: answer from the rules tier without a
          // generation, so an empty revision never costs seconds of CPU.
          if (!hasSummarizableTasks({ tasks: body.tasks })) {
            return send(res, 200, {
              tasks: [],
              tier: 'rules',
              source: 'rules',
              modelId: localModel?.candidate?.id ?? DEFAULT_CANDIDATE,
              modelStatus: localModel?.status ?? 'rule-fallback (nothing to summarize)',
              fallbackReason: 'nothing_to_summarize',
              localModel,
            });
          }
          const result = await polishTasks(
            { tasks: body.tasks },
            {
              model: localModel,
              ...(typeof options.generator === 'function' ? { generator: options.generator } : {}),
              ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
            },
          );
          return send(res, 200, {
            tasks: result.tasks ?? [],
            tier: result.tier ?? 'rules',
            source: result.source ?? (result.tier === 'local-model' ? 'model' : 'rules'),
            modelId: result.modelId ?? localModel?.candidate?.id ?? DEFAULT_CANDIDATE,
            modelStatus: result.modelStatus ?? localModel?.status ?? 'rule-fallback (weights not installed)',
            fallbackReason: result.fallbackReason ?? null,
            ...(result.generationMs !== undefined ? { generationMs: result.generationMs } : {}),
            localModel,
          });
        }
        return send(res, 200, await summarizeRequest({
          events: body.events,
          taskId: body.taskId ?? null,
          session: body.session ?? null,
        }));
      }
      if (path === '/title' && req.method === 'POST') {
        const body = await readJson(req);
        const localModel = detectModel();
        const result = await generateTitle(
          { prompt: body?.prompt, reply: body?.reply, files: body?.files },
          {
            model: localModel,
            ...(typeof options.titleGenerator === 'function'
              ? { generator: options.titleGenerator }
              : typeof options.generator === 'function'
                ? { generator: options.generator }
                : {}),
            ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
          },
        );
        return send(res, 200, {
          title: result.title,
          tier: result.tier,
          source: result.source,
          modelId: result.modelId,
          modelStatus: result.modelStatus ?? localModel?.status ?? 'rule-fallback (weights not installed)',
          fallbackReason: result.fallbackReason ?? null,
          ...(result.generationMs !== undefined ? { generationMs: result.generationMs } : {}),
        });
      }
      if (path === '/local-model' && req.method === 'GET') {
        return send(res, 200, detectModel());
      }
      if (path === '/summary' && req.method === 'GET') {
        return send(res, 200, await summarizeRequest({
          taskId: url.searchParams.get('taskId') ?? null,
          session: url.searchParams.get('session') ?? null,
        }));
      }
      if (path === '/metrics' && req.method === 'GET') {
        const session = url.searchParams.get('session') ?? null;
        const windowMs = Number(url.searchParams.get('windowMs') ?? 60000);
        const source = await sourceEvents({});
        let selection = null;
        if (session && typeof options.resolveSelection === 'function') {
          try {
            selection = await options.resolveSelection(session);
          } catch {
            selection = null;
          }
        }
        const result = await metrics({
          events: source.events,
          session,
          windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000,
          selection,
        });
        const stall = watchdog({ events: source.events, session, thresholds });
        return send(res, 200, {
          ...result,
          format: formatFor(result),
          watchdog: { ...stall, text: formatWatchdog(stall) },
          selection: { reported: Boolean(selection), source: selection ? 'selection-record' : 'none' },
          source: { kind: source.kind, reported: source.reported, path: source.path, skipped: source.skipped, reason: source.reason ?? null, events: source.events.length },
        });
      }
      if (path === '/watchdog' && req.method === 'GET') {
        const session = url.searchParams.get('session') ?? null;
        const source = await sourceEvents({});
        const status = watchdog({ events: source.events, session, thresholds });
        return send(res, 200, {
          ...status,
          text: formatWatchdog(status),
          source: { kind: source.kind, reported: source.reported, events: source.events.length },
        });
      }
      if (path === '/' && req.method === 'GET') {
        return send(res, 200, {
          basePath,
          endpoints: [
            'POST /api/insight/summarize', 'POST /api/insight/title',
            'GET /api/insight/summary', 'GET /api/insight/local-model',
            'GET /api/insight/metrics', 'GET /api/insight/watchdog',
          ],
          tier: 'rules|local-model',
          watchdog: 'observable signals only (frame ts, heartbeat, tool start/end, progress, timeout)',
          localModel: { default: DEFAULT_CANDIDATE, highQuality: HIGH_QUALITY_CANDIDATE, registry: REGISTRY, roles: ROLES },
        });
      }
      if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'method_not_allowed' });
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      return send(res, 500, { error: 'insight_failed', message: error.message });
    }
  };
  handle.handle = handle;
  return handle;
}

function formatFor(metrics) {
  const speed = metrics.speed.reported && metrics.speed.tokensPerSecond !== null
    ? `${metrics.speed.tokensPerSecond} 토큰/초` : '미보고';
  const cache = metrics.cache.reported && metrics.cache.hitRate !== null
    ? `${Math.round(metrics.cache.hitRate * 100)}%` : '미보고';
  const model = metrics.model.reported
    ? `${metrics.model.auto ? '자동 선택' : '직접 선택'} · ${metrics.model.id}`
    : '미보고';
  return { speed, cache, model };
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`${JSON.stringify(payload)}\n`);
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('요청 바디 크기 제한(5MB)을 초과했습니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        return reject(new Error(`잘못된 JSON 형식입니다: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

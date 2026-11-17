import fs from 'node:fs';
import path from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const UPSTREAM_CLASSES = Object.freeze(['server_local', 'proxy', 'direct']);
export const UPSTREAM_KINDS = Object.freeze(['openai', 'ollama']);
export const AUTH_MODES = Object.freeze(['gateway_key', 'pass_through', 'none']);
export const CAPABILITIES = Object.freeze(['chat', 'images', 'video']);
export const ROUTE_VALUES = Object.freeze(['local_only', 'zdr_cloud', 'any_cloud']);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

function fail(where, message) {
  throw new ConfigError(`${where}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectAt(value, where) {
  if (!isObject(value)) fail(where, 'must be an object');
  return value;
}

function stringAt(value, where, { pattern = null, nonEmpty = true } = {}) {
  if (typeof value !== 'string') fail(where, 'must be a string');
  const trimmed = value.trim();
  if (nonEmpty && !trimmed) fail(where, 'must not be empty');
  if (pattern && !pattern.test(trimmed)) fail(where, `must match ${pattern}`);
  return trimmed;
}

function enumAt(value, where, allowed) {
  if (!allowed.includes(value)) fail(where, `must be one of ${allowed.join(', ')}`);
  return value;
}

function integerAt(value, where, { min = 0, fallback = undefined } = {}) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(value) || value < min) fail(where, `must be an integer >= ${min}`);
  return value;
}

// A daily cap is nullable. An absent key keeps the documented default so nothing
// silently loosens, `null` is the operator's explicit "no cap", and an integer
// keeps the bounded behaviour (min 1: a cap of 0 would refuse every request).
function optionalCapAt(value, where, fallback) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 1) fail(where, 'must be a positive integer or null');
  return value;
}

function boolAt(value, where, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') fail(where, 'must be a boolean');
  return value;
}

// An optional USD ceiling for one turn's prompt+output estimate. Absent means the
// plan is not budget-capped, and the validator says so instead of implying a cap.
function optionalUsdAt(value, where) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(where, 'must be a non-negative number or null');
  }
  return value;
}

function parseBaseUrl(value, where, upstreamClass) {
  const raw = stringAt(value, where);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(where, 'must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(where, 'must use http or https');
  if (url.username || url.password) fail(where, 'must not embed credentials');
  if (url.search || url.hash) fail(where, 'must not contain a query or fragment');
  if (upstreamClass === 'server_local' && !LOOPBACK_HOSTS.has(url.hostname)) {
    fail(where, `class server_local must point at a loopback host, got ${url.hostname}`);
  }
  return raw.replace(/\/+$/, '');
}

function normalizePath(value, where) {
  const raw = stringAt(value, where);
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function loadConfig(configPath) {
  const absolute = path.resolve(configPath);
  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read config ${absolute}: ${error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`config ${absolute} is not valid JSON: ${error.message}`);
  }
  return parseConfig(raw, { configPath: absolute, baseDir: path.dirname(absolute) });
}

export function parseConfig(raw, { configPath = '<memory>', baseDir = process.cwd() } = {}) {
  objectAt(raw, 'config');

  const listenRaw = objectAt(raw.listen ?? {}, 'listen');
  const listenHost = stringAt(listenRaw.host ?? '127.0.0.1', 'listen.host');
  // The deployment host is a shared multi-tenant machine behind NAT. A gateway
  // that binds a routable interface by accident is exposed to every other
  // tenant, so a non-loopback host needs an explicit, deliberate opt-in.
  const allowNonLoopback = boolAt(
    listenRaw.allow_non_loopback_bind,
    'listen.allow_non_loopback_bind',
    false,
  );
  if (!isLoopbackHost(listenHost) && !allowNonLoopback) {
    fail('listen.host',
      `refusing to bind ${listenHost}: only a loopback host is allowed unless listen.allow_non_loopback_bind is set to true. `
      + 'This host is shared; bind 127.0.0.1 and reach it through an SSH tunnel');
  }
  const listen = {
    host: listenHost,
    port: integerAt(listenRaw.port, 'listen.port', { min: 0, fallback: 8787 }),
    allowNonLoopbackBind: allowNonLoopback,
    openFilesTarget: integerAt(listenRaw.open_files_target, 'listen.open_files_target', { min: 1024, fallback: 65535 }),
  };
  if (listen.port > 65535) fail('listen.port', 'must be <= 65535');

  const keysRaw = objectAt(raw.keys ?? {}, 'keys');
  const keys = {
    upstreamKeyEnv: stringAt(
      keysRaw.upstream_key_env ?? 'GATEWAY_UPSTREAM_KEY',
      'keys.upstream_key_env',
      { pattern: /^[A-Z][A-Z0-9_]*$/ },
    ),
  };

  const routeRaw = objectAt(raw.route ?? {}, 'route');
  const defaultRoute = enumAt(routeRaw.default ?? 'zdr_cloud', 'route.default', ROUTE_VALUES);
  if (defaultRoute === 'local_only') {
    fail('route.default', 'cannot be local_only: the local plane does not traverse the gateway');
  }

  const quotaRaw = objectAt(raw.quota ?? {}, 'quota');
  const quota = {
    identityHeader: stringAt(quotaRaw.identity_header ?? 'x-user-id', 'quota.identity_header').toLowerCase(),
    requestsPerDay: optionalCapAt(quotaRaw.requests_per_day, 'quota.requests_per_day', 200),
    tokensPerDay: optionalCapAt(quotaRaw.tokens_per_day, 'quota.tokens_per_day', 200000),
    ledgerPath: path.resolve(baseDir, stringAt(quotaRaw.ledger_path ?? './data/quota-ledger.json', 'quota.ledger_path')),
  };

  const loggingRaw = objectAt(raw.logging ?? {}, 'logging');
  const logging = {
    level: enumAt(loggingRaw.level ?? 'info', 'logging.level', ['debug', 'info', 'warn', 'error']),
    logRequestBodies: boolAt(loggingRaw.log_request_bodies, 'logging.log_request_bodies', false),
    file: loggingRaw.file === null
      ? null
      : path.resolve(baseDir, stringAt(loggingRaw.file ?? './data/gateway.log', 'logging.file')),
  };

  const healthRaw = objectAt(raw.health ?? {}, 'health');
  const health = {
    cacheMs: integerAt(healthRaw.cache_ms, 'health.cache_ms', { min: 0, fallback: 5000 }),
    timeoutMs: integerAt(healthRaw.timeout_ms, 'health.timeout_ms', { min: 100, fallback: 2500 }),
  };

  const timeoutsRaw = objectAt(raw.timeouts ?? {}, 'timeouts');
  const timeouts = {
    upstreamMs: integerAt(timeoutsRaw.upstream_ms, 'timeouts.upstream_ms', { min: 100, fallback: 60000 }),
    videoMs: integerAt(timeoutsRaw.video_ms, 'timeouts.video_ms', { min: 100, fallback: 30000 }),
  };

  const maxBodyBytes = integerAt(raw.max_body_bytes, 'max_body_bytes', { min: 1024, fallback: 2 * 1024 * 1024 });

  const upstreamsRaw = raw.upstreams;
  if (!Array.isArray(upstreamsRaw) || upstreamsRaw.length === 0) {
    fail('upstreams', 'must be a non-empty array: a gateway with no upstream serves nothing');
  }

  const upstreams = [];
  const upstreamIds = new Set();
  const modelIndex = new Map();

  upstreamsRaw.forEach((entry, index) => {
    const where = `upstreams[${index}]`;
    objectAt(entry, where);
    const id = stringAt(entry.id, `${where}.id`, { pattern: /^[a-z0-9][a-z0-9_-]*$/ });
    if (upstreamIds.has(id)) fail(`${where}.id`, `duplicate upstream id ${id}`);
    upstreamIds.add(id);

    const upstreamClass = enumAt(entry.class, `${where}.class`, UPSTREAM_CLASSES);
    const kind = enumAt(entry.kind ?? 'openai', `${where}.kind`, UPSTREAM_KINDS);
    const baseUrl = parseBaseUrl(entry.base_url, `${where}.base_url`, upstreamClass);
    const authMode = enumAt(entry.auth_mode, `${where}.auth_mode`, AUTH_MODES);
    // Only a gateway_key upstream owns an environment variable. A pass-through
    // upstream exists precisely so the operator does not need one.
    const keyEnv = authMode === 'gateway_key'
      ? stringAt(entry.key_env ?? keys.upstreamKeyEnv, `${where}.key_env`, { pattern: /^[A-Z][A-Z0-9_]*$/ })
      : null;
    if (authMode === 'gateway_key' && entry.key_env === undefined && keys.upstreamKeyEnv === undefined) {
      fail(`${where}.key_env`, 'a gateway_key upstream must name the environment variable holding its key');
    }
    if (kind === 'ollama' && upstreamClass !== 'server_local') {
      fail(`${where}.class`, 'an ollama upstream is server_local: it is served by a model host, not by a third party');
    }

    const pathsRaw = objectAt(entry.paths ?? {}, `${where}.paths`);
    const paths = {
      models: normalizePath(pathsRaw.models ?? '/models', `${where}.paths.models`),
      chat: normalizePath(pathsRaw.chat ?? '/chat/completions', `${where}.paths.chat`),
      images: normalizePath(pathsRaw.images ?? '/images/generations', `${where}.paths.images`),
      // Ollama's own API, not its OpenAI-compatible shim: this is what health
      // and GPU residency actually have to read.
      ps: normalizePath(pathsRaw.ps ?? '/api/ps', `${where}.paths.ps`),
      tags: normalizePath(pathsRaw.tags ?? '/api/tags', `${where}.paths.tags`),
    };

    const modelsRaw = entry.models;
    if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
      fail(`${where}.models`, 'must be a non-empty array');
    }
    const models = modelsRaw.map((modelRaw, modelIdx) => {
      const modelWhere = `${where}.models[${modelIdx}]`;
      objectAt(modelRaw, modelWhere);
      const modelId = stringAt(modelRaw.id, `${modelWhere}.id`);
      const capabilitiesRaw = modelRaw.capabilities;
      if (!Array.isArray(capabilitiesRaw) || capabilitiesRaw.length === 0) {
        fail(`${modelWhere}.capabilities`, 'must be a non-empty array');
      }
      const capabilities = capabilitiesRaw.map((cap, capIdx) =>
        enumAt(cap, `${modelWhere}.capabilities[${capIdx}]`, CAPABILITIES));
      if (new Set(capabilities).size !== capabilities.length) {
        fail(`${modelWhere}.capabilities`, 'must not repeat a capability');
      }
      if (modelsRaw.slice(0, modelIdx).some((other) => other && other.id === modelId)) {
        fail(`${modelWhere}.id`, `model ${modelId} appears twice under upstream ${id}`);
      }
      const model = {
        id: modelId,
        capabilities: Object.freeze([...capabilities]),
        zeroDataRetention: boolAt(modelRaw.zero_data_retention, `${modelWhere}.zero_data_retention`),
        trainingOptOut: boolAt(modelRaw.training_opt_out, `${modelWhere}.training_opt_out`),
        displayName: typeof modelRaw.display_name === 'string' ? modelRaw.display_name : null,
        contextWindow: Number.isInteger(modelRaw.context_window) ? modelRaw.context_window : null,
        thinkingLimit: Number.isInteger(modelRaw.thinking_limit) ? modelRaw.thinking_limit : null,
        supportsPromptCacheKey: boolAt(modelRaw.supports_prompt_cache_key, `${modelWhere}.supports_prompt_cache_key`, false),
        metadata: isObject(modelRaw.metadata) ? Object.freeze({ ...modelRaw.metadata }) : null,
      };
      if (capabilities.includes('video') && !isObject(entry.video)) {
        fail(`${modelWhere}.capabilities`, 'declares video but the upstream has no video path block');
      }
      return Object.freeze(model);
    });

    // Enforced after the whole upstream record is parsed so that a video model
    // can only be accepted once the upstream's video path block exists.
    for (const model of models) {
      if (modelIndex.has(model.id)) {
        const owner = modelIndex.get(model.id).upstream;
        fail(`${where}.models`, `model ${model.id} is already served by upstream ${owner ? owner.id : 'another upstream'}; the allowlist resolves a model to exactly one upstream and has no fallback chain`);
      }
    }
    let video = null;
    if (isObject(entry.video)) {
      const videoWhere = `${where}.video`;
      video = Object.freeze({
        createPath: normalizePath(entry.video.create_path, `${videoWhere}.create_path`),
        pollPath: normalizePath(entry.video.poll_path, `${videoWhere}.poll_path`),
        contentPath: normalizePath(entry.video.content_path, `${videoWhere}.content_path`),
      });
      if (!video.pollPath.includes('{id}') || !video.contentPath.includes('{id}')) {
        fail(videoWhere, 'poll_path and content_path must contain the {id} placeholder');
      }
    }

    const upstream = Object.freeze({
      id,
      class: upstreamClass,
      kind,
      baseUrl,
      authMode,
      keyEnv,
      paths: Object.freeze(paths),
      video,
      models: Object.freeze(models),
    });
    for (const model of models) modelIndex.set(model.id, { model, upstream });
    upstreams.push(upstream);
  });

  // Optimisation profile. `OPT_PROFILE=baseline` exists for the benchmark
  // harness: it turns every gateway-side optimisation off so the same tasks can
  // be measured against the unmodified behaviour. The profile is data, not code
  // paths, so a baseline request still runs the same validated handler.
  const optimizationRaw = objectAt(raw.optimization ?? {}, 'optimization');
  const profileRaw = String(optimizationRaw.profile ?? process.env.OPT_PROFILE ?? 'optimized').trim().toLowerCase();
  const profile = enumAt(profileRaw, 'optimization.profile', ['optimized', 'baseline']);
  const on = profile === 'optimized' ? true : false;
  const optimization = {
    profile,
    enabled: on,
    pinSessions: boolAt(optimizationRaw.pin_sessions, 'optimization.pin_sessions', on),
    pinCacheTtlMs: integerAt(optimizationRaw.pin_cache_ttl_ms, 'optimization.pin_cache_ttl_ms', { min: 60000, fallback: 5 * 60 * 1000 }),
    prefixStable: boolAt(optimizationRaw.prefix_stable, 'optimization.prefix_stable', on),
    providerCache: boolAt(optimizationRaw.provider_cache, 'optimization.provider_cache', on),
    // V-08 needs a real number to compare against: an absent cap leaves the plan
    // accepted and reported as unbounded rather than silently "within budget".
    budgetCapUsd: optionalUsdAt(optimizationRaw.budget_cap_usd, 'optimization.budget_cap_usd'),
    decisionModel: boolAt(optimizationRaw.decision_model, 'optimization.decision_model', false),
    // Background work is local unconditionally: there is no switch that can put a
    // provider call back into a title, a progress line or a digest.
    localBackground: true,
    eventsPath: optimizationRaw.events_path === null
      ? null
      : (typeof optimizationRaw.events_path === 'string' && optimizationRaw.events_path.length > 0
        ? path.resolve(baseDir, optimizationRaw.events_path)
        : (typeof process.env.AI_EVENTS_PATH === 'string' && process.env.AI_EVENTS_PATH.length > 0
          ? path.resolve(process.env.AI_EVENTS_PATH) : null)),
  };

  const chatModels = [];
  const imageModels = [];
  const videoModels = [];
  for (const { model, upstream } of modelIndex.values()) {
    if (model.capabilities.includes('chat')) chatModels.push({ model, upstream });
    if (model.capabilities.includes('images')) imageModels.push({ model, upstream });
    if (model.capabilities.includes('video')) videoModels.push({ model, upstream });
  }

  return Object.freeze({
    configPath,
    listen: Object.freeze(listen),
    keys: Object.freeze(keys),
    route: Object.freeze({ default: defaultRoute }),
    quota: Object.freeze(quota),
    logging: Object.freeze(logging),
    health: Object.freeze(health),
    timeouts: Object.freeze(timeouts),
    optimization: Object.freeze(optimization),
    maxBodyBytes,
    upstreams: Object.freeze(upstreams),
    modelIndex,
    chatModels: Object.freeze(chatModels),
    imageModels: Object.freeze(imageModels),
    videoModels: Object.freeze(videoModels),
    videoUpstream: videoModels.length > 0 ? videoModels[0].upstream : null,
  });
}

export function publicCatalogue(config, createdAt) {
  const data = [];
  for (const { model, upstream } of config.modelIndex.values()) {
    data.push({
      id: model.id,
      object: 'model',
      created: createdAt,
      owned_by: upstream.id,
      gateway: {
        upstream: upstream.id,
        upstream_class: upstream.class,
        capabilities: [...model.capabilities],
        zero_data_retention: model.zeroDataRetention,
        training_opt_out: model.trainingOptOut,
        display_name: model.displayName,
        context_window: model.contextWindow,
        thinking_limit: model.thinkingLimit,
        supports_prompt_cache_key: model.supportsPromptCacheKey,
        ...(model.metadata ? { metadata: model.metadata } : {}),
      },
    });
  }
  data.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { object: 'list', data };
}
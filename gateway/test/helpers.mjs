import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStubUpstream } from '../stub/stub-upstream.mjs';
import { parseConfig } from '../lib/config.mjs';
import { createGateway } from '../lib/gateway.mjs';
import { createLogger } from '../lib/log.mjs';
import { createRedactor } from '../lib/redact.mjs';

export const STUB_KEY = 'stub-provider-key-0123456789abcdef';
export const BASETEN_KEY = 'baseten-provider-key-fedcba9876543210';
export const BYOK_KEY = 'byok-client-key-0a1b2c3d4e5f6a7b';

export function tempDir(prefix = 'gateway-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Three upstream classes plus one video upstream, all pointed at one stub.
export function stubConfig({ stubPort, dir, overrides = {} }) {
  return {
    listen: { host: '127.0.0.1', port: 0 },
    route: { default: 'zdr_cloud', ...(overrides.route || {}) },
    quota: {
      identity_header: 'x-user-id',
      requests_per_day: 100,
      tokens_per_day: 100000,
      ledger_path: path.join(dir, 'quota-ledger.json'),
      ...(overrides.quota || {}),
    },
    logging: {
      level: 'info',
      log_request_bodies: overrides.logRequestBodies === true,
      file: path.join(dir, 'gateway.log'),
    },
    health: { cache_ms: 0, timeout_ms: 700, ...(overrides.health || {}) },
    timeouts: { upstream_ms: 4000, video_ms: 4000 },
    max_body_bytes: 2097152,
    upstreams: [
      {
        id: 'ollama',
        class: 'server_local',
        kind: 'ollama',
        base_url: `http://127.0.0.1:${stubPort}/ollama`,
        auth_mode: 'none',
        paths: {
          models: '/v1/models',
          chat: '/v1/chat/completions',
          images: '/v1/images/generations',
          ps: '/api/ps',
          tags: '/api/tags',
        },
        models: [
          {
            id: 'qwen3:32b',
            display_name: 'Qwen3 32B (Ollama, server GPU)',
            capabilities: ['chat'],
            zero_data_retention: true,
            training_opt_out: true,
            context_window: 40960,
          },
        ],
      },
      {
        id: 'server_gpu',
        class: 'server_local',
        base_url: `http://127.0.0.1:${stubPort}/local/v1`,
        auth_mode: 'none',
        paths: { models: '/models', chat: '/chat/completions', images: '/images/generations' },
        video: { create_path: '/videos', poll_path: '/videos/{id}', content_path: '/videos/{id}/content' },
        models: [
          {
            id: 'server/qwen3-coder-30b',
            display_name: 'Qwen3 Coder 30B (server GPU)',
            capabilities: ['chat'],
            zero_data_retention: true,
            training_opt_out: true,
            context_window: 262144,
          },
          {
            id: 'server/flux-schnell',
            display_name: 'FLUX schnell (server GPU)',
            capabilities: ['images'],
            zero_data_retention: true,
            training_opt_out: true,
          },
          {
            id: 'server/wan-2.2-t2v',
            display_name: 'Wan 2.2 T2V (server GPU)',
            capabilities: ['video'],
            zero_data_retention: true,
            training_opt_out: true,
          },
        ],
      },
      {
        id: 'openrouter',
        class: 'proxy',
        base_url: `http://127.0.0.1:${stubPort}/openrouter/v1`,
        auth_mode: 'gateway_key',
        key_env: 'OPENROUTER_API_KEY',
        paths: { models: '/models', chat: '/chat/completions', images: '/images/generations' },
        models: [
          {
            id: 'deepseek/deepseek-v4.1-flash-1017',
            capabilities: ['chat'],
            zero_data_retention: true,
            training_opt_out: true,
            thinking_limit: 8192,
          },
          {
            id: 'google/gemini-2.5-flash',
            capabilities: ['chat', 'images'],
            zero_data_retention: true,
            training_opt_out: true,
          },
        ],
      },
      {
        id: 'a6api',
        class: 'proxy',
        base_url: `http://127.0.0.1:${stubPort}/a6api/v1`,
        auth_mode: 'pass_through',
        paths: { models: '/models', chat: '/chat/completions', images: '/images/generations' },
        models: [
          {
            id: 'a6api/deepseek-chat-v3.1',
            capabilities: ['chat'],
            zero_data_retention: false,
            training_opt_out: false,
          },
        ],
      },
      {
        id: 'baseten',
        class: 'direct',
        base_url: `http://127.0.0.1:${stubPort}/direct/v1`,
        auth_mode: 'gateway_key',
        key_env: 'BASETEN_API_KEY',
        paths: { models: '/models', chat: '/chat/completions', images: '/images/generations' },
        models: [
          {
            id: 'baseten/mammoth-1',
            capabilities: ['chat'],
            zero_data_retention: false,
            training_opt_out: true,
          },
          {
            // Declares retention flags the other direction from mammoth-1: no
            // data retention, but no training opt-out. A route that requires
            // both must refuse this one too, which is the only way to show the
            // two flags are checked independently instead of one implying the
            // other.
            id: 'baseten/zdr-no-training-optout',
            capabilities: ['chat'],
            zero_data_retention: true,
            training_opt_out: false,
          },
        ],
      },
    ],
  };
}

export async function startHarness({ configOverrides = {}, env: extraEnv = {}, stubDown = false, mutateConfig = null } = {}) {
  const dir = tempDir();
  const stub = createStubUpstream();
  let stubPort = 0;
  if (!stubDown) {
    const address = await stub.listen(0, '127.0.0.1');
    stubPort = address.port;
  } else {
    // Bind and immediately release a port so the config points at a closed one.
    const probe = createStubUpstream();
    const address = await probe.listen(0, '127.0.0.1');
    stubPort = address.port;
    await probe.close();
  }

  const raw = stubConfig({ stubPort, dir, overrides: configOverrides });
  // A test that needs a catalogue shape the shared fixture does not carry (an
  // extra model, a different thinking_limit) edits the raw config here instead
  // of duplicating the harness.
  if (mutateConfig) mutateConfig(raw);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2));
  const config = parseConfig(raw, { configPath, baseDir: dir });
  const logPath = path.join(dir, 'gateway.log');
  const env = {
    OPENROUTER_API_KEY: STUB_KEY,
    BASETEN_API_KEY: BASETEN_KEY,
    ...extraEnv,
  };
  const redactor = createRedactor([env.OPENROUTER_API_KEY, env.BASETEN_API_KEY]);
  const logger = createLogger({
    level: 'debug',
    filePath: logPath,
    redactor,
    stdout: { write() {} },
  });
  let gateway = createGateway({ config, env, logger });
  let address = await gateway.listen();

  const harness = {
    dir,
    stub,
    stubPort,
    config,
    env,
    logPath,
    redactor,
    logger,
    configPath,
    get gateway() {
      return gateway;
    },
    get baseUrl() {
      return `http://127.0.0.1:${address.port}`;
    },
    get port() {
      return address.port;
    },
    // Stops the listening server and builds a brand new gateway object over the
    // same config and the same on-disk ledger. This is what "survives a restart"
    // means operationally: a new process reading the persisted counters.
    async restart() {
      await gateway.close();
      gateway = createGateway({ config, env, logger });
      address = await gateway.listen();
      return address;
    },
    async stop() {
      await gateway.close();
      await stub.close();
    },
  };
  return harness;
}

// Small fetch wrapper that returns status, headers and the raw body text.
export async function call(baseUrl, pathName, { method = 'GET', body = null, headers = {}, rawBody = null } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== null) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = init.headers['content-type'] || 'application/json';
  } else if (rawBody !== null) {
    init.body = rawBody;
    init.headers['content-type'] = init.headers['content-type'] || 'application/json';
  }
  const response = await fetch(`${baseUrl}${pathName}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

export function readLog(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

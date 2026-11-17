#!/usr/bin/env node
// Entry point. Everything it needs comes from a JSON config plus environment
// variables; nothing is read from argv except the config path.

import process from 'node:process';
import { loadConfig, ConfigError, isLoopbackHost } from './lib/config.mjs';
import { createGateway, GATEWAY_VERSION } from './lib/gateway.mjs';
import { requireConsentForCloud } from './lib/consent.mjs';
import { raiseFdLimit } from './lib/fdlimit.mjs';

const args = process.argv.slice(2);
let configPath = process.env.GATEWAY_CONFIG || new URL('./gateway.config.example.json', import.meta.url).pathname;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--config') {
    configPath = args[i + 1];
    i += 1;
    if (!configPath) {
      process.stderr.write('--config requires a path\n');
      process.exit(2);
    }
  } else if (arg === '--version') {
    process.stdout.write(`${GATEWAY_VERSION}\n`);
    process.exit(0);
  } else if (arg === '--help' || arg === '-h') {
    process.stdout.write(
      'usage: node server.mjs [--config <path>] [--version]\n'
      + '  GATEWAY_CONFIG       config path (default: gateway.config.example.json)\n'
      + '  GATEWAY_UPSTREAM_KEY provider key (name set by keys.upstream_key_env)\n',
    );
    process.exit(0);
  } else {
    process.stderr.write(`unknown argument: ${arg}\n`);
    process.exit(2);
  }
}

let config;
try {
  config = loadConfig(configPath);
} catch (error) {
  process.stderr.write(`config error: ${error instanceof ConfigError ? error.message : error.message}\n`);
  process.exit(2);
}

// A standalone gateway has no conversation to consult, so it applies the same
// cloud-consent rule the embedding app applies: a route that leaves the device
// is refused with 403 consent_required until the caller sends the consent header.
const gateway = createGateway({ config, authorize: requireConsentForCloud({ config }) });

// Raised before any socket is accepted, and reported either way: an operator who
// sees 1024 here knows exactly why streaming stalls under load.
const fdLimit = raiseFdLimit({ target: config.listen.openFilesTarget });

// Startup declares the mode it is in and the switches that change its
// behaviour. Body logging is off by default; when it is on, it says so loudly.
gateway.logger.info('gateway_starting', {
  version: GATEWAY_VERSION,
  config: config.configPath,
  listen: `${config.listen.host}:${config.listen.port}`,
  default_route: config.route.default,
  upstreams: config.upstreams.map((u) => ({
    id: u.id,
    class: u.class,
    auth_mode: u.authMode,
    models: u.models.map((m) => m.id),
    zero_data_retention: u.models.every((m) => m.zeroDataRetention),
  })),
  allowlist_size: config.modelIndex.size,
  keys: [...gateway.keys.entries()].map(([upstream, k]) => ({
    upstream,
    env: k.envName,
    configured: k.configured,
    usable: k.usable,
  })),
  quota: {
    requests_per_day: config.quota.requestsPerDay,
    tokens_per_day: config.quota.tokensPerDay,
    ledger: config.quota.ledgerPath,
  },
  log_file: config.logging.file,
  log_request_bodies: config.logging.logRequestBodies,
});

const missing = [...gateway.keys.entries()].filter(([, k]) => !k.configured);
const tooShort = [...gateway.keys.entries()].filter(([, k]) => k.configured && !k.usable);
if (missing.length > 0) {
  gateway.logger.warn('gateway_key_missing', {
    upstreams: missing.map(([id]) => id),
    envs: missing.map(([, k]) => k.envName),
    message: `no provider key for ${missing.map(([id]) => id).join(', ')}: those upstreams will refuse with 503; pass-through (BYOK) upstreams still work`,
  });
}
if (tooShort.length > 0) {
  gateway.logger.error('gateway_key_too_short', {
    upstreams: tooShort.map(([id]) => id),
    envs: tooShort.map(([, k]) => k.envName),
    message: 'a provider key shorter than 8 characters is refused',
  });
}

if (config.logging.logRequestBodies) {
  gateway.logger.warn('request_body_logging_enabled', {
    message: 'DEVELOPMENT MODE: logging.log_request_bodies is true, so full prompt bodies are written to this log. Do not run this configuration with real user content.',
  });
  process.stderr.write(
    'WARNING: request-body logging is ENABLED (logging.log_request_bodies=true). '
    + 'Full prompt content will be written to the gateway log.\n',
  );
}

const address = await gateway.listen();
gateway.logger.info('gateway_listening', {
  url: `http://${config.listen.host}:${address.port}`,
  version: GATEWAY_VERSION,
});
gateway.logger.info('fd_limit', {
  soft: fdLimit.soft,
  hard: fdLimit.hard,
  target: config.listen.openFilesTarget,
  raised: fdLimit.raised,
  supported: fdLimit.supported,
  source: fdLimit.source,
  note: fdLimit.note,
});
process.stdout.write(
  `open-file limit: soft=${fdLimit.soft ?? 'unknown'} hard=${fdLimit.hard ?? 'unknown'} `
  + `(target ${config.listen.openFilesTarget}, ${fdLimit.raised ? 'raised in-process' : 'not raised in-process'})\n`,
);
if (fdLimit.soft !== null && fdLimit.soft < 4096) {
  process.stdout.write(
    'WARNING: the open-file soft limit is low. Concurrent SSE relays need roughly two descriptors '
    + 'each. Run the gateway through start.sh, which raises the limit with ulimit -n before exec; a '
    + 'user-space start cannot exceed the hard limit.\n',
  );
}
if (!isLoopbackHost(config.listen.host)) {
  gateway.logger.warn('non_loopback_bind', {
    host: config.listen.host,
    message: 'listen.allow_non_loopback_bind is set, so the gateway is reachable beyond loopback. This host is shared; reconsider and prefer an SSH tunnel.',
  });
}
gateway.logger.info('listen_address', {
  host: config.listen.host,
  port: address.port,
  loopback_only: isLoopbackHost(config.listen.host),
  allow_non_loopback_bind: config.listen.allowNonLoopbackBind,
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  gateway.logger.info('gateway_stopping', { signal });
  await gateway.close();
  process.exit(0);
}
process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

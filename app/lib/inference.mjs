import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseConfig } from '../../gateway/lib/config.mjs';
import { createGatewayHandler } from '../../gateway/lib/gateway.mjs';
import { createChatHandler } from '../../gateway/lib/chat.mjs';
import { createUpstreamKeys } from '../../gateway/lib/upstream.mjs';
import { createDecisionPlane } from '../../gateway/lib/decision-plane.mjs';
import {
  AGENT_ROLES,
  MODEL_REGISTRY,
  ROLE_IDS,
  classifyAgentRole,
  normalizeRole,
  resolveRequestModelWithPolicy,
  resolveRoleModelChain,
} from '../../gateway/lib/selection.mjs';
import { enforceRoute, resolveRoute } from '../../gateway/lib/policy.mjs';
import { resolveIdentity } from '../../gateway/lib/identity.mjs';
import { GatewayError } from '../../gateway/lib/errors.mjs';
import {
  screenOutbound,
  getVault,
  restoreJsonPayload,
  createStreamRestorer,
  PRIVACY_CODES,
} from '../privacy/index.mjs';

export const runtimeProvider = 'harness-local';
export const runtimeModel = 'auto';

export function createInference({ raw, appRoot, stateDir, identity = 'local-user', sessions, env, stdout }) {
  const parsed = parseConfig(raw, { baseDir:appRoot });
  if (parsed.logging.logRequestBodies) throw new Error('The local harness forbids prompt-body logging');
  // The config file's `route.default` (e.g. `any_cloud`) is authoritative;
  // local_only requests still require a server_local upstream, and cloud routes
  // still require explicit session consent in `authorize()`.
  const config = parsed;
  resolveIdentity(config.quota.identityHeader,{ [config.quota.identityHeader]:identity });
  if (config.chatModels.length === 0) throw new Error('The local harness requires a configured chat upstream');
  const localModels = config.chatModels.filter(e => e.upstream.class === 'server_local');
  const localConfig = { ...config, chatModels:localModels };

  // The remote decision plane: the upstream whose models are resolved per request
  // by the remote decision model (`combo/*`). Reachability is probed, cached and
  // reported — never assumed, and never allowed to be silent: when the probe says
  // it is down, the role's declared local chain serves the request and the
  // selection says so.
  const planeEnv = env ?? process.env ?? {};
  const upstreamKeys = createUpstreamKeys(config, planeEnv);
  const decisionEntries = config.chatModels.filter(e => e.model.metadata?.decision_model === true);
  const decisionUpstream = decisionEntries.length > 0 ? decisionEntries[0].upstream : null;
  const planeTimeoutMs = Number.parseInt(String(planeEnv.AI_DECISION_PLANE_TIMEOUT_MS ?? ''),10);
  const planeTtlMs = Number.parseInt(String(planeEnv.AI_DECISION_PLANE_TTL_MS ?? ''),10);
  const decisionPlane = createDecisionPlane({
    upstreamId: decisionUpstream?.id ?? null,
    baseUrl: decisionUpstream?.baseUrl ?? null,
    modelsPath: decisionUpstream?.paths?.models ?? '/models',
    keyValue: decisionUpstream ? (upstreamKeys.get(decisionUpstream.id)?.value ?? null) : null,
    ...(Number.isInteger(planeTimeoutMs) && planeTimeoutMs > 0 ? { timeoutMs:planeTimeoutMs } : {}),
    ...(Number.isInteger(planeTtlMs) && planeTtlMs > 0 ? { ttlMs:planeTtlMs } : {}),
  });
  // The probe belongs to one request, so its result is held per async context
  // rather than in a shared variable that a concurrent turn could overwrite.
  const decisionStore = new AsyncLocalStorage();

  function routePolicy(args) {
    if (args.route !== 'local_only') return enforceRoute(args);
    if ((args.entry && args.entry.upstream.class !== 'server_local') || (!args.entry && localModels.length === 0)) {
      throw new GatewayError(400,'local_only_not_served',
        'local_only requires an allowlisted on-device loopback upstream; a cloud provider is never a fallback',
        { type:'permission_error',param:'route' });
    }
    return args.route;
  }
  const chatHandler = createChatHandler({
    routePolicy,
    modelResolver(args) {
      const body = { ...args.body };
      let role = args.role ?? body.role ?? body.agent_role ?? null;
      // OMP needs a concrete transport model. This app-owned alias deliberately
      // leaves the real choice to the shared selector on every request.
      if (body.model === runtimeModel || body.model === `${runtimeProvider}/${runtimeModel}`) {
        delete body.model;
      } else if (typeof body.model === 'string') {
        const stripped = body.model.startsWith(`${runtimeProvider}/`)
          ? body.model.slice(runtimeProvider.length + 1)
          : body.model;
        if (stripped.startsWith('auto:')) {
          const roleAlias = normalizeRole(stripped.slice('auto:'.length));
          if (roleAlias) role = role ?? roleAlias;
          delete body.model;
        } else if (ROLE_IDS.includes(stripped)) {
          role = role ?? stripped;
          delete body.model;
        }
      }
      return resolveRequestModelWithPolicy(
        { ...args, body, role, config: args.route === 'local_only' ? localConfig : config,
          decisionPlane: decisionStore.getStore()?.plane ?? decisionPlane },
        routePolicy,
      );
    }
  });

  // Pre-send Privacy Gate (SEC-01 / SEC-02):
  // 1. Detects across the whole envelope (messages.content, array blocks,
  //    tool_calls.arguments, role: "tool" payloads, and prompts).
  // 2. Confirmed secrets trigger default action BLOCK (HTTP 422 privacy_guard_blocked)
  //    before quota reservation and upstream dispatch; upstream is NEVER called.
  // 3. Ambiguous high-risk credentials/national-IDs fail closed (422 unverifiable)
  //    when the SLM is absent or times out.
  // 4. Dual-form session-scoped pseudonyms replace sensitive spans.
  // 5. Mandatory re-verification of the serialized wire payload before dispatch
  //    (HTTP 422 privacy_guard_recheck_failed if any secret, checksummed PII,
  //    or raw vault value survives).
  // 6. Response placeholders are restored in both assistant text and inside
  //    tool_calls[].function.arguments (non-streaming and SSE).
  async function maskedChatHandler(context) {
    const { req, res, body, helmet } = context;
    // Derive session ID strictly from authenticated server-side header, never from client body.user (A6)
    const token = req.headers['x-app-session'];
    const matchingSession = token ? [...sessions.values()].find(s => !s.stopped && !s.failed && s.token === token) : null;
    const sessionId = matchingSession ? matchingSession.id : (token || null);
    const privacyState = matchingSession?.privacyState || 'mask';
    const route = String(req.headers['x-route'] ?? (typeof body?.route === 'string' ? body.route : '')).toLowerCase() || 'local_only';

    // Cloud requests probe the remote decision plane after authorization.
    if (route === 'any_cloud' || route === 'zdr_cloud' || route === 'openrouter-zdr' || route === 'a6api' || route === 'opencodex-nace') {
      await decisionPlane.check();
    }

    // Unified pre-send gate: scanning, blocking secrets, pseudonymizing, and wire recheck.
    // privacyState may enforce stricter policy ('strict' vs 'mask'), but masking can NEVER be disabled on cloud routes.
    const screenResult = await screenOutbound({ body, sessionId, route, purpose: 'chat', privacyState });
    if (screenResult.action === 'blocked') {
      helmet.logger.warn('privacy_guard_blocked', {
        session: sessionId,
        code: screenResult.code,
        reason: screenResult.reason,
        counts: screenResult.report?.counts ?? {},
        fingerprint: screenResult.report?.fingerprint ?? null,
      });
      throw new GatewayError(screenResult.status || 422, screenResult.code || PRIVACY_CODES.blocked,
        `Privacy Guard refused outbound request: ${screenResult.reason}`,
        { type: 'privacy_guard_error', code: screenResult.code, fingerprint: screenResult.report?.fingerprint });
    }

    const maskedBody = screenResult.body;
    const vault = screenResult.vault || getVault(sessionId);

    if (screenResult.report?.total > 0) {
      helmet.logger.info('pii_masked', {
        session: sessionId,
        counts: screenResult.report.counts,
        total_placeholders: screenResult.report.total,
        fingerprint: screenResult.report.fingerprint,
      });
    }

    // Intercept response to restore placeholders
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalWriteHead = res.writeHead.bind(res);

    let isSse = false;
    let streamRestorer = null;
    const responseBodyBuffer = [];

    res.writeHead = function (statusCode, headers) {
      const contentType = headers?.['content-type'] || headers?.['Content-Type'] || '';
      if (String(contentType).includes('text/event-stream')) {
        isSse = true;
        if (vault.size > 0) streamRestorer = createStreamRestorer(vault);
      }
      if (vault.size > 0 && headers && typeof headers === 'object') {
        // The declared length belongs to the pre-restoration body; restoring a
        // pseudonym changes the byte count, and a stale `content-length` either
        // truncates the reply or leaves the client waiting on bytes that never
        // come (the socket then closes and the caller sees `terminated`).
        const clean = { ...headers };
        for (const key of Object.keys(clean)) {
          if (key.toLowerCase() === 'content-length') delete clean[key];
        }
        return originalWriteHead(statusCode, clean);
      }
      return originalWriteHead(statusCode, headers);
    };

    res.write = function (chunk, encoding, callback) {
      if (vault.size === 0) {
        return originalWrite(chunk, encoding, callback);
      }

      if (isSse && streamRestorer) {
        const restoredChunk = streamRestorer.processChunk(chunk);
        if (restoredChunk && restoredChunk.length > 0) {
          return originalWrite(restoredChunk, callback);
        }
        if (typeof callback === 'function') callback();
        return true;
      }

      // Non-streaming JSON buffering
      if (chunk) {
        responseBodyBuffer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));
      }
      if (typeof callback === 'function') callback();
      return true;
    };

    res.end = function (chunk, encoding, callback) {
      if (vault.size === 0) {
        return originalEnd(chunk, encoding, callback);
      }

      if (isSse && streamRestorer) {
        if (chunk) {
          const restoredChunk = streamRestorer.processChunk(chunk);
          if (restoredChunk && restoredChunk.length > 0) originalWrite(restoredChunk);
        }
        const finalChunk = streamRestorer.flush();
        if (finalChunk && finalChunk.length > 0) originalWrite(finalChunk);
        return originalEnd(callback);
      }

      if (chunk) {
        responseBodyBuffer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));
      }

      const fullBuffer = Buffer.concat(responseBodyBuffer);
      if (fullBuffer.length === 0) {
        // `originalEnd(callback)` would pass the callback as the body: the socket
        // closes without a response and the client sees `TypeError: terminated`.
        return originalEnd();
      }

      let outBuffer = fullBuffer;
      try {
        const json = JSON.parse(fullBuffer.toString('utf8'));
        const restoredJson = restoreJsonPayload(json, vault);
        outBuffer = Buffer.from(JSON.stringify(restoredJson), 'utf8');
      } catch {
        // If not valid JSON, write verbatim
        outBuffer = fullBuffer;
      }
      // `sendJson` computed `content-length` for the pre-restoration body. A
      // pseudonym being replaced by the real value changes the byte count, so a
      // stale length truncates or overruns the client's parser — recompute it.
      if (outBuffer !== fullBuffer && !res.headersSent && res.getHeader('content-length') !== undefined) {
        res.setHeader('content-length', String(outBuffer.length));
      }
      return originalEnd(outBuffer, 'utf8', callback);
    };

    return decisionStore.run({ plane: decisionPlane }, () => chatHandler({ ...context, body: maskedBody }));
  }

  const handler = createGatewayHandler({
    config,env,stdout,chatHandler: maskedChatHandler,privacyGate: screenOutbound,
    authorize({ req,body,identity:requestIdentity }) {
      const route = resolveRoute({ headerValue:req.headers['x-route'],bodyValue:body.route,config });
      const token = req.headers['x-app-session'];
      const session = [...sessions.values()].find(s => !s.stopped && !s.failed && s.token === token && token);
      if (token && (!session || session.route !== route || session.identity !== requestIdentity)) {
        throw new GatewayError(403,'session_route_mismatch','The runtime request does not match its conversation',{ type:'permission_error' });
      }
      if (route !== 'local_only' && (!session || session.consent !== true)) {
        throw new GatewayError(403,'consent_required','Cloud requests require this conversation’s explicit consent',{ type:'permission_error' });
      }
      // A pass-through credential, like a held provider key, must not escape in
      // an upstream echo or error. The base logger remains the final redactor.
      handler.helmet.redactor.add(req.headers.authorization);
    }
  });
  const agentDir = resolve(stateDir,'agent');
  const modelsFile = resolve(agentDir,'models.yml');
  let endpoint = null;
  function prepareRuntime(baseUrl, backgroundConfig = null) {
    const url = new URL(baseUrl);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/v1') throw new Error('The runtime endpoint must be this app’s loopback /v1 endpoint');
    mkdirSync(agentDir,{ recursive:true });
    let existingRoute = 'OMP_BRIDGE_ROUTE';
    try {
      const match = readFileSync(modelsFile,'utf8').match(/["']?x-route["']?\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,\s#}]+))/);
      if (match) existingRoute = (match[1] ?? match[2] ?? match[3] ?? '').trim() || existingRoute;
    } catch {}

    const providers = {
      [runtimeProvider]: {
        baseUrl,api:'openai-completions',auth:'none',
        headers:{ 'x-route':existingRoute,[config.quota.identityHeader]:'OMP_BRIDGE_IDENTITY','x-app-session':'OMP_BRIDGE_SESSION' },
        models:[{
          id:runtimeModel,
          name:'Harness automatic selection',
          contextWindow:32768,
          maxTokens:4096,
          reasoning:false,
          ...(backgroundConfig?.enabled ? { compactionModel: `${backgroundConfig.provider || 'harness-local-small'}/${backgroundConfig.model || 'small-background'}` } : {})
        }]
      }
    };

    if (backgroundConfig?.enabled) {
      const bgProvider = backgroundConfig.provider || 'harness-local-small';
      const bgModel = backgroundConfig.model || 'small-background';
      providers[bgProvider] = {
        baseUrl: backgroundConfig.endpoint || 'http://127.0.0.1:11434/v1',
        api: 'openai-completions',
        auth: 'none',
        headers: { 'x-route': existingRoute },
        models: [{
          id: bgModel,
          name: 'Harness small background model',
          contextWindow: backgroundConfig.contextWindow || 16384,
          maxTokens: backgroundConfig.maxTokens || 2048,
          reasoning: false
        }]
      };
    }

    const models = { providers };
    writeFileSync(modelsFile,JSON.stringify(models,null,2) + '\n',{ mode:0o600 });
    endpoint = baseUrl;
  }
  return {
    ...handler,config,identity,agentDir,modelsFile,prepareRuntime,
    decisionPlane,
    roles: AGENT_ROLES,
    modelRegistry: MODEL_REGISTRY,
    classifyRole: classifyAgentRole,
    resolveRoleChain: resolveRoleModelChain,
    get endpoint() { return endpoint; },
    runtimeEnv(session) {
      if (!endpoint) throw new Error('The local compatible endpoint is not ready');
      handler.helmet.redactor.add(session.token);
      return {
        PI_CODING_AGENT_DIR:agentDir,OMP_PROFILE:'',PI_PROFILE:'',PI_CONFIG_FILES:'',
        OMP_BRIDGE_ROUTE:session.route,OMP_BRIDGE_IDENTITY:identity,OMP_BRIDGE_SESSION:session.token
      };
    },
    selection(session) { return handler.helmet.redactor.value(handler.helmet.selectionRecord.get(session.identity,session.route)); }
  };
}


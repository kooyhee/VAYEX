import http from 'node:http';
import { statSync, readFileSync, existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, stat, rename, unlink, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { upgrade } from './websocket.mjs';
import { launchArguments, negotiation, isReady, readyLimits, negotiationResult, allowedCommand, FrameDecoder, physicalFrameLimit, logicalFrameLimit } from './public/protocol.js';

// Privacy redaction: full sanitizer with deterministic fallback if privacy package is absent.
let privacyModule = null;
try {
  privacyModule = await import('./privacy/index.mjs');
} catch {
  privacyModule = null;
}
export function sanitizeDiagnostics(text) {
  if (privacyModule?.redactForLog) return privacyModule.redactForLog(text);
  let str = String(text ?? '');
  str = str.replace(/\b[0-9]{6}-[1-8][0-9]{6}\b/g, '[REDACTED:korean_rrn]');
  str = str.replace(/\b(?:[0-9]{4}[- ]){3}[0-9]{4}\b/g, '[REDACTED:credit_card_luhn]');
  str = str.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED:email_address]');
  str = str.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED:aws_key]');
  str = str.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED:provider_key]');
  str = str.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED:jwt_token]');
  str = str.replace(/-----BEGIN (?:[A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]*)PRIVATE KEY-----/g, '[REDACTED:private_key]');
  str = str.replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/gi, '[REDACTED:db_uri]');
  return str;
}

// Loaded on first bridge creation rather than at import time, so this module stays
// loadable (and its own fail-closed startup errors stay reportable) even in a
// bundle that carries no gateway directory beside it.
let rolePlanner = null;
async function loadRolePlanner() {
  rolePlanner ??= await import('../gateway/lib/decision-planner.mjs');
  return rolePlanner;
}
// Same rule for the DX cost feed: the bridge reads gateway events on each
// aggregation, so the module is resolved then, not while this file is parsed.
let gatewayEventFeed = null;
async function loadGatewayEvents() {
  gatewayEventFeed ??= await import('../gateway/lib/events.mjs');
  return gatewayEventFeed;
}

const root = dirname(fileURLToPath(import.meta.url));
export const localRuntime = {
  bun:resolve(root,'../.omp-runtime/node_modules/bun/bin/bun.exe'),
  cli:resolve(root,'../.omp-runtime/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js')
};
const defaults = { coreArgs:[], coreEnv:{}, local:{ label:'로컬 코딩 모델', provider:'openai', model:'', endpoint:'' }, background:{ label:'전용 백그라운드 모델', provider:'openai', model:'', endpoint:'' }, cloud:null };
// WHATWG `URL.hostname` keeps an IPv6 literal bracketed ("[::1]"), so the bracket
// form is what actually arrives here; bare "::1" never does. Forms this refuses —
// 127.0.0.2, [::ffff:127.0.0.1] — are outside the allowlist on purpose: refusing
// is the fail-closed direction, so the allowlist stays narrow rather than growing
// a second way to reach the local plane.
function isLoopbackEndpoint(endpoint) {
  let host;
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch { return false; }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1,-1);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
// The `local` slot is the on-host plane. This process serves `local_only` only
// for a configured server_local upstream, so pointing this slot at a remote origin would either claim a traversal
// that never happens or route around that refusal; a non-loopback address is
// therefore reported unusable instead of being probed.
const localMustBeLoopback = '로컬 슬롯은 루프백 엔드포인트만 조회합니다. 원격 주소는 조회하지 않으므로 사용할 수 없습니다.';
// The background slot may hold a cloud model, so a remote origin is legal there.
// Probing it while the page loads would be an off-device request sent before any
// route or consent exists, so an off-device slot that names no route is left
// uncontacted. `available` stays a boolean because the UI renders it as one; the
// reason carries the distinction between "not reachable" and "not sent".
const offDeviceNeedsRoute = '기기 밖 엔드포인트는 경로(route)를 명시해야 조회합니다. 동의 없이 조회하지 않았습니다.';
/**
 * How one asset read failure is answered. A blanket 500 hid the difference
 * between an asset that is simply not on disk (permanent, and named here) and a
 * read that genuinely failed; a mid-write file is not a read failure at all, its
 * short content is served with 200 and never reaches this function.
 * @returns {{status:number,body:string,retry:boolean}}
 */
export function assetFailure(name, error) {
  const code = error?.code ?? 'unknown';
  if (code === 'ENOENT' || code === 'ENOTDIR') return { status:404, body:`Asset missing: public/${name}`, retry:false };
  if (code === 'EISDIR') return { status:500, body:`Asset path is a directory, not a file: public/${name}`, retry:false };
  if (['EBUSY','EPERM','EACCES','EMFILE','ENFILE'].includes(code)) return { status:503, body:`Asset temporarily unreadable (${code}): public/${name}`, retry:true };
  return { status:500, body:`Asset read failed (${code}): public/${name}`, retry:false };
}
// Route values the shared policy module defines. The bridge sends one of these
// verbatim so the in-process policy applies it; it invents no fourth value and
// does not translate a conversation's choice into a different plane.
export const ROUTE_HEADER = 'x-route';
export const routeValues = ['local_only','zdr_cloud','any_cloud'];
const cloudRoutes = new Set(['zdr_cloud','any_cloud']);
const consentRequired = '클라우드 경로는 이 대화의 명시적 전송 동의 없이는 보내지 않습니다.';
/**
 * The header for one outbound model request. A cloud value is withheld — headers
 * are null — unless this conversation carries explicit consent, so the refusal
 * happens before a socket is opened rather than as a rejected request.
 * @returns {{headers:Record<string,string>|null, reason:string|null}}
 */
export function routeHeaders(route, consent) {
  if (!routeValues.includes(route)) return { headers:null, reason:`알 수 없는 경로 값입니다: ${route}` };
  if (cloudRoutes.has(route) && consent !== true) return { headers:null, reason:consentRequired };
  return { headers:{ [ROUTE_HEADER]:route }, reason:null };
}
/**
 * The route one conversation runs on. A WebSocket connection is one conversation,
 * so its route and consent are read from that connection only and die with it: a
 * later session starts on the local plane with no consent, and never inherits an
 * earlier conversation's. An unreadable value fails closed to local_only.
 *
 * The consent toggle and the route are one decision, not two: with consent off a
 * cloud route can never be the active route, so the conversation runs on
 * `local_only` and the request that was asked for is reported as `requested`.
 * That keeps startup honest — the page is told the route it is actually on
 * rather than being refused for a route it never could have used.
 * @returns {{route:string, consent:boolean, invalid:string|null,
 *            requested:string|null, fallback:string|null, active:string}}
 */
export function conversationRoute(params) {
  const asked = params.get('route');
  const consent = ['1','true','yes','on'].includes(String(params.get('consent') ?? '').toLowerCase());
  if (asked === null) {
    return { route:'local_only', consent:false, invalid:null, requested:null, fallback:null, active:'local_only' };
  }
  if (!routeValues.includes(asked)) {
    return { route:'local_only', consent:false, invalid:asked, requested:asked, fallback:'invalid_route', active:'local_only' };
  }
  // Consent off: the cloud choice is recorded as a request, never as the route.
  if (cloudRoutes.has(asked) && !consent) {
    return { route:'local_only', consent:false, invalid:null, requested:asked, fallback:'consent_off', active:'local_only' };
  }
  return { route:asked, consent, invalid:null, requested:asked, fallback:null, active:asked };
}
async function availability(entry, { slot = 'local', conversation = { route:null, consent:false } } = {}) {
  if (!entry?.endpoint || !entry.model) return { ...entry, available:false, reason:'모델 또는 엔드포인트가 설정되지 않았습니다.' };
  const loopback = isLoopbackEndpoint(entry.endpoint);
  if (slot === 'local' && !loopback) return { ...entry, available:false, reason:localMustBeLoopback };
  // The route this request declares to the plane it reaches. The conversation's own
  // cloud choice wins, then what the config declares for that endpoint — a loopback
  // port may be an SSH forward, so an explicit cloud declaration there is honoured
  // and gated rather than being relabelled local. Only an on-host endpoint with no
  // declaration is labelled local_only, the sole truthful label for a request that
  // does not leave the device. Off the device with no route, nothing is sent.
  const chosen = cloudRoutes.has(conversation.route) ? conversation.route : null;
  const declared = chosen ?? entry.route ?? (loopback ? 'local_only' : null);
  if (!declared) return { ...entry, available:false, reason:offDeviceNeedsRoute };
  // The gate runs before the URL is built, so a cloud route without this
  // conversation's explicit consent refuses here and no socket is opened.
  const gate = routeHeaders(declared, conversation.consent === true);
  if (!gate.headers) return { ...entry, available:false, declaredRoute:declared, reason:gate.reason };
  try {
    const url = new URL(entry.endpoint);
    if (!['http:','https:'].includes(url.protocol)) throw new Error('invalid endpoint');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
    const response = await fetch(url, { signal:AbortSignal.timeout(2500), redirect:'error', headers:gate.headers });
    if (!response.ok) throw new Error('endpoint refused');
    const body = await response.json();
    const available = Array.isArray(body.data) && body.data.some(x => x.id === entry.model);
    return { ...entry, available, declaredRoute:declared, reason:available ? '엔드포인트의 모델 목록에서 확인됨' : '엔드포인트에 지정한 모델이 없습니다.' };
  } catch { return { ...entry, available:false, declaredRoute:declared, reason:'엔드포인트에 연결할 수 없습니다.' }; }
}
/**
 * The agent directory omp reads `models.yml` from, resolved from the same
 * environment the core is launched with: an explicit `PI_CODING_AGENT_DIR`, a
 * named profile, or the default `.<config dir>/agent` under HOME/USERPROFILE.
 */
function agentDirectory(env) {
  const configDirName = env.PI_CONFIG_DIR || '.omp';
  const home = env.HOME || env.USERPROFILE || '';
  const profile = env.OMP_PROFILE;
  return env.PI_CODING_AGENT_DIR || (profile ? resolve(home,configDirName,'profiles',profile,'agent') : resolve(home,configDirName,'agent'));
}
/** Both model files omp accepts, in the order it reads them. */
function modelFiles(agentDir) {
  const yml = resolve(agentDir,'models.yml'), json = resolve(agentDir,'models.json');
  return [...new Set([yml,json])];
}
/**
 * The `x-route` header a launch would actually cause, checked before anything is
 * spawned. omp resolves a models.yml header value per request, and when that value
 * names an unset variable it sends the bare name instead of omitting the header
 * (observed: the literal string `OMP_BRIDGE_ROUTE`). The bridge therefore emulates
 * that resolution and refuses the launch on any mismatch — a bare variable name, an
 * empty value, or a literal that disagrees with the conversation — so a wrong route
 * never leaves the machine even though the in-process policy also refuses these values.
 * Both YAML and single-line JSON forms are read, because a JSON file would otherwise
 * hide the entry on one line.
 * @returns {string|null} a description of the offending header, or null when safe
 */
export function routeHeaderProblem(env, route) {
  const agentDir = agentDirectory(env);
  const entries = /["']?x-route["']?\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,\s#}]+))/g;
  for (const file of modelFiles(agentDir)) {
    let text;
    try { if (!statSync(file).isFile()) continue; text = readFileSync(file,'utf8'); }
    catch { continue; }
    for (const match of text.matchAll(entries)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      const line = text.slice(0,match.index).split('\n').length;
      // Faithful to omp: a non-empty environment value wins, otherwise the literal
      // config value is sent as-is — which is how a bare variable name escapes.
      const sent = env[value] || value;
      if (sent !== route) return `${file}:${line} "x-route: ${value}" sends "${sent}", not this conversation's "${route}"`;
    }
  }
  return null;
}
/**
 * The identity the core actually sends, read from the same `models.yml` header the
 * launch check reads (`x-user-id`) and resolved the way omp resolves a header value:
 * a non-empty environment value wins, otherwise the literal is sent. Two different
 * values, or none at all, mean this conversation has no single identity to read the
 * recorded decision with, so nothing is read rather than an identity being guessed.
 * @returns {string|null}
 */
export function selectionIdentity(env) {
  const values = new Set();
  for (const file of modelFiles(agentDirectory(env))) {
    let text;
    try { if (!statSync(file).isFile()) continue; text = readFileSync(file,'utf8'); }
    catch { continue; }
    for (const match of text.matchAll(/["']?x-user-id["']?\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,\s#}]+))/g)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      if (value) values.add(env[value] || value);
    }
  }
  return values.size === 1 ? [...values][0] : null;
}
// One bounded read per finished turn, used only by the detached-endpoint path. A
// short timeout and no retry are the whole retry policy: an endpoint that is slow,
// absent or answering an error is simply a conversation with no selection to
// report, never a failed prompt round-trip.
export const selectionReadTimeout = 1500;
/**
 * The last decision recorded by a detached gateway for one identity+route (`GET {endpoint}/selection`).
 * Read-only, loopback-only, and never thrown: the identity header and the local
 * address stay inside this process and out of the page, an endpoint this bridge
 * would not probe is not read, and every failure is the same answer — `null`.
 * @returns {Promise<object|null>}
 */
export async function readSelection({ endpoint, route, identity, timeout = selectionReadTimeout, fetchImpl = fetch }) {
  if (!endpoint || !identity || !routeValues.includes(route) || !isLoopbackEndpoint(endpoint)) return null;
  let url;
  try {
    url = new URL(endpoint);
    if (!['http:','https:'].includes(url.protocol)) return null;
    // The configured chat endpoint already carries `/v1`, so the read path is
    // appended to it rather than rebuilt from the origin.
    url.pathname = `${url.pathname.replace(/\/+$/,'')}/selection`;
    url.search = '';
  } catch { return null; }
  try {
    const response = await fetchImpl(url,{
      method:'GET',
      redirect:'error',
      signal:AbortSignal.timeout(timeout),
      headers:{ 'x-user-id':identity,[ROUTE_HEADER]:route }
    });
    if (!response.ok) return null;
    const body = await response.json();
    const selection = body && typeof body === 'object' ? body.selection : null;
    return selection && typeof selection === 'object' && !Array.isArray(selection) ? selection : null;
  } catch { return null; }
}
/** A frame that says a turn finished: the core's own result frame. */
function turnResultFrame(frame) {
  if (frame?.type === 'prompt_result') return true;
  return typeof frame?.agentInvoked === 'boolean' && ['completed','aborted','error'].includes(frame.status);
}
/**
 * Resolve the file a `--config` / `--extension` / `-e` value names. A value names a
 * file of this app, so the app root is the first candidate; the bundled config also
 * names `app/memory/extension.mjs` from the project root, which is the second. Only a
 * path that exists is chosen, so a typo still resolves to the app-root path and the
 * core reports it as missing instead of loading some other file.
 * @param {string[]} coreArgs
 * @returns {string[]}
 */
export function resolveCoreArgs(coreArgs = []) {
  return (coreArgs ?? []).map((arg, idx, arr) => {
    if (idx > 0 && (arr[idx - 1] === '--config' || arr[idx - 1] === '--extension' || arr[idx - 1] === '-e') && typeof arg === 'string' && !arg.startsWith('-')) {
      const candidates = [resolve(root, arg), resolve(root, '..', arg)];
      return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
    }
    return arg;
  });
}
export async function createBridge(options = {}) {
  const lifecycleTimers = options.lifecycleTimers ?? { setTimeout,clearTimeout };
  const mock = options.mock ?? false;
  const { AGENT_ROLES, classifyAgentRole, resolveRoleModelChain } = await loadRolePlanner();
  const gatewayEvents = await loadGatewayEvents();
  if (options.config !== undefined && (!options.config || typeof options.config !== 'object' || Array.isArray(options.config))) throw new Error('App config must be an object');
  const config = { ...defaults, ...options.config };
  if (!Array.isArray(config.coreArgs) || !config.coreArgs.every(x => typeof x === 'string')) throw new Error('coreArgs must be an array of strings');
  if (!config.coreEnv || typeof config.coreEnv !== 'object' || !Object.values(config.coreEnv).every(x => typeof x === 'string')) throw new Error('coreEnv must contain string values');
  const sessions = new Map(), children = new Set();
  // One memory database for both faces. `/api/memory` and the extension inside the
  // core child used to resolve their own defaults (`<stateDir>/memory` vs
  // `app/memory/data`), so the agent wrote rows the HTTP router never read. Both now
  // take these two values: the router directly, the child through the environment
  // variables `app/memory/config.mjs` already honors. An explicit
  // OMP_MEMORY_ROOT / OMP_MEMORY_DATA_DIR still wins for both, unchanged.
  const memoryRoot = resolve(process.env.OMP_MEMORY_ROOT ?? resolve(root, '..'));
  const memoryDataDir = resolve(process.env.OMP_MEMORY_DATA_DIR ?? resolve(config.stateDir ?? resolve(root, 'data'), 'memory'));
  const inference = config.inference ? (await import('./lib/inference.mjs')).createInference({
    raw:config.inference,appRoot:root,stateDir:resolve(config.stateDir ?? resolve(root,'data')),
    identity:config.identity ?? 'local-user',sessions,env:{ ...process.env,...config.coreEnv,...options.coreEnv },stdout:options.stdout
  }) : null;
  let closing = false;
  const assets = {
    '/':['index.html','text/html; charset=utf-8'],
    '/styles.css':['styles.css','text/css; charset=utf-8'],
    '/app.js':['app.js','text/javascript; charset=utf-8'],
    '/protocol.js':['protocol.js','text/javascript; charset=utf-8'],
    '/activity.js':['activity.js','text/javascript; charset=utf-8'],
    '/insight.js':['insight.js','text/javascript; charset=utf-8'],
    '/visualize.js':['visualize.js','text/javascript; charset=utf-8'],
    '/session-report.js':['session-report.js','text/javascript; charset=utf-8'],
    '/preview-inspector.js':['preview-inspector.js','text/javascript; charset=utf-8']
  };
  const sharedDxRouter = options.dxRouter ?? (await import('./dx/routes.mjs')).createDxRouter({
    projectRoot: resolve(config.previewRoot ?? resolve(root, '../booth/sample-project')),
    stateDir: resolve(config.stateDir ?? resolve(root, 'data'), 'dx'),
    // The agent edits the tree it runs in, not the preview root detection reports on.
    editRoot: resolve(config.coreCwd ?? root),
    // A real turn reports its accounting as a gateway `llm_turn` event; the DX cost
    // overview reads that same stream so its figures are actual turns, not fixtures.
    eventsFrom: () => gatewayEvents.events({ type: 'llm_turn' }),
    resolveMemoryLayer: async () => {
      const { getMemoryLayer } = await import('./memory/index.mjs');
      return getMemoryLayer({ root:memoryRoot, dataDir:memoryDataDir });
    }
  });
  const previewDir = resolve(config.previewRoot ?? resolve(root, '../booth/sample-project'));
  // Deliverable documents live beside the rest of this app's state.
  const stateRoot = resolve(config.stateDir ?? resolve(root, 'data'));
  const visualizeDir = resolve(stateRoot, 'visualizations');
  const safeName = value => String(value ?? 'session').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64) || 'session';
  // A document version is named by the content hash; anything that is not one is
  // treated as "current content" rather than reaching the filesystem as a path.
  const parseHash = value => {
    const text = String(value ?? '');
    return /^[0-9a-fA-F]{4,64}$/.test(text) ? text.toLowerCase() : null;
  };
  // In-flight builds keyed by artifact key: concurrent identical requests share
  // one generation run instead of racing to write the same file.
  const inFlightBuilds = new Map();
  async function singleFlight(key, factory) {
    if (inFlightBuilds.has(key)) return inFlightBuilds.get(key);
    const promise = (async () => {
      try {
        return await factory();
      } finally {
        inFlightBuilds.delete(key);
      }
    })();
    inFlightBuilds.set(key, promise);
    return promise;
  }
  /**
   * Render one PDF and publish it atomically: the renderer writes a private
   * temporary file, and only a successful, existing render is renamed into place.
   * A timeout, a crash or a partial write therefore never becomes a cached
   * artifact that later requests would serve.
   */
  async function publishPdf(base, htmlPath, pdfPath) {
    return singleFlight(`pdf:${base}`, async () => {
      if (existsSync(pdfPath)) return { ok:true, reason:null };
      const tempPdf = `${pdfPath}.${randomUUID()}.partial.pdf`;
      const rendered = await renderPdfTo(htmlPath, tempPdf);
      if (!rendered.ok || !existsSync(tempPdf)) {
        try { await unlink(tempPdf); } catch {}
        return rendered.ok ? { ok:false, reason:'pdf_missing' } : rendered;
      }
      try {
        await rename(tempPdf, pdfPath);
      } catch (err) {
        try { await unlink(tempPdf); } catch {}
        return { ok:false, reason:`pdf_publish_failed:${err.code ?? 'unknown'}` };
      }
      return { ok:true, reason:null };
    });
  }
  // Structured evidence per conversation. Every frame the core sends is kept in
  // bounded memory so the insight and visualization routes answer from what actually
  // happened instead of asking the page to send its own copy back. Nothing here is
  // written to a model or sent anywhere.
  const sessionEvents = new Map();
  const MAX_SESSION_EVENTS = 4000;
  function recordFrame(sessionId, frame) {
    if (!sessionId || !frame || typeof frame !== 'object') return;
    const list = sessionEvents.get(sessionId) ?? [];
    list.push({ ...frame, session:sessionId, ts: typeof frame.ts === 'number' ? frame.ts : Date.now() });
    if (list.length > MAX_SESSION_EVENTS) list.splice(0, list.length - MAX_SESSION_EVENTS);
    sessionEvents.set(sessionId, list);
  }
  function recordSessionEvents(sessionId, events = []) {
    if (!sessionId || !Array.isArray(events)) return;
    for (const ev of events) recordFrame(sessionId, ev);
  }
  if (options.initialEvents && typeof options.initialEvents === 'object') {
    for (const [sid, evs] of Object.entries(options.initialEvents)) {
      recordSessionEvents(sid, evs);
    }
  }
  /** Events of one conversation; `current`/absent means the newest one that reported. */
  function eventsFor(requestedSession) {
    const wanted = requestedSession && requestedSession !== 'current' ? requestedSession : null;
    if (wanted) {
      return { key: wanted, requested: wanted, events: sessionEvents.get(wanted) ?? [] };
    }
    const key = [...sessionEvents.keys()].at(-1) ?? null;
    return { key, requested: wanted, events: key ? sessionEvents.get(key) ?? [] : [] };
  }
  function recordedEvents() { return [...sessionEvents.values()].flat(); }
  // One insight router per bridge. Its event source is this bridge's own frame
  // buffer plus whatever JSONL sink an operator wired through AI_EVENTS_PATH.
  let insightRouterPromise = null;
  function insightRouter() {
    if (!insightRouterPromise) {
      insightRouterPromise = (async () => {
        const { createInsightRouter } = await import('./insight/routes.mjs');
        const { readEventLog, resolveEventLogPath } = await import('./insight/event-source.mjs');
        return createInsightRouter({
          loadEvents: async () => {
            const disk = readEventLog(process.env.AI_EVENTS_PATH ? resolveEventLogPath() : null);
            const live = recordedEvents();
            return {
              events: [...disk.events, ...live],
              reported: disk.reported || live.length > 0,
              path: disk.path,
              skipped: disk.skipped,
              reason: disk.reported || live.length ? null : 'no_event_source',
            };
          },
          resolveSelection: (sessionId) => {
            if (!inference) return null;
            const target = sessions.get(sessionId);
            return target ? inference.selection(target) : null;
          },
          ...(options.insightModelRoot !== undefined ? { modelRoot: options.insightModelRoot } : {}),
          ...(options.insightModelEnv !== undefined ? { modelEnv: options.insightModelEnv } : {}),
        });
      })();
    }
    return insightRouterPromise;
  }
  const EDGE_CANDIDATES = [
    process.env.EDGE_PATH ?? null,
    resolve(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft','Edge','Application','msedge.exe'),
    resolve(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft','Edge','Application','msedge.exe'),
    resolve(process.env.LOCALAPPDATA ?? '', 'Microsoft','Edge','Application','msedge.exe'),
  ].filter(Boolean);
  function edgeBinary() {
    return EDGE_CANDIDATES.find(candidate => { try { return statSync(candidate).isFile(); } catch { return false; } }) ?? null;
  }
  /**
   * Print the saved HTML to `tempPdf` with Edge's own pipeline. The browser runs
   * headless against a local file, so no page, CDN or network request is involved.
   * It writes to the caller's temporary path only: publishing (rename) and
   * discarding belong to the caller, so a timeout can never leave a file that a
   * later request would serve. Each invocation gets its own throwaway profile
   * directory, because two Edge runs sharing one `--user-data-dir` overwrite each
   * other's output and can hang.
   * @returns {Promise<{ok:boolean, reason:string|null}>}
   */
  async function renderPdfToTemp(sourcePath, tempPdf) {
    const binary = edgeBinary();
    if (!binary) return { ok:false, reason:'edge_not_installed' };
    const profileDir = resolve(visualizeDir, `.edge-profile-${randomUUID()}`);
    try { await mkdir(profileDir, { recursive:true }); } catch {}
    const result = await new Promise(resolveExport => {
      const args = [
        '--headless','--disable-gpu','--no-pdf-header-footer','--print-to-pdf-no-header',
        `--print-to-pdf=${tempPdf}`, pathToFileURL(sourcePath).href,
        `--user-data-dir=${profileDir}`,
        '--no-first-run','--no-default-browser-check','--disable-extensions','--disable-sync','--disable-gpu-compositing'
      ];
      const child = spawn(binary, args, { windowsHide:true, stdio:'ignore' });
      let settled = false;
      const finish = (res) => { if (settled) return; settled = true; clearTimeout(timer); resolveExport(res); };
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish({ ok:false, reason:'pdf_timeout' }); }, 20000);
      child.once('error', error => finish({ ok:false, reason:`edge_spawn_failed:${error.code ?? 'unknown'}` }));
      child.once('exit', code => {
        if (code === 0 && existsSync(tempPdf)) finish({ ok:true, reason:null });
        else finish({ ok:false, reason:`edge_exit_${code}` });
      });
    });
    try { await rm(profileDir, { recursive:true, force:true }); } catch {}
    return result;
  }
  // Test seam: a replaced renderer gets the same (source, tempTarget) contract.
  const renderPdfTo = typeof options.renderPdf === 'function' ? options.renderPdf : renderPdfToTemp;

  function validHost(host) { const port = server.address()?.port; return [`127.0.0.1:${port}`,`localhost:${port}`].includes(host); }
  // The two origins this server is same-origin with. A page cannot claim either origin
  // in its own request, so a value outside this list was sent by somebody else.
  function sameOrigins() { const port = server.address()?.port; return [`http://127.0.0.1:${port}`,`http://localhost:${port}`]; }
  /**
   * Whether a page from another origin caused this request. Nothing here carries a
   * bearer token, so the browser's own signals are the only boundary between the local
   * owner and a hostile page that reached the loopback port: `text/plain` is a
   * preflight-free content type, so such a page can POST a JSON body to any route and
   * every route used to answer without asking who sent it.
   *
   * `origin` is checked first and is decisive when present: a browser sends it on every
   * cross-origin request and on same-origin POSTs, and a page cannot choose its value.
   * A same-origin GET carries no `origin`, so `sec-fetch-site` — which a page cannot
   * write either — is the fallback. A request with neither is a non-browser client
   * (curl, a test, the core's own call), which a page cannot produce, so it stays
   * allowed exactly as the WebSocket upgrade's own rule already allows it.
   * @returns {boolean}
   */
  function foreignOrigin(req) {
    const origin = req.headers.origin;
    if (origin !== undefined) return !sameOrigins().includes(origin);
    return String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site';
  }
  // One ceiling for every `/api/*` body, applied before a router can start buffering it.
  // Each router has its own limit and only some of them also tear the socket down, so a
  // request that announced a length past this cap is refused here, where no router has
  // allocated anything yet.
  const MAX_API_BODY_BYTES = 8 * 1024 * 1024;
  function oversizedBody(req) {
    const declared = Number(req.headers['content-length']);
    return Number.isFinite(declared) && declared > MAX_API_BODY_BYTES;
  }
  const server = http.createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    if (!validHost(req.headers.host)) { res.writeHead(403); res.end(); return; }
    const path = new URL(req.url,'http://localhost').pathname;
    // Cross-origin first: this decides before any router, `inference` or child process
    // sees the request, so a route added later cannot reopen the hole. The page's own
    // same-origin calls pass, and a browser always labels them, so nothing that the UI
    // does today is refused here.
    if (foreignOrigin(req)) {
      res.writeHead(403,{ 'Content-Type':'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error:'cross_origin_denied', message:'다른 출처의 페이지는 이 서버의 상태를 바꿀 수 없습니다.' }));
      return;
    }
    if (path.startsWith('/api/') && oversizedBody(req)) {
      // The refusal says nothing about whether the route exists, so it cannot be used to
      // enumerate routes, and the connection is closed rather than reused: the client's
      // remaining bytes are never handed to a router's buffer.
      res.writeHead(413,{ 'Content-Type':'application/json; charset=utf-8', Connection:'close' });
      res.end(JSON.stringify({ error:'request_body_too_large', limit:MAX_API_BODY_BYTES }));
      return;
    }
    if (path === '/healthz' && req.method === 'GET') {
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(JSON.stringify({ ok:true,mode:'local-harness',compatible_endpoint:inference?.endpoint ?? null,upstream_reachable:null })); return;
    }
    if (path.startsWith('/v1/') && inference) {
      // The gate decides while it screens this request, so the first byte of the
      // request's own response is the moment the decision belongs to this
      // conversation and the page can be told: the line then lands before the answer
      // it describes. A response that writes no body is covered by close. Neither a
      // read on `/api/privacy/*` nor a scan reaches here, so neither can claim a send.
      const token = req.headers['x-app-session'];
      const session = typeof token === 'string' && token ? [...sessions.values()].find(s => s.token === token) : null;
      if (session) {
        // One token per outbound request, carried on the gate's own record, so a
        // record belongs to the request that caused it. The old timestamp snapshot
        // claimed every `privacy.*` record appended for the session during the
        // window — including one an out-of-band `/api/privacy/scan` had just
        // written — and made a clean chat advertise a mask it never performed. The
        // session id on a scan is caller-supplied, so that window was mintable.
        const correlation = randomUUID();
        let relayed = false;
        const relay = () => { if (relayed) return; relayed = true; relayPrivacy(session, correlation); };
        res.once('close', relay);
        const { write, end } = res;
        res.write = (...args) => { relay(); return write.apply(res, args); };
        res.end = (...args) => { relay(); return end.apply(res, args); };
        const correlated = privacyModule?.runWithPrivacyCorrelation;
        if (correlated) return correlated(correlation, () => inference.handle(req,res));
      }
      return inference.handle(req,res);
    }
    // DX router (project detection, diff preview/revert/rollback, verify, explain-error, resume, cost)
    if (path.startsWith('/api/dx/')) {
      try {
        const handled = await sharedDxRouter.handle(req,res);
        if (handled) return;
      } catch (err) {
        res.writeHead(500,{ 'Content-Type':'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error:`DX 라우터 실행 실패: ${err.message}` }));
        return;
      }
    }
    // Insight router: local summarizer, journal, metrics and the observable watchdog.
    if (path.startsWith('/api/insight/')) {
      try {
        const router = await insightRouter();
        const handled = await router.handle(req,res);
        if (handled) return;
      } catch (err) {
        res.writeHead(500,{ 'Content-Type':'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error:`인사이트 라우터 실행 실패: ${err.message}` }));
        return;
      }
    }
    // Deliverable visualization: one document per session + type + content hash.
    // The artifact name carries the hash, so a repeated request finds the file it
    // already wrote and returns it: no second document, no second version.
    if (path === '/api/visualize/html' || path === '/api/visualize/pdf' || path === '/api/visualize/list') {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      const url = new URL(req.url, 'http://localhost');
      const sessionParam = url.searchParams.get('session') ?? url.searchParams.get('sessionId') ?? 'current';
      try {
        if (path === '/api/visualize/list') {
          let names = [];
          try { names = await readdir(visualizeDir); } catch { names = []; }
          // If a specific session was requested, scope strictly to that session.
          // If 'current' was requested, resolve against the live session if any.
          const currentKey = eventsFor(sessionParam).key;
          const targetSession = sessionParam === 'current'
            ? (currentKey ? safeName(currentKey) : null)
            : safeName(sessionParam);

          const byArtifact = new Map();
          for (const name of names) {
            const match = name.match(/^(.+?)-(report|study|spec|summary)(?:-([0-9a-fA-F]{4,64}))?\.(html|pdf)$/);
            if (!match) continue;
            // Only list items with a valid hash (legacy unhashed files are not addressable as versions)
            const hash = match[3] ? match[3].toLowerCase() : null;
            if (!hash) continue;
            if (targetSession && match[1] !== targetSession) continue;
            let info;
            try { info = await stat(resolve(visualizeDir,name)); } catch { continue; }
            const item = {
              session:match[1], type:match[2], format:match[4], hash, name,
              bytes:info.size, modifiedAt:info.mtimeMs,
              url:`/api/visualize/${match[4]}?session=${encodeURIComponent(match[1])}&type=${match[2]}&hash=${hash}`,
            };
            const key = `${match[1]}|${match[2]}|${match[4]}|${hash}`;
            if (!byArtifact.has(key)) byArtifact.set(key, item);
          }
          const items = [...byArtifact.values()];
          items.sort((a,b) => b.modifiedAt - a.modifiedAt);
          res.setHeader('Content-Type','application/json; charset=utf-8');
          res.end(JSON.stringify({ dir:'data/visualizations', count:items.length, items }));
          return;
        }
        const { DOC_TYPES, buildSessionDocument, isEmptySession, EMPTY_SESSION_MESSAGE } = await import('./public/session-report.js');
        const { buildDocumentModel, contentHashFor } = await import('./insight/document.mjs');
        const { isEmptySessionEvents } = await import('./insight/summarize.mjs');
        const typeParam = url.searchParams.get('type');
        const type = DOC_TYPES.includes(typeParam) ? typeParam : 'report';
        const requestedHash = parseHash(url.searchParams.get('hash') ?? url.searchParams.get('version'));
        await mkdir(visualizeDir,{ recursive:true });

        // Branch 1: User requested a specific version via &hash=.
        // A version can be retrieved without live in-memory events, but must strictly
        // belong to the requesting session so cross-session files cannot be read.
        if (requestedHash) {
          const sessionKey = sessionParam === 'current'
            ? (eventsFor('current').key ?? 'session')
            : sessionParam;
          const base = `${safeName(sessionKey)}-${type}-${requestedHash}`;
          const htmlPath = resolve(visualizeDir, `${base}.html`);
          const pdfPath = resolve(visualizeDir, `${base}.pdf`);

          if (path === '/api/visualize/html') {
            if (!existsSync(htmlPath)) {
              res.writeHead(404, { 'Content-Type':'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error:'document_version_not_found', hash:requestedHash, session:sessionKey }));
              return;
            }
            res.setHeader('X-Document-Key', `${sessionKey}:${type}:${requestedHash}`);
            res.setHeader('X-Document-Hash', requestedHash);
            res.setHeader('Content-Type','text/html; charset=utf-8');
            res.end(await readFile(htmlPath,'utf8'));
            return;
          }

          if (path === '/api/visualize/pdf') {
            if (!existsSync(pdfPath)) {
              if (!existsSync(htmlPath)) {
                res.writeHead(404, { 'Content-Type':'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error:'document_version_not_found', hash:requestedHash, session:sessionKey }));
                return;
              }
              const exportResult = await publishPdf(base, htmlPath, pdfPath);
              if (!exportResult.ok) {
                res.writeHead(503, { 'Content-Type':'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error:'PDF 변환 실패', reason:exportResult.reason }));
                return;
              }
            }
            const pdf = await readFile(pdfPath);
            res.setHeader('X-Document-Key', `${sessionKey}:${type}:${requestedHash}`);
            res.setHeader('X-Document-Hash', requestedHash);
            res.writeHead(200, { 'Content-Type':'application/pdf', 'Content-Disposition':`inline; filename="${base}.pdf"` });
            res.end(pdf);
            return;
          }
        }

        // Branch 2: Current content requested (no &hash=).
        // Live events are required to project and create a new or current document.
        const found = eventsFor(sessionParam);
        // The evidence snapshot is taken once, here, and every later decision reads
        // it: the emptiness check, the model, the hash and the render.
        const snapshot = found.events.slice();
        if (isEmptySessionEvents(snapshot)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ empty: true, error: 'empty_session', message: EMPTY_SESSION_MESSAGE }));
          return;
        }

        const live = found.key ? sessions.get(found.key) : null;
        const sessionKey = found.key ?? found.requested ?? sessionParam;
        const meta = {
          title:url.searchParams.get('title') ?? '작업 결과 문서',
          sessionId:sessionKey,
          model:url.searchParams.get('model') ?? (inference ? 'harness-local/auto' : '자동 선택'),
          mode:url.searchParams.get('mode') ?? '오케스트레이터',
          route:live?.route ?? conversationRoute(url.searchParams).route,
          consent:live?.consent === true,
        };

        const requestKey = [
          'doc', safeName(sessionKey), type, meta.title, meta.model, meta.mode, meta.route,
          meta.consent ? '1' : '0', String(snapshot.length), String(snapshot.at(-1)?.ts ?? 0),
        ].join('|');
        // Concurrent identical requests share this one build: the model, the identity
        // and the write happen once, and every caller receives the same artifact.
        const built = await singleFlight(requestKey, async () => {
          const model = await buildDocumentModel({
            type,
            events:snapshot,
            session:found.key,
            meta,
            ...(options.insightModelRoot !== undefined ? { modelRoot: options.insightModelRoot } : {}),
            ...(options.insightModelEnv !== undefined ? { env: options.insightModelEnv } : {}),
          });
          if (isEmptySession(model)) return { empty:true, message: EMPTY_SESSION_MESSAGE };
          const contentHash = model.contentHash ?? contentHashFor(model);
          const base = `${safeName(sessionKey)}-${type}-${contentHash}`;
          const htmlPath = resolve(visualizeDir, `${base}.html`);
          if (!existsSync(htmlPath)) {
            const rendered = buildSessionDocument(model);
            if (typeof rendered === 'object' && rendered?.empty) {
              return { empty:true, message: rendered.message ?? EMPTY_SESSION_MESSAGE };
            }
            // Temp + rename: a reader never sees a half-written document.
            const tempHtml = resolve(visualizeDir, `${base}.${randomUUID()}.tmp`);
            await writeFile(tempHtml, rendered, 'utf8');
            await rename(tempHtml, htmlPath);
          }
          return { empty:false, contentHash, base, htmlPath };
        });
        if (built.empty) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ empty: true, error: 'empty_session', message: built.message }));
          return;
        }

        const { contentHash, base, htmlPath } = built;
        const pdfPath = resolve(visualizeDir,`${base}.pdf`);

        res.setHeader('X-Document-Key', `${sessionKey}:${type}:${contentHash}`);
        res.setHeader('X-Document-Hash', contentHash);

        if (path === '/api/visualize/html') {
          res.setHeader('Content-Type','text/html; charset=utf-8');
          res.end(await readFile(htmlPath,'utf8'));
          return;
        }

        // Atomic, single-flight PDF generation
        if (!existsSync(pdfPath)) {
          const exportResult = await publishPdf(base, htmlPath, pdfPath);
          if (!exportResult.ok) {
            res.writeHead(503,{ 'Content-Type':'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error:'PDF 변환 실패', reason:exportResult.reason, saved:{ html:`data/visualizations/${base}.html` } }));
            return;
          }
        }
        const pdf = await readFile(pdfPath);
        res.writeHead(200,{ 'Content-Type':'application/pdf', 'Content-Disposition':`inline; filename="${base}.pdf"` });
        res.end(pdf);
        return;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `${path === '/api/visualize/pdf' ? 'PDF' : path === '/api/visualize/list' ? '문서 목록' : '시각화 HTML'} 생성 실패: ${err.message}` }));
        return;
      }
    }
    // The safety sheet's 전체 목록 viewer reads the two files that own the claim: the
    // DOCUMENTED RESIDUALS comment and the array that asserts it. Read-only, served
    // from this app, so the booth has no dead link and no new tab.
    if (path === '/api/safety/residuals') {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      const read = async file => { try { return await readFile(resolve(root, file), 'utf8'); } catch { return null; } };
      const detectors = await read('privacy/detectors.mjs');
      const tests = await read('test/pii-mask.test.mjs');
      // Only the documented block and the asserted array: the rest of either file is
      // implementation, not the published residual list.
      const detectorsBlock = detectors ? (detectors.match(/\/\*\*[\s\S]*?DOCUMENTED RESIDUALS[\s\S]*?\*\/\s*export function isSecretAssignment/)?.[0]?.replace(/\s*export function isSecretAssignment$/,'') ?? null) : null;
      const testsBlock = tests ? (tests.match(/const residuals = \[[\s\S]*?\n  \];/)?.[0] ?? null) : null;
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(JSON.stringify({
        detectors: detectorsBlock, tests: testsBlock,
        reason: detectorsBlock && testsBlock ? null : 'residual_source_unreadable'
      }));
      return;
    }
    // Live preview endpoint for the workspace / sample project (Orca style)
    if (path.startsWith('/preview/')) {
      const rel = path.slice('/preview/'.length).replace(/^[/\\]+/, '') || 'index.html';
      const target = resolve(previewDir, rel);
      if (!target.startsWith(previewDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      try {
        const data = await readFile(target);
        const ext = target.split('.').pop()?.toLowerCase();
        const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', png: 'image/png', svg: 'image/svg+xml' };
        res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream');
        res.end(data);
        return;
      } catch (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(err.code === 'ENOENT' ? `Preview file not found: ${rel}` : `Preview read failed: ${err.message}`);
        return;
      }
    }
    // Memory router (status, list, search, block, audit, add, update, delete, reindex)
    if (path.startsWith('/api/memory/')) {
      try {
        const { createMemoryRoutes } = await import('./memory/routes.mjs');
        const { getMemoryLayer } = await import('./memory/index.mjs');
        const memoryHandle = options.memoryRoutes ?? createMemoryRoutes({ resolveLayer: () => getMemoryLayer({ root:memoryRoot, dataDir:memoryDataDir }) });
        const handled = await memoryHandle(req,res);
        if (handled) return;
      } catch (err) {
        res.writeHead(500,{ 'Content-Type':'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error:`메모리 라우터 실행 실패: ${err.message}` }));
        return;
      }
    }
    // Privacy router (catalogue, SLM status, deterministic scan, recorded consent)
    if (path.startsWith('/api/privacy/')) {
      try {
        const { createPrivacyRoutes } = await import('./privacy/routes.mjs');
        const privacyHandle = options.privacyRoutes ?? createPrivacyRoutes({ resolveConversation: params => conversationRoute(params) });
        const handled = await privacyHandle(req,res);
        if (handled) return;
      } catch (err) {
        res.writeHead(500,{ 'Content-Type':'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error:`프라이버시 라우터 실행 실패: ${err.message}` }));
        return;
      }
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (path === '/api/config') {
      const conversation = conversationRoute(new URL(req.url,'http://localhost').searchParams);
      const configuredDefault = config.inference?.route?.default ?? 'any_cloud';
      const hasLocalUpstream = inference ? inference.config.chatModels.some(m => m.upstream?.class === 'server_local') : true;
      const integratedSlot = entry => ({
        ...entry,
        provider:'harness-local',
        model:'auto',
        endpoint:inference.endpoint,
        available:hasLocalUpstream,
        reason:hasLocalUpstream ? '하네스의 모델 허용 목록이 설정됨.' : '로컬 모델(server_local)이 실행 중이 아닙니다.'
      });
      const [local,background] = inference
        ? [integratedSlot(config.local),integratedSlot(config.background)]
        : await Promise.all([availability(config.local,{ slot:'local',conversation }),availability(config.background,{ slot:'background',conversation })]);
      const currentRoute = conversation.route;
      // Per-route servability, read from the same allow-list the gateway routes on:
      // a route with no candidate upstream must say so before the visitor sends anything.
      const chatModels = inference ? inference.config.chatModels : [];
      const zdrCapable = chatModels.some(m => m.model?.zero_data_retention === true && m.model?.training_opt_out === true);
      const cloudCapable = chatModels.some(m => m.upstream?.class !== 'server_local') || zdrCapable;
      const routeServed = route => route === 'local_only' ? hasLocalUpstream : inference ? (route === 'zdr_cloud' ? zdrCapable : cloudCapable) : true;
      const routeReason = route => route === 'local_only' ? '로컬 모델이 실행 중이 아닙니다.' : route === 'zdr_cloud' ? '제로 데이터 보존(ZDR)을 선언한 모델이 없습니다.' : '클라우드 경로를 처리할 업스트림이 없습니다.';
      const routes = Object.fromEntries(routeValues.map(route => [route, { served:routeServed(route), reason:routeServed(route) ? null : routeReason(route) }]));
      const gatewayKeys = inference ? [...inference.keys.entries()].map(([upstream, k]) => ({
        upstream,
        env: k.envName,
        configured: Boolean(k.configured),
        usable: Boolean(k.usable),
      })) : [];
      const missingGatewayKeys = gatewayKeys.filter(k => !k.configured || !k.usable);
      // The parsed quota is the same one the gateway enforces; `null` is reported
      // as `null` so the page never renders an uncapped dimension as a number.
      const quota = inference ? {
        identity_header: inference.config.quota.identityHeader,
        requests_per_day: inference.config.quota.requestsPerDay,
        tokens_per_day: inference.config.quota.tokensPerDay,
      } : null;
      const planeSnap = inference?.decisionPlane ? inference.decisionPlane.snapshot() : null;
      // A default nobody can serve is a 502 on the visitor's first request: pick a served one instead.
      const servedDefault = routeValues.includes(configuredDefault) && routes[configuredDefault].served
        ? configuredDefault
        : routeValues.find(route => routes[route].served) ?? configuredDefault;
      const served = routes[currentRoute].served;
      const servedReason = routes[currentRoute].reason;
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(JSON.stringify({
        mock, local, background,
        defaultRoute:servedDefault,
        // `route.route` is the route this conversation is actually on; `requested`
        // is what the page asked for, and `fallback` names a reconciliation so the
        // page can render "동의 없음 → 로컬 경로" instead of a false error.
        route:{ ...conversation, served, servedReason },
        routes,
        gatewayKeys,
        missingGatewayKeys,
        quota,
        decisionPlane: planeSnap,
        activeRoute:conversation.route,
        consent:conversation.consent,
        requestedRoute:conversation.requested,
        routeFallback:conversation.fallback,
        endpoints:{ insight:'/api/insight/metrics', visualize:'/api/visualize/html', visualizePdf:'/api/visualize/pdf', visualizeList:'/api/visualize/list' },
        cloud:config.cloud ? { ...config.cloud,...(inference ? { provider:'harness-local',model:'auto',endpoint:inference.endpoint } : {}),available:null,reason:'사용자 선택 후 연결합니다. 가용성 미확인.' } : null
      })); return;
    }
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const asset = assets[path];
    if (!asset) { res.writeHead(404); res.end('Not found'); return; }
    try { const data = await readFile(resolve(root,'public',asset[0])); res.setHeader('Content-Type',asset[1]); res.end(data); }
    catch (error) {
      // A blanket 500 here was the transient this replaced: it said "server broken"
      // for causes that are not the same failure. An asset that is not on disk is
      // absent on every request (404, named); a read that fails because another
      // process holds the file is genuinely transient (503 + Retry-After, with the
      // code); a path that resolves to a directory is a broken install, not a
      // missing file, so it stays a 500 with its own message. A file caught
      // mid-write is not a read failure at all — its short content is served with
      // 200, which is why no rerun is needed and none is added.
      const failure = assetFailure(asset[0],error);
      res.writeHead(failure.status,{ 'Content-Type':'text/plain; charset=utf-8', ...(failure.retry ? { 'Retry-After':'1' } : {}) });
      res.end(failure.body);
    }
  });
  server.on('upgrade',(req,socket,head) => {
    const url = new URL(req.url,'http://localhost'), origin = req.headers.origin;
    if (closing || url.pathname !== '/ws' || !validHost(req.headers.host) || (origin && !sameOrigins().includes(origin))) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const requested = url.searchParams.get('session');
    if (requested && !sessions.has(requested)) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    if (!requested && sessions.size >= 8) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
    const peer = upgrade(req,socket,logicalFrameLimit); if (!peer) return;
    // A completed local close write is not the end of the conversation. Destroying the
    // socket at `finish` (what this line used to do) leaves nothing to retransmit the
    // final FIN, and this host's loopback drops the occasional loopback FIN (measured:
    // the page's `close` never fired and netstat kept both ends ESTABLISHED with the
    // server side already destroyed, so the page drew a live connection forever). The
    // transport is therefore retired by Peer.close: the peer's own FIN closes it, and its
    // bounded fallback resets it, so a lost FIN is always followed by a second signal.
    let s = requested ? sessions.get(requested) : null;
    if (!s) {
      // One connection is one conversation, so its route and consent are fixed here
      // and never re-read from a later peer. An unreadable route value fails closed
      // before anything is spawned. A cloud route asked for without consent is not
      // a refusal any more: the conversation runs on local_only and the page is told
      // both what it asked for and what it is actually on.
      // Privacy state is separate from consent: consent never disables masking.
      const conversation = conversationRoute(url.searchParams);
      const privacyState = url.searchParams.get('privacy') ?? 'mask';
      s = { id:randomUUID(),token:randomUUID(),peers:new Set(),child:null,ready:false,failed:false,terminalError:null,pending:Buffer.alloc(0),negotiationId:randomUUID(),negotiating:false,decoder:new FrameDecoder(),stderr:Buffer.alloc(0),stopped:false,timer:null,exit:Promise.resolve(),selectionRelayed:false,privacyRelayed:new WeakSet(),route:conversation.route,consent:conversation.consent,privacyState,requestedRoute:conversation.requested,routeFallback:conversation.fallback,identity:inference?.identity ?? null };
      sessions.set(s.id,s);
      if (conversation.invalid) {
        s.failed = true;
        s.terminalError = { type:'bridge_error',code:'invalid_route',message:`알 수 없는 경로 값입니다: ${conversation.invalid}. 이 대화는 시작하지 않았습니다.`,stderr:'' };
      }
    }
    s.peers.add(peer);
    peer.send({ type:'bridge_connected',sessionId:s.id,mock,route:s.route,consent:s.consent,privacyState:s.privacyState,requestedRoute:s.requestedRoute,routeFallback:s.routeFallback });
    if (s.failed && s.terminalError) peer.send(s.terminalError);
    else if (s.ready) peer.send({ type:'bridge_ready' });
    const resume = () => { if ([...s.peers].every(p => !p.blocked)) s.child?.stdout.resume(); };
    peer.on('drain',resume);
    peer.on('close',() => { s.peers.delete(peer); resume(); if (!s.peers.size) stopSession(s); });
    peer.on('message',frame => {
      if (s.failed && s.terminalError) { peer.send(s.terminalError); return; }
      if (!s.ready && frame?.type === 'abort') { fail(s,'startup_cancelled','사용자가 준비 중인 코어 시작을 취소했습니다.'); return; }
      if (!s.ready || s.failed) { peer.send({ type:'bridge_error',code:'not_ready',message:'코어가 준비되지 않았습니다.' }); return; }
      if (!allowedCommand(frame)) { peer.send({ type:'bridge_error',code:'invalid_command',message:'지원하지 않는 명령입니다.' }); return; }
      if (inference && frame.type === 'set_model' && (frame.provider !== 'harness-local' || frame.modelId !== 'auto')) {
        peer.send({ type:'response',id:frame.id,command:frame.type,success:false,error:'모델 선택은 이 하네스의 허용 목록과 경로 정책을 통해서만 변경할 수 있습니다.' }); return;
      }
      writeCore(s,frame);
    });
    if (!s.child && !s.failed) launch(s);
    if (head.length) peer.consume(head);
  });
  function broadcast(s,frame) { for (const peer of s.peers) peer.send(frame); if ([...s.peers].some(p => p.blocked)) s.child?.stdout.pause(); }
  // The pre-send gate records every mask/block decision on the shared event stream,
  // and the page draws the per-turn privacy line from a websocket frame, so the
  // bridge publishes its own conversation's decisions. Only the published contract
  // travels: rule ids, counts, field paths, the 8-hex fingerprint and the code.
  // The matched value is not on the record and is never added here.
  const PRIVACY_FRAME_FIELDS = ['rules','counts','fields','fingerprint','code'];
  function privacyFrame(record) {
    const source = record.data && typeof record.data === 'object' ? record.data : {};
    const data = {};
    for (const key of PRIVACY_FRAME_FIELDS) if (source[key] !== undefined) data[key] = source[key];
    return { type:record.type, data };
  }
  // `privacy.masked` is recorded only after the wire recheck passed and the request
  // is dispatched; `privacy.blocked` only when it was refused. A request with no
  // finding records nothing, so it draws no line. A record counts only when it
  // carries this request's own correlation token, so a decision a different call
  // produced for the same session — an out-of-band `/api/privacy/scan`, the send
  // of another request in flight — is never claimed as this request's line.
  function relayPrivacy(s, correlation) {
    for (const record of gatewayEvents.events()) {
      if (record.session !== s.id) continue;
      if (record.type !== 'privacy.masked' && record.type !== 'privacy.blocked') continue;
      if (record.data?.correlation !== correlation) continue;
      if (s.privacyRelayed.has(record)) continue;
      s.privacyRelayed.add(record);
      broadcast(s, privacyFrame(record));
    }
  }
  function diagnostics(s) {
    const raw = s.stderr.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trim();
    return sanitizeDiagnostics(raw);
  }
  function fail(s,code,message,details = {}) {
    if (s.failed || s.stopped) return;
    s.failed = true; s.ready = false; s.negotiating = false; lifecycleTimers.clearTimeout(s.timer);
    const stderr = diagnostics(s);
    s.terminalError = { type:'bridge_error',code,message:message + (stderr ? `\n코어 stderr:\n${stderr}` : ''),stderr,...details };
    broadcast(s,s.terminalError);
    if (['startup_timeout','startup_cancelled','negotiation_timeout'].includes(code)) s.terminateOnExit = true;
    stopChild(s);
  }
  function writeCore(s,frame) {
    // A new turn may produce a new decision, so the once-per-turn relay is re-armed here.
    if (frame?.type === 'prompt' || frame?.type === 'abort') s.selectionRelayed = false;
    if (frame?.type === 'prompt' && typeof frame.message === 'string') {
      const roleInfo = classifyAgentRole(frame.message);
      const roleChain = resolveRoleModelChain(roleInfo.role, { route: s.route });
      s.activeRole = roleInfo.role;
      s.roleChain = roleChain;
      recordFrame(s.id, {
        type: 'prompt',
        message: frame.message,
        role: roleInfo.role,
        roleReason: roleInfo.reason,
        primaryModel: roleChain.primaryModel,
        fallbackChain: roleChain.fallbackChain,
      });
    }
    const data = Buffer.from(JSON.stringify(frame) + '\n');
    if (data.length > s.decoder.physical) { broadcast(s,{ type:'response',id:frame.id,command:frame.type,success:false,error:'브리지 명령이 코어의 물리 프레임 한도를 초과했습니다.' }); return; }
    if (!s.child?.stdin.writable) { fail(s,'write_failed','코어 입력 스트림을 사용할 수 없습니다.'); return; }
    if (s.child.stdin.writableLength + data.length > physicalFrameLimit * 4) { fail(s,'backpressure','코어 입력 대기열이 한도를 초과했습니다.'); return; }
    // A full core stdin is backpressure the child's own Writable already holds: the frame
    // stays queued there and the guard above bounds that queue. The peer sockets are
    // deliberately left readable. Pausing them stopped the frame reader too, so a page
    // that closed its socket while the core was draining sent a close frame nobody
    // parsed, and its session and child outlived the disconnect until app.close().
    // An unpaused peer observes a close frame (parsed), a FIN (socket `end`) and an
    // RST (socket `error`/`close`); each reaches stopSession through peer close when
    // the last peer leaves. A peer that vanishes with no signal at all is not detected
    // here: there is no keepalive, so its session lives until app.close().
    s.child.stdin.write(data);
  }
  function stopChild(s) {
    if (!s.childStopping && s.child && s.child.exitCode === null && s.child.signalCode === null) {
      s.childStopping = true;
      s.child.stdin.end(); s.child.kill();
      const timer = setTimeout(() => { if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill('SIGKILL'); },1000); timer.unref();
      s.child.once('close',() => clearTimeout(timer));
    }
  }
  function terminatePeer(peer) { peer.close(1001); peer.socket.destroy(); }
  function stopSession(s) { s.stopped = true; sessions.delete(s.id); lifecycleTimers.clearTimeout(s.timer); stopChild(s); for (const peer of s.peers) terminatePeer(peer); }
  // A precheck that only tests existence lets a directory through, and spawn then
  // reports EACCES/ENOENT without naming the path. Only a regular file is a
  // runtime the bridge can execute; the reason explains anything else, so the
  // failure names the exact offending path like the launcher's -PathType Leaf.
  function runtimeProblem(path) {
    let stats;
    try { stats = statSync(path); }
    catch (error) { return `경로가 없습니다 (${error.code ?? 'stat'}): ${path}`; }
    if (!stats.isFile()) return `일반 파일이 아닙니다: ${path}`;
    return null;
  }
  function launch(s) {
    const envMerged = { ...process.env,...config.coreEnv,...(options.coreEnv ?? {}),OMP_BRIDGE_ROUTE:s.route };
    // The extension resolves the same values the router above uses, so a memory written
    // through the agent is the memory `/api/memory` returns. Set only when neither an
    // explicit env override nor coreEnv already named them.
    envMerged.OMP_MEMORY_ROOT ??= memoryRoot;
    envMerged.OMP_MEMORY_DATA_DIR ??= memoryDataDir;
    if (!inference) s.identity = selectionIdentity(envMerged);
    const executable = options.binary ?? envMerged.OMP_BINARY;
    const bin = mock ? process.execPath : (executable ?? envMerged.OMP_BUN ?? localRuntime.bun);
    const resolvedCoreArgs = resolveCoreArgs(config.coreArgs);
    const overlay = options.overlayFile ?? resolve(root,'omp-overlay.yml');
    const wantsOverlay = !resolvedCoreArgs.some(arg => arg === '--config');
    const args = mock ? [resolve(root,'mock-core.mjs')] : [
      ...(executable ? [] : [envMerged.OMP_CLI ?? localRuntime.cli]),...launchArguments(resolvedCoreArgs),
      ...(inference && wantsOverlay ? ['--config',overlay] : []),
      ...(inference ? ['--provider','harness-local','--model','harness-local/auto','--models','harness-local/auto'] : [])
    ];
    if (!mock) {
      const problems = executable
        ? [runtimeProblem(executable)].filter(Boolean)
        : [runtimeProblem(envMerged.OMP_BUN ?? localRuntime.bun),runtimeProblem(envMerged.OMP_CLI ?? localRuntime.cli)].filter(Boolean);      if (problems.length) {
        fail(s,'launch_failed',executable
          ? `지정한 OMP 실행 파일을 실행할 수 없습니다: ${problems.join(', ')}`
          : `로컬 OMP 런타임이 설치되지 않았거나 누락되었습니다: ${problems.join(', ')}`);
        return;
      }
      if (!inference) {
        // No separate gateway exists any more, so there is nothing a core could talk
        // to without this section: refuse instead of letting omp read a global
        // models.yml that points at a host this app does not run.
        fail(s,'launch_failed','하네스에 inference 설정이 없어 코어를 실행하지 않았습니다. 외부 게이트웨이로 대체하지 않으며, app/config.json의 inference.upstreams를 설정해야 합니다.');
        return;
      }
      if (!inference.endpoint) { fail(s,'launch_failed','하네스의 호환 엔드포인트와 inference 업스트림 설정이 필요합니다. 외부 모델 설정으로 대체하지 않았습니다.'); return; }
      if (config.coreArgs.some(arg => /^(--profile|--provider|--model|--models)(=|$)/.test(arg))) {
        fail(s,'launch_failed','coreArgs의 provider/model/profile 재정의는 허용하지 않습니다. inference.upstreams를 설정하세요.'); return;
      }
      try { readFileSync(options.overlayFile ?? resolve(root,'omp-overlay.yml'),'utf8'); Object.assign(envMerged,inference.runtimeEnv(s)); }
      catch (error) { fail(s,'launch_failed',`필수 하네스 설정을 읽을 수 없습니다: ${error.message}`); return; }
      for (const key of inference.keys.values()) delete envMerged[key.envName];
      s.agentModelsFile = inference.modelsFile;
      const headerProblem = routeHeaderProblem(envMerged,s.route);
      if (headerProblem) {
        fail(s,'launch_failed',`models.yml의 x-route 헤더가 이 대화의 경로와 일치하지 않아 코어를 실행하지 않았습니다: ${headerProblem}`);
        return;
      }
    }
    s.child = spawn(bin,args,{ shell:false,cwd:config.coreCwd ?? root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:envMerged });

    children.add(s);
    s.exit = new Promise(resolveExit => s.child.once('close',(code,signal) => {
      lifecycleTimers.clearTimeout(s.timer); children.delete(s);
      if (!s.stopped && !s.failed) fail(s,s.ready ? 'core_crashed' : 'launch_failed',`코어가 ${s.ready ? '예기치 않게 종료' : '준비 전에 종료'}되었습니다. 종료 코드: ${code ?? signal}.`,{ exitCode:code,signal });
      if (s.terminateOnExit) {
        // Finish terminal ownership before waking any waiter on child exit;
        // registering another .then here makes cleanup depend on waiter order.
        sessions.delete(s.id);
        for (const peer of s.peers) terminatePeer(peer);
      }
      resolveExit();
    }));
    s.child.once('error',error => fail(s,'launch_failed',`코어 실행 실패 (${error.code ?? 'spawn'}). Bun/OMP_BINARY 경로를 확인하세요.`));
    s.child.stdin.on('error',() => { if (!s.child.killed && s.child.exitCode === null) fail(s,'write_failed','코어 입력 스트림이 닫혔습니다.'); });
    s.child.stderr.on('data',chunk => { s.stderr = Buffer.concat([s.stderr,chunk]).subarray(-16384); });
    s.timer = lifecycleTimers.setTimeout(() => fail(s,'startup_timeout','코어 시작이 60초 내에 ready를 알리지 않아 중단했습니다.'),60000);
    s.child.stdout.on('data',chunk => {
      if (s.failed || s.stopped) return;
      s.pending = Buffer.concat([s.pending,chunk]);
      let newline;
      while ((newline = s.pending.indexOf(10)) !== -1) {
        if (newline + 1 > s.decoder.physical) return fail(s,'frame_too_large','코어 물리 프레임이 협상된 한도를 초과했습니다.');
        const line = s.pending.subarray(0,newline); s.pending = s.pending.subarray(newline + 1);
        if (!line.length) continue;
        let frame;
        try { frame = s.decoder.push(JSON.parse(new TextDecoder('utf8',{ fatal:true }).decode(line))); }
        catch (error) { return fail(s,'protocol_mismatch',`코어 프레임 해석 실패: ${error.message}`); }
        if (!frame) continue;
        recordFrame(s.id, frame);
        // A tool the core is about to run may change a file. The DX snapshot has to be
        // taken before it runs, so the start frame is the live trigger; `noteFrame`
        // ignores everything that cannot write.
        sharedDxRouter.noteFrame?.(s.id, frame)?.catch?.(() => {});
        if (isReady(frame)) {
          if (s.negotiating || s.ready) return fail(s,'protocol_mismatch','중복 ready 프레임입니다.');
          try { Object.assign(s.decoder,readyLimits(frame)); } catch (error) { return fail(s,'protocol_mismatch',error.message); }
          // Ready ends discovery and starts the independent protocol response budget.
          lifecycleTimers.clearTimeout(s.timer);
          s.timer = lifecycleTimers.setTimeout(() => fail(s,'negotiation_timeout','준비된 코어의 프로토콜 v2 협상 응답이 시간 내에 도착하지 않았습니다.'),15000);
          s.negotiating = true; writeCore(s,negotiation(s.negotiationId)); continue;
        }
        const result = negotiationResult(frame,s.negotiationId);
        if (result) {
          if (!result.ok) return fail(s,'protocol_mismatch',String(result.message));
          s.ready = true; s.decoder.negotiated = true; lifecycleTimers.clearTimeout(s.timer); broadcast(s,{ type:'bridge_ready' }); continue;
        }
        // Startup widget/catalog notifications are valid before the negotiation response.
        // The selection belongs to the turn that just ended, so it is broadcast on the
        // turn's own completion frame, before `prompt_result`: a client that stops
        // reading at prompt_result already holds the decision. Relaying it after the
        // result frame was the race that left live sessions with `selection:null`.
        if (frame?.type === 'turn_end' || turnResultFrame(frame)) relaySelection(s);
        broadcast(s,frame);
      }
      if (s.pending.length >= s.decoder.physical) fail(s,'frame_too_large','코어 물리 프레임이 협상된 한도를 초과했습니다.');
    });
  }
  function relaySelection(s) {
    if (s.selectionRelayed) return;
    s.selectionRelayed = true;
    if (!s.identity) return;
    // With the in-process gateway the decision is already recorded, so it is read
    // synchronously and the frame enters the socket before the turn's result frame.
    if (inference) { broadcast(s,{ type:'selection',selection:inference.selection(s) }); return; }
    const decision = config.local?.endpoint ? readSelection({ endpoint:config.local.endpoint,route:s.route,identity:s.identity,timeout:options.selectionTimeout ?? selectionReadTimeout,fetchImpl:options.fetch }) : null;
    decision?.then(selection => {
      if (closing || s.stopped || s.failed) return;
      broadcast(s,{ type:'selection',selection });
    });
  }
  return {
    server,sessions,inference,recordSessionEvents,
    roles: AGENT_ROLES,
    // The one memory location both faces use, reported so a test or an operator can
    // name the database instead of guessing which default was applied.
    memory:{ root:memoryRoot, dataDir:memoryDataDir },
    async start(port = 4317) {
      await new Promise((ok,bad) => { server.once('error',bad); server.listen(port,'127.0.0.1',() => { server.off('error',bad); ok(); }); });
      const url = `http://127.0.0.1:${server.address().port}`;
      try { inference?.prepareRuntime(url + '/v1', config.backgroundModel); }
      catch (error) { await new Promise(ok => server.close(ok)); throw error; }
      return url;
    },
    async close() { closing = true; for (const s of children) stopSession(s); for (const s of sessions.values()) for (const p of s.peers) terminatePeer(p); await Promise.all([...children].map(s => s.exit)); sessions.clear(); await (await import('./memory/index.mjs')).closeMemoryLayer(); await new Promise(ok => server.close(ok)); }
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // An empty OMP_CONFIG_FILE means "not set" (launch.ps1 treats "" the same way), so
    // the bundled config.json is the file that must be readable. Anything else is an
    // explicit choice whose own read error has to propagate.
    const explicit = (process.env.OMP_CONFIG_FILE ?? '').trim();
    const configFile = explicit || resolve(root, 'config.json');
    let config;
    try {
      config = JSON.parse(await readFile(configFile, 'utf8'));
    } catch (err) {
      throw new Error(`설정 파일(${configFile})을 읽거나 해석할 수 없습니다: ${err.message}`);
    }
    const app = await createBridge({ config,mock:process.argv.includes('--mock') });
    console.log(`Student workspace: ${await app.start(Number(process.env.PORT ?? 4317))} (${process.argv.includes('--mock') ? 'MOCK core' : 'Bun / real omp'})`);

    const shutdown = async () => { await app.close(); process.exit(0); };
    process.once('SIGINT',shutdown); process.once('SIGTERM',shutdown);
    process.once('exit',() => { for (const s of app.sessions.values()) s.child?.kill(); });
    process.on('uncaughtException',async error => { console.error(error.message); await app.close(); process.exit(1); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

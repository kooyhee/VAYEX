// HTTP adapter, exported for the UI owner to mount in `app/server.mjs`.
//
// Contract: `const memoryRoutes = createMemoryRoutes({ layer: getMemoryLayer })` then,
// inside `http.createServer(...)` before the GET-only gate:
//
//     if (await memoryRoutes(req, res)) return;
//
// The handler returns `true` when it owned the request and `false` otherwise, so it
// composes with the existing `/healthz`, `/v1/*`, `/api/config` and asset branches.
import {
  addMemory,
  auditLog,
  deleteMemory,
  getMemory,
  listMemories,
  memoryBlock,
  memoryStatus,
  reindex,
  searchMemory,
  updateMemory,
} from './api.mjs';

const MAX_BODY_BYTES = 64 * 1024;

export function createMemoryRoutes({ layer, basePath = '/api/memory', resolveLayer } = {}) {
  const getLayer = resolveLayer ?? (typeof layer === 'function' ? layer : async () => layer);

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(basePath)) return false;
    const path = url.pathname.slice(basePath.length) || '/';
    try {
      const layers = await getLayer();
      const memory = await layers;
      if (path === '/status' && req.method === 'GET') return send(res, 200, memoryStatus(memory));
      if (path === '/list' && req.method === 'GET') {
        return send(res, 200, listMemories(memory, {
          type: url.searchParams.get('type') ?? undefined,
          status: url.searchParams.get('status') ?? 'active',
          project: url.searchParams.get('project') ?? undefined,
          query: url.searchParams.get('q') ?? undefined,
          limit: Number(url.searchParams.get('limit') ?? 50),
          offset: Number(url.searchParams.get('offset') ?? 0),
          includeSuperseded: url.searchParams.get('includeSuperseded') === '1',
        }));
      }
      if (path === '/get' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        const found = id ? getMemory(memory, id) : null;
        return send(res, found ? 200 : 404, found ?? { error: 'not_found' });
      }
      if (path === '/search' && req.method === 'GET') {
        return send(res, 200, await searchMemory(memory, url.searchParams.get('q') ?? '', {
          project: url.searchParams.get('project') ?? undefined,
          limit: Number(url.searchParams.get('k') ?? 10),
        }));
      }
      if (path === '/block' && req.method === 'GET') {
        return send(res, 200, await memoryBlock(memory, url.searchParams.get('q') ?? '', {
          backfill: url.searchParams.get('backfill') === '1',
        }));
      }
      if (path === '/audit' && req.method === 'GET') {
        return send(res, 200, { items: auditLog(memory, Number(url.searchParams.get('limit') ?? 50)) });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const body = await readJson(req);
      if (path === '/add') return sendGuard(res, addMemory(memory, body));
      if (path === '/update') return sendGuard(res, updateMemory(memory, body.id, body));
      if (path === '/delete') return send(res, 200, deleteMemory(memory, body.id, { hard: body.hard === true, actor: 'api' }));
      if (path === '/reindex') return send(res, 200, await reindex(memory));
      return send(res, 404, { error: 'not_found' });
    } catch (error) {
      return send(res, 500, { error: 'memory_failed', message: error.message });
    }
  };
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`${JSON.stringify(payload)}\n`);
  return true;
}

/**
 * A write the privacy gate refused answers 422 — the status the gate itself
 * declares — so an HTTP caller can tell a refusal from a validation error.
 */
function sendGuard(res, result) {
  const refused = result?.ok === false && Number.isFinite(result.status) && result.status !== 200;
  return send(res, refused ? result.status : 200, result);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

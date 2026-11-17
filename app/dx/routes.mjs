import { resolve, join, relative } from 'node:path';
import { detectProject } from './project-detect.mjs';
import { SnapshotManager } from './snapshot-diff.mjs';
import { runVerification } from './auto-verify.mjs';
import { explainError } from './korean-error-explainer.mjs';
import { TaskResumeManager } from './task-resume.mjs';
import { CostAnalytics } from './cost-analytics.mjs';

/**
 * Safely parse JSON body from incoming HTTP request.
 */
async function parseJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    let settled = false;
    req.on('data', chunk => {
      // Past the limit the body stops being buffered. It used to keep concatenating every
      // later chunk into `body` after the rejection, so a client that announced nothing
      // (chunked) could hold an arbitrary amount of this process's memory as a string.
      if (settled) return;
      body += chunk.toString('utf8');
      if (body.length > 5 * 1024 * 1024) { // 5MB limit
        settled = true;
        body = '';
        const tooLarge = new Error('요청 바디 크기 제한(5MB)을 초과했습니다.');
        tooLarge.code = 'ETOOLARGE';
        rejectBody(tooLarge);
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!body.trim()) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(body));
      } catch (err) {
        rejectBody(new Error(`잘못된 JSON 형식입니다: ${err.message}`));
      }
    });
    req.on('error', error => { if (!settled) { settled = true; rejectBody(error); } });
  });
}

/**
 * Send JSON response helper.
 */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

// Tool names that write to the workspace. A turn that starts one of them is about to
// change a file, which is the moment the pre-edit snapshot has to be taken; reading or
// running a command changes nothing and must not create a snapshot.
const WRITE_TOOL = /(write|edit|patch|replace|apply|create|insert|append|overwrite|delete|remove|rename|move|save|str_replace|notebook_edit)/;

/**
 * Every file path a tool-start frame names, from the argument keys the core actually
 * uses (`path` / `file_path` for the editor tools, `files` for the multi-file ones).
 *
 * @param {object} frame
 * @returns {string[]}
 */
export function toolStartPaths(frame) {
  const args = frame?.args ?? frame?.arguments;
  if (!args || typeof args !== 'object') return [];
  const paths = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.trim()) paths.add(value.trim());
  };
  for (const key of ['path', 'file_path', 'filePath', 'target', 'target_file', 'notebook_path']) add(args[key]);
  for (const entry of Array.isArray(args.files) ? args.files : [args.files]) {
    add(typeof entry === 'string' ? entry : entry?.path ?? entry?.file_path);
  }
  for (const entry of Array.isArray(args.edits) ? args.edits : []) add(entry?.path ?? entry?.file_path);
  return [...paths];
}

/**
 * The paths a tool-start frame is about to modify, or `[]` when the frame cannot
 * change a file.
 *
 * @param {object} frame
 * @returns {string[]}
 */
export function fileModifyingPaths(frame) {
  if (!frame || typeof frame !== 'object' || frame.type !== 'tool_execution_start') return [];
  if (!WRITE_TOOL.test(String(frame.toolName ?? '').toLowerCase())) return [];
  return toolStartPaths(frame);
}

/**
 * Creates the DX route handler instance.
 *
 * @param {object} options
 * @param {string} options.projectRoot - Default root of the workspace
 * @param {string} options.stateDir - Storage directory for snapshots and task state
 * @returns {object} Router instance with `handle(req, res)` method
 */
export function createDxRouter(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const stateDir = resolve(options.stateDir || join(projectRoot, 'data', 'dx'));
  // The tree the agent actually writes to, which is not necessarily the tree stack
  // detection reports on: snapshots and reverts must resolve against the former.
  const editRoot = resolve(options.editRoot || projectRoot);

  const snapshotManager = new SnapshotManager({
    storageDir: join(stateDir, 'snapshots'),
    projectRoot: editRoot
  });

  const taskResumeManager = new TaskResumeManager({
    storageDir: join(stateDir, 'tasks')
  });

  const costAnalytics = new CostAnalytics({
    storageDir: join(stateDir, 'cost'),
    // The live feed of gateway `llm_turn` records. Without it the overview only
    // sees explicit POST /api/dx/cost/event calls, which a real turn never makes.
    eventsFrom: options.eventsFrom
  });

  // Ensure init on startup
  const initPromise = Promise.all([
    snapshotManager.init(),
    taskResumeManager.init(),
    costAnalytics.init()
  ]);

  // A resumed task carries the project's standing memory back with it. The layer is
  // resolved lazily so the DX router can be built before the memory layer exists.
  if (typeof options.resolveMemoryLayer === 'function') {
    taskResumeManager.setMemoryHook(async (sessionKey) => {
      const layer = await options.resolveMemoryLayer();
      const { memoryResumeState } = await import('../memory/resume.mjs');
      return memoryResumeState(layer, sessionKey);
    });
  }

  /**
   * Take the pre-edit snapshot for a tool call that is about to change a file.
   *
   * This is the live path item 4 was missing: the agent core announces the edit with a
   * `tool_execution_start` frame *before* the tool runs, and the bridge hands every core
   * frame to this function, so "변경 전 파일 보존" no longer depends on a client calling
   * `POST /api/dx/snapshot/record`. That endpoint stays for a client that edits files
   * itself.
   *
   * @param {string} sessionId conversation id; the same key the diff panel reads
   * @param {object} frame core frame
   * @returns {Promise<Array<{ relativePath: string, existed: boolean }>>}
   */
  async function noteFrame(sessionId, frame) {
    const paths = fileModifyingPaths(frame);
    if (!paths.length || !sessionId) return [];
    await initPromise;
    const recorded = [];
    for (const filePath of paths) {
      try {
        // The frame names the file the way the tool takes it: absolute, or relative to
        // the directory the agent runs in. `recordSnapshot` wants it relative to the
        // tree being edited, so the conversion happens once, here.
        const relativeToEditRoot = relative(editRoot, resolve(editRoot, filePath));
        // A path outside the edited tree is not ours to snapshot or revert.
        if (!relativeToEditRoot || relativeToEditRoot.startsWith('..')) continue;
        recorded.push({ path: filePath, ...(await snapshotManager.recordSnapshot(String(sessionId), relativeToEditRoot)) });
      } catch {
        // A path the snapshot store cannot reach must not break the turn it describes.
      }
    }
    return recorded;
  }

  /**
   * Main HTTP request dispatcher for DX endpoints.
   * Mount under `/api/dx/*` in server.mjs.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<boolean>} True if route was handled, false if not matched.
   */
  async function handle(req, res) {
    await initPromise;

    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/dx/')) {
      return false;
    }

    try {
      // 1. Project auto-detection
      if (pathname === '/api/dx/project/detect' && req.method === 'GET') {
        const targetPath = url.searchParams.get('path') || projectRoot;
        const result = await detectProject(targetPath);
        sendJson(res, 200, result);
        return true;
      }

      // 2. Snapshot & Diff Preview
      if (pathname === '/api/dx/snapshot/record' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        if (!body.taskId || !body.filePath) {
          sendJson(res, 400, { error: 'taskId와 filePath는 필수입니다.' });
          return true;
        }
        const record = await snapshotManager.recordSnapshot(body.taskId, body.filePath);
        sendJson(res, 200, { success: true, ...record });
        return true;
      }

      if (pathname === '/api/dx/snapshot/diff' && (req.method === 'GET' || req.method === 'POST')) {
        const body = req.method === 'POST' ? await parseJsonBody(req) : null;
        const taskId = url.searchParams.get('taskId') || body?.taskId;
        if (!taskId) {
          sendJson(res, 400, { error: 'taskId 쿼리 파라미터가 필요합니다.' });
          return true;
        }
        const diffData = await snapshotManager.getTaskDiff(taskId);
        sendJson(res, 200, diffData);
        return true;
      }

      if (pathname === '/api/dx/snapshot/revert' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        if (!body.taskId || !body.filePath) {
          sendJson(res, 400, { error: 'taskId와 filePath는 필수입니다.' });
          return true;
        }
        const result = await snapshotManager.revertFile(body.taskId, body.filePath);
        sendJson(res, 200, result);
        return true;
      }

      if (pathname === '/api/dx/snapshot/rollback' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        if (!body.taskId) {
          sendJson(res, 400, { error: 'taskId는 필수입니다.' });
          return true;
        }
        const result = await snapshotManager.rollbackTask(body.taskId);
        sendJson(res, 200, result);
        return true;
      }

      // 3. Auto-verify runner
      if (pathname === '/api/dx/verify/run' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        const targetRoot = body.projectRoot || projectRoot;
        const result = await runVerification({
          projectRoot: targetRoot,
          command: body.command,
          mode: body.mode || 'auto',
          timeoutMs: body.timeoutMs || 30000,
          env: body.env || {}
        });
        sendJson(res, 200, result);
        return true;
      }

      // 4. Plain Korean Error Explainer
      if (pathname === '/api/dx/explain-error' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        const text = body.error || body.log || '';
        const explanation = explainError(text);
        sendJson(res, 200, explanation);
        return true;
      }

      // 5. Task Resume & Persistence
      if (pathname === '/api/dx/tasks/save' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        const saved = await taskResumeManager.saveTaskState(body);
        sendJson(res, 200, { success: true, task: saved });
        return true;
      }

      if (pathname === '/api/dx/tasks/get' && req.method === 'GET') {
        const taskId = url.searchParams.get('taskId');
        if (!taskId) {
          sendJson(res, 400, { error: 'taskId 쿼리 파라미터가 필요합니다.' });
          return true;
        }
        try {
          const task = await taskResumeManager.getTaskState(taskId);
          sendJson(res, 200, task);
        } catch (err) {
          sendJson(res, 404, { error: `태스크를 찾을 수 없습니다: ${err.message}` });
        }
        return true;
      }

      if (pathname === '/api/dx/tasks/list' && req.method === 'GET') {
        const status = url.searchParams.get('status') || undefined;
        const limit = Number(url.searchParams.get('limit')) || 20;
        const tasks = await taskResumeManager.listTasks({ status, limit });
        sendJson(res, 200, { tasks });
        return true;
      }

      if (pathname === '/api/dx/tasks/interrupt' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        if (!body.taskId) {
          sendJson(res, 400, { error: 'taskId는 필수입니다.' });
          return true;
        }
        const updated = await taskResumeManager.markInterrupted(body.taskId, body.reason);
        sendJson(res, 200, { success: true, task: updated });
        return true;
      }

      if (pathname === '/api/dx/tasks/resume' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        if (!body.taskId) {
          sendJson(res, 400, { error: 'taskId는 필수입니다.' });
          return true;
        }
        const resumed = await taskResumeManager.restoreTask(body.taskId);
        sendJson(res, 200, resumed);
        return true;
      }

      // 6. Cost Visualization & Aggregation
      if (pathname === '/api/dx/cost/event' && req.method === 'POST') {
        const body = await parseJsonBody(req);
        const recorded = costAnalytics.recordEvent(body);
        sendJson(res, 200, { success: true, event: recorded });
        return true;
      }

      if (pathname === '/api/dx/cost/task' && req.method === 'GET') {
        const taskId = url.searchParams.get('taskId');
        if (!taskId) {
          sendJson(res, 400, { error: 'taskId 쿼리 파라미터가 필요합니다.' });
          return true;
        }
        const taskCost = costAnalytics.getTaskCost(taskId);
        sendJson(res, 200, taskCost);
        return true;
      }

      if (pathname === '/api/dx/cost/overview' && req.method === 'GET') {
        const overview = costAnalytics.getOverview();
        sendJson(res, 200, overview);
        return true;
      }

      sendJson(res, 404, { error: `존재하지 않는 DX API 엔드포인트입니다: ${pathname}` });
      return true;
    } catch (err) {
      // A path or id outside the tree this router owns is the caller's error, not a
      // server failure: `snapshot-diff` raises `EOUTSIDEROOT` for exactly that.
      if (err?.code === 'EOUTSIDEROOT') {
        sendJson(res, 400, { error: err.message });
        return true;
      }
      // There is no snapshot for this task and path: the caller asked to revert
      // something that was never recorded, which is a missing resource, not a failure.
      if (err?.code === 'ENOSNAPSHOT') {
        sendJson(res, 404, { error: err.message });
        return true;
      }
      // A body past this router's own ceiling is a 413, not a 500 — a client that streams
      // without announcing a length never reaches the server-wide declaration check.
      if (err?.code === 'ETOOLARGE') {
        sendJson(res, 413, { error: err.message });
        return true;
      }
      sendJson(res, 500, { error: `DX API 처리 중 오류 발생: ${err.message}` });
      return true;
    }
  }

  return {
    handle,
    // The live pre-edit snapshot hook. `app/server.mjs` hands every core frame here as
    // it arrives, so a file-modifying turn is snapshotted before the tool runs.
    noteFrame,
    snapshotManager,
    taskResumeManager,
    costAnalytics
  };
}

// Security regressions for the DX route surface (app/dx/routes.mjs and the snapshot
// store it calls). Each case drives the wire request a caller can actually send and
// asserts the observable result, so it fails against the pre-fix code:
//
//  1. a junction inside the tree cannot point a snapshot at a file outside it
//     (was: record cached the outside file, diff served it, revert rewrote/deleted it)
//  2. a path inside the tree still records, diffs and reverts (containment, not denial)
//  3. reading a task id that was never recorded creates no entry
//     (was: every invented id grew the in-memory task map forever)
//  4. a revert for a path that was never snapshotted is a 404
//     (was: 500 "DX API 처리 중 오류 발생")
//  5. a task id too long for the filesystem is refused as the caller's error
//     (was: 500 with the store's ENOENT)

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

import { createDxRouter } from '../dx/index.mjs';

const MARK = 'DXSEC_CANARY_5f81c2';

/**
 * One temp root holding the edited tree (`workspace`), a directory beside it
 * (`outside`) and the snapshot store (`state`) — "inside" and "outside" are the
 * test's own directories, not the product's.
 */
async function withSurface(run) {
  const root = await mkdtemp(join(tmpdir(), 'dxsec-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  const stateDir = join(root, 'state');
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  const router = createDxRouter({ projectRoot: workspace, stateDir });
  const server = http.createServer(async (req, res) => {
    const handled = await router.handle(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.text() };
  };
  const get = async (path) => {
    const response = await fetch(baseUrl + path, { signal: AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.text() };
  };
  try {
    return await run({ router, workspace, outside, stateDir, root, post, get });
  } finally {
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * A directory link from inside the workspace to a directory outside it. A junction is
 * what an unprivileged Windows process can always create; the same shape on POSIX is a
 * plain directory symlink.
 */
async function linkOutside(workspace, outside) {
  const link = join(workspace, 'link');
  try {
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    return link;
  } catch (err) {
    return err;
  }
}

test('a junction inside the tree cannot point a snapshot at a file outside it', async (t) => {
  await withSurface(async ({ workspace, outside, post, get }) => {
    const canary = join(outside, 'secret.txt');
    await writeFile(canary, MARK, 'utf8');
    const link = await linkOutside(workspace, outside);
    if (!(typeof link === 'string')) {
      t.diagnostic(`a directory link could not be created here (${link.code}); link escape untested`);
      return;
    }

    // Recording through the link used to accept the path and cache the outside file.
    const record = await post('/api/dx/snapshot/record', { taskId: 't-link', filePath: 'link/secret.txt' });
    assert.equal(record.status, 400, 'a path that resolves outside the tree is the caller\'s error');
    assert.match(record.body, /프로젝트 루트/);

    // ...which then served that content from the diff endpoint.
    const diff = await get('/api/dx/snapshot/diff?taskId=t-link');
    assert.equal(diff.status, 200);
    assert.equal(diff.body.includes(MARK), false, 'no outside file content may be served');

    // A revert through the link used to rewrite the outside file...
    await writeFile(canary, 'ATTACKER_SUPPLIED_CONTENT', 'utf8');
    const revert = await post('/api/dx/snapshot/revert', { taskId: 't-link', filePath: 'link/secret.txt' });
    assert.ok(revert.status >= 400, 'a revert through the link is refused');
    assert.equal(await readFile(canary, 'utf8'), 'ATTACKER_SUPPLIED_CONTENT', 'the outside file is untouched');

    // ...and deleting through it removed a file outside the workspace.
    const ghost = join(outside, 'victim.txt');
    await post('/api/dx/snapshot/record', { taskId: 't-link2', filePath: 'link/victim.txt' });
    await writeFile(ghost, 'VICTIM', 'utf8');
    const rollback = await post('/api/dx/snapshot/rollback', { taskId: 't-link2' });
    assert.equal(rollback.status, 200);
    assert.equal(await stat(ghost).then(() => true, () => false), true, 'no file outside the tree may be deleted');
  });
});

test('a path inside the tree still records, diffs and reverts', async () => {
  await withSurface(async ({ workspace, post, get }) => {
    await writeFile(join(workspace, 'inside.js'), 'const a = 1;\n', 'utf8');
    const record = await post('/api/dx/snapshot/record', { taskId: 't-own', filePath: 'inside.js' });
    assert.equal(record.status, 200);
    assert.equal(JSON.parse(record.body).relativePath, 'inside.js');

    await writeFile(join(workspace, 'inside.js'), 'const a = 2;\n', 'utf8');
    const diff = await get('/api/dx/snapshot/diff?taskId=t-own');
    assert.equal(diff.status, 200);
    assert.match(JSON.parse(diff.body).files[0].diff, /\+const a = 2;/);

    const revert = await post('/api/dx/snapshot/revert', { taskId: 't-own', filePath: 'inside.js' });
    assert.equal(revert.status, 200);
    assert.equal(JSON.parse(revert.body).action, 'restored');
    assert.equal(await readFile(join(workspace, 'inside.js'), 'utf8'), 'const a = 1;\n');
  });
});

test('reading a task id that was never recorded creates no task entry', async () => {
  await withSurface(async ({ router, post, get }) => {
    for (let i = 0; i < 50; i++) {
      const response = await get(`/api/dx/snapshot/diff?taskId=invented-${i}`);
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.body).files, []);
    }
    assert.equal(router.snapshotManager.tasks.size, 0, 'a read must not mint a task entry');

    // The write path still opens one, and that one is then readable.
    await writeFile(join(router.snapshotManager.projectRoot, 'a.txt'), 'x\n', 'utf8');
    assert.equal((await post('/api/dx/snapshot/record', { taskId: 'real', filePath: 'a.txt' })).status, 200);
    assert.equal(router.snapshotManager.tasks.size, 1);
    assert.equal(JSON.parse((await get('/api/dx/snapshot/diff?taskId=real')).body).files.length, 1);
  });
});

test('reverting a path that was never snapshotted is a 404, not a server error', async () => {
  await withSurface(async ({ post }) => {
    const response = await post('/api/dx/snapshot/revert', { taskId: 't-none', filePath: 'never.txt' });
    assert.equal(response.status, 404);
    assert.match(JSON.parse(response.body).error, /스냅샷을 찾을 수 없습니다/);
  });
});

test('a task id too long for the filesystem is refused as the caller\'s error', async () => {
  await withSurface(async ({ workspace, post, stateDir }) => {
    await writeFile(join(workspace, 'a.txt'), 'x\n', 'utf8');
    const response = await post('/api/dx/snapshot/record', { taskId: 'x'.repeat(5000), filePath: 'a.txt' });
    assert.equal(response.status, 400, 'an id the store cannot hold is a bad request, not a 500');
    assert.match(response.body, /스냅샷 저장소/);
    assert.equal(await stat(join(stateDir, 'snapshots')).then(() => true, () => false), true);
  });
});

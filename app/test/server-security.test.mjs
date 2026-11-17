// Security regressions for the HTTP + WebSocket server (app/server.mjs, app/websocket.mjs).
//
// Each test drives the same wire request an attacker uses and asserts the observable
// result. Four of them gate a fix in this file's own module and fail against the server
// as it was before it — a cross-origin page could reach every `/api/*` route, including
// the shell behind `/api/dx/verify/run`, and a declared body length was buffered in full:
//
//  1. a hostile page's cross-origin request cannot change state    (was: every /api/* route)
//  2. ...which includes arbitrary command execution                (was: /api/dx/verify/run)
//  3. ...and a path-taking route is no longer a cross-origin read  (was: reachable by page)
//  4. a body that announces more than the cap is refused unread     (was: buffered in full)
//
// Two are guards over behaviour that already held and must keep holding: the WebSocket
// upgrade's Origin rule, and a router's own 413 past a chunked body. They exist so a later
// edit cannot quietly drop either boundary.
//
// Everything asserted here is decided in app/server.mjs, before any router runs: the
// routers' own containment rules are that module's business, and this file does not
// depend on them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { createBridge } from '../server.mjs';

async function openBridge(t) {
  // One temp root holds the edited tree (`workspace`) and, beside it, files that are
  // outside that tree — "inside" and "outside" are this test's own directories.
  const root = mkdtempSync(join(tmpdir(), 'srvsec-'));
  const stateDir = join(root, 'state');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const app = await createBridge({ mock: true, config: { stateDir, coreCwd: workspace, previewRoot: workspace } });
  const url = await app.start(0);
  t.after(async () => {
    await app.close();
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  });
  return { app, url, root, stateDir, workspace, port: Number(new URL(url).port) };
}

/**
 * A raw request, because a browser sends headers `fetch` will not let a test write.
 * It finishes shortly after the response head arrives, so the small body that follows
 * is captured too, and a client that keeps sending after the answer cannot turn the
 * reply into an RST on Windows — nothing is written past the head's arrival.
 *
 * A connection that dies before a single byte came back is retried once: under a busy
 * machine the loopback connect itself can be refused, and that says nothing about the
 * server. Any other outcome is reported as it happened.
 * @returns {Promise<string>} the response bytes received
 */
async function rawRequest(port, text, options = {}) {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await rawAttempt(port, text, options);
    if (result.data) return result.data;
    last = result.error;
  }
  throw new Error(`no response from the server (${last})`);
}

function rawAttempt(port, text, { body = [], delayMs = 15, timeoutMs = 8000 } = {}) {
  return new Promise(done => {
    let data = '', settled = false, index = 0, grace = null, error = null;
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(text);
      const pump = () => {
        if (index >= body.length || settled || socket.destroyed || grace) return;
        socket.write(body[index++]);
        setTimeout(pump, delayMs);
      };
      pump();
    });
    const finish = () => { if (settled) return; settled = true; clearTimeout(grace); socket.destroy(); done({ data, error }); };
    socket.on('data', chunk => {
      data += chunk.toString('binary');
      if (!grace && data.includes('\r\n\r\n')) grace = setTimeout(finish, 150);
    });
    socket.on('close', () => { if (!settled) { settled = true; clearTimeout(grace); done({ data, error }); } });
    socket.on('error', cause => { error = cause.code ?? cause.message; });
    socket.setTimeout(timeoutMs, () => { error = error ?? 'timeout'; finish(); });
  });
}

test('a cross-origin page cannot change state on any /api route', async (t) => {
  const { url } = await openBridge(t);
  const hostile = { 'content-type': 'text/plain', origin: 'https://evil.example' };

  for (const pathname of ['/api/dx/tasks/save', '/api/memory/add', '/api/privacy/scan', '/api/insight/summarize']) {
    const response = await fetch(`${url}${pathname}`, {
      method: 'POST', headers: hostile, body: JSON.stringify({ taskId: 't', request: 'x', text: 'a', events: [] }),
    });
    assert.equal(response.status, 403, `${pathname} must refuse foreign origins`);
    assert.equal((await response.json()).error, 'cross_origin_denied');
  }
  // A state-changing read is the same decision.
  const detect = await fetch(`${url}/api/dx/project/detect`, { headers: hostile });
  assert.equal(detect.status, 403);

  // The browser's other signal is enough on its own: a form-style POST from a foreign
  // page carries no Origin but is always labelled cross-site, and cannot be written by
  // the page.
  const form = await fetch(`${url}/api/dx/tasks/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
    body: 'taskId=t',
  });
  assert.equal(form.status, 403);

  // The page's own calls still work: same origin in the Origin header, and a same-origin
  // GET (which browsers send without any Origin at all).
  const own = await fetch(`${url}/api/dx/tasks/save`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ taskId: 't-own', request: 'x' }),
  });
  assert.equal(own.status, 200);
  assert.equal((await fetch(`${url}/api/config`)).status, 200);
  assert.equal((await fetch(`${url}/api/config`, { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test('a cross-origin page cannot reach the shell behind /api/dx/verify/run', async (t) => {
  const { url, workspace } = await openBridge(t);
  const marker = join(workspace, 'rce-marker.txt');
  const response = await fetch(`${url}/api/dx/verify/run`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    body: JSON.stringify({ projectRoot: workspace, command: `echo RCE>${marker}` }),
  });
  assert.equal(response.status, 403);
  assert.equal(existsSync(marker), false, 'a refused request must not have run anything');

  // Same route, same body, from the app's own origin: the endpoint is still the local
  // owner's tool, so this is a boundary test, not a removal of the feature.
  const own = await fetch(`${url}/api/dx/verify/run`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: url },
    body: JSON.stringify({ projectRoot: workspace, command: 'node -v' }),
  });
  assert.equal(own.status, 200);
  assert.equal((await own.json()).status, 'passed');
});

test('a foreign page cannot turn a path-taking route into a file read', async (t) => {
  const { url, root } = await openBridge(t);
  const canary = join(root, 'outside-root-secret.txt');
  writeFileSync(canary, 'TOPSECRET-TRAVERSAL-CANARY', 'utf8');
  const absolute = canary.replace(/\\/g, '/');

  // The read this attacker wants: name any file on the machine and get its bytes back.
  // It is decided at the door, so the router never sees the path at all.
  const record = await fetch(`${url}/api/dx/snapshot/record`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    body: JSON.stringify({ taskId: 'probe', filePath: absolute }),
  });
  assert.equal(record.status, 403);
  assert.equal((await record.text()).includes('TOPSECRET-TRAVERSAL-CANARY'), false);

  // The same refused attempt leaves nothing behind for a later read to collect.
  const diff = await fetch(`${url}/api/dx/snapshot/diff?taskId=probe`);
  assert.equal((await diff.text()).includes('TOPSECRET-TRAVERSAL-CANARY'), false);
  assert.equal(readFileSync(canary, 'utf8'), 'TOPSECRET-TRAVERSAL-CANARY', 'the canary is untouched');
});

test('a body that announces more than the cap is refused without being buffered', async (t) => {
  const { port } = await openBridge(t);
  // No body is sent at all: the declared length alone is what decides, which is the
  // point — the refusal happens before a single byte of the payload is buffered.
  const declared = 9 * 1024 * 1024;
  const response = await rawRequest(port,
    `POST /api/dx/explain-error HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: text/plain\r\nContent-Length: ${declared}\r\n\r\n`);
  assert.match(response.split('\r\n')[0], /413/, 'the declared length alone is enough to answer');
  assert.match(response, /request_body_too_large/);
  assert.match(response, /Connection: close/i, 'the pipe is closed instead of reused');
});

test('a chunked body past a router cap answers 413, not a server error', async (t) => {
  const { port, url } = await openBridge(t);
  const piece = 'y'.repeat(256 * 1024);
  // Just past the routers' 5MB ceiling, so the test proves the refusal without
  // spending the machine's memory on a payload the cap already rejects.
  const chunks = Array.from({ length: 21 }, () => `${piece.length.toString(16)}\r\n${piece}\r\n`);
  const response = await rawRequest(port,
    `POST /api/dx/explain-error HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n`,
    { body: chunks, delayMs: 5 });
  assert.match(response.split('\r\n')[0], /413/, 'the router ceiling is a client error');
  assert.equal(/500 Internal/.test(response), false, 'and never a server failure');
  assert.match(response, /"error"/, 'the answer is the router\'s own refusal body');
  // The server survived the flood and still answers.
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
});

test('the WebSocket upgrade keeps its own origin rule', async (t) => {
  const { port, url } = await openBridge(t);
  const key = Buffer.alloc(16, 7).toString('base64');
  const upgrade = origin => rawRequest(port, [
    'GET /ws HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${key}`, ...(origin ? [`Origin: ${origin}`] : []), '', '',
  ].join('\r\n'));

  assert.match((await upgrade('https://evil.example')).split('\r\n')[0], /403/);
  assert.match((await upgrade('null')).split('\r\n')[0], /403/, 'a sandboxed frame has no origin of its own');
  assert.match((await upgrade(url)).split('\r\n')[0], /101/);
  assert.match((await upgrade(undefined)).split('\r\n')[0], /101/, 'a non-browser client sends no Origin, exactly as before');
});

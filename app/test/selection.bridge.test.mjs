// The bridge reads the gateway's own last decision back after a turn and forwards it
// as a `selection` frame. These tests pin the three properties the UI relies on: the
// identity header and route travel from the runtime's own models.yml (never from the
// page), a read failure is not a prompt failure, and nothing is read when the
// conversation has no single identity to read with.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge, readSelection, selectionIdentity } from '../server.mjs';

const SELECTION = {
  sequence:1,
  decided_at:'2026-02-14T03:04:05.000Z',
  capability:'chat',
  route:'local_only',
  model:{ id:'deepseek/deepseek-v4.1-flash-1017',upstream:'openrouter',source:'gateway',reason:'auto:local_declared' },
  reasoning:{ source:'gateway',reason:'auto:threshold_medium',grade:'medium',thinking_budget:4096 }
};

function agentDir(models) {
  const dir = mkdtempSync(join(tmpdir(),'selection-identity-'));
  if (models !== null) writeFileSync(join(dir,'models.yml'),models,'utf8');
  return { dir, cleanup:() => rmSync(dir,{ recursive:true,force:true }) };
}

/** A loopback stand-in for the gateway's read-only endpoint, recording every request. */
async function gateway(handler) {
  const requests = [];
  const server = http.createServer((req,res) => {
    requests.push({ method:req.method, path:req.url, identity:req.headers['x-user-id'] ?? null, route:req.headers['x-route'] ?? null });
    handler(req,res);
  });
  await new Promise(ok => server.listen(0,'127.0.0.1',ok));
  return { requests, url:`http://127.0.0.1:${server.address().port}/v1`, close:() => new Promise(ok => server.close(ok)) };
}

async function connect(app) {
  const url = await app.start(0);
  const socket = new WebSocket(url.replace('http:','ws:') + '/ws');
  const frames = [], waiters = [];
  socket.addEventListener('message', e => { frames.push(JSON.parse(e.data)); for (const wake of [...waiters]) wake(); });
  function until(predicate) {
    const found = frames.find(predicate); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a bridge frame')),5000);
      const wake = () => { const frame = frames.find(predicate); if (frame) { clearTimeout(timer); waiters.splice(waiters.indexOf(wake),1); resolve(frame); } };
      waiters.push(wake);
    });
  }
  return { socket, url, frames, until };
}

test('selection identity comes from the runtime models.yml and never from a guess', () => {
  const one = agentDir('providers:\n  gateway-local:\n    headers:\n      x-user-id: student-1\n');
  const two = agentDir('providers:\n  a:\n    headers:\n      x-user-id: user-a\n  b:\n    headers:\n      x-user-id: user-b\n');
  const variable = agentDir('providers:\n  a:\n    headers:\n      x-user-id: OMP_STUDENT\n');
  const none = agentDir('providers:\n  a:\n    baseUrl: http://127.0.0.1:8787/v1\n');
  try {
    assert.equal(selectionIdentity({ PI_CODING_AGENT_DIR:one.dir }),'student-1');
    assert.equal(selectionIdentity({ PI_CODING_AGENT_DIR:two.dir }),null,'two identities cannot be resolved to one');
    assert.equal(selectionIdentity({ PI_CODING_AGENT_DIR:none.dir }),null);
    // omp sends a bare variable name when it is unset, so the bridge mirrors that
    // literal rather than substituting an identity of its own (same rule as x-route).
    assert.equal(selectionIdentity({ PI_CODING_AGENT_DIR:variable.dir }),'OMP_STUDENT');
    assert.equal(selectionIdentity({ PI_CODING_AGENT_DIR:variable.dir, OMP_STUDENT:'env-user' }),'env-user','a non-empty environment value wins like omp resolves it');
  } finally { for (const d of [one,two,variable,none]) d.cleanup(); }
});

test('readSelection reads {endpoint}/selection with both headers and treats every failure as null', async () => {
  const ok = await gateway((req,res) => { res.writeHead(200,{ 'Content-Type':'application/json' }); res.end(JSON.stringify({ selection:SELECTION })); });
  const denied = await gateway((req,res) => { res.writeHead(401); res.end('{}'); });
  const broken = await gateway((req,res) => { res.writeHead(200); res.end('not json'); });
  try {
    const read = await readSelection({ endpoint:ok.url, route:'local_only', identity:'student-1' });
    assert.equal(read.model.id,'deepseek/deepseek-v4.1-flash-1017');
    assert.deepEqual(ok.requests,[{ method:'GET', path:'/v1/selection', identity:'student-1', route:'local_only' }]);
    assert.equal(await readSelection({ endpoint:denied.url, route:'local_only', identity:'student-1' }),null);
    assert.equal(await readSelection({ endpoint:broken.url, route:'local_only', identity:'student-1' }),null);
    assert.equal(await readSelection({ endpoint:'http://127.0.0.1:1/v1', route:'local_only', identity:'student-1' }),null,'a refused connection is not an error the caller sees');
    assert.equal(await readSelection({ endpoint:ok.url, route:'not_a_route', identity:'student-1' }),null);
    assert.equal(await readSelection({ endpoint:ok.url, route:'local_only', identity:'' }),null);
    assert.equal(ok.requests.length,1,'a route or identity the bridge cannot send is never requested');
    const offDevice = 'http://10.0.0.5:8787/v1';
    assert.equal(await readSelection({ endpoint:offDevice, route:'local_only', identity:'student-1' }),null,'an off-device endpoint is not read');
  } finally { await ok.close(); await denied.close(); await broken.close(); }
});

test('a finished turn forwards the gateway selection to that session as a selection frame', { timeout:15000 }, async t => {
  const served = await gateway((req,res) => { res.writeHead(200,{ 'Content-Type':'application/json' }); res.end(JSON.stringify({ selection:SELECTION })); });
  const identity = agentDir('providers:\n  gateway-local:\n    headers:\n      x-user-id: student-1\n      x-route: OMP_BRIDGE_ROUTE\n');
  const app = await createBridge({ mock:true, coreEnv:{ PI_CODING_AGENT_DIR:identity.dir }, config:{ local:{ provider:'openai', model:'qwen3:32b', endpoint:served.url } } });
  t.after(async () => { await app.close(); await served.close(); identity.cleanup(); });
  const client = await connect(app); await client.until(x => x.type === 'bridge_ready');
  client.socket.send(JSON.stringify({ type:'prompt', message:'선택 조회 확인' }));
  const frame = await client.until(x => x.type === 'selection');
  assert.deepEqual(frame.selection,SELECTION,'the gateway record is forwarded as reported, not reshaped');
  assert.deepEqual(served.requests,[{ method:'GET', path:'/v1/selection', identity:'student-1', route:'local_only' }],'the read carries the runtime identity and this conversation route');
  assert.ok(client.frames.some(x => x.type === 'prompt_result'),'the prompt round-trip still completed');
});

test('a failed or empty selection read never becomes a prompt failure or a bridge error', { timeout:15000 }, async t => {
  const failing = await gateway((req,res) => { res.writeHead(503); res.end('{"error":{"message":"unavailable"}}'); });
  const empty = await gateway((req,res) => { res.writeHead(200,{ 'Content-Type':'application/json' }); res.end(JSON.stringify({ selection:null })); });
  const identity = agentDir('providers:\n  gateway-local:\n    headers:\n      x-user-id: student-1\n');
  const failingApp = await createBridge({ mock:true, coreEnv:{ PI_CODING_AGENT_DIR:identity.dir }, config:{ local:{ provider:'openai', model:'qwen3:32b', endpoint:failing.url } } });
  const emptyApp = await createBridge({ mock:true, coreEnv:{ PI_CODING_AGENT_DIR:identity.dir }, config:{ local:{ provider:'openai', model:'qwen3:32b', endpoint:empty.url } } });
  t.after(async () => { await failingApp.close(); await emptyApp.close(); await failing.close(); await empty.close(); identity.cleanup(); });
  for (const app of [failingApp,emptyApp]) {
    const client = await connect(app); await client.until(x => x.type === 'bridge_ready');
    client.socket.send(JSON.stringify({ type:'prompt', message:'조회 실패 확인' }));
    const frame = await client.until(x => x.type === 'selection');
    assert.equal(frame.selection,null,'a failed or empty read is reported as no selection');
    assert.ok(client.frames.some(x => x.type === 'prompt_result'),'the prompt round-trip completed despite the failed read');
    assert.equal(client.frames.some(x => x.type === 'bridge_error'),false,'a selection read failure never surfaces as a bridge error');
  }
});

test('no identity means no read at all, and the turn still completes', { timeout:15000 }, async t => {
  const served = await gateway((req,res) => { res.writeHead(200,{ 'Content-Type':'application/json' }); res.end(JSON.stringify({ selection:SELECTION })); });
  const identity = agentDir(null);
  const app = await createBridge({ mock:true, coreEnv:{ PI_CODING_AGENT_DIR:identity.dir }, config:{ local:{ provider:'openai', model:'qwen3:32b', endpoint:served.url } } });
  t.after(async () => { await app.close(); await served.close(); identity.cleanup(); });
  const client = await connect(app); await client.until(x => x.type === 'bridge_ready');
  client.socket.send(JSON.stringify({ type:'prompt', message:'신원 미확인' }));
  await client.until(x => x.type === 'prompt_result');
  await client.until(x => x.type === 'session_settled');
  assert.deepEqual(served.requests,[],'an identity the bridge cannot resolve sends no request');
  assert.equal(client.frames.some(x => x.type === 'selection'),false,'no selection frame is invented');
  assert.equal(client.frames.some(x => x.type === 'bridge_error'),false);
});

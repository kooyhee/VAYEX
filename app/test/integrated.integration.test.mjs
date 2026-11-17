import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startRealFixture, attach } from './real-fixture.mjs';
import { promptCommand, command } from '../public/protocol.js';

test('one local listener serves real OMP inference, JSON and SSE with recorded automatic decisions', { timeout:45000 }, async t => {
  const f = await startRealFixture(); t.after(() => f.close());
  const models = await fetch(f.url + '/v1/models');
  assert.equal(models.status,200,'the app, not a second gateway, serves the compatible API');
  assert.ok((await models.json()).data.some(m => m.id === 'stub-7b'));
  const health = await fetch(f.url + '/healthz');
  assert.equal(health.status,200);
  const c = attach(f.url); await c.until(x => x.type === 'bridge_ready' || x.type === 'bridge_error');
  assert.equal(c.frames.find(x => x.type === 'bridge_error'),undefined);
  c.socket.send(JSON.stringify(command('get_state')));
  const state = await c.until(x => x.type === 'response' && x.command === 'get_state');
  assert.equal(state.data.model.baseUrl,f.url + '/v1');
  assert.notEqual(new URL(state.data.model.baseUrl).port,'8787');
  const s = [...f.bridge.sessions.values()][0];
  const modelsText = await readFile(s.agentModelsFile,'utf8');
  assert.equal(JSON.parse(modelsText).providers['harness-local'].baseUrl,f.url + '/v1');
  const prompt = promptCommand('hello integrated fixture');
  c.socket.send(JSON.stringify(prompt));
  const result = await c.until(x => x.type === 'prompt_result' && x.id === prompt.id);
  assert.equal(result.status,'completed');
  const frame = await c.until(x => x.type === 'selection' && x.selection);
  assert.equal(frame.selection.model.id,'stub-7b');
  assert.equal(frame.selection.model.source,'gateway');
  assert.equal(frame.selection.reasoning.source,'gateway');
  assert.match(frame.selection.reasoning.grade,/^(low|medium|high)$/);
  const recorded = await (await fetch(f.url + '/v1/selection',{ headers:{ 'x-user-id':s.identity,'x-route':'local_only' } })).json();
  assert.deepEqual(recorded.selection,frame.selection);
  const runtimeRequest = f.requests.find(r => r.body);
  assert.equal(runtimeRequest.body.model,'stub-7b');
  assert.equal(runtimeRequest.body.stream,true);
  assert.equal(runtimeRequest.body.reasoning_effort,recorded.selection.reasoning.grade);
  assert.equal(runtimeRequest.body.thinking_budget,recorded.selection.reasoning.thinking_budget);
  assert.ok(runtimeRequest.body.thinking_budget > 0 && runtimeRequest.body.thinking_budget <= 8192);
  const json = await fetch(f.url + '/v1/chat/completions',{
    method:'POST',headers:{ 'content-type':'application/json','x-user-id':'json-user','x-route':'local_only' },
    body:JSON.stringify({ messages:[{ role:'user',content:'JSON integrated fixture' }],stream:false,untrusted_field:'must-not-leave' })
  });
  assert.equal(json.status,200);
  const completion = await json.json();
  assert.equal(completion.object,'chat.completion');
  assert.match(completion.choices[0].message.content,/테스트 스텁/);
  assert.equal(completion.gateway.model.source,'gateway');
  assert.equal(completion.gateway.reasoning.grade,'low');
  assert.equal(Object.hasOwn(f.requests.at(-1).body,'untrusted_field'),false);
  const selected = await (await fetch(f.url + '/v1/selection',{ headers:{ 'x-user-id':'json-user','x-route':'local_only' } })).json();
  assert.equal(selected.selection.model.id,'stub-7b');
  assert.equal(selected.selection.reasoning.grade,'low');
  console.log('Effective runtime base URL:',state.data.model.baseUrl);
});

async function post(f,body,headers = {}) {
  const response = await fetch(f.url + '/v1/chat/completions',{
    method:'POST',headers:{ 'content-type':'application/json','x-user-id':'local-user','x-route':'local_only',...headers },body:JSON.stringify(body)
  });
  return { status:response.status,json:await response.json() };
}
const messages = content => [{ role:'user',content }];

test('integrated route policy refuses cloud fallback, invalid routes and unattested consent', { timeout:45000 }, async t => {
  const f = await startRealFixture({ configureInference:raw => ({ ...raw,upstreams:[...raw.upstreams,{
    id:'cloud',class:'proxy',base_url:raw.upstreams[0].base_url,auth_mode:'none',
    models:[{ id:'retained-cloud',capabilities:['chat'],zero_data_retention:false,training_opt_out:false,context_window:32768 }]
  }] }) }); t.after(() => f.close());
  const body = { model:'retained-cloud',messages:messages('policy probe') };
  const local = await post(f,body);
  assert.equal(local.status,400); assert.equal(local.json.error.code,'local_only_not_served');
  const unknown = await post(f,body,{ 'x-route':'not-a-route' });
  assert.equal(unknown.status,400); assert.equal(unknown.json.error.code,'invalid_route');
  const conflict = await post(f,{ ...body,route:'any_cloud' });
  assert.equal(conflict.status,400); assert.equal(conflict.json.error.code,'route_conflict');
  const unattested = await post(f,body,{ 'x-route':'any_cloud','x-cloud-consent':'true' });
  assert.equal(unattested.status,403); assert.equal(unattested.json.error.code,'consent_required');
  assert.equal(f.requests.filter(r => r.body).length,0);
  const zdr = attach(f.url,'?route=zdr_cloud&consent=1');
  await zdr.until(x => x.type === 'bridge_ready' || x.type === 'bridge_error');
  assert.equal(zdr.frames.find(x => x.type === 'bridge_error'),undefined);
  const session = f.bridge.sessions.get(zdr.frames.find(x => x.type === 'bridge_connected').sessionId);
  const denied = await post(f,body,{ 'x-route':'zdr_cloud','x-app-session':session.token });
  assert.equal(denied.status,403); assert.equal(denied.json.error.code,'route_policy_violation');
  const changedRoute = await post(f,body,{ 'x-route':'any_cloud','x-app-session':session.token });
  assert.equal(changedRoute.status,403); assert.equal(changedRoute.json.error.code,'session_route_mismatch');
  assert.equal(f.requests.filter(r => r.body).length,0);
  const any = attach(f.url,'?route=any_cloud&consent=1');
  await any.until(x => x.type === 'bridge_ready' || x.type === 'bridge_error');
  assert.equal(any.frames.find(x => x.type === 'bridge_error'),undefined);
  const wideSession = f.bridge.sessions.get(any.frames.find(x => x.type === 'bridge_connected').sessionId);
  const accepted = await post(f,body,{ 'x-route':'any_cloud','x-app-session':wideSession.token });
  assert.equal(accepted.status,200); assert.equal(accepted.json.gateway.model.id,'retained-cloud');
  const nextConversation = attach(f.url,'?route=any_cloud');
  const nextReady = await nextConversation.until(x => x.type === 'bridge_ready' || x.type === 'bridge_error');
  assert.equal(nextReady.type,'bridge_ready');
  const nextConnected = nextConversation.frames.find(x => x.type === 'bridge_connected');
  assert.equal(nextConnected.route,'local_only');
  assert.equal(nextConnected.requestedRoute,'any_cloud');
  assert.equal(nextConnected.routeFallback,'consent_off');
  assert.equal(nextConversation.frames.some(x => x.type === 'bridge_error'),false);
  assert.equal([...f.bridge.sessions.values()].filter(s => !s.consent && s.route === 'any_cloud').length,0);
  assert.equal(f.requests.filter(r => r.body).length,1);
});

test('integrated quota persists reported and unknown usage and refuses the next request', { timeout:15000 }, async t => {
  const f = await startRealFixture({ configureInference:raw => ({ ...raw,quota:{ ...raw.quota,requests_per_day:2,tokens_per_day:10000 } }) }); t.after(() => f.close());
  assert.equal((await post(f,{ messages:messages('reported usage') })).status,200);
  assert.equal((await post(f,{ messages:messages('unknown usage') })).status,200);
  const quota = JSON.parse(await readFile(f.bridge.inference.config.quota.ledgerPath,'utf8'));
  const day = Object.values(quota.users['local-user'])[0];
  assert.equal(day.requests,2); assert.equal(day.tokens,12); assert.equal(day.unknown_usage,1);
  assert.equal(day.reserved_requests,0); assert.equal(day.reserved_tokens,0);
  const over = await post(f,{ messages:messages('must not reach the fixture') });
  assert.equal(over.status,429); assert.equal(over.json.error.code,'quota_exceeded');
  assert.equal(f.requests.filter(r => r.body).length,2);
});

test('integrated JSON SSE and substituted log fields are redacted without logging prompts', { timeout:15000 }, async t => {
  const key = 'fixture-provider-secret-0123456789';
  const f = await startRealFixture({ providerKey:key,configureInference:raw => ({ ...raw,upstreams:raw.upstreams.map(u => ({ ...u,auth_mode:'gateway_key',key_env:'FIXTURE_UPSTREAM_KEY' })) }) }); t.after(() => f.close());
  const prompt = 'credential echo private-prompt-must-not-appear-in-logs';
  const json = await post(f,{ messages:messages(prompt) });
  assert.equal(json.status,200); assert.equal(json.json.choices[0].message.content,'[REDACTED]');
  const response = await fetch(f.url + '/v1/chat/completions',{
    method:'POST',headers:{ 'content-type':'application/json','x-user-id':'stream-user','x-route':'local_only' },
    body:JSON.stringify({ messages:messages(prompt),stream:true })
  });
  assert.equal(response.status,200); assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const stream = await response.text();
  assert.ok(stream.includes('[REDACTED]')); assert.equal(stream.includes(key),false); assert.ok(stream.includes('data: [DONE]'));
  f.bridge.inference.logger.child({ scope:'custom-redactor' },{ value:fields => ({ ...fields,substituted:key }) }).info('redaction_probe',{ nested:{ value:key } });
  const logs = await readFile(f.bridge.inference.config.logging.file,'utf8');
  assert.equal(logs.includes(key),false); assert.equal(logs.includes(prompt),false);
  assert.ok(logs.includes('[REDACTED]')); assert.ok(logs.includes('redaction_probe'));
  assert.equal(f.logs.join('').includes(key),false); assert.equal(f.logs.join('').includes(prompt),false);
});

// The wait this test exercises is `startRealFixture()` plus the core's own `bridge_ready`:
// a real bun omp child has to start, negotiate and read its overlay. Measured on this
// machine (12 logical CPUs): 2.6 s alone, 7.7–8.1 s with six fixtures up at once, and
// 15.6–21.3 s with twelve — which is what `node --test test/*.test.mjs` creates, since it
// runs a file per logical CPU and several of those files launch real cores. The 15 s cap
// therefore expired before `bridge_ready` arrived during a full run; the gate adds
// nothing here (this test never sends a prompt: `screenOutbound` costs 0.07 ms and its
// import 12.5 ms idle / 76 ms busy). The budget is above the slowest measured startup, so
// the assertion stays about the app's base URL and the retired port, not about CPU speed;
// a real hang still fails, because nothing here ever answers.
const CORE_READY_BUDGET_MS = 45000;

test('no listener is required on 8787 and effective base URL points at the app', { timeout:CORE_READY_BUDGET_MS }, async t => {
  const f = await startRealFixture(); t.after(() => f.close());
  const c = attach(f.url); await c.until(x => x.type === 'bridge_ready' || x.type === 'bridge_error');
  assert.equal(c.frames.find(x => x.type === 'bridge_error'),undefined);
  c.socket.send(JSON.stringify(command('get_state')));
  const state = await c.until(x => x.type === 'response' && x.command === 'get_state');
  assert.equal(state.data.model.baseUrl,f.url + '/v1');
  const retiredReachable = await fetch('http://127.0.0.1:8787/v1/models').then(() => true).catch(() => false);
  assert.equal(retiredReachable,false,'retired port 8787 must not have any listener');
});


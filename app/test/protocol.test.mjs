import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createViewModel,applyFrame,approvalCommand,approvalLabel,FrameDecoder,negotiationResult,beginModelSwitch,setConsent,canSendPrompt } from '../public/protocol.js';
import { Peer } from '../websocket.mjs';
import { createBridge } from '../server.mjs';

test('observed select approvals return the exact chosen label, never confirmed or an app-side always rule',() => {
  const request = { id:'abc123',method:'select',options:['Approve','Approve bash for this session','Deny'] };
  for (const value of request.options) assert.deepEqual(approvalCommand(request,value),{ type:'extension_ui_response',id:'abc123',value });
  assert.throws(() => approvalCommand(request,'reject'),/제공하지 않은/);
});
test('every core approval option keeps its own Korean label and its own scope',() => {
  // Exactly the option vocabulary the installed core emits for a `write` approval, plus the
  // bash session label already in use. Each distinct scope must stay distinct.
  const observed = ['Approve Once','Approve File','Approve Directory: ~','Always Approve File','Always Approve Directory: ~','Approve bash for this session','Deny'];
  const labels = observed.map(approvalLabel);
  assert.deepEqual(labels,[
    '한 번 승인','파일에 대해 승인','폴더에 대해 승인: ~','항상 파일에 대해 승인','항상 폴더에 대해 승인: ~','이 세션에서 bash 승인','거절'
  ]);
  assert.equal(new Set(labels).size,labels.length,'two scopes must never collapse into one label');
  assert.equal(labels.at(-1),'거절','deny stays last, as the core orders it');
  assert.equal(approvalLabel('Approve'),'한 번 승인');
  assert.equal(approvalLabel('Approve zsh for this session'),'이 세션에서 zsh 승인');
  assert.equal(approvalLabel('Approve Directory: C:\\work'),'폴더에 대해 승인: C:\\work','two directories stay distinguishable');
  assert.equal(approvalLabel('Something New'),'Something New','an unknown option is never dropped or renamed');
});
// The labels above only prove the mapping function; nothing proved the card behind a real
// frame renders through it. This drives the shipped page (public/app.js) in a Chromium-family
// browser over the DevTools pipe — the same harness the other frontend Node tests use — and
// reads the buttons the approval card actually builds.
const browserCandidates = () => [
  process.env.CHROME_PATH,
  process.env['ProgramFiles'] && join(process.env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['ProgramFiles'] && join(process.env['ProgramFiles'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium'
];
const chromePath = browserCandidates().find(path => path && existsSync(path));
const browserSkip = chromePath ? false
  : 'No Chromium-family browser (Chrome, Edge or Chromium) found at a standard install location and CHROME_PATH is unset, so the shipped page cannot be rendered';

// Runs before any page script: the page talks to these stubs, so a test can hand the app the
// exact core frame it wants instead of waiting for a core to emit one.
const pageStubs = `(() => {
  const config = {
    mock:true, defaultRoute:'local_only',
    route:{ route:'local_only', consent:false, invalid:null, requested:'local_only', fallback:null, served:true, servedReason:null },
    routes:{ local_only:{ served:true, reason:null }, zdr_cloud:{ served:true, reason:null }, any_cloud:{ served:true, reason:null } },
    local:{ provider:'stub', model:'stub-local', available:true, label:'stub' },
    background:{ available:false, reason:'stub' },
    cloud:null, endpoints:{}
  };
  window.__approvalTest = { sockets:[] };
  window.fetch = async () => new Response(JSON.stringify(config), { headers:{ 'Content-Type':'application/json' } });
  window.WebSocket = class extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { super(); window.__approvalTest.sockets.push(this); queueMicrotask(() => this.frame({ type:'bridge_ready' })); }
    frame(data) { this.dispatchEvent(new MessageEvent('message', { data:JSON.stringify(data) })); }
    send(raw) {
      const command = JSON.parse(raw); this.sent.push(command);
      if (command.type === 'get_state') queueMicrotask(() => this.frame({ type:'response', id:command.id, command:'get_state', success:true, data:{ model:{ provider:'stub', id:'stub-local' } } }));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  };
})();`;

async function openPage() {
  const profile = await mkdtemp(join(tmpdir(), 'omp-approval-card-'));
  const child = spawn(chromePath, [
    '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1280,900', `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let nextId = 0, buffer = '';
  const pending = new Map();
  child.stdio[4].on('data', chunk => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  const { targetInfos } = await send('Target.getTargets');
  const { sessionId } = await send('Target.attachToTarget', { targetId:targetInfos.find(info => info.type === 'page').targetId, flatten:true });
  const page = (method, params) => send(method, params, sessionId);
  const evaluate = async expression => {
    const { result, exceptionDetails } = await page('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  await page('Page.enable');
  await page('Page.addScriptToEvaluateOnNewDocument', { source:pageStubs });
  return {
    evaluate, until,
    navigate: async url => {
      await page('Page.navigate', { url });
      await until(`document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`, `load of ${url}`);
    },
    close: async () => {
      await send('Browser.close').catch(() => {});
      await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
      await rm(profile, { recursive:true, force:true, maxRetries:5, retryDelay:200 });
    }
  };
}

test('the approval card renders the Korean labels of the real write options and replies with the core value', { skip:browserSkip, timeout:60000 }, async () => {
  const options = ['Approve Once','Approve File','Approve Directory: ~','Always Approve','Always Approve File','Always Approve Directory: ~','Deny'];
  const labels = ['한 번 승인','파일에 대해 승인','폴더에 대해 승인: ~','항상 승인','항상 파일에 대해 승인','항상 폴더에 대해 승인: ~','거절'];
  const bridge = await createBridge({ mock:true });
  const baseUrl = await bridge.start(0);
  const browser = await openPage();
  try {
    await browser.navigate(`${baseUrl}/`);
    await browser.until(`window.__approvalTest?.sockets.length === 1 && !!document.getElementById('approvals')`, 'the app shell and its socket');
    assert.equal(await browser.evaluate(`document.getElementById('approvals').hidden`), true, 'the gate is absent before the core asks');

    const askFor = id => browser.evaluate(`(() => {
      window.__approvalTest.sockets[0].frame({ type:'extension_ui_request', id:${JSON.stringify(id)}, method:'select',
        title:'파일을 수정하려고 합니다', message:'허용 범위를 고르세요', options:${JSON.stringify(options)} });
      return true;
    })()`);
    /** The collapsed scope group's radio labels, then the two buttons. */
    const radios = () => browser.evaluate(`[...document.querySelectorAll('#gate-radios input[type=radio]')].map(input => input.closest('label').textContent.trim())`);

    await askFor('ap-write');
    await browser.until(`!document.getElementById('approvals').hidden && document.querySelectorAll('#gate-radios input[type=radio]').length === ${options.length - 1}`, 'one radio per approve option');
    assert.deepEqual(await radios(), labels.slice(0, -1), 'each core approve option renders as its own Korean label, in core order');
    assert.equal(new Set(await radios()).size, labels.length - 1, 'two scopes must never render the same radio text');
    assert.ok(!(await radios()).some(text => /Approve|Deny/.test(text)), 'an English core label leaked into the gate');
    assert.equal(await browser.evaluate(`document.querySelectorAll('#gate-radios input:checked').length`), 1, 'exactly one scope is selected by default');
    assert.equal(await browser.evaluate(`document.querySelector('#gate-radios input:checked').closest('label').textContent.trim()`), '한 번 승인', 'the default scope is 한 번 승인');
    // Two buttons only: 승인 and 거절. The six core options are a collapsed radio group.
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('#gate > .gate-actions button')].map(b => b.textContent.trim())`), ['승인', '거절']);

    // Choosing a scope sends the core's own option string back, never the Korean label the user read.
    await browser.evaluate(`(() => {
      const input = [...document.querySelectorAll('#gate-radios input')].find(node => node.closest('label').textContent.trim() === '폴더에 대해 승인: ~');
      input.checked = true; input.dispatchEvent(new Event('change', { bubbles:true }));
      document.getElementById('approval-approve').click();
    })()`);
    await browser.until(`window.__approvalTest.sockets[0].sent.some(frame => frame.type === 'extension_ui_response')`, 'the reply to reach the socket');
    assert.deepEqual(await browser.evaluate(`window.__approvalTest.sockets[0].sent.filter(frame => frame.type === 'extension_ui_response').at(-1)`),
      { type:'extension_ui_response', id:'ap-write', value:'Approve Directory: ~' }, 'the chosen scope must travel back as the original core value');
    await browser.until(`document.getElementById('approvals').hidden`, 'the answered gate to clear');

    await askFor('ap-deny');
    await browser.until(`!document.getElementById('approvals').hidden && document.querySelectorAll('#gate-radios input[type=radio]').length === ${options.length - 1}`, 'the second gate');
    assert.deepEqual(await radios(), labels.slice(0, -1), 'a second request renders the same scope labels');
    await browser.evaluate(`document.getElementById('approval-deny').click()`);
    await browser.until(`window.__approvalTest.sockets[0].sent.filter(frame => frame.type === 'extension_ui_response').length === 2`, 'the reject reply');
    assert.deepEqual(await browser.evaluate(`window.__approvalTest.sockets[0].sent.filter(frame => frame.type === 'extension_ui_response').at(-1)`),
      { type:'extension_ui_response', id:'ap-deny', value:'Deny' }, '거절 must send the core value Deny, not the Korean text');
  } finally {
    await browser.close();
    await bridge.close();
  }
});
test('startup widget/catalog notifications do not become blocking approvals',() => {
  const vm = createViewModel();
  applyFrame(vm,{ type:'extension_ui_request',id:'w',method:'setWidget',widgetKey:'autoresearch',widgetLines:['실제 위젯 내용'] });
  applyFrame(vm,{ type:'available_commands_update',commands:[{ name:'long-command',description:'x'.repeat(16384),input:'query',subcommands:[],source:'builtin' }] });
  assert.equal(vm.approvals.length,0); assert.deepEqual(vm.widgets.autoresearch,['실제 위젯 내용']); assert.equal(vm.commands[0].name,'long-command');
  applyFrame(vm,{ type:'extension_ui_request',id:'clear',method:'setWidget',widgetKey:'autoresearch' }); assert.equal(vm.widgets.autoresearch,undefined);
});
test('id-less streamed message events preserve text blocks and distinct turns without duplicating user echo',() => {
  const vm = createViewModel(); vm.messages.push({ id:'optimistic',role:'user',text:'질문',blocks:{},pending:true });
  const user = { role:'user',content:[{ type:'text',text:'질문' }] };
  applyFrame(vm,{ type:'message_start',message:user }); applyFrame(vm,{ type:'message_end',message:user });
  for (const text of ['첫 응답','다음 응답']) {
    applyFrame(vm,{ type:'message_start',message:{ role:'assistant',content:[] } });
    applyFrame(vm,{ type:'message_update',assistantMessageEvent:{ type:'text_delta',contentIndex:0,delta:text } });
    applyFrame(vm,{ type:'message_end',message:{ role:'assistant',content:[{ type:'text',text }] } });
  }
  assert.deepEqual(vm.messages.map(x => x.text),['질문','첫 응답','다음 응답']);
});
test('parse and unknown-command errors survive later success and fail-closed tool text remains visible',() => {
  const vm = createViewModel();
  applyFrame(vm,{ type:'response',command:'parse',success:false,error:'Failed to parse command: JSON Parse error' });
  applyFrame(vm,{ id:'bad',type:'response',command:'no_such_command',success:false,error:'Unknown command: no_such_command' });
  applyFrame(vm,{ type:'response',id:'good',command:'get_state',success:true,data:{ model:{ provider:'llamacpp-stub',id:'stub-7b' },systemPrompt:'private',dumpTools:['private'] } });
  assert.equal(vm.errors.length,2); assert.equal(vm.coreModel,'llamacpp-stub/stub-7b'); assert.equal(vm.systemPrompt,undefined);
  applyFrame(vm,{ type:'tool_execution_end',toolCallId:'tool',toolName:'bash',isError:true,result:{ content:[{ type:'text',text:'Tool "bash" requires approval but no interactive UI available.' }] },details:{ wallTimeMs:3 } });
  assert.equal(vm.tools[0].status,'실패'); assert.match(vm.tools[0].result,/no interactive UI available/);
  applyFrame(vm,{ type:'prompt_result',id:'req_prompt',agentInvoked:true,status:'completed',sessionSettled:true }); assert.equal(vm.promptStatus,'completed');
});
test('protocol v2 reassembles a large UTF-8 logical frame and rejects pre-negotiation or reordered chunks',() => {
  const data = Buffer.from(JSON.stringify({ type:'response',command:'get_messages',success:true,data:{ text:'한'.repeat(400000) } }));
  const chunks = [data.subarray(0,600000),data.subarray(600000)].map((bytes,index) => ({ type:'rpc_chunk',chunkId:'observed-wire-shape',index,count:2,byteLength:data.length,data:bytes.toString('base64') }));
  const decoder = new FrameDecoder(); assert.throws(() => decoder.push(chunks[0]),/협상 전에/); decoder.negotiated = true;
  assert.equal(decoder.push(chunks[0]),null); const frame = decoder.push(chunks[1]); assert.equal(frame.data.text,'한'.repeat(400000));
  assert.throws(() => decoder.push(chunks[1]),/index 0/);
  assert.equal(negotiationResult({ type:'response',id:'other',command:'negotiate_protocol',success:true,data:{ protocolVersion:2 } },'expected'),null);
});
test('rejected set_model after cloud-to-local switch fails closed and blocks sending until a switch is confirmed',() => {
  const vm = createViewModel();
  const cloud = { provider:'cloud',model:'frontier-1' }, local = { provider:'local',model:'student-7b' };
  setConsent(vm,true);
  const toCloud = beginModelSwitch(vm,'cloud',cloud);
  assert.equal(canSendPrompt(vm,cloud,{ ready:true }),false);
  applyFrame(vm,{ type:'response',id:'unrelated-id',command:'set_model',success:true,data:{ provider:'cloud',id:'frontier-1' } });
  assert.equal(canSendPrompt(vm,cloud,{ ready:true }),false);
  applyFrame(vm,{ type:'response',id:toCloud.id,command:'set_model',success:true,data:{ provider:'cloud',id:'frontier-1' } });
  assert.equal(canSendPrompt(vm,cloud,{ ready:true }),true);

  setConsent(vm,false);
  const toLocal = beginModelSwitch(vm,'local',local);
  assert.equal(canSendPrompt(vm,local,{ ready:true }),false);
  assert.equal(canSendPrompt(vm,cloud,{ ready:true }),false);
  applyFrame(vm,{ type:'response',id:toLocal.id,command:'set_model',success:false,error:'Local model unavailable' });
  assert.equal(canSendPrompt(vm,local,{ ready:true }),false);
  assert.equal(canSendPrompt(vm,cloud,{ ready:true }),false);
  assert.equal(vm.route.confirmed,null);
  assert.equal(vm.error?.code,'model_switch_failed');
  assert.equal(vm.error?.message,'Local model unavailable');
  assert.equal(vm.phase,'모델 전환 실패');

  const retryLocal = beginModelSwitch(vm,'local',local);
  applyFrame(vm,{ type:'response',id:retryLocal.id,command:'set_model',success:true,data:{ provider:'cloud',id:'frontier-1' } });
  assert.equal(canSendPrompt(vm,local,{ ready:true }),false);
  assert.equal(vm.error?.code,'model_switch_failed');

  const confirmedLocal = beginModelSwitch(vm,'local',local);
  applyFrame(vm,{ type:'response',id:confirmedLocal.id,command:'set_model',success:true,data:{ provider:'local',id:'student-7b' } });
  assert.equal(canSendPrompt(vm,local,{ ready:true }),true);
});
test('websocket overload close terminates in one call without recursion and counts header bytes in admission',() => {
  function mockSocket(writableLength) {
    const s = new EventEmitter();
    s.writableLength = writableLength;
    s.writes = 0; s.ended = 0; s.destroyed = 0;
    s.cork = () => {}; s.uncork = () => {};
    s.write = chunk => { s.writes++; s.writableLength += chunk.length; return true; };
    s.end = () => { s.ended++; };
    s.destroy = () => { s.destroyed++; };
    return s;
  }
  const overloadedSocket = mockSocket(400);
  const peer = new Peer(overloadedSocket,100);
  let closeCalls = 0;
  const originalClose = peer.close.bind(peer);
  peer.close = (...args) => { closeCalls++; return originalClose(...args); };
  assert.equal(peer.writeFrame(1,Buffer.alloc(1)),false);
  assert.equal(closeCalls,1);
  assert.equal(peer.closed,true);
  assert.equal(overloadedSocket.destroyed,1);
  assert.equal(overloadedSocket.writes,0);

  const headerBoundarySocket = mockSocket(399);
  const boundaryPeer = new Peer(headerBoundarySocket,100);
  let boundaryCloses = 0;
  const origBoundaryClose = boundaryPeer.close.bind(boundaryPeer);
  boundaryPeer.close = (...args) => { boundaryCloses++; return origBoundaryClose(...args); };
  assert.equal(boundaryPeer.writeFrame(1,Buffer.alloc(1)),false);
  assert.equal(boundaryCloses,1);
  assert.equal(boundaryPeer.closed,true);
  assert.equal(headerBoundarySocket.destroyed,1);
});

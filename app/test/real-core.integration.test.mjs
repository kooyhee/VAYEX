import test from 'node:test';
import assert from 'node:assert/strict';
import { startRealFixture,attach } from './real-fixture.mjs';
import { createViewModel,applyFrame,promptCommand,command,approvalCommand } from '../public/protocol.js';

/**
 * Run one bash tool call through the real bridge + real Bun/omp and return both
 * faces of the result: the `tool_execution_end` payload and the text the model
 * actually received in the next provider request. The directive text doubles as
 * the model stub's payload selector, so every number below comes from real bytes
 * rather than from a locally recomputed formula.
 */
async function runBashProbe(f,c,directive) {
  const mark = c.frames.length;
  const prompt = promptCommand('tool ' + directive);
  c.socket.send(JSON.stringify(prompt));
  const request = await c.until(x => x.type === 'extension_ui_request' && x.method === 'select' && c.frames.indexOf(x) >= mark);
  c.socket.send(JSON.stringify(approvalCommand(request,'Approve')));
  const end = await c.until(x => x.type === 'tool_execution_end' && c.frames.indexOf(x) >= mark);
  await c.until(x => x.type === 'prompt_result' && x.id === prompt.id);
  const text = end.result?.content?.find(b => b.type === 'text')?.text ?? JSON.stringify(end.result);
  const withTool = [...f.requests].reverse().find(r => r.body?.messages?.some(m => m.role === 'tool'));
  // The newest tool message: a later request still carries the earlier probes'
  // tool results as history, so the first match is always the oldest call.
  const toolMessage = [...(withTool?.body?.messages ?? [])].reverse().find(m => m.role === 'tool');
  const modelText = typeof toolMessage?.content === 'string'
    ? toolMessage.content
    : Array.isArray(toolMessage?.content) ? toolMessage.content.map(b => b.text ?? '').join('') : '';
  return { end,text,modelText,requestBytes:withTool?.rawBytes ?? null };
}

test('real Bun omp: negotiation, large get_state, recoverable parse/unknown errors, streaming and exact-label tool denial', { timeout:45000 },async t => {
  const f = await startRealFixture(); t.after(() => f.close());
  const c = attach(f.url); await c.until(x => x.type === 'bridge_ready' || x.type === 'bridge_error');
  assert.equal(c.frames.find(x => x.type === 'bridge_error'),undefined);
  c.socket.send(JSON.stringify(command('get_state')));
  const state = await c.until(x => x.type === 'response' && x.command === 'get_state');
  assert.equal(state.success,true); assert.equal(state.data.model.id,'auto'); assert.equal(typeof state.data.isStreaming,'boolean');
  await fetch(f.stubUrl + '/probe/errors',{ method:'POST' });
  const parse = await c.until(x => x.type === 'response' && x.command === 'parse'); assert.equal(parse.success,false); assert.equal(Object.hasOwn(parse,'id'),false);
  const unknown = await c.until(x => x.id === 'real-unknown'); assert.equal(unknown.success,false); assert.match(unknown.error,/Unknown command/);
  const prompt = promptCommand('hello local stub'); c.socket.send(JSON.stringify(prompt));
  const done = await c.until(x => x.type === 'prompt_result' && x.id === prompt.id); assert.equal(done.status,'completed');
  const toolPrompt = promptCommand('tool approval probe'); c.socket.send(JSON.stringify(toolPrompt));
  const request = await c.until(x => x.type === 'extension_ui_request' && x.method === 'select');
  assert.deepEqual(request.options,['Approve','Approve bash for this session','Deny']);
  c.socket.send(JSON.stringify(approvalCommand(request,'Deny')));
  const end = await c.until(x => x.type === 'tool_execution_end'); assert.equal(end.toolName,'bash'); assert.equal(end.isError,true);
  await c.until(x => x.type === 'prompt_result' && x.id === toolPrompt.id);
  const vm = createViewModel(); for (const frame of c.frames) applyFrame(vm,frame);
  assert.equal(vm.errors.length,2); assert.ok(vm.messages.some(x => x.text.includes('실제 omp와 연결되었습니다'))); assert.ok(vm.commands.length > 0);
  assert.ok(c.frames.some(x => x.type === 'extension_ui_request' && x.method === 'setWidget'));
  console.log('Real core frame types:',[...new Set(c.frames.map(x => x.type))].join(', '));
  console.log('Real get_state UTF-8 bytes:',Buffer.byteLength(JSON.stringify(state)));
});

test('a real launch with a missing required overlay refuses before spawning any core', { timeout:30000 },async t => {
  const f = await startRealFixture({ overlayFile:'C:\\nonexistent-harness\\omp-overlay.yml' }); t.after(() => f.close());
  const c = attach(f.url);
  const error = await c.until(x => x.type === 'bridge_error');
  assert.equal(error.code,'launch_failed');
  assert.match(error.message,/필수 하네스 설정을 읽을 수 없습니다/);
  assert.match(error.message,/ENOENT|no such file/i);
  assert.equal(c.frames.some(x => x.type === 'bridge_ready'),false);
  assert.equal([...f.bridge.sessions.values()].every(s => s.child === null),true);
});

test('a real launch without an app inference section refuses before spawning any core', { timeout:30000 },async t => {
  const f = await startRealFixture({ noModel:true }); t.after(() => f.close()); const c = attach(f.url);
  const error = await c.until(x => x.type === 'bridge_error');
  assert.equal(error.code,'launch_failed');
  assert.match(error.message,/inference 설정이 없어/);
  assert.equal(error.exitCode ?? null,null,'the core was never started, so there is no exit code to report');
  assert.equal(c.frames.some(x => x.type === 'bridge_ready'),false);
  assert.equal([...f.bridge.sessions.values()].every(s => s.child === null),true);
  assert.equal(f.requests.length,0,'no upstream was contacted for a refused launch');
});

test('real omp without interactive UI returns the fail-closed tool error', { timeout:45000 },async t => {
  const f = await startRealFixture({ headless:true }); t.after(() => f.close()); const c = attach(f.url); await c.until(x => x.type === 'bridge_ready' || x.type === 'bridge_error');
  assert.equal(c.frames.find(x => x.type === 'bridge_error'),undefined);
  const prompt = promptCommand('tool headless probe'); c.socket.send(JSON.stringify(prompt));
  const end = await c.until(x => x.type === 'tool_execution_end'); assert.equal(end.isError,true);
  assert.match(JSON.stringify(end.result),/requires approval but no interactive UI available/);
  const vm = applyFrame(createViewModel(),end); assert.match(vm.tools[0].result,/requires approval but no interactive UI available/);
});

test('real omp inference carries the conversation route; an unconsented cloud route falls back to local without a cloud process', { timeout:60000 },async t => {
  const f = await startRealFixture(); t.after(() => f.close());
  const inferenceRequests = () => f.requests.filter(x => x.method === 'POST' && x.path.endsWith('/chat/completions') && x.route);

  const local = attach(f.url); await local.until(x => x.type === 'bridge_ready' || x.type === 'bridge_error');
  assert.equal(local.frames.find(x => x.type === 'bridge_error'),undefined);
  const localPrompt = promptCommand('route header probe');
  local.socket.send(JSON.stringify(localPrompt));
  await local.until(x => x.type === 'prompt_result' && x.id === localPrompt.id);
  // The spawned omp reached the app's local compatible endpoint, which sent the
  // conversation's route header to the local fixture upstream.
  const appInferenceRequests = () => f.requests.filter(x => x.method === 'POST' && x.path.endsWith('/chat/completions') && x.route);
  assert.deepEqual([...new Set(appInferenceRequests().map(x => x.route))],['local_only']);

  // A cloud route the user consented to reaches the inference request as itself.
  const cloud = attach(f.url,'?route=zdr_cloud&consent=1');
  await cloud.until(x => x.type === 'bridge_ready' || x.type === 'bridge_error');
  assert.equal(cloud.frames.find(x => x.type === 'bridge_error'),undefined);
  const cloudPrompt = promptCommand('cloud route header probe');
  cloud.socket.send(JSON.stringify(cloudPrompt));
  await cloud.until(x => x.type === 'prompt_result' && x.id === cloudPrompt.id);
  cloud.socket.close();
  assert.equal(inferenceRequests().some(x => x.route === 'zdr_cloud'),true);

  // The same cloud route without consent never reaches the cloud plane. The
  // conversation falls back to local_only and says so; no any_cloud child is
  // spawned and no request carries an any_cloud route.
  const before = inferenceRequests().length;
  const fallback = attach(f.url,'?route=any_cloud');
  const ready = await fallback.until(x => x.type === 'bridge_ready' || x.type === 'bridge_error');
  assert.equal(ready.type,'bridge_ready');
  const connected = fallback.frames.find(x => x.type === 'bridge_connected');
  assert.equal(connected.route,'local_only');
  assert.equal(connected.requestedRoute,'any_cloud');
  assert.equal(connected.routeFallback,'consent_off');
  assert.equal(fallback.frames.some(x => x.type === 'bridge_error'),false);
  assert.equal(inferenceRequests().length,before);
  assert.equal(inferenceRequests().some(x => x.route === 'any_cloud'),false);
  assert.equal([...f.bridge.sessions.values()].filter(s => s.route === 'any_cloud').length,0);
  fallback.socket.close();
});

test('real omp: a models.yml route header that would leak a bare variable name is refused before launch', { timeout:45000 },async t => {
  // `OMP_MISSING_ROUTE` is deliberately not exported by the bridge, so real omp would
  // send the literal name as the header value. The bridge must stop the launch itself.
  const f = await startRealFixture({ routeHeader:'OMP_MISSING_ROUTE' }); t.after(() => f.close());
  const c = attach(f.url);
  const error = await c.until(x => x.type === 'bridge_error');
  assert.equal(error.code,'launch_failed');
  assert.match(error.message,/models\.yml의 x-route 헤더가 이 대화의 경로와 일치하지 않아/);
  assert.match(error.message,/sends "OMP_MISSING_ROUTE"/);
  assert.equal(c.frames.some(x => x.type === 'bridge_ready'),false);
  assert.equal(f.requests.filter(x => x.path.endsWith('/chat/completions')).length,0);
  assert.equal([...f.bridge.sessions.values()].every(s => s.child === null),true);
});

test('real omp stdin closes during approval: disconnected-client tool error is rendered', { timeout:30000 },async t => {
  const f = await startRealFixture(); t.after(() => f.close()); const c = attach(f.url); await c.until(x => x.type === 'bridge_ready');
  c.socket.send(JSON.stringify(promptCommand('tool disconnect probe')));
  await c.until(x => x.type === 'extension_ui_request' && x.method === 'select');
  await fetch(f.stubUrl + '/probe/disconnect',{ method:'POST' });
  const end = await c.until(x => x.type === 'tool_execution_end');
  assert.equal(end.isError,true); assert.match(JSON.stringify(end.result),/RPC client disconnected before extension UI response completed/);
  const vm = applyFrame(createViewModel(),end); assert.match(vm.tools[0].result,/RPC client disconnected before extension UI response completed/);
});

test('real omp recovers the single huge line through the read tool the notice names', { timeout:60000 }, async t => {
  // The recovery claim is only true if the tool the notice tells the model to use
  // actually returns the original. The stub feeds the notice's own selector back
  // through the core's `read` tool; the assertion is on the bytes the core returned.
  const f = await startRealFixture({ ephemeralSession:false,tools:'bash,read',followNoticeWithRead:true });
  t.after(() => f.close());
  const c = attach(f.url); await c.until(x => x.type === 'bridge_ready');

  const mark = c.frames.length;
  const prompt = promptCommand('tool single-line bytes 30000');
  c.socket.send(JSON.stringify(prompt));
  // Approve every approval the core asks for (bash, then the read and whatever path
  // approval it wants) until the read tool actually runs. Counting requests would be
  // brittle: the number depends on how the core groups its approval prompts.
  const deadline = Date.now() + 50000;
  let approved = 0;
  let readEnd = c.frames.find(x => x.type === 'tool_execution_end' && x.toolName === 'read' && c.frames.indexOf(x) >= mark);
  while (!readEnd && Date.now() < deadline) {
    const seenCount = c.frames.filter(x => x.type === 'extension_ui_request' && x.method === 'select').length;
    assert.equal(seenCount >= approved,true,'approval bookkeeping must not skip prompts');
    if (seenCount > approved) {
      const request = c.frames.filter(x => x.type === 'extension_ui_request' && x.method === 'select')[approved];
      approved += 1;
      c.socket.send(JSON.stringify(approvalCommand(request,request.options.find(o => /^Approve/.test(o)))));
      continue;
    }
    await new Promise(r => setTimeout(r,15));
    readEnd = c.frames.find(x => x.type === 'tool_execution_end' && x.toolName === 'read' && c.frames.indexOf(x) >= mark);
  }
  assert.ok(readEnd,'the read the notice instructs must run');
  const end = readEnd;
  await c.until(x => x.type === 'prompt_result' && x.id === prompt.id);

  const bash = c.frames.filter(x => x.type === 'tool_execution_end' && x.toolName === 'bash').at(-1);
  const bashText = bash?.result?.content?.find(b => b.type === 'text')?.text ?? '';
  assert.equal(bash.isError,false,'the bounded bash call itself must keep its real status');
  assert.ok(Buffer.byteLength(bashText,'utf8') <= 20480,`model-facing bash bytes ${Buffer.byteLength(bashText,'utf8')}`);
  const selector = bashText.match(/한 줄 원본 선택자: (\S+)/)?.[1];
  assert.ok(selector,'a column-capped line must name a raw selector the read tool accepts');

  assert.equal(end.toolName,'read');
  assert.equal(end.isError,false,'the read the notice instructs must succeed');
  const recovered = end.result?.content?.find(b => b.type === 'text')?.text ?? '';
  assert.equal(Buffer.byteLength(recovered,'utf8'),30000,`read returned ${Buffer.byteLength(recovered,'utf8')} bytes`);
  assert.equal(/^A+$/.test(recovered),true,'the read must return the original payload, not a capped page');
  console.log('recovery probe bytes:',JSON.stringify({ modelFacingBash:Buffer.byteLength(bashText,'utf8'), readReturned:Buffer.byteLength(recovered,'utf8'), selector }));
});

test('real omp bounds a huge single line and the notice names a readable artifact holding every original byte', { timeout:60000 }, async t => {
  const { readFile,stat } = await import('node:fs/promises');
  // A persistent session is what the app itself launches (config.json sets no
  // --no-session); it is also the only mode whose artifacts are real files.
  const f = await startRealFixture({ ephemeralSession:false }); t.after(() => f.close());
  const c = attach(f.url); await c.until(x => x.type === 'bridge_ready');

  const { text,modelText } = await runBashProbe(f,c,'single-line bytes 30000');

  // The single-line case is the one native truncation used to discard entirely.
  assert.ok(Buffer.byteLength(modelText,'utf8') <= 20480,`model-facing bytes ${Buffer.byteLength(modelText,'utf8')}`);
  assert.match(text,/Some lines truncated/,'native column-cap notice must survive');
  const path = text.match(/보존 위치: (.+?)\r?\n/)?.[1]?.trim();
  assert.ok(path,'the notice must name the artifact path, not merely claim completeness');
  // The column cap applies per line, so paging the path would loop on the same cap;
  // the notice must therefore also instruct the read tool with a raw selector.
  assert.match(text,/읽기: .*read 도구/,'the notice must carry a bounded retrieval instruction naming the read tool');
  assert.match(text,/한 줄 원본 선택자: artifact:\/\/\d+:raw:1-1/,'the selector must be the native raw-line form');

  const onDisk = await readFile(path,'utf8');
  assert.ok((await stat(path)).isFile());
  assert.equal(onDisk.length,30000,'the artifact must hold every original byte of the one line');
  assert.equal(onDisk.includes('…'),false,'the artifact must be the lossless original, not the truncated view');
  assert.equal(/^A+$/.test(onDisk),true,'artifact content must be the original payload verbatim');
  assert.match(text,new RegExp(`${onDisk.length}바이트`),'the notice byte count must equal the artifact size');
  assert.ok(Buffer.byteLength(modelText,'utf8') < Buffer.byteLength(onDisk,'utf8'),'the inline view must be smaller than the original');
  console.log('single-line probe bytes:',JSON.stringify({ modelFacing:Buffer.byteLength(modelText,'utf8'), artifactBytes:Buffer.byteLength(onDisk,'utf8'), artifactPath:path }));
});

test('real omp bounds multibyte Korean and emoji output on UTF-8 boundaries with a lossless artifact', { timeout:60000 }, async t => {
  const { readFile,stat } = await import('node:fs/promises');
  const f = await startRealFixture({ ephemeralSession:false }); t.after(() => f.close());
  const c = attach(f.url); await c.until(x => x.type === 'bridge_ready');

  const { text,modelText } = await runBashProbe(f,c,'multibyte lines 900');
  const modelBytes = Buffer.byteLength(modelText,'utf8');
  assert.ok(modelBytes <= 20480,`model-facing bytes ${modelBytes}`);
  // A split code point would show up as U+FFFD replacement characters.
  assert.equal(modelText.includes('\uFFFD'),false,'bounded text must not split a multibyte code point');

  const path = text.match(/보존 위치: (.+?)\r?\n/)?.[1]?.trim();
  assert.ok(path,'multibyte case must also name a real artifact path');
  const onDisk = await readFile(path);
  assert.ok((await stat(path)).isFile());
  const original = onDisk.toString('utf8');
  assert.equal(original.includes('\uFFFD'),false,'the artifact must preserve the original code points');
  assert.ok(original.includes('한글_🚀🔥_가'),'the artifact must retain Korean text and the emoji sequence');
  // Exact comparison against the payload the model asked bash to print — no formula.
  assert.equal(original,('한글_🚀🔥_가'.repeat(8)+'\n').repeat(900),'artifact must hold the complete original output byte for byte');
});

// Native bash.ts #buildCompletedResult appends a timing notice at >= 1s. It is
// part of the tool result (not stdout), so spill/recovery must preserve it too.
function expectedBashText(payload, end) {
  const details = end.result.details;
  assert.equal(typeof details.wallTimeMs,'number');
  assert.equal(details.wallTimeNoticeEmitted,details.wallTimeMs >= 1000);
  return payload + (details.wallTimeNoticeEmitted ? `\n\nWall time: ${(details.wallTimeMs / 1000).toFixed(2)} seconds` : '');
}

test('real omp inline ceiling boundary includes native timing text and counts its notice inside the budget', { timeout:90000 }, async t => {
  const f = await startRealFixture(); t.after(() => f.close());
  const c = attach(f.url); await c.until(x => x.type === 'bridge_ready');

  // Payload bytes alone are not tool-result bytes when bash reports wall time.
  const below = await runBashProbe(f,c,'ascii lines 500');
  const at = await runBashProbe(f,c,'ascii lines 512');
  const above = await runBashProbe(f,c,'ascii lines 513');

  assert.equal(below.modelText,expectedBashText(('L'.repeat(39) + '\n').repeat(500),below.end),'below-ceiling tool output, including timing, must pass through unchanged');
  assert.equal(below.modelText.includes('보존 위치'),false,'below-ceiling output gets no bounding notice');
  const atOriginal = expectedBashText(('L'.repeat(39) + '\n').repeat(512),at.end);
  if (Buffer.byteLength(atOriginal,'utf8') === 20480) {
    assert.equal(at.modelText,atOriginal,'an exactly-at-ceiling complete result passes through unchanged');
    assert.equal(at.modelText.includes('보존 위치'),false,'an exactly-at-ceiling result needs no notice');
  } else {
    assert.ok(Buffer.byteLength(at.modelText,'utf8') <= 20480,'timing that pushes the result over the ceiling must be bounded');
    assert.match(at.modelText,/보존 위치:/,'a result pushed over the ceiling by timing must be recoverable');
  }

  const aboveBytes = Buffer.byteLength(above.modelText,'utf8');
  assert.ok(aboveBytes <= 20480,`just-above-ceiling bytes ${aboveBytes} must be within the ceiling with its notice`);
  assert.ok(aboveBytes < 20520,'just-above-ceiling output must actually shrink');
  assert.match(above.modelText,/보존 위치:/,'just-above-ceiling output must carry the recovery notice');
  assert.ok(aboveBytes > 8000,'the bound must keep a usable head/tail, not collapse to the notice alone');
});

test('real omp: the spill notice handle is recovered by the tool_output_recover tool it names', { timeout:90000 }, async t => {
  // The spill path (output the extension itself holds complete, above its ceiling) is
  // the one whose notice prints a spill:// handle. A lowered ceiling puts ordinary
  // bash output on that path; the stub then calls only the handle, exactly as the
  // notice instructs, so the assertion is on the bytes the core's own tool returned.
  const f = await startRealFixture({
    ephemeralSession:false,
    tools:'bash',
    followNoticeWithRecover:true,
    coreEnvOverrides:{ OMP_TOOL_RESULT_CEILING:'1200' },
  });
  t.after(() => f.close());
  const c = attach(f.url); await c.until(x => x.type === 'bridge_ready');

  const mark = c.frames.length;
  const prompt = promptCommand('tool ascii lines 100');   // 4000 bytes of 'L' lines
  c.socket.send(JSON.stringify(prompt));
  const deadline = Date.now() + 60000;
  let approved = 0;
  let recovered = c.frames.find(x => x.type === 'tool_execution_end' && x.toolName === 'tool_output_recover' && c.frames.indexOf(x) >= mark);
  while (!recovered && Date.now() < deadline) {
    const selects = c.frames.filter(x => x.type === 'extension_ui_request' && x.method === 'select');
    if (selects.length > approved) {
      const request = selects[approved];
      approved += 1;
      c.socket.send(JSON.stringify(approvalCommand(request,request.options.find(o => /^Approve/.test(o)))));
      continue;
    }
    await new Promise(r => setTimeout(r,20));
    recovered = c.frames.find(x => x.type === 'tool_execution_end' && x.toolName === 'tool_output_recover' && c.frames.indexOf(x) >= mark);
  }
  assert.ok(recovered,'the recovery tool the notice names must exist and run');
  await c.until(x => x.type === 'prompt_result' && x.id === prompt.id);

  const boundedBash = c.frames.filter(x => x.type === 'tool_execution_end' && x.toolName === 'bash' && c.frames.indexOf(x) >= mark).at(-1);
  const notice = boundedBash?.result?.content?.find(b => b.type === 'text')?.text ?? '';
  assert.ok(Buffer.byteLength(notice,'utf8') <= 1200,`model-facing bytes ${Buffer.byteLength(notice,'utf8')} must stay inside the configured ceiling`);
  const handle = notice.match(/핸들: (\S+)/)?.[1];
  assert.ok(handle?.startsWith('spill://'),`the notice must print one spill:// handle, got ${handle}`);
  assert.equal(/artifact:\/\//.test(notice),false,'the spill notice must not advertise a second scheme');
  assert.match(notice,new RegExp(`핸들: ${handle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')} — tool_output_recover`),'the notice must name the registered tool next to the handle it printed');

  assert.equal(recovered.isError ?? false,false,'recovering a handle the notice printed must succeed');
  const text = recovered.result?.content?.find(b => b.type === 'text')?.text ?? '';
  assert.equal(text,expectedBashText(('L'.repeat(39) + '\n').repeat(100),boundedBash),'the recovery tool must return the complete tool result, including native timing, byte for byte');
  assert.equal(recovered.result?.details?.handle,handle,'the result must echo the handle it resolved');
});



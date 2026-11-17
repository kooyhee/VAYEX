// The default launch path, exercised end to end: register the memory extension in
// coreArgs, let the agent capture a memory, and read that same memory back through
// `/api/memory`. Two defects made this impossible before: the extension was absent
// from `app/config.json`, and the extension and the HTTP router opened different
// SQLite files (`app/memory/data` vs `<stateDir>/memory`), so neither face could see
// the other's rows. The same session also pins the two client-frame facts: assistant
// text arrives on message frames (no top-level `text_end` exists) and the selection
// decision is already delivered when `prompt_result` arrives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { startRealFixture, attach } from './real-fixture.mjs';
import { createViewModel, applyFrame } from '../public/protocol.js';

test('the bundled launch loads the memory extension, injects the block and shares one memory database with /api/memory', { timeout:120000 }, async t => {
  const f = await startRealFixture({
    ephemeralSession:false,
    extraCoreArgs:['--extension','app/memory/extension.mjs'],
    // The offline stand-in keeps this local: it never fetches model weights.
    coreEnvOverrides:{ OMP_MEMORY_EMBED_MODEL:'local-hash-3gram-v1' },
  });
  t.after(() => f.close());
  const client = attach(f.url);
  await client.until(x => x.type === 'bridge_ready' || x.type === 'bridge_error');
  const refusal = client.frames.find(x => x.type === 'bridge_error');
  assert.equal(refusal,undefined,`the shipped launch must reach ready: ${refusal?.message ?? ''}`);

  const prompt = { id:`prompt-${Date.now()}`, type:'prompt', message:'기억해줘: 이 프로젝트의 빌드/검증 명령은 항상 `node --test test/*.test.mjs` 이고 npm run build 는 쓰지 않는다.' };
  client.socket.send(JSON.stringify(prompt));
  const done = await client.until(x => x.type === 'prompt_result' && x.id === prompt.id);
  assert.equal(done.status,'completed');

  // 1. The extension injected its frozen block into the model-facing request.
  const request = [...f.requests].reverse().find(r => JSON.stringify(r.body ?? {}).includes('<!-- omp-memory:block'));
  assert.ok(request,'the upstream request must carry the memory block the extension prepends to the system prompt');

  // 2. The memory the agent captured through that request is readable over HTTP.
  const listed = await (await fetch(`${f.url}/api/memory/list?limit=20`)).json();
  const items = Array.isArray(listed.items) ? listed.items : [];
  const captured = items.find(item => JSON.stringify(item).includes('node --test test/*.test.mjs'));
  assert.ok(captured, `the memory captured through the agent is not readable over /api/memory: ${JSON.stringify(items).slice(0,400)}`);
  assert.equal(captured.project,basename(f.bridge.memory.root),'both faces must tag the same project scope');
  // The row was written by the core's own session (the extension records its id), so
  // the id present here is the upstream session the capture happened in, not a value
  // this test could have made up.
  assert.equal(typeof captured.sessionId,'string');
  assert.ok(captured.sessionId.length > 0,'the captured row names the session it came from');
  assert.ok(existsSync(join(f.bridge.memory.dataDir,'memory.db')),'the reported memory directory must be the one holding the database');

  // 3. Assistant text reached the client on the frame the core actually emits.
  const vm = createViewModel();
  for (const frame of client.frames) applyFrame(vm,frame);
  const assistant = vm.messages.filter(message => message.role === 'assistant');
  assert.ok(assistant.some(message => message.text.length > 0),'the assistant text must reach the client reducer');
  assert.equal(client.frames.some(x => x.type === 'text_end'),false,'the core emits no top-level text_end frame; the text rides on message_update.message.content');

  // 4. The selection decision is already held when the result frame arrives.
  const selection = client.frames.find(x => x.type === 'selection');
  assert.ok(selection,'a client that stops reading at prompt_result must already hold the selection');
  assert.ok(selection.selection?.model?.id,'the selection names the model the gateway chose');
  assert.ok(client.frames.indexOf(selection) < client.frames.indexOf(done),'the selection is delivered before the terminal result frame, not after it');
});

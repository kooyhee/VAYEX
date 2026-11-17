import test from 'node:test';
import assert from 'node:assert/strict';
import { compactToolOutput } from '../omp/bounded-tool-result.js';

test('compactToolOutput: strips ANSI escape sequences cleanly', () => {
  const colored = '\x1b[32mPASS\x1b[0m \x1b[1msrc/foo.test.ts\x1b[22m';
  assert.equal(compactToolOutput(colored), 'PASS src/foo.test.ts');
});

test('compactToolOutput: collapses repetitive consecutive identical lines', () => {
  const repeated = ['Building project...', ...Array(20).fill('info: downloading package chunk'), 'Build succeeded.'].join('\n');
  const compacted = compactToolOutput(repeated);
  assert.ok(compacted.includes('중복 반복 생략'));
  assert.ok(compacted.includes('Build succeeded.'));
});

test('compactToolOutput: preserves full error traces without truncating errors', () => {
  const failureOutput = [
    'Test suite failed with 1 error:',
    'FAIL src/app.test.ts',
    'Error: Expected 42 but received null',
    '    at Object.<anonymous> (src/app.test.ts:24:12)',
    '    at runTest (runner.js:100:5)',
    ...Array(60).fill('    at internalProcessTick (node:internal:50)'),
  ].join('\n');

  const result = compactToolOutput(failureOutput);
  // Errors must be completely preserved for accurate agent debugging
  assert.ok(result.includes('Error: Expected 42 but received null'));
  assert.ok(result.includes('FAIL src/app.test.ts'));
});

test('tool-result ceiling counts complete output including timing and recovers every byte', async () => {
  const { mkdtemp,rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(),'omp-result-boundary-'));
  const previous = process.env.AI_TOOL_SPILL_DIR;
  process.env.AI_TOOL_SPILL_DIR = root;
  try {
    const ext = await import(`../omp/bounded-tool-result.js?boundary=${process.pid}-${Date.now()}`);
    const handlers = new Map(),tools = new Map();
    ext.default({ on:(name,handler) => handlers.set(name,handler),registerTool:tool => tools.set(tool.name,tool) });
    const line = 'L'.repeat(39) + '\n';
    for (const [original,bounded] of [
      [line.repeat(500),false],
      [line.repeat(512),false],
      [line.repeat(513),true],
      [line.repeat(512) + '\n\nWall time: 1.25 seconds',true],
    ]) {
      const result = await handlers.get('tool_result')({ toolName:'bash',content:[{ type:'text',text:original }],details:null },{});
      if (!bounded) {
        assert.equal(result,undefined,'a complete result at or below the ceiling must pass through');
      } else {
        const text = result.content[0].text;
        assert.ok(Buffer.byteLength(text,'utf8') <= 20480,'the notice counts inside the total byte ceiling');
        assert.ok(Buffer.byteLength(text,'utf8') > 8000,'bounding must retain usable output');
        const handle = text.match(/핸들: (\S+)/)?.[1];
        assert.ok(handle,'bounded output must offer recovery');
        const recovered = await tools.get('tool_output_recover').execute('boundary',{ handle });
        assert.equal(recovered.content[0].text,original,'recovery preserves all text, including a legitimate Wall time suffix');
      }
    }
  } finally {
    if (previous === undefined) delete process.env.AI_TOOL_SPILL_DIR;
    else process.env.AI_TOOL_SPILL_DIR = previous;
    await rm(root,{ recursive:true,force:true });
  }
});

test('spillStore: spills output above 20KB and recovers lossless original', async () => {
  const { createSpillStore } = await import('../omp/tool-spill.mjs');
  const store = createSpillStore();
  const largeOutput = 'line ' + 'A'.repeat(500) + '\n'.repeat(50);
  const spilled = store.spill({ text: largeOutput, tool: 'bash' });
  assert.ok(spilled.handle.startsWith('spill://'));
  assert.ok(spilled.bytes > 0);

  const recovered = store.recover(spilled.handle);
  assert.equal(recovered.text, largeOutput);
});

test('tool_output_recover: the handle printed in the notice resolves through the registered tool', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const spillRoot = await mkdtemp(path.join(os.tmpdir(), 'omp-spill-recover-'));
  const previous = process.env.AI_TOOL_SPILL_DIR;
  process.env.AI_TOOL_SPILL_DIR = spillRoot;
  try {
    // A fresh module instance so the extension builds its store under this root.
    const ext = await import(`../omp/bounded-tool-result.js?recover=${process.pid}-${Date.now()}`);
    const registered = new Map();
    const handlers = new Map();
    const pi = {
      on: (event, handler) => handlers.set(event, handler),
      registerTool: (tool) => registered.set(tool.name, tool),
    };
    ext.default(pi);

    const tool = registered.get('tool_output_recover');
    assert.ok(tool, 'the extension must register the tool its notice names');

    // Not a test/build log, so compaction leaves the bytes alone apart from newlines.
    const original = Array.from({ length: 400 }, (_, i) => `payload ${i} ${'A'.repeat(60)}`).join('\n');
    assert.ok(Buffer.byteLength(original, 'utf8') > 20 * 1024, 'the payload must exceed the spill ceiling');

    const bounded = await handlers.get('tool_result')(
      { toolName: 'bash', content: [{ type: 'text', text: original }], details: null },
      {},
    );
    const noticeText = bounded.content.find((b) => b.type === 'text').text;
    assert.ok(Buffer.byteLength(noticeText, 'utf8') <= 20 * 1024, 'the notice stays inside the ceiling');

    const handle = noticeText.match(/핸들: (\S+)/)?.[1];
    assert.ok(handle?.startsWith('spill://'), `the notice must print one spill:// handle, got ${handle}`);
    assert.equal(/artifact:\/\//.test(noticeText), false, 'the spill notice must not advertise a second scheme');
    assert.match(noticeText, /tool_output_recover/, 'the notice must name the registered tool');

    const recovered = await tool.execute('call-1', { handle }, undefined, undefined, {});
    assert.equal(recovered.isError ?? false, false, 'recovering a fresh handle is not an error');
    assert.equal(recovered.content[0].text, original, 'the tool returns the complete original, byte for byte');
    assert.equal(recovered.details.handle, handle);

    const windowed = await tool.execute('call-2', { handle, offset: 2, limit: 3 }, undefined, undefined, {});
    assert.equal(windowed.content[0].text, original.split('\n').slice(1, 4).join('\n'));

    const foreign = await tool.execute('call-3', { handle: 'artifact://12' }, undefined, undefined, {});
    assert.equal(foreign.isError, true, 'a foreign handle scheme is refused, not looked up in the spill store');
    assert.match(foreign.content[0].text, /spill:\/\//);

    // The recovery result is never re-bounded, or the model could never see the original.
    assert.equal(
      await handlers.get('tool_result')({ toolName: 'tool_output_recover', content: [{ type: 'text', text: original }], details: null }, {}),
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.AI_TOOL_SPILL_DIR;
    else process.env.AI_TOOL_SPILL_DIR = previous;
    await rm(spillRoot, { recursive: true, force: true });
  }
});

test('tool_output_recover: without a runtime registration API the notice names only the file read path', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const spillRoot = await mkdtemp(path.join(os.tmpdir(), 'omp-spill-norecover-'));
  const previous = process.env.AI_TOOL_SPILL_DIR;
  process.env.AI_TOOL_SPILL_DIR = spillRoot;
  try {
    const ext = await import(`../omp/bounded-tool-result.js?norecover=${process.pid}-${Date.now()}`);
    const handlers = new Map();
    // A runtime whose ExtensionAPI has no tool-registration surface at all.
    ext.default({ on: (event, handler) => handlers.set(event, handler) });

    const original = Array.from({ length: 400 }, (_, i) => `payload ${i} ${'A'.repeat(60)}`).join('\n');
    const bounded = await handlers.get('tool_result')(
      { toolName: 'bash', content: [{ type: 'text', text: original }], details: null },
      {},
    );
    const noticeText = bounded.content.find((b) => b.type === 'text').text;
    assert.equal(/tool_output_recover/.test(noticeText), false, 'an unregistered tool must never be advertised');
    assert.match(noticeText, /보존 위치: /, 'the notice still names the file the read tool opens');
    assert.match(noticeText, /read 도구/);
  } finally {
    if (previous === undefined) delete process.env.AI_TOOL_SPILL_DIR;
    else process.env.AI_TOOL_SPILL_DIR = previous;
    await rm(spillRoot, { recursive: true, force: true });
  }
});

test('transcriptSegments: merges alternating tool -> privacy -> tool -> privacy into one tool group and one privacy group', async () => {
  const { createViewModel, applyFrame, transcriptEntries, transcriptSegments, privacyLine } = await import('../public/protocol.js');
  const vm = createViewModel();
  applyFrame(vm, { type: 'message_start', message: { role: 'user', content: '확인해 주세요' } });
  applyFrame(vm, { type: 'message_end', message: { role: 'user', content: '확인해 주세요' } });

  for (const [id, name] of [['t1', 'todo'], ['t2', 'read'], ['t3', 'read'], ['t4', 'read']]) {
    applyFrame(vm, { type: 'tool_execution_start', toolCallId: id, toolName: name, args: {} });
    applyFrame(vm, { type: 'tool_execution_end', toolCallId: id, toolName: name, result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
  }
  applyFrame(vm, { type: 'privacy.masked', data: { rules: ['korean_name'], counts: { korean_name: 1 }, fields: ['messages[0].content'] } });

  for (const [id, name] of [['t5', 'read'], ['t6', 'read']]) {
    applyFrame(vm, { type: 'tool_execution_start', toolCallId: id, toolName: name, args: {} });
    applyFrame(vm, { type: 'tool_execution_end', toolCallId: id, toolName: name, result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
  }
  applyFrame(vm, { type: 'privacy.masked', data: { rules: ['korean_name'], counts: { korean_name: 1 }, fields: ['messages[2].content'] } });

  applyFrame(vm, { type: 'message_start', message: { role: 'assistant', content: '완료했습니다.' } });
  applyFrame(vm, { type: 'message_end', message: { role: 'assistant', content: '완료했습니다.' } });

  const segments = transcriptSegments(transcriptEntries(vm));
  assert.equal(segments.length, 4, 'user + 1 merged tool batch + 1 merged privacy line + assistant');
  assert.equal(segments[0].entry.message.role, 'user');
  assert.equal(segments[1].foldable, true);
  assert.equal(segments[1].entries.filter((e) => e.tool).length, 6);
  assert.equal(segments[2].foldable, false);
  assert.equal(privacyLine(segments[2].entry.privacy).text, '개인정보 보호 · 이름 2건 · 가명화 · 요청 전송됨');
  assert.equal(segments[3].entry.message.role, 'assistant');
});

test('transcriptSegments: does not merge tool or privacy groups across separate turns', async () => {
  const { createViewModel, applyFrame, transcriptEntries, transcriptSegments } = await import('../public/protocol.js');
  const vm = createViewModel();
  applyFrame(vm, { type: 'message_start', message: { role: 'user', content: '첫 번째' } });
  applyFrame(vm, { type: 'message_end', message: { role: 'user', content: '첫 번째' } });
  applyFrame(vm, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: {} });
  applyFrame(vm, { type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
  applyFrame(vm, { type: 'privacy.masked', data: { rules: ['korean_name'], counts: { korean_name: 1 }, fields: ['messages[0].content'] } });
  applyFrame(vm, { type: 'message_start', message: { role: 'assistant', content: '첫 번째 응답' } });
  applyFrame(vm, { type: 'message_end', message: { role: 'assistant', content: '첫 번째 응답' } });

  applyFrame(vm, { type: 'message_start', message: { role: 'user', content: '두 번째' } });
  applyFrame(vm, { type: 'message_end', message: { role: 'user', content: '두 번째' } });
  applyFrame(vm, { type: 'tool_execution_start', toolCallId: 't2', toolName: 'read', args: {} });
  applyFrame(vm, { type: 'tool_execution_end', toolCallId: 't2', toolName: 'read', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
  applyFrame(vm, { type: 'privacy.masked', data: { rules: ['phone_number'], counts: { phone_number: 1 }, fields: ['messages[0].content'] } });

  const segments = transcriptSegments(transcriptEntries(vm));
  const toolBatches = segments.filter((s) => s.foldable);
  const privacySegments = segments.filter((s) => !s.foldable && s.entry.privacy);
  assert.equal(toolBatches.length, 2);
  assert.equal(privacySegments.length, 2);
});

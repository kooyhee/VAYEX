import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundExternalAllowed, localDigest, localProgressSummary, localTitle, skippedExternal } from '../lib/local-background.mjs';
import { events, resetEvents } from '../lib/events.mjs';

test('local-background: a title is the first meaningful line, not a model call', () => {
  assert.equal(localTitle({ prompt: '  \n# Fix the parser bug\nmore text' }), 'Fix the parser bug');
  assert.equal(localTitle({ prompt: 'A very long first line that keeps going and going beyond the limit of the title field', maxChars: 20 }), 'A very long first l…');
  assert.equal(localTitle({ prompt: '', files: ['src/a.mjs', 'src/b.mjs'] }), '작업: src/a.mjs, src/b.mjs');
  assert.equal(localTitle({}), '새 세션');
});

test('local-background: the digest is extractive', () => {
  const text = [
    'random chatter',
    '결정: 세션 핀을 TTL로 제한한다',
    '수정 src/gateway/lib/session-pin.mjs',
    '남은 작업: 벤치 하네스',
  ].join('\n');
  const digest = localDigest({ text });
  assert.equal(digest.includes('세션 핀'), true);
  assert.equal(digest.includes('session-pin.mjs'), true);
  assert.equal(digest.includes('random chatter'), false);
  assert.equal(localDigest({ text: 'only one line' }), 'only one line');
});

test('local-background: progress is counted from events, and failures are counted once', () => {
  const stream = [
    { type: 'task.start', run: 'r1' },
    { type: 'task.delegate', run: 'r1' },
    { type: 'task.done', run: 'r1', data: { ok: true } },
    { type: 'task.start', run: 'r2' },
    { type: 'task.done', run: 'r2', data: { ok: false } },
    { type: 'task.retry', run: 'r2' },
    { type: 'task.file_change', run: 'r1', data: { path: 'a.mjs' } },
    { type: 'task.file_change', run: 'r1', data: { path: 'b.mjs' } },
  ];
  const summary = localProgressSummary({ events: stream, run: 'r1' });
  assert.equal(summary.includes('시작 1'), true);
  assert.equal(summary.includes('완료 1'), true);
  assert.equal(summary.includes('변경 파일: a.mjs, b.mjs'), true);
});

test('local-background: a replaced background job is recorded, with no external call', () => {
  resetEvents();
  const result = skippedExternal({ kind: 'title', session: 's-1', replacedBy: 'localTitle' });
  assert.equal(result.external, false);
  const [record] = events({ type: 'background.skipped' });
  assert.equal(record.data.kind, 'title');
  assert.equal(record.data.replaced_by, 'localTitle');
  assert.equal(record.data.external, false);
  assert.equal(backgroundExternalAllowed(), false);
  assert.throws(() => skippedExternal({ kind: 'summary', replacedBy: 'x' }), /unknown background kind/);
});

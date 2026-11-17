import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { summarizeEvents, subjectFor, josa, classifyChange, changesOf, countToolCalls, isEmptySessionEvents } from '../summarize.mjs';

const change = (task, path, value, ts = '2026-11-08T07:00:00.000Z') => ({
  type: 'task.file_change', session: 's-1', task, ts, data: { path, change: value },
});

const emptyRoot = mkdtempSync(join(tmpdir(), 'summarize-empty-'));
test.after(() => rmSync(emptyRoot, { recursive: true, force: true }));
const summarizeRules = (opts) => summarizeEvents({ modelRoot: emptyRoot, env: {}, ...opts });

test('summarizer: Korean sentences end in a polite ending and carry no raw extension', async () => {
  const result = await summarizeRules({ events: [change('t-1', 'app/insight/metrics.mjs', 'created')] });
  assert.equal(result.tasks.length, 1);
  const line = result.tasks[0].added[0];
  assert.match(line, /습니다\.$/);
  assert.ok(!line.includes('.mjs'), line);
  assert.ok(line.includes('지표'), line);
  assert.equal(result.tasks[0].modified.length, 0);
  assert.equal(result.tasks[0].deleted.length, 0);
  // Purpose-oriented journal entries: what purpose the target served, not a bare path.
  assert.ok(result.journal.entries.length > 0);
  assert.match(result.journal.entries[0].lines[0], /세션 토큰과 캐시 사용량을 집계하는 지표.*모듈/);
  assert.equal(result.journal.entries[0].category, '추가');
});

test('summarizer: add/modify/delete classification from explicit evidence', async () => {
  const events = [
    change('t-1', 'app/insight/summarize.mjs', 'created'),
    change('t-1', 'app/insight/routes.mjs', 'modified'),
    change('t-1', 'app/insight/legacy.mjs', 'deleted'),
  ];
  const [task] = (await summarizeRules({ events })).tasks;
  assert.match(task.added[0], /새로 만들었습니다/);
  assert.match(task.modified[0], /수정했습니다/);
  assert.match(task.deleted[0], /삭제했습니다/);
  assert.equal(task.added.length, 1);
  assert.equal(task.modified.length, 1);
  assert.equal(task.deleted.length, 1);

  assert.equal(classifyChange({ created: true }), 'added');
  assert.equal(classifyChange({ existedBefore: false }), 'added');
  assert.equal(classifyChange({ deleted: true }), 'deleted');
  assert.equal(classifyChange({ op: 'rename' }), 'modified');
});

test('summarizer: three edits to one target collapse into one line with a count', async () => {
  const events = [
    change('t-1', 'app/insight/metrics.mjs', 'modified', '2026-11-08T07:00:00.000Z'),
    change('t-1', 'app/insight/metrics.mjs', 'modified', '2026-11-08T07:01:00.000Z'),
    change('t-1', 'app/insight/metrics.mjs', 'modified', '2026-11-08T07:02:00.000Z'),
  ];
  const [task] = (await summarizeRules({ events })).tasks;
  assert.equal(task.modified.length, 1);
  assert.match(task.modified[0], /3회 수정했습니다/);
  assert.equal(task.details.modified[0].path, 'app/insight/metrics.mjs');
  assert.equal(task.details.modified[0].count, 3);
});

test('summarizer: a rename is one 수정 line, never 삭제+추가', async () => {
  const events = [
    change('t-1', 'app/insight/token-count.mjs', 'deleted'),
    change('t-1', 'app/insight/token-meter.mjs', 'created'),
  ];
  const [task] = (await summarizeRules({ events })).tasks;
  assert.equal(task.deleted.length, 0);
  assert.equal(task.added.length, 0);
  assert.equal(task.modified.length, 1);
  assert.match(task.modified[0], /이름만 바꿔 수정했습니다/);
  assert.equal(task.details.modified[0].renamedFrom, 'app/insight/token-count.mjs');
  assert.equal(task.details.modified[0].path, 'app/insight/token-meter.mjs');
});

test('summarizer: an explicit rename field is a modification of the new path', async () => {
  const events = [{
    type: 'task.file_change', task: 't-1', data: { path: 'app/insight/new-name.mjs', op: 'rename', renamed_from: 'app/insight/old-name.mjs' },
  }];
  const [task] = (await summarizeRules({ events })).tasks;
  assert.equal(task.modified.length, 1);
  assert.equal(task.added.length + task.deleted.length, 0);
});

test('summarizer: repeated files in one directory become one grouped line', async () => {
  const events = [
    change('t-1', 'app/insight/metrics.mjs', 'created'),
    change('t-1', 'app/insight/event-source.mjs', 'created'),
    change('t-1', 'app/insight/local-model.mjs', 'created'),
  ];
  const [task] = (await summarizeRules({ events })).tasks;
  assert.equal(task.added.length, 1);
  assert.match(task.added[0], /app\/insight 디렉터리에 파일 3개를 새로 만들었습니다/);
});

test('summarizer: tool_execution_end per-file results are read, not inferred', async () => {
  const frame = {
    type: 'tool_execution_end',
    session: 's-1',
    task: 't-2',
    args: { file_path: 'app/insight/routes.mjs' },
    result: {
      details: {
        perFileResults: [
          { path: 'app/insight/routes.mjs', created: true },
          { path: 'app/insight/metrics.mjs', deleted: true },
        ],
      },
    },
  };
  const changes = changesOf(frame);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].category, 'added');
  assert.equal(changes[1].category, 'deleted');
  const [task] = (await summarizeRules({ events: [frame] })).tasks;
  assert.equal(task.added.length, 1);
  assert.equal(task.deleted.length, 1);
});

test('summarizer: empty categories are omitted and the session roll-up is compact', async () => {
  const events = [
    change('t-1', 'app/insight/metrics.mjs', 'created'),
    change('t-2', 'app/insight/routes.mjs', 'modified'),
  ];
  const result = await summarizeRules({ events });
  assert.equal(result.tasks.length, 2);
  for (const task of result.tasks) {
    assert.ok(Array.isArray(task.added) && Array.isArray(task.modified) && Array.isArray(task.deleted));
    for (const category of ['added', 'modified', 'deleted']) {
      if (task[category].length === 0) assert.ok(true);
    }
  }
  assert.match(result.session.line, /^이번 세션에서는 /);
  assert.match(result.session.line, /습니다\.$/);
  assert.equal(result.session.counts.added, 1);
  assert.equal(result.session.counts.modified, 1);
  assert.equal(result.session.counts.deleted, 0);
  const emptyRoot = mkdtempSync(join(tmpdir(), 'summarize-rules-'));
  try {
    const rulesOnly = await summarizeEvents({ events, modelRoot: emptyRoot, env: {} });
    assert.equal(rulesOnly.tier, 'rules');
    assert.equal(rulesOnly.tasks[0].tier, 'rules');
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test('summarizer: session and task filters', async () => {
  const events = [
    { ...change('t-1', 'a.mjs', 'created'), session: 's-1' },
    { ...change('t-2', 'b.mjs', 'created'), session: 's-2' },
  ];
  const filtered = await summarizeRules({ events, session: 's-1' });
  assert.equal(filtered.tasks.length, 1);
  assert.equal(filtered.tasks[0].taskId, 't-1');
});

test('summarizer: Korean particles and subjects', () => {
  assert.equal(josa('모듈', ['을', '를']), '을');
  assert.equal(josa('요약기', ['을', '를']), '를');
  assert.equal(josa('테스트', ['은', '는']), '는');
  assert.equal(subjectFor('app/insight/routes.mjs'), '라우터');
  assert.equal(subjectFor('README.md'), 'README 문서');
  assert.equal(subjectFor('app/insight/test/summarize.test.mjs'), '요약기 테스트');
});

test('summarizer: no network module is imported anywhere in app/insight', () => {
  const root = join(import.meta.dirname, '..');
  const offenders = [];
  for (const file of readdirSync(root).filter((name) => name.endsWith('.mjs'))) {
    const source = readFileSync(join(root, file), 'utf8');
    if (/from ['"]node:(http|https|net|dgram)/.test(source) || /globalThis\.fetch|fetch\(/.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

test('summarizer: detects empty sessions (0 file changes and 0 tool calls) and summarizes gateway/app modules', async () => {
  assert.equal(isEmptySessionEvents([]), true);
  assert.equal(isEmptySessionEvents([{ type: 'prompt', message: 'hello' }]), true);
  assert.equal(isEmptySessionEvents([change('t-1', 'gateway/lib/decision-planner.mjs', 'modified')]), false);
  assert.equal(countToolCalls([{ type: 'tool_execution_end', toolName: 'bash', command: 'node --test' }]), 1);

  const emptySummary = await summarizeRules({ events: [{ type: 'prompt', session: 's-0', message: '질문만 있음' }], session: 's-0' });
  assert.equal(emptySummary.empty, true);
  assert.equal(emptySummary.session.empty, true);
  assert.equal(emptySummary.session.toolCalls, 0);

  const nonEmpty = await summarizeRules({
    events: [
      change('t-1', 'gateway/lib/decision-planner.mjs', 'modified'),
      change('t-1', 'app/lib/inference.mjs', 'modified'),
    ],
  });
  assert.equal(nonEmpty.empty, false);
  assert.equal(nonEmpty.journal.entries.length, 2);
  const lines = nonEmpty.journal.entries.map((entry) => entry.lines[0]);
  assert.ok(lines.some((line) => line.includes('6역할 분류와 실행 계획을 세우는 역할·실행 계획기를 수정했습니다')), lines.join(' / '));
  assert.ok(lines.some((line) => line.includes('로컬 하네스 추론 경로를 연결하는 추론 어댑터를 수정했습니다')), lines.join(' / '));
});

test('summarizer: applies polished tasks and session line when local-model succeeds', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'summarize-local-model-'));
  try {
    const runtime = join(scratch, 'node_modules', '@huggingface', 'transformers');
    const modelDir = join(scratch, 'models', 'Qwen2.5-0.5B-Instruct');
    mkdirSync(runtime, { recursive: true });
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'config.json'), '{}');
    writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }));
    writeFileSync(join(runtime, 'index.cjs'), 'exports.env = {}; exports.pipeline = async () => async () => [];');

    const result = await summarizeEvents({
      events: [
        change('t-1', 'app/insight/metrics.mjs', 'created'),
        change('t-1', 'app/insight/routes.mjs', 'modified'),
      ],
      modelRoot: scratch,
      env: {},
      generator: async () => ({
        tasks: [{
          taskId: 't-1',
          added: ['지표 집계 모듈을 새로 구성했습니다.'],
          modified: ['인사이트 라우터 응답 처리를 개선했습니다.'],
          deleted: [],
        }],
        session: { line: '지표 집계 추가와 라우터 개선을 마쳤습니다.' },
      }),
    });

    assert.equal(result.tier, 'local-model');
    assert.equal(result.modelStatus, 'local-model');
    assert.equal(result.tasks[0].tier, 'local-model');
    assert.deepEqual(result.tasks[0].added, ['지표 집계 모듈을 새로 구성했습니다.']);
    assert.deepEqual(result.tasks[0].modified, ['인사이트 라우터 응답 처리를 개선했습니다.']);
    assert.equal(result.session.line, '지표 집계 추가와 라우터 개선을 마쳤습니다.');
    assert.equal(result.session.tier, 'local-model');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

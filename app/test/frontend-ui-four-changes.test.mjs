import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

test('CHANGE 1: every surface the product still has is reachable from the shell', async () => {
  const html = await readFile(resolve(root, '../public/index.html'), 'utf8');
  // Rail entries: new task, task list, results, safety, settings.
  for (const id of ['rail-new', 'rail-tasks', 'rail-results', 'rail-safety', 'rail-settings']) assert(html.includes(`id="${id}"`), `${id} missing from the rail`);
  // Everything that used to be a tab or a quick-action is a sheet now, opened from the rail.
  for (const id of ['sheet-preview', 'sheet-docs', 'sheet-stats', 'sheet-settings', 'sheet-safety']) assert(html.includes(`id="${id}"`), `${id} sheet missing`);
  for (const id of ['preview-frame', 'pane-preview', 'pane-visualize', 'pane-stats']) assert(html.includes(`id="${id}"`), `${id} missing`);
  assert(html.includes('id="dock"') && html.includes('id="diff-rollback"'), 'the result dock is the change-review surface now');
  assert(html.includes('id="transcript"') && html.includes('role="log"'), 'the conversation is the only log surface');
  // Deleted surfaces stay deleted.
  for (const gone of ['card-quick', 'timeline', 'insp-tabs', 'theme-toggle']) assert(!html.includes(`id="${gone}"`), `${gone} came back`);
});

test('CHANGE 2: Insight summarizer module and Korean rule fallback', async () => {
  const { ruleSummary, subjectOf, insightPayload, INSIGHT_ENDPOINT } = await import('../public/insight.js');
  assert.equal(INSIGHT_ENDPOINT, '/api/insight/summarize');
  assert.equal(subjectOf('src/auth/login.ts'), '로그인');
  assert.equal(subjectOf('app/public/styles.css'), '스타일');
  assert.ok(subjectOf('tests/api.test.mjs').includes('테스트'));

  const activity = {
    events: [
      { id:'1', kind:'write', taskId:'main', facts:{ path:'src/auth/login.ts', op:'추가' } },
      { id:'2', kind:'write', taskId:'main', facts:{ path:'src/auth/login.ts', op:'수정' } },
      { id:'3', kind:'write', taskId:'main', facts:{ path:'src/unused.ts', op:'삭제' } }
    ],
    main: { id:'main', name:'메인 작업', status:'done' },
    tasks: []
  };

  const summary = ruleSummary(activity);
  assert.equal(summary.tasks.length, 1);
  const rows = summary.tasks[0].rows;
  assert.equal(rows.length, 3); // 추가, 수정, 삭제
  const addRow = rows.find(r => r.category === '추가');
  const modRow = rows.find(r => r.category === '수정');
  const delRow = rows.find(r => r.category === '삭제');
  assert.equal(addRow.text, '로그인을 새로 만들었습니다');
  assert.equal(modRow.text, '로그인을 바꿨습니다');
  assert.ok(delRow.text.includes('지웠습니다'));

  const payload = insightPayload(activity);
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].changes.length, 3);
});

test('CHANGE 3: Visualize module renders inline SVG without external libraries', async () => {
  const { renderTaskGraph, renderCostChart, renderMemoryChart } = await import('../public/visualize.js');
  assert.equal(typeof renderTaskGraph, 'function');
  assert.equal(typeof renderCostChart, 'function');
  assert.equal(typeof renderMemoryChart, 'function');
});

test('CHANGE 4: route and model are disclosed once, in the status strip; consent lives in the safety sheet', async () => {
  const html = await readFile(resolve(root, '../public/index.html'), 'utf8');
  // The strip states the route as a sentence, the model in one chip, the cost once.
  assert(html.includes('id="strip-path"'), 'the strip must state the route');
  assert(html.includes('id="model-chip"') && html.includes('id="model-chip-label"'), 'the strip must carry the one model chip');
  assert(html.includes('id="strip-cost"'), 'the strip must state the cost');
  assert(html.includes('id="status-bar"'), 'the status strip is missing');
  // The four duplicates are gone: composer chip, footer model, inspector model row, header meta.
  for (const gone of ['composer-auto', 'foot-model', 'foot-speed', 'foot-cache', 'foot-tokens', 'foot-mode', 'head-meta', 'head-stage', 'head-run', 'head-plan', 'consent-toggle']) {
    assert(!html.includes(`id="${gone}"`), `${gone} still renders a second copy of a fact`);
  }
  assert(html.includes('id="sheet-safety"') && html.includes('id="safety-body"'), 'the cloud consent control belongs to the safety sheet');
  assert(html.includes('id="card-viz-doc"'), 'the document generator must survive');

  const appJs = await readFile(resolve(root, '../public/app.js'), 'utf8');
  assert(appJs.includes('renderStrip'), 'the strip is built by renderStrip');
  assert(appJs.includes('renderSafety'), 'the safety sheet is built by renderSafety');
  assert(!appJs.includes('renderFooterMetrics'), 'the removed footer metrics must not be re-rendered');
  assert(appJs.includes('refreshVizDoc'), 'the document generator still runs');
  assert(appJs.includes('reportFileName'), 'the HTML/PDF export still names its artifact');
});

test('CHANGE 5: Standalone HTML session report generator and server route', async () => {
  const { buildSessionReport, reportFileName } = await import('../public/session-report.js');
  assert.equal(typeof buildSessionReport, 'function');
  const html = buildSessionReport({
    title: '테스트 세션',
    sessionId: 'test-123',
    model: 'combo/main',
    mode: '오케스트레이터',
    tokens: 269500000,
    speed: 43.2,
    cacheRate: 90.1,
    cost: 1.234,
    changes: [
      { category:'추가', path:'src/index.ts', text:'새 진입점을 만들었습니다', at:Date.now() },
      { category:'수정', path:'src/config.ts', text:'설정을 바꿨습니다', at:Date.now() }
    ],
    agents: [
      { name:'조사 에이전트', state:'completed', model:'qwen/3b', tokens:1200, cost:0.001, duration:'1.2s', lane:0 }
    ]
  });
  assert(html.includes('<!doctype html>'), 'Generated report must be standalone HTML');
  assert(html.includes('테스트 세션'), 'Report missing title');
  assert(html.includes('269.5M'), 'Report missing formatted tokens');
  assert(html.includes('43.2 tok/s'), 'Report missing speed');
  assert(html.includes('90.1%'), 'Report missing cache rate');
  assert(html.includes('src/index.ts'), 'Report missing changed path');
  assert(html.includes('조사 에이전트'), 'Report missing subagent');

  const fileName = reportFileName({ title:'My Task' });
  assert(fileName.startsWith('My-Task-') && fileName.endsWith('.html'));
});

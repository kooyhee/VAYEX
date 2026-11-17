import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

test('CHANGE 1: every surface the product still has is reachable from the shell', async () => {
  const html = await readFile(resolve(root, '../public/index.html'), 'utf8');
  // The restored three-pane shell: one sidebar, one conversation column, one inspector column,
  // each side pane reachable from its header toggle.
  for (const id of ['sidebar', 'center', 'inspector']) assert(html.includes(`id="${id}"`), `${id} pane missing from the shell`);
  for (const id of ['toggle-sidebar', 'toggle-inspector']) assert(html.includes(`id="${id}"`), `${id} missing from the header`);
  // Sidebar entries open the product's surfaces: a new task, search, agents, memory, more.
  for (const id of ['new-session', 'menu-search', 'menu-agents', 'menu-memory', 'menu-more', 'recent-list']) assert(html.includes(`id="${id}"`), `${id} missing from the sidebar`);
  // Every inspector tab has its own pane behind it.
  for (const [tab, pane] of [['tab-overview', 'pane-overview'], ['tab-agents', 'pane-agents'], ['tab-visualize', 'pane-visualize'], ['tab-stats', 'pane-stats'], ['tab-preview', 'pane-preview'], ['tab-diff', 'pane-diff'], ['tab-memory', 'pane-memory']]) {
    assert(html.includes(`id="${tab}"`) && html.includes(`id="${pane}"`), `${tab}/${pane} missing from the inspector`);
  }
  assert(html.includes('id="transcript"') && html.includes('role="log"'), 'the conversation is the only log surface');
  assert(html.includes('id="theme-studio"') && html.includes('<dialog'), 'the theme studio is a native dialog');
  // The discarded rail/sheet redesign must not return: the restored shell owns these surfaces.
  for (const gone of ['rail-new', 'rail-tasks', 'rail-safety', 'sheet-settings', 'strip-path', 'model-chip']) assert(!html.includes(`id="${gone}"`), `${gone} belongs to the retired shell`);
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

test('CHANGE 4: route and model are disclosed once, in the status bar; consent lives in the header', async () => {
  const html = await readFile(resolve(root, '../public/index.html'), 'utf8');
  // The status bar states tokens, speed, cache and the one gateway-chosen model.
  assert(html.includes('id="status-bar"'), 'the status bar is missing');
  for (const id of ['stat-tokens', 'stat-speed', 'stat-cache', 'stat-model']) assert(html.includes(`id="${id}"`), `${id} readout missing from the status bar`);
  // Each measurement has exactly one home: the stats group on the left, the model on the right.
  assert(html.includes('id="foot-stats"') && html.includes('id="foot-right"'), 'the bar must keep its two measurement groups');
  // The header states the run's route/consent honestly, in the one consent control.
  assert(html.includes('id="consent-toggle"') && html.includes('id="consent-label"'), 'the header must carry the consent state');
  // The retired rail strip and its duplicate copies of these facts stay retired.
  for (const gone of ['strip-path', 'model-chip', 'strip-cost', 'sheet-safety']) assert(!html.includes(`id="${gone}"`), `${gone} belongs to the retired shell`);
  assert(html.includes('id="card-viz-doc"'), 'the document preview card must survive');
  for (const gone of ['viz-doc-types', 'viz-doc-generate', 'viz-doc-fullscreen', 'viz-doc-open', 'viz-doc-save', 'viz-doc-pdf', 'timeline-chrono', 'timeline-modes']) {
    assert(!html.includes(`id="${gone}"`), `${gone} should be removed`);
  }
  assert(!html.includes('세션 문서 생성'), '세션 문서 생성 controls should be removed');
  const css = await readFile(resolve(root, '../public/styles.css'), 'utf8');
  assert(!css.includes('tl-work-sweep'), 'tl-work-sweep animation should be removed');

  const appJs = await readFile(resolve(root, '../public/app.js'), 'utf8');
  assert(appJs.includes('function renderFooterMetrics'), 'the status bar is built by renderFooterMetrics');
  assert(appJs.includes("$('stat-model')") && appJs.includes("$('consent-label')"), 'both readouts are written from reported state');
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

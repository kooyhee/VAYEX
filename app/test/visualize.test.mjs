import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../server.mjs';
import { DOC_TYPES, BRAND, buildSessionDocument, buildSessionReport, reportFileName } from '../public/session-report.js';
import { buildDocumentModel as buildRawDocumentModel, DOC_TYPE_LABELS } from '../insight/document.mjs';

const emptyModelRoot = mkdtempSync(join(tmpdir(), 'viz-nomodel-'));
test.after(() => {
  try { rmSync(emptyModelRoot, { recursive: true, force: true }); } catch {}
});
const buildDocumentModel = (opts) => buildRawDocumentModel({ modelRoot: emptyModelRoot, env: {}, ...opts });

const sampleEvents = [
  { type: 'prompt', session: 's-viz', ts: 1700000000000, message: '로그인 검증 함수와 테스트를 작성해 줘' },
  { type: 'task.start', session: 's-viz', task: 't-1', ts: 1700000001000, data: { description: '로그인 함수 구현' } },
  {
    type: 'tool_execution_end',
    session: 's-viz',
    task: 't-1',
    ts: 1700000003000,
    toolName: 'write_file',
    result: {
      details: {
        perFileResults: [
          { path: 'src/auth/login.ts', created: true },
          { path: 'src/auth/validate.ts', created: true },
        ],
        diff: '--- a/src/auth/login.ts\n+++ b/src/auth/login.ts\n@@ -0,0 +1,5 @@\n+export function login(user, pass) {\n+  return Boolean(user && pass);\n+}',
      },
    },
  },
  {
    type: 'tool_execution_end',
    session: 's-viz',
    task: 't-1',
    ts: 1700000005000,
    command: 'npm run test',
    result: { isError: false },
  },
  {
    type: 'llm_turn',
    session: 's-viz',
    ts: 1700000006000,
    promptTokens: 120,
    completionTokens: 60,
    cachedTokens: 30,
    elapsedMs: 800,
    data: { reported: true, usage_source: 'openai' },
  },
  { type: 'prompt_result', session: 's-viz', ts: 1700000007000, status: 'completed' },
];

test('document model: builds 4 distinct document types from structured events', async () => {
  for (const type of DOC_TYPES) {
    const model = await buildDocumentModel({
      type,
      events: sampleEvents,
      session: 's-viz',
      meta: { title: '로그인 검증 구현' },
    });
    assert.equal(model.type, type);
    assert.equal(model.typeLabel, DOC_TYPE_LABELS[type]);
    assert.equal(model.brand.name, BRAND.name);
    assert.equal(model.brand.tagline, BRAND.tagline);
    assert.equal(model.context.title, '로그인 검증 구현');
    assert.equal(model.context.sessionId, 's-viz');
    assert.match(model.goal.text, /로그인 검증 함수와 테스트를 작성해 줘/);
    assert.equal(model.steps.length, 2); // 2 created files
    assert.equal(model.deliverables.items.length, 2);
    assert.equal(model.deliverables.snippets.length, 1);
    assert.equal(model.verification.state, 'passed');
    assert.equal(model.metrics.tokens, 180);
    assert.equal(model.watchdog.state, 'done');
  }
});

test('session document HTML: self-contained, no CDN, includes 4 sections, light/dark and print controls', async () => {
  const model = await buildDocumentModel({
    type: 'report',
    events: sampleEvents,
    session: 's-viz',
    meta: { title: '자체 완결형 보고서' },
  });
  const html = buildSessionDocument(model);
  assert.ok(html.startsWith('<!doctype html>'), 'must be standard standalone HTML');
  assert.ok(html.includes(BRAND.name), 'must include brand name');
  assert.ok(html.includes(BRAND.tagline), 'must include tagline');
  assert.ok(html.includes('작업 목적 및 배경'), 'section 1 required');
  assert.ok(html.includes('진행 과정 및 단계별 요약'), 'section 2 required');
  assert.ok(html.includes('핵심 결과 및 변경 상세'), 'section 3 required');
  assert.ok(html.includes('검증 내용 및 품질 지표'), 'section 4 required');
  assert.ok(html.includes('<svg'), 'must include inline SVG');
  assert.ok(html.includes('theme-toggle'), 'must include theme toggle');
  assert.ok(html.includes('print-doc'), 'must include print button');
  assert.ok(!html.includes('http://') && !html.includes('https://') && !html.includes('cdn.'), 'zero external resources allowed');
});

test('legacy buildSessionReport backwards-compatibility', () => {
  const html = buildSessionReport({
    title: '레거시 리포트',
    sessionId: 's-leg',
    model: 'qwen3:32b',
    changes: [
      { category: '추가', path: 'src/index.ts', text: '진입점 생성', at: Date.now() },
    ],
  });
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('레거시 리포트'));
  assert.ok(html.includes('진입점 생성'));
  const filename = reportFileName({ title: 'My Work', type: 'study' });
  assert.match(filename, /^My-Work-.*-study\.html$/);
});

test('empty session visualization guard blocks generating fabricated documents when 0 file changes and 0 tool calls', async () => {
  const emptyDocModel = await buildDocumentModel({
    type: 'report',
    events: [{ type: 'prompt', session: 's-empty', message: '아무 도구도 실행되지 않은 세션' }],
    session: 's-empty',
  });
  assert.equal(emptyDocModel.empty, true);
  assert.equal(emptyDocModel.message, '세션 작업 기록이 없습니다.');

  const docResult = buildSessionDocument(emptyDocModel);
  assert.deepEqual(docResult, { empty: true, message: '세션 작업 기록이 없습니다.' });

  const legacyEmpty = buildSessionReport({ title: '빈 세션', changes: [], tools: 0 });
  assert.deepEqual(legacyEmpty, { empty: true, message: '세션 작업 기록이 없습니다.' });
});

test('server endpoints: /api/visualize/html, /api/visualize/pdf, /api/visualize/list', async (t) => {
  const app = await createBridge({ mock: true, insightModelRoot: emptyModelRoot, insightModelEnv: {} });
  t.after(() => app.close());
  const url = await app.start(0);

  // 0. Empty session must return 400 with { empty: true, message: "세션 작업 기록이 없습니다." }
  const emptyRes = await fetch(`${url}/api/visualize/html?session=empty-session&type=report`);
  assert.equal(emptyRes.status, 400);
  const emptyBody = await emptyRes.json();
  assert.equal(emptyBody.empty, true);
  assert.equal(emptyBody.message, '세션 작업 기록이 없습니다.');

  // Seed real events for the active session before generating deliverables
  app.recordSessionEvents('s-viz', sampleEvents);

  // 1. Generate HTML for all 4 types
  for (const type of ['report', 'study', 'spec', 'summary']) {
    const res = await fetch(`${url}/api/visualize/html?session=current&type=${type}&title=테스트-${type}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.ok(body.includes(BRAND.name));
    assert.ok(body.includes(DOC_TYPE_LABELS[type]));
    assert.ok(body.includes(`테스트-${type}`));
  }

  // 2. Query document list
  const listRes = await fetch(`${url}/api/visualize/list`);
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.equal(list.dir, 'data/visualizations');
  assert.ok(list.count >= 4);
  assert.ok(list.items.some((item) => item.type === 'report' && item.format === 'html'));
  assert.ok(list.items.some((item) => item.type === 'spec' && item.format === 'html'));

  // 3. Query PDF endpoint (headless Edge)
  const pdfRes = await fetch(`${url}/api/visualize/pdf?session=current&type=summary`);
  if (pdfRes.status === 200) {
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
    const pdfBytes = await pdfRes.arrayBuffer();
    assert.ok(pdfBytes.byteLength > 100);
  } else {
    // If running in an environment where Edge is unavailable or blocked
    assert.equal(pdfRes.status, 503);
    const err = await pdfRes.json();
    assert.ok(err.saved?.html);
  }
});

// Charts and exported diagrams must carry their reported data as text, keep unknown
// values unknown, and the standalone document must not overflow a narrow preview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildSessionDocument } from '../public/session-report.js';
import { renderTaskGraph, renderCostChart, renderMemoryChart, memoryChartData } from '../public/visualize.js';
import { buildDocumentModel as buildRawDocumentModel } from '../insight/document.mjs';

const emptyModelRoot = mkdtempSync(join(tmpdir(), 'report-a11y-nomodel-'));
test.after(() => {
  try { rmSync(emptyModelRoot, { recursive: true, force: true }); } catch {}
});
const buildDocumentModel = (opts) => buildRawDocumentModel({ modelRoot: emptyModelRoot, env: {}, ...opts });

function render(fn, data) {
  const previous = globalThis.document;
  const make = (tag) => ({
    tag, attrs:{}, children:[], textContent:'',
    setAttribute(key, value) { this.attrs[key] = String(value); },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
  });
  globalThis.document = { createElementNS: (_ns, tag) => make(tag) };
  try {
    const root = make('svg');
    fn(root, data);
    const find = (node, pred, out = []) => { if (pred(node)) out.push(node); node.children.forEach(c => find(c, pred, out)); return out; };
    return {
      root,
      title: find(root, n => n.tag === 'title')[0]?.textContent,
      items: find(root, n => n.attrs.role === 'listitem').map(n => n.attrs['aria-label']),
    };
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

test('memory chart exposes counts as list items and keeps 미집계 for uncounted types', () => {
  const out = render(renderMemoryChart, memoryChartData({ active:4, superseded:1, quarantined:0,
    typeBreakdown:[{ type:'rule', count:4 }, { type:'fact', count:null }] }));
  assert.equal(out.root.attrs.role, 'group');
  assert.ok(out.root.attrs['aria-labelledby']);
  assert.match(out.title, /메모리 구성/);
  const text = out.items.join('\n');
  assert.match(text, /rule[^\n]*4건/);
  assert.match(text, /fact[^\n]*미집계/);
  assert.doesNotMatch(text, /fact[^\n]*0건/);
});

test('an omitted state total is announced as 미보고, not as 0건', () => {
  // The payload reports active only: superseded and quarantined were never counted.
  const out = render(renderMemoryChart, memoryChartData({ active:4 }));
  const text = out.items.join('\n');
  assert.match(text, /상태 활성 4건/);
  assert.match(text, /상태 대체됨 미보고/);
  assert.match(text, /상태 격리 미보고/);
  assert.doesNotMatch(text, /대체됨 0건|격리 0건/, `missing totals became zero: ${text}`);
});

test('explicitly reported zero totals stay visible instead of vanishing', () => {
  const out = render(renderMemoryChart, memoryChartData({ active:0, superseded:0, quarantined:0 }));
  const text = out.items.join('\n');
  assert.match(text, /상태 활성 0건/);
  assert.match(text, /상태 대체됨 0건/);
  assert.match(text, /상태 격리 0건/);
});

test('an unknown task state reads 미보고 while a reported waiting state reads 대기', () => {
  const graph = render(renderTaskGraph, {
    main:{ id:'m', name:'메인', state:'unknown' },
    subagents:[
      { id:'a', name:'검토자', state:'waiting', lane:1, dependsOn:null },
      { id:'b', name:'기록자', lane:null, dependsOn:null },
    ],
  });
  const main = graph.items.find(l => l.startsWith('메인 작업'));
  assert.match(main, /상태 미보고/, `unknown main state announced as something else: ${main}`);
  const waiting = graph.items.find(l => l.includes('검토자'));
  assert.match(waiting, /상태 대기/);
  const absent = graph.items.find(l => l.includes('기록자'));
  assert.match(absent, /상태 미보고/, `an absent state was announced: ${absent}`);
  assert.doesNotMatch(graph.items.join('\n'), /검토자[^\n]*미보고/);
});

test('cost chart labels keep identities that collide in the drawing', () => {
  const out = render(renderCostChart, { tasks:[
    { name:'deployment-pipeline-alpha', tokens:10, cost:null },
    { name:'deployment-pipeline-beta', tokens:20, cost:null },
  ], dx:null });
  const alpha = out.items.find(l => l.includes('alpha'));
  const beta = out.items.find(l => l.includes('beta'));
  assert.ok(alpha && beta, `truncated labels collided: ${out.items.join(' | ')}`);
  assert.notEqual(alpha, beta);
});

test('cost chart and task graph expose reported values and relationships', () => {
  const cost = render(renderCostChart, { tasks:[{ name:'빌드', tokens:1200, cost:null }], dx:null });
  assert.ok(cost.items.some(l => /빌드/.test(l) && /1,200 토큰/.test(l) && /비용 미보고/.test(l)));
  const graph = render(renderTaskGraph, { main:{ id:'m', name:'메인', state:'running' },
    subagents:[{ id:'a', name:'검토자', state:'done', lane:0, dependsOn:null, elapsed:'3s' }] });
  assert.match(graph.title, /하위 에이전트 1개/);
  assert.ok(graph.items.some(l => /검토자/.test(l) && /메인 작업에 의존/.test(l) && /완료/.test(l) && /레인 1/.test(l)));
});

const events = [
  { type:'prompt', session:'s-a11y', ts:1700000000000, message:'로그인 검증 함수 작성' },
  { type:'tool_execution_end', session:'s-a11y', ts:1700000003000, toolName:'write_file',
    result:{ details:{ perFileResults:[{ path:'src/very/long/path/'.repeat(8) + 'login.ts', created:true }] } } },
  { type:'tool_execution_end', session:'s-a11y', ts:1700000005000, command:'npm run test', result:{ isError:false } },
  { type:'prompt_result', session:'s-a11y', ts:1700000007000, status:'completed' },
];

async function documentHtml() {
  const model = await buildDocumentModel({ type:'report', events, session:'s-a11y', meta:{ title:'접근성 보고서' } });
  return { model, html:buildSessionDocument(model) };
}

test('exported diagrams carry steps and structure as a text alternative', async () => {
  const { model, html } = await documentHtml();
  const flow = html.match(/<div class="diagram-alt" id="flow-alt">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.ok(model.steps.length > 0);
  for (const step of model.steps) assert.ok(flow.includes(step.title), `flow alt lists ${step.title}`);
  assert.match(flow, /<ol/);
  assert.match(html, /<figure class="diagram" aria-labelledby="flow-cap">/);
  const arch = html.match(/<div class="diagram-alt" id="arch-alt">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.match(arch, /<ol aria-label="실행 계층 연결 순서">/);
  for (const title of ['화면 (브라우저)', '노드 하네스', 'OMP 코어', '로컬 경로']) {
    assert.ok(arch.includes(title), `architecture alt is missing ${title}`);
  }
  assert.match(arch, /화면 \(브라우저\)에서 연결 → 노드 하네스/);
  assert.match(arch, /<ul aria-label="역할 분담">/);
});

test('architecture alternative keeps the full reported model identity the drawing truncates', async () => {
  const model = await buildDocumentModel({
    type:'spec', events, session:'s-a11y', meta:{ title:'모델 식별자', model:'Qwen2.5-0.5B-Instruct' },
  });
  assert.equal(model.context.model, 'Qwen2.5-0.5B-Instruct');
  const html = buildSessionDocument(model);
  const arch = html.match(/<div class="diagram-alt" id="arch-alt">([\s\S]*?)<\/div>/)?.[1] ?? '';
  const caption = html.match(/<figcaption class="diagram-cap" id="arch-cap">([\s\S]*?)<\/figcaption>/)?.[1] ?? '';
  assert.ok(arch.includes('Qwen2.5-0.5B-Instruct'), `alt truncated the identity: ${arch.slice(0, 400)}`);
  assert.ok(caption.includes('Qwen2.5-0.5B-Instruct'), `caption truncated the identity: ${caption}`);
});

/** WCAG 2.1 relative luminance of a rendered rgb colour. */
const channel = (value) => {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
};
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

// Any Chromium-family browser renders these documents, so an explicitly set CHROME_PATH wins
// and otherwise the standard install locations of Chrome, Edge and Chromium are searched at
// runtime — the skip then names the one thing really missing instead of a machine path.
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

const browser = browserCandidates().find(path => path && existsSync(path));
const skip = browser ? false
  : 'No Chromium-family browser (Chrome, Edge or Chromium) found at a standard install location and CHROME_PATH is unset, so the rendered document cannot be measured';
const chromiumArgs = () => ['--headless=new', '--disable-gpu', '--no-first-run'];

// A headless render is not sized like the rest of this file. Measured on this machine
// (12 logical CPUs, the whole suite running in parallel): one cold Edge --dump-dom takes
// 1.3–3.2 s when the machine is idle, 43 s at 14 busy CPUs, and 62–84 s under the
// contention a full `npm test` creates; the --print-to-pdf stage measured 112 s in the
// same conditions. The 60 s cap this file used to carry therefore expired while the page
// had already rendered, and the failure surfaced as `spawnSync … ETIMEDOUT` with a
// complete document in stdout. This budget is bounded above the slowest measured stage.
const RENDER_BUDGET_MS = 180000;

// One render, in a profile directory only this invocation owns. A previous run's browser
// can never hold it (a Chromium started on a profile another instance owns exits with
// code 21 in ~0.1 s, which used to look like a render failure), and the directory is
// removed afterwards. stdout goes to a file instead of a pipe: when a helper process
// inherits the pipe, spawnSync keeps waiting for EOF past its deadline even though the
// document was fully written — the "ETIMEDOUT with complete stdout" signature. The
// deadline kills the whole browser tree, so a stuck render cannot leak a browser either.
function renderOnce(label, args) {
  const dir = mkdtempSync(join(tmpdir(), `report-render-${label}-`));
  const outPath = join(dir, 'stdout.txt'), errPath = join(dir, 'stderr.txt');
  const outFd = openSync(outPath, 'w'), errFd = openSync(errPath, 'w');
  const started = Date.now();
  const child = spawn(browser, [`--user-data-dir=${join(dir, 'profile')}`, ...args], { stdio:['ignore', outFd, errFd], windowsHide:true });
  closeSync(outFd); closeSync(errFd);
  const killTree = () => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio:'ignore' });
  let killedAt = null;
  const deadline = setTimeout(() => { killedAt = Date.now() - started; killTree(); }, RENDER_BUDGET_MS);
  return new Promise((resolve, reject) => {
    child.once('error', error => { clearTimeout(deadline); reject(new Error(`${label}: the browser could not be started (${error.code ?? 'spawn'})`)); });
    child.once('exit', (code, signal) => {
      clearTimeout(deadline);
      const stderr = readFileSync(errPath, 'utf8');
      if (killedAt !== null) return reject(new Error(`${label}: still running at ${killedAt} ms, over the ${RENDER_BUDGET_MS} ms render budget; the browser tree was killed\n${stderr.slice(-600)}`));
      if (code !== 0) return reject(new Error(`${label}: the browser exited with ${code ?? signal} after ${Date.now() - started} ms\n${stderr.slice(-600)}`));
      resolve(readFileSync(outPath, 'utf8'));
    });
  }).finally(() => rmSync(dir, { recursive:true, force:true }));
}

// A session that really deletes a file, so the 삭제 label, count and badge are rendered.
const deletionEvents = [
  { type:'prompt', session:'s-del', ts:1700000100000, message:'레거시 인증 정리' },
  { type:'tool_execution_end', session:'s-del', ts:1700000103000, toolName:'delete_file',
    result:{ details:{ perFileResults:[{ path:'src/legacy/auth.ts', deleted:true }] } } },
  { type:'prompt_result', session:'s-del', ts:1700000106000, status:'completed' },
];

// Reads the colour each deletion element actually renders with, in both themes.
const contrastProbe = `
addEventListener('load', () => {
  const parse = (value) => {
    const m = String(value).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return { r:p[0], g:p[1], b:p[2], a:p.length > 3 ? p[3] : 1 };
  };
  const over = (top, bottom) => ({ r:top.r*top.a + bottom.r*(1-top.a), g:top.g*top.a + bottom.g*(1-top.a),
    b:top.b*top.a + bottom.b*(1-top.a), a:1 });
  const chainOf = (el) => { const chain = []; for (let n = el; n; n = n.parentElement) chain.push(n); return chain.reverse(); };
  const bgOf = (el) => chainOf(el).reduce((bg, node) => {
    const c = parse(getComputedStyle(node).backgroundColor);
    return c && c.a > 0 ? over(c, bg) : bg;
  }, { r:255, g:255, b:255, a:1 });
  const measure = (el) => {
    const fg = parse(getComputedStyle(el).color);
    const bg = bgOf(el);
    return { text: el.textContent.trim(), fg: fg.a >= 1 ? fg : over(fg, bg), bg };
  };
  const sample = () => {
    const card = [...document.querySelectorAll('.count')]
      .find((el) => el.querySelector('.count-name')?.textContent.trim() === '삭제');
    const badge = [...document.querySelectorAll('.badge')].find((el) => el.textContent.trim() === '삭제');
    return {
      countName: card ? measure(card.querySelector('.count-name')) : null,
      countValue: card ? measure(card.querySelector('.count-value')) : null,
      badge: badge ? measure(badge) : null,
    };
  };
  const out = {};
  for (const theme of ['dark', 'light']) {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
    getComputedStyle(document.body).color;
    out[theme] = sample();
  }
  document.body.setAttribute('data-probe', JSON.stringify(out));
});
`;

test('deletion label, count and badge keep 4.5:1 as rendered in light and dark', { skip }, async (t) => {
  const model = await buildDocumentModel({ type:'report', events:deletionEvents, session:'s-del', meta:{ title:'삭제 보고서' } });
  const reported = model.deliverables.counts['삭제'];
  assert.ok(reported > 0, 'the fixture must report at least one deletion');
  const dir = mkdtempSync(join(tmpdir(), 'report-contrast-'));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const page = join(dir, 'deletion.html');
  writeFileSync(page, buildSessionDocument(model).replace('</body>', `<script>${contrastProbe}</script></body>`));
  const dom = await renderOnce('contrast', [...chromiumArgs(), '--window-size=900,1200', '--virtual-time-budget=3000',
    '--dump-dom', pathToFileURL(page).href]);
  const measured = JSON.parse(dom.match(/data-probe="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));

  for (const theme of ['dark', 'light']) {
    const sample = measured[theme];
    assert.ok(sample, `${theme} theme was not measured`);
    assert.equal(sample.countName?.text, '삭제', `${theme} deletion label is missing`);
    assert.equal(sample.countValue?.text, String(reported), `${theme} deletion count lost the reported value`);
    assert.equal(sample.badge?.text, '삭제', `${theme} deletion badge is missing`);
    for (const [part, rendered] of Object.entries(sample)) {
      const ratio = contrast(rendered.fg, rendered.bg);
      assert.ok(ratio >= 4.5, `${theme} ${part} renders at ${ratio.toFixed(2)}:1 (${JSON.stringify(rendered)})`);
    }
  }
  assert.ok(luminance(measured.dark.countValue.bg) < luminance(measured.light.countValue.bg),
    'the theme switch did not repaint the document');
});

test('narrow preview has no horizontal overflow; print paginates per section', { skip }, async (t) => {
  const { html } = await documentHtml();
  const dir = mkdtempSync(join(tmpdir(), 'report-a11y-'));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const probe = `<script>addEventListener('load',()=>{const w=document.documentElement.clientWidth;
    const bad=[...document.querySelectorAll('body *')].filter(e=>!e.closest('.table-wrap,pre')&&e.getBoundingClientRect().right>w+1).length;
    document.body.setAttribute('data-probe',JSON.stringify({sw:document.documentElement.scrollWidth,w,bad,
      th:parseFloat(getComputedStyle(document.querySelector('table.data td')).fontSize)}));});</script>`;
  const page = join(dir, 'doc.html');
  writeFileSync(page, html.replace('</body>', `${probe}</body>`));
  const common = chromiumArgs();
  const dom = await renderOnce('narrow', [...common, '--window-size=360,800', '--virtual-time-budget=3000', '--dump-dom', pathToFileURL(page).href]);
  const probeResult = JSON.parse(dom.match(/data-probe="([^"]*)"/)[1].replace(/&quot;/g, '"'));
  assert.ok(probeResult.sw <= probeResult.w, `scrollWidth ${probeResult.sw} > ${probeResult.w}`);
  assert.equal(probeResult.bad, 0);
  assert.ok(probeResult.th >= 14, `table cell font ${probeResult.th}px`);

  const pdf = join(dir, 'doc.pdf');
  await renderOnce('print', [...common, '--no-pdf-header-footer', `--print-to-pdf=${pdf}`, pathToFileURL(join(dir, 'doc.html')).href]);
  const pages = (readFileSync(pdf, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  assert.ok(pages >= 4 && pages <= 12, `print pages ${pages}`);
});

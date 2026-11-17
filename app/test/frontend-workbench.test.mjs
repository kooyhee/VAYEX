import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../server.mjs';

const root = dirname(fileURLToPath(import.meta.url));

test('design tokens: seven studio themes, the elevation steps and the three column widths', async () => {
  // Comments are stripped so a rule's prelude is its selector alone when the sheet is split.
  const css = (await readFile(resolve(root, '../public/styles.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  // The theme studio offers seven presets; each one re-tones the whole surface ramp.
  const schemes = { obsidian:'dark', daylight:'light', aurora:'dark', lavender:'light', coral:'light', maritime:'dark', contrast:'dark' };
  for (const [theme, scheme] of Object.entries(schemes)) {
    const declared = cssDeclared(css, `:root[data-theme=${theme}]`);
    assert.equal(declared.get('color-scheme'), scheme, `the ${theme} theme must declare ${scheme}`);
    for (const token of ['--surface-0', '--surface-5', '--ink', '--accent']) assert.ok(declared.has(token), `the ${theme} theme must re-tone ${token}`);
  }
  // One shared tonal ladder: 0 (lowest surface) to 5 (raised controls).
  const rootTokens = cssDeclared(css, ':root');
  for (let step = 0; step <= 5; step++) assert.ok(rootTokens.has(`--md-sys-elevation-surface-${step}`), `elevation step ${step} is missing`);
  for (const role of ['--md-sys-color-primary', '--md-sys-color-success', '--md-sys-color-warning', '--md-sys-color-error']) assert.ok(rootTokens.has(role), `${role} is missing`);
  // Three measured columns, and the width at which they stop reflowing.
  assert.equal(rootTokens.get('--sidebar-w'), '260px', 'the sidebar column is 260px');
  assert.equal(rootTokens.get('--inspector-w'), '364px', 'the inspector column is 364px');
  assert(css.includes('@media (min-width:1180px)'), 'the three-column layout must hold from 1180px (260 + 364 + 556)');
});

// A bracket-matching rule splitter, so the type-scale contract is read from declarations
// instead of from one exact source string.
function cssBlocks(text) {
  const out = [];
  let depth = 0, preludeStart = 0, bodyStart = 0, prelude = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '{') {
      if (depth === 0) { prelude = text.slice(preludeStart, index); bodyStart = index + 1; }
      depth++;
    } else if (text[index] === '}') {
      depth--;
      if (depth === 0) { out.push({ prelude:prelude.trim(), body:text.slice(bodyStart, index) }); preludeStart = index + 1; }
    }
  }
  return out;
}
const cssSelectors = block => block.prelude.split(',').map(selector => selector.trim()).filter(Boolean);
function cssDeclarations(body) {
  const out = new Map();
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    out.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  return out;
}
/** Every declaration a plain rule for `selector` sets inside `text`, later rules winning like the cascade. */
function cssDeclared(text, selector) {
  const merged = new Map();
  for (const block of cssBlocks(text)) {
    if (block.prelude.startsWith('@')) continue;
    if (!cssSelectors(block).includes(selector)) continue;
    for (const [property, value] of cssDeclarations(block.body)) merged.set(property, value);
  }
  return merged;
}
/** Every below-`breakpoint` media block: `(width < N)` or `(max-width: N)`, never `min-width`. */
function cssBelow(css, breakpoint) {
  const pattern = new RegExp(`(?:\\(\\s*width\\s*<\\s*${breakpoint}\\s*\\)|\\(\\s*max-width\\s*:\\s*${breakpoint}\\s*\\))`);
  const bodies = cssBlocks(css)
    .filter(entry => entry.prelude.startsWith('@media') && pattern.test(entry.prelude) && !/min-width/.test(entry.prelude))
    .map(entry => entry.body);
  assert.ok(bodies.length > 0, `the below-${breakpoint} media block must exist`);
  return bodies.join('\n');
}

// The 12px type-scale floor and its --fs-* tokens belonged to the discarded rail/dock redesign;
// the restored shell declares no size scale (`--fs-` appears nowhere), so there is no product
// behaviour left to measure. Removed rather than re-pointed at unrelated literals.

test('shell markup: one sidebar, one conversation column, one inspector column', async () => {
  const html = await readFile(resolve(root, '../public/index.html'), 'utf8');
  // The three panes of the restored shell, each side pane reachable from its header toggle.
  for (const id of ['sidebar', 'center', 'inspector']) assert(html.includes(`id="${id}"`), `${id} pane is missing`);
  assert(html.includes('id="toggle-sidebar"') && html.includes('id="toggle-inspector"'), 'the header must carry the two panel toggles');
  // Sidebar entries that open the product's surfaces.
  for (const id of ['new-session', 'menu-search', 'menu-agents', 'menu-memory', 'menu-more', 'recent-list']) assert(html.includes(`id="${id}"`), `${id} is missing from the sidebar`);
  // The inspector's tabs and the pane each one shows.
  for (const [tab, pane] of [['tab-overview', 'pane-overview'], ['tab-agents', 'pane-agents'], ['tab-visualize', 'pane-visualize'], ['tab-stats', 'pane-stats'], ['tab-preview', 'pane-preview'], ['tab-diff', 'pane-diff'], ['tab-memory', 'pane-memory']]) {
    assert(html.includes(`id="${tab}"`) && html.includes(`id="${pane}"`), `${tab}/${pane} is missing`);
  }
  // One conversation log, one status bar, one consent control, one composer.
  assert(html.includes('id="transcript"') && html.includes('role="log"'), 'the conversation must be the log surface');
  assert(html.includes('id="status-bar"') && html.includes('id="stat-model"'), 'the status bar must carry the gateway-chosen model');
  assert(html.includes('id="consent-toggle"') && html.includes('id="consent-label"'), 'the header must carry the consent state');
  assert(html.includes('id="prompt"') && html.includes('id="send"'), 'the composer must exist');
  // The change-review surface and the approval gate still exist.
  assert(html.includes('id="diff-rollback"') && html.includes('id="review-form"'), 'change review must keep rollback and the follow-up request');
  assert(html.includes('id="gate"') && html.includes('id="approval-approve"') && html.includes('id="approval-deny"'), 'the approval gate must carry exactly the two answer buttons');
  // The theme studio is a native dialog.
  assert(html.includes('<dialog') && html.includes('id="theme-studio"'), 'the theme studio must be a native dialog');
  // The discarded rail/dock/strip redesign must not creep back.
  for (const gone of ['rail-new', 'rail-tasks', 'rail-safety', 'sheet-settings', 'sheet-safety', 'strip-path', 'model-chip', 'dock']) assert(!html.includes(`id="${gone}"`), `${gone} belongs to the retired shell`);
});

test('Live preview inspector script is self-contained and communicates via postMessage', async () => {
  const script = await readFile(resolve(root, '../public/preview-inspector.js'), 'utf8');
  assert(script.includes('omp:design-mode'), 'Design mode command listener missing');
  assert(script.includes('omp:element-selected'), 'Element selection message missing');
  assert(script.includes('omp-inspector-overlay'), 'Inspection highlight overlay missing');
  assert(script.includes('postMessage'), 'postMessage communication missing');
});

test('Server endpoints for live preview and preview inspector script asset', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const emptyModelRoot = mkdtempSync(join(tmpdir(), 'workbench-nomodel-'));
  t.after(() => {
    try { rmSync(emptyModelRoot, { recursive: true, force: true }); } catch {}
  });
  const bridge = await createBridge({ mock: true, insightModelRoot: emptyModelRoot, insightModelEnv: {} });
  const baseUrl = await bridge.start(0);

  try {
    // 1. Preview inspector script asset
    const scriptRes = await fetch(`${baseUrl}/preview-inspector.js`);
    assert.equal(scriptRes.status, 200);
    assert(scriptRes.headers.get('content-type')?.includes('javascript'));
    const scriptText = await scriptRes.text();
    assert(scriptText.includes('omp:element-selected'));

    // 2. Sample project live preview HTML
    const previewHtmlRes = await fetch(`${baseUrl}/preview/index.html`);
    assert.equal(previewHtmlRes.status, 200);
    assert(previewHtmlRes.headers.get('content-type')?.includes('text/html'));
    const previewHtml = await previewHtmlRes.text();
    assert(previewHtml.includes('국립목포해양대학교 AI 코딩 부스') || previewHtml.includes('card'));

    // 3. Sample project live preview CSS
    const previewCssRes = await fetch(`${baseUrl}/preview/style.css`);
    assert.equal(previewCssRes.status, 200);
    assert(previewCssRes.headers.get('content-type')?.includes('text/css'));

    // 4. Sample project live preview JS
    const previewJsRes = await fetch(`${baseUrl}/preview/app.js`);
    assert.equal(previewJsRes.status, 200);
    assert(previewJsRes.headers.get('content-type')?.includes('javascript'));

    // 5. Path traversal protection on preview
    const attackRes = await fetch(`${baseUrl}/preview/../../package.json`);
    assert(attackRes.status === 403 || attackRes.status === 404);

    // 6. CSP header allows framing self
    const indexRes = await fetch(`${baseUrl}/`);
    assert.equal(indexRes.status, 200);
    const csp = indexRes.headers.get('content-security-policy') || '';
    assert(csp.includes("frame-src 'self'"), 'CSP must allow frame-src self');
    assert(csp.includes("frame-ancestors 'self'"), 'CSP must allow frame-ancestors self');

    // 7. DX Snapshot diff route accessible
    const diffRes = await fetch(`${baseUrl}/api/dx/snapshot/diff?taskId=demo-task`);
    assert.equal(diffRes.status, 200);
    const diffData = await diffRes.json();
    assert.equal(diffData.taskId, 'demo-task');
    assert(Array.isArray(diffData.files));

    // 8. Memory status route accessible
    const memRes = await fetch(`${baseUrl}/api/memory/status`);
    assert.equal(memRes.status, 200);
    const memData = await memRes.json();
    assert(typeof memData.total === 'number');

    // 9. Standalone HTML visualization report route blocks empty sessions and renders recorded sessions
    const emptyVizRes = await fetch(`${baseUrl}/api/visualize/html?session=empty-session&title=ReportTest`);
    assert.equal(emptyVizRes.status, 400);
    const emptyVizData = await emptyVizRes.json();
    assert.equal(emptyVizData.empty, true);
    assert.equal(emptyVizData.message, '세션 작업 기록이 없습니다.');

    bridge.recordSessionEvents('demo-session', [
      { type: 'task.file_change', session: 'demo-session', task: 't-1', data: { path: 'app/server.mjs', change: 'modified' } },
    ]);
    const vizRes = await fetch(`${baseUrl}/api/visualize/html?session=demo-session&title=ReportTest`);
    assert.equal(vizRes.status, 200);
    assert(vizRes.headers.get('content-type')?.includes('text/html'));
    const vizHtml = await vizRes.text();
    assert(vizHtml.includes('<!doctype html>') && vizHtml.includes('ReportTest'));
  } finally {
    await bridge.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../server.mjs';

const root = dirname(fileURLToPath(import.meta.url));

test('design tokens: three themes, elevation roles, diff roles, and the rail/dock/strip dimensions', async () => {
  const css = await readFile(resolve(root, '../public/styles.css'), 'utf8');
  for (const theme of ['obsidian', 'daylight', 'contrast']) {
    assert(css.includes(`:root[data-theme=${theme}]`), `the ${theme} theme is not defined`);
  }
  for (const token of ['--md-sys-elevation-surface-0', '--md-sys-elevation-surface-5', '--md-sys-color-diff-add-bg', '--md-sys-color-diff-del-bg', '--md-sys-color-primary',
    '--rail-w:56px', '--dock-w:0px', '--header-h:48px', '--strip-h:36px', '--thread-max:760px']) {
    assert(css.includes(token), `${token} is missing`);
  }
  // Status colours and diff colours are disjoint token sets: diff colour never leaks out of a diff.
  const statusRole = /--status-(?:ready|busy|warn|danger):var\(--(?:success|accent|warning|danger)\)/g;
  assert((css.match(statusRole) ?? []).length === 4, 'the four status roles must resolve to the state colours');
  for (const role of ['--diff-add-bg', '--diff-del-bg', '--diff-hunk-bg']) assert(css.includes(role), `${role} must be its own role`);
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

test('type scale has a floor: no font-size below the 12px label size, and the mono/body sizes are the fixed ones', async () => {
  const css = (await readFile(resolve(root, '../public/styles.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  // Every literal font-size declaration in the sheet (everything else resolves a token).
  const sizes = [...css.matchAll(/font-size\s*:\s*([0-9.]+)px/g)].map(match => Number(match[1]));
  const below = sizes.filter(size => size < 12);
  assert.deepEqual(below, [], `a font-size below 12px is still declared: ${below.join(', ')}`);
  // Every font-size declaration is either a token or >= the label size.
  for (const match of css.matchAll(/font-size\s*:\s*([^;}]+)/g)) {
    const value = match[1].trim();
    if (/^var\(--fs-(?:body|aux|mono|label|badge)\)$/.test(value)) continue;
    assert.match(value, /^\d+(?:\.\d+)?px$/, `an unlisted font-size form is declared: ${value}`);
  }
  const tokens = cssDeclared(css, ':root');
  assert.equal(tokens.get('--fs-body'), '15px');
  assert.equal(tokens.get('--lh-body'), '1.65');
  assert.equal(tokens.get('--fs-aux'), '13px');
  assert.equal(tokens.get('--fs-mono'), '12.5px');
  assert.equal(tokens.get('--fs-label'), '12px');
  // The one documented exception: an 11.5px badge on a solid fill.
  assert.equal(tokens.get('--fs-badge'), '11.5px');
});

test('shell markup: an icon rail, one centre column, a result dock and dialog sheets', async () => {
  const html = await readFile(resolve(root, '../public/index.html'), 'utf8');
  for (const id of ['rail-new', 'rail-tasks', 'rail-results', 'rail-safety', 'rail-settings']) assert(html.includes(`id="${id}"`), `${id} is missing from the rail`);
  assert(html.includes('id="top-head"') && html.includes('id="head-status"') && html.includes('id="safety-entry"'), 'the header must carry the title, one status word and one safety entry');
  assert(html.includes('id="status-bar"') && html.includes('id="model-chip"') && html.includes('id="strip-cost"') && html.includes('id="strip-path"'), 'the strip must carry route, model chip and cost');
  assert(html.includes('id="dock"') && html.includes('id="diff-rollback"') && html.includes('id="review-form"'), 'the result dock must exist with rollback and the follow-up request');
  for (const id of ['sheet-safety', 'sheet-tasks', 'sheet-stats', 'sheet-preview', 'sheet-docs', 'sheet-settings', 'sheet-model']) {
    assert(html.includes(`<dialog`) && html.includes(`id="${id}"`), `${id} must be a native dialog`);
  }
  assert(html.includes('id="gate"') && html.includes('id="approval-approve"') && html.includes('id="approval-deny"'), 'the approval gate must carry exactly the two answer buttons');
  assert(html.includes('id="gate-radios"') && html.includes('id="gate-scope"'), 'the approval scopes must be the collapsed radio group');
  // Deleted surfaces must not creep back.
  for (const gone of ['insp-tabs', 'tab-overview', 'split-sidebar', 'split-inspector', 'card-quick', 'card-bridge']) assert(!html.includes(gone), `${gone} came back`);
  assert(!html.includes('diff-task-id'), 'the 작업 ID input must not exist: the dock always shows the current session');
  assert(!html.includes('theme-studio'), 'the theme studio must be gone; the settings sheet owns the theme');
  assert(!/<input[^>]+type="range"/.test(html), 'no range slider belongs in this app');
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

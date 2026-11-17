// One canonical artifact per session + document type + content hash.
//
// These tests drive the HTTP routes the workbench and the inspector actually call
// (preview, tab-open, download, list) against a private state directory, and count
// files on disk between calls: the contract is about artifacts, not about response
// bodies. The client-side contract is checked at the source level, because app.js
// is a browser script with no importable seam.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createBridge } from '../server.mjs';
import { buildDocumentModel as buildRawDocumentModel } from '../insight/document.mjs';

const emptyModelRoot = mkdtempSync(resolve(tmpdir(), 'vayex-dedupe-nomodel-'));
test.after(() => {
  try { rmSync(emptyModelRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
});
const buildDocumentModel = (opts) => buildRawDocumentModel({ modelRoot: emptyModelRoot, env: {}, ...opts });

const workEvents = [
  { type: 'prompt', session: 's-dedupe', ts: 1700000000000, message: '중복 문서 방지 로직을 구현해 줘' },
  {
    type: 'tool_execution_end',
    session: 's-dedupe',
    task: 't-1',
    ts: 1700000002000,
    toolName: 'write_file',
    result: {
      details: {
        perFileResults: [{ path: 'app/insight/document.mjs', created: true }],
        diff: '--- a/app/insight/document.mjs\n+++ b/app/insight/document.mjs\n@@ -1,1 +1,2 @@\n+export function contentHashFor() {}',
      },
    },
  },
  { type: 'tool_execution_end', session: 's-dedupe', task: 't-1', ts: 1700000004000, command: 'node --test app/test/document-dedupe.test.mjs', result: { isError: false } },
];

const moreWorkEvents = [
  { type: 'tool_execution_end', session: 's-dedupe', task: 't-2', ts: 1700000006000, toolName: 'edit', result: { details: { perFileResults: [{ path: 'app/server.mjs', modified: true }] } } },
];

function artifacts(stateDir) {
  try {
    return readdirSync(resolve(stateDir, 'visualizations')).filter((name) => /\.(html|pdf)$/.test(name)).sort();
  } catch {
    return [];
  }
}
/** Everything in the artifact directory, including temp and profile leftovers. */
function entries(stateDir) {
  try { return readdirSync(resolve(stateDir, 'visualizations')).sort(); } catch { return []; }
}

async function openBridge(stateDir, extra = {}) {
  const app = await createBridge({
    mock: true,
    config: { stateDir },
    insightModelRoot: emptyModelRoot,
    insightModelEnv: {},
    ...extra,
  });
  const url = await app.start(0);
  return { app, url };
}

async function withBridge(t, sessionEvents = {}, extra = {}) {
  const stateDir = mkdtempSync(resolve(tmpdir(), 'vayex-dedupe-'));
  const { app, url } = await openBridge(stateDir, extra);
  t.after(async () => {
    await app.close();
    try { rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });
  for (const [sessionId, events] of Object.entries(sessionEvents)) app.recordSessionEvents(sessionId, events);
  return { url, stateDir, app };
}

function newStateDir(t) {
  const stateDir = mkdtempSync(resolve(tmpdir(), 'vayex-dedupe-'));
  t.after(() => {
    try { rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  });
  return stateDir;
}

/** Same values, opposite key insertion order: canonical hashing must not notice. */
function permuteKeys(value) {
  if (Array.isArray(value)) return value.map(permuteKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, permuteKeys(inner)]));
  }
  return value;
}

test('document hash follows the printed projection, not the raw stream', async () => {
  const permuted = permuteKeys(workEvents);
  const base = await buildDocumentModel({ type: 'report', events: workEvents, session: 's-dedupe', meta: { title: 'T' }, now: 111 });
  // Same content, different wall clock, different key order inside an event: same identity.
  const sameContent = await buildDocumentModel({ type: 'report', events: permuted, session: 's-dedupe', meta: { title: 'T' }, now: 999999 });
  assert.ok(base.contentHash);
  assert.equal(sameContent.contentHash, base.contentHash, 'the generation clock must not be part of the identity');
  assert.equal(base.documentKey, `s-dedupe:report:${base.contentHash}`);

  // Every field that reaches the printed page changes the identity.
  for (const [label, meta] of [
    ['title', { title: '다른 제목' }],
    ['consent', { title: 'T', consent: true }],
    ['route', { title: 'T', route: 'cloud' }],
    ['model', { title: 'T', model: 'harness-local/other' }],
    ['mode', { title: 'T', mode: '계획 모드' }],
  ]) {
    const variant = await buildDocumentModel({ type: 'report', events: workEvents, session: 's-dedupe', meta, now: 111 });
    assert.notEqual(variant.contentHash, base.contentHash, `${label} is printed, so it must change the version`);
  }
  const otherSession = await buildDocumentModel({ type: 'report', events: workEvents, session: 's-other', meta: { title: 'T' }, now: 111 });
  assert.notEqual(otherSession.contentHash, base.contentHash);
  const otherType = await buildDocumentModel({ type: 'study', events: workEvents, session: 's-dedupe', meta: { title: 'T' }, now: 111 });
  assert.notEqual(otherType.contentHash, base.contentHash);
  const otherEvidence = await buildDocumentModel({ type: 'report', events: [...workEvents, ...moreWorkEvents], session: 's-dedupe', meta: { title: 'T' }, now: 111 });
  assert.notEqual(otherEvidence.contentHash, base.contentHash);
});

test('identical request twice returns the same artifact and never rewrites it', async (t) => {
  const { url, stateDir } = await withBridge(t, { 's-dedupe': workEvents });
  const target = `${url}/api/visualize/html?session=s-dedupe&type=report&title=Same`;

  const first = await fetch(target);
  assert.equal(first.status, 200);
  const firstHash = first.headers.get('x-document-hash');
  assert.match(firstHash, /^[0-9a-f]{16}$/);
  assert.equal(first.headers.get('x-document-key'), `s-dedupe:report:${firstHash}`);
  assert.deepEqual(artifacts(stateDir), [`s-dedupe-report-${firstHash}.html`]);
  const disk = readFileSync(resolve(stateDir, 'visualizations', `s-dedupe-report-${firstHash}.html`));

  const second = await fetch(target);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-document-hash'), firstHash);
  assert.deepEqual(artifacts(stateDir), [`s-dedupe-report-${firstHash}.html`]);
  const diskAfter = readFileSync(resolve(stateDir, 'visualizations', `s-dedupe-report-${firstHash}.html`));
  assert.ok(disk.equals(diskAfter), 'the repeat must return the artifact already on disk');
});

test('a different title is a different document, not a cached older one', async (t) => {
  const { url, stateDir } = await withBridge(t, { 's-dedupe': workEvents });
  const one = await fetch(`${url}/api/visualize/html?session=s-dedupe&type=report&title=Alpha`);
  const h1 = one.headers.get('x-document-hash');
  const bodyOne = await one.text();
  assert.match(bodyOne, /Alpha/);

  const two = await fetch(`${url}/api/visualize/html?session=s-dedupe&type=report&title=Beta`);
  const h2 = two.headers.get('x-document-hash');
  assert.notEqual(h2, h1, 'the printed title must produce its own version');
  const bodyTwo = await two.text();
  assert.match(bodyTwo, /Beta/);
  assert.doesNotMatch(bodyTwo, /<title>Alpha/, 'the returned document must be the one the request described');

  // Both versions stay addressable, and asking again returns the requested one.
  const again = await fetch(`${url}/api/visualize/html?session=s-dedupe&type=report&hash=${h1}`);
  assert.equal(again.status, 200);
  assert.match(await again.text(), /<title>Alpha/);
  assert.deepEqual(artifacts(stateDir), [`s-dedupe-report-${h1}.html`, `s-dedupe-report-${h2}.html`].sort());
});

test('preview, tab-open and re-fetch of an existing document create nothing', async (t) => {
  const { url, stateDir } = await withBridge(t, { 's-dedupe': workEvents });
  const target = `${url}/api/visualize/html?session=s-dedupe&type=report&title=One`;
  const first = await fetch(target);
  assert.equal(first.status, 200);
  const hash = first.headers.get('x-document-hash');
  const before = entries(stateDir);
  assert.equal(artifacts(stateDir).length, 1);

  for (const variant of [
    `${target}&t=${Date.now()}`,
    `${url}/api/visualize/html?session=s-dedupe&type=report&title=One&hash=${hash}`,
    `${url}/api/visualize/html?session=current&type=report&title=One`,
  ]) {
    const response = await fetch(variant);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-document-hash'), hash);
  }
  assert.deepEqual(entries(stateDir), before, 'preview must never write an artifact or a temp file');
});

test('a session with no recorded work produces no document at all', async (t) => {
  const { url, stateDir } = await withBridge(t, {
    's-quiet': [{ type: 'prompt', session: 's-quiet', ts: 1700000000000, message: '설명만 있고 실행된 도구가 없다' }],
  });
  assert.deepEqual(entries(stateDir), []);

  for (const session of ['s-quiet', 'never-seen']) {
    for (const type of ['report', 'study', 'spec', 'summary']) {
      const response = await fetch(`${url}/api/visualize/html?session=${session}&type=${type}&title=Empty`);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).empty, true);
    }
    const pdf = await fetch(`${url}/api/visualize/pdf?session=${session}&type=report&title=Empty`);
    assert.equal(pdf.status, 400);
  }
  assert.deepEqual(entries(stateDir), [], 'an empty session must leave no file behind');
});

test('changed content adds one version and keeps the previous one retrievable', async (t) => {
  const { url, stateDir, app } = await withBridge(t, { 's-dedupe': workEvents });
  const target = `${url}/api/visualize/html?session=s-dedupe&type=report&title=Ver`;
  const first = await fetch(target);
  const v1 = first.headers.get('x-document-hash');
  const v1Bytes = readFileSync(resolve(stateDir, 'visualizations', `s-dedupe-report-${v1}.html`));

  const repeat = await fetch(target);
  assert.equal(repeat.headers.get('x-document-hash'), v1);
  assert.deepEqual(artifacts(stateDir), [`s-dedupe-report-${v1}.html`]);

  app.recordSessionEvents('s-dedupe', moreWorkEvents);
  const changed = await fetch(target);
  const v2 = changed.headers.get('x-document-hash');
  assert.notEqual(v2, v1, 'a content change must produce a new version');
  assert.deepEqual(artifacts(stateDir), [`s-dedupe-report-${v1}.html`, `s-dedupe-report-${v2}.html`].sort());

  const previous = await fetch(`${url}/api/visualize/html?session=s-dedupe&type=report&hash=${v1}`);
  assert.equal(previous.status, 200);
  assert.equal(previous.headers.get('x-document-hash'), v1);
  assert.match(await previous.text(), /Ver/);
  assert.ok(readFileSync(resolve(stateDir, 'visualizations', `s-dedupe-report-${v1}.html`)).equals(v1Bytes), 'the previous version stays byte-identical');

  const missing = await fetch(`${url}/api/visualize/html?session=s-dedupe&type=report&hash=ffffffffffffffff`);
  assert.equal(missing.status, 404);
  assert.deepEqual(entries(stateDir), artifacts(stateDir), 'no temp file may survive a failed version lookup');
});

test('concurrent identical requests leave one artifact and no temp files', async (t) => {
  const { url, stateDir } = await withBridge(t, { 's-dedupe': workEvents });
  const target = `${url}/api/visualize/html?session=s-dedupe&type=report&title=Rush`;
  const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(target)));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-document-hash'), responses[0].headers.get('x-document-hash'));
  }
  assert.deepEqual(artifacts(stateDir), [`s-dedupe-report-${responses[0].headers.get('x-document-hash')}.html`]);
  assert.deepEqual(entries(stateDir), artifacts(stateDir), 'no temp file may be left behind');
  assert.ok(readFileSync(resolve(stateDir, 'visualizations', artifacts(stateDir)[0])).length > 0);
});

test('a failed render leaves no cached PDF, and the next request renders again', async (t) => {
  let attempts = 0;
  const failing = async (source, tempTarget) => {
    attempts += 1;
    // Emulates a timed-out print: a partial file exists when the renderer gives up.
    writeFileSync(tempTarget, '%PDF-1.4 partial');
    return { ok: false, reason: 'pdf_timeout' };
  };
  const { url, stateDir } = await withBridge(t, { 's-dedupe': workEvents }, { renderPdf: failing });

  const html = await fetch(`${url}/api/visualize/html?session=s-dedupe&type=report&title=Pdf`);
  assert.equal(html.status, 200);
  const hash = html.headers.get('x-document-hash');

  const pdf = await fetch(`${url}/api/visualize/pdf?session=s-dedupe&type=report&title=Pdf`);
  assert.equal(pdf.status, 503);
  assert.equal((await pdf.json()).reason, 'pdf_timeout');
  assert.ok(!existsSync(resolve(stateDir, 'visualizations', `s-dedupe-report-${hash}.pdf`)), 'a timed-out render must not be published');
  assert.deepEqual(artifacts(stateDir), [`s-dedupe-report-${hash}.html`], 'no partial pdf may survive');

  // Nothing was cached: the next request tries again instead of serving the failure's bytes.
  const retry = await fetch(`${url}/api/visualize/pdf?session=s-dedupe&type=report&title=Pdf`);
  assert.equal(retry.status, 503);
  assert.equal(attempts, 2, 'a failed render must not be cached');
  assert.ok(!existsSync(resolve(stateDir, 'visualizations', `s-dedupe-report-${hash}.pdf`)));
});

test('a version survives the live event buffer, and another session cannot address it', async (t) => {
  const stateDir = newStateDir(t);
  const first = await openBridge(stateDir);
  first.app.recordSessionEvents('s-keep', workEvents);
  const response = await fetch(`${first.url}/api/visualize/html?session=s-keep&type=report&title=Keep`);
  const hash = response.headers.get('x-document-hash');
  const diskPath = resolve(stateDir, 'visualizations', `s-keep-report-${hash}.html`);
  const diskBytes = readFileSync(diskPath);
  await first.app.close();

  // A fresh bridge has no in-memory events; the artifact is still on disk.
  const second = await openBridge(stateDir);
  t.after(() => second.app.close());
  const restored = await fetch(`${second.url}/api/visualize/html?session=s-keep&type=report&hash=${hash}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.headers.get('x-document-hash'), hash);
  assert.match(await restored.text(), /Keep/, 'the stored version is what was served, not a fresh build');
  assert.ok(readFileSync(diskPath).equals(diskBytes), 'serving a version must not rewrite it');

  // The same hash from another session is not addressable.
  const foreign = await fetch(`${second.url}/api/visualize/html?session=s-other&type=report&hash=${hash}`);
  assert.equal(foreign.status, 404);
  assert.equal((await foreign.json()).error, 'document_version_not_found');

  // Without a hash and without live events it still refuses to create anything.
  const fresh = await fetch(`${second.url}/api/visualize/html?session=s-keep&type=report&title=Keep`);
  assert.equal(fresh.status, 400);
  assert.deepEqual(artifacts(stateDir), [`s-keep-report-${hash}.html`]);
});

test('the list is scoped to the requesting session, hashed and duplicate-free', async (t) => {
  const { url, stateDir, app } = await withBridge(t, { 's-a': workEvents });
  app.recordSessionEvents('s-b', workEvents.map((event) => ({ ...event, session: 's-b' })));

  const a = await fetch(`${url}/api/visualize/html?session=s-a&type=report&title=List`);
  const hashA = a.headers.get('x-document-hash');
  const b = await fetch(`${url}/api/visualize/html?session=s-b&type=report&title=List`);
  assert.equal(b.status, 200);
  // Repeat requests and a version read must not add list rows.
  await fetch(`${url}/api/visualize/html?session=s-a&type=report&title=List`);
  await fetch(`${url}/api/visualize/html?session=s-a&type=report&hash=${hashA}`);

  // A hash-less file from before content addressing is on disk but not addressable.
  mkdirSync(resolve(stateDir, 'visualizations'), { recursive: true });
  writeFileSync(resolve(stateDir, 'visualizations', 's-a-report.html'), '<html>legacy</html>');

  const listA = await (await fetch(`${url}/api/visualize/list?session=s-a`)).json();
  const keysA = listA.items.map((item) => `${item.session}|${item.type}|${item.format}|${item.hash}`);
  assert.deepEqual(keysA, [...new Set(keysA)], 'an artifact must be listed once');
  assert.equal(listA.count, listA.items.length);
  assert.ok(listA.items.every((item) => item.session === 's-a'), 'the list must not leak another session');
  assert.ok(listA.items.every((item) => item.hash && item.url.includes(`hash=${item.hash}`)), 'every listed row must be addressable');
  assert.equal(listA.items.length, 1);

  const listB = await (await fetch(`${url}/api/visualize/list?session=s-b`)).json();
  assert.ok(listB.items.every((item) => item.session === 's-b'));
});

test('the inspector opens the clicked version and keeps every version row', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /refreshVizDoc\(\{ hash: entry\.hash \?\? null \}\)/, 'preview must fetch the version that was clicked');
  assert.match(source, /docUrl\('html', pinned\)/, 'the fetch must carry the pinned hash');
  assert.match(source, /docUrl\('pdf', docHash\)/, 'PDF download must carry the open version');
  assert.match(source, /const key = \(entry\) => `\$\{entry\.type\}:\$\{entry\.hash \?\? ''\}`;/, 'rows are keyed by type + hash');
  assert.match(source, /filter\(entry => key\(entry\) !== `\$\{docType\}:\$\{hash \?\? ''\}`\)/, 're-recording a version must not replace another version row');
  assert.match(source, /reportFileName\(\{ title:docSessionTitle\(\), type:docType, hash:docHash \}\)/, 'download names come from reportFileName with the full hash');
  assert.match(source, /DOC_EMPTY_NOTE/, 'the empty state has its own message, distinct from a failure');
  assert.match(source, /response\.status === 400/, 'the empty-session response is handled separately');
  assert.match(source, /response\.status === 404/, 'a missing pinned version keeps its row');
});

// The memory chart must draw what the store counted. Before this, `/api/memory/status`
// returned only type names and the front end invented `{type, count:1}`, so six bars
// all read 1 regardless of what was stored. This pins the whole chain: rows in the
// store → `memoryStatus` → the SVG the inspector renders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../memory/store.mjs';
import { memoryStatus } from '../memory/api.mjs';
import { MEMORY_TYPES } from '../memory/config.mjs';
import { memoryChartData, renderMemoryChart } from '../public/visualize.js';

/** The chart's own mapping, rendered: what the inspector paints for a status payload. */
function chartText(status) {
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
    renderMemoryChart(root, memoryChartData(status));
    const walk = node => [node.textContent, ...node.children.map(walk)].join('\n');
    return walk(root);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

test('a store holding N memories of one type charts N, not one bar per type name', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-chart-truth-'));
  const store = await MemoryStore.open({ dataDir:dir, dbPath:join(dir, 'memory.db'), embedModel:'local-hash-3gram-v1' });
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive:true, force:true });
  });

  // Four unrelated rules: each one is its own row (no merge, no supersede).
  const rules = [
    ['빌드', 'node --test test/*.test.mjs 만 쓴다', 'build-alpha'],
    ['커밋', '메시지는 한국어 한 줄로 쓴다', 'commit-bravo'],
    ['포트', '8787 은 다른 하네스가 쓰므로 피한다', 'port-charlie'],
    ['로그', '개인정보는 남기기 전에 마스킹한다', 'log-delta'],
  ];
  for (const [i, [topic, sentence, key]] of rules.entries()) {
    const written = store.add({
      type:'project-rule',
      subjectKey:`chart-rules:${key}`,
      title:`${topic} 규칙`,
      body:`${topic}: ${sentence} (${key})`,
      sessionId:'chart-session', sourceEvent:`evt-${i}`, sourceKind:'user',
    });
    assert.equal(written.action, 'inserted', `fixture row ${i} was not stored as its own row: ${JSON.stringify(written)}`);
  }
  const status = memoryStatus({ store, embedder:{ status:() => ({ model:'local-hash-3gram-v1', resident:false }) } });

  assert.equal(status.typeCounts['project-rule'], 4, 'the status route must report the rows the store holds');
  assert.deepEqual(status.typeBreakdown.map(row => row.type), [...MEMORY_TYPES], 'every memory type is reported, in table order');

  // Each type row draws its label, then a bar (no text), then the count: the
  // label is truncated to 16 characters, the count follows it.
  const lines = chartText(status).split('\n').filter(line => line !== '');
  const rowValue = type => lines[lines.indexOf(type.slice(0, 16)) + 1];
  assert.equal(rowValue('project-rule'), '4건', `four project-rule rows did not chart as 4: ${JSON.stringify(lines)}`);
  assert.equal(rowValue('user-preference'), '0건', `an empty type must chart as the server's 0: ${JSON.stringify(lines)}`);
  assert.equal(lines.filter(line => line === '1건').length, 0, `a fabricated per-type 1 is still on the chart: ${JSON.stringify(lines)}`);
  assert.equal(lines.filter(line => line === '0건').length, MEMORY_TYPES.length - 1, `every empty type must read 0건: ${JSON.stringify(lines)}`);
});

test('a status payload that names types without counting them charts 미집계, never 0 or 1', () => {
  const text = chartText({ active:0, superseded:0, quarantined:0, types:MEMORY_TYPES });
  const lines = text.split('\n').filter(line => line !== '');
  const rowValue = type => lines[lines.indexOf(type.slice(0, 16)) + 1];
  for (const type of MEMORY_TYPES) {
    assert.equal(rowValue(type), '미집계', `unreported type ${type} did not stay 미집계: ${JSON.stringify(lines)}`);
  }
  // Only the three state totals carry a figure here; the totals reported as 0 stay
  // visible as 0건 rather than being hidden, and no type row gained a bare count.
  assert.deepEqual(lines.filter(line => /^\d+건$/.test(line)), [],
    `a type count became a number: ${JSON.stringify(lines)}`);
  for (const state of ['활성 0건', '대체됨 0건', '격리 0건']) {
    assert.ok(lines.includes(state), `reported zero ${state} vanished: ${JSON.stringify(lines)}`);
  }
});

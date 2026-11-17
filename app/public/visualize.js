// @ts-check
// Self-contained SVG diagrams for the inspector's 시각화 tab.
// No chart library, no CDN, no network: primitives only, coloured by the theme
// tokens so the same drawing follows light and dark.

const NS = 'http://www.w3.org/2000/svg';

function svgNode(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

const STATE_COLOR = {
  running:'var(--blue)',
  done:'var(--green)',
  failed:'var(--md-sys-tint-e08b80)',
  waiting:'var(--amber)',
  idle:'var(--md-sys-neutral-8a)'
};
const STATE_LABEL = { running:'실행 중', done:'완료', failed:'실패', waiting:'대기', idle:'대기', unknown:'미보고' };

/**
 * The word a state is announced with. Only a reported waiting/idle state reads
 * 대기; an absent or unrecognised state stays 미보고 rather than claiming 대기.
 * @param {string|null|undefined} state
 */
function stateWord(state) {
  const key = String(state ?? '').trim();
  if (!key) return '미보고';
  return STATE_LABEL[key] ?? '미보고';
}

function text(size = 9.5, fill = 'var(--md-sys-neutral-b0)') {
  return { 'font-size':size, fill };
}

let chartSeq = 0;

function nextChartId() {
  chartSeq += 1;
  return `viz-chart-${chartSeq}`;
}

/**
 * A chart is a named group: `<title>` is its concise accessible name and `<desc>`
 * says what the rows below mean. Each row is a `role="listitem"` whose
 * `aria-label` carries the reported values as one sentence, and whose drawing is
 * `aria-hidden`, so the chart exports its data as text instead of announcing only
 * a label (Modern Web Guidance, accessibility §6 "Complex images and charts").
 * @param {SVGElement} root
 * @param {string} name
 * @param {string} description
 */
function nameChart(root, name, description) {
  const id = nextChartId();
  root.setAttribute('role', 'group');
  root.setAttribute('aria-labelledby', `${id}-title`);
  root.setAttribute('aria-describedby', `${id}-desc`);
  const title = svgNode('title', { id:`${id}-title` });
  title.textContent = name;
  const desc = svgNode('desc', { id:`${id}-desc` });
  desc.textContent = description;
  root.append(title, desc);
}

/** A `role="list"` group: the chart's text alternative. */
function chartList(label) {
  return svgNode('g', { role:'list', 'aria-label':label });
}

/** One row of that list; the returned child holds the drawing. */
function chartItem(label) {
  const item = svgNode('g', { role:'listitem', 'aria-label':label });
  const visual = svgNode('g', { 'aria-hidden':'true' });
  item.append(visual);
  return { item, visual };
}

/**
 * Main agent on the left, reported subagents stacked on the right, an edge per
 * dependency. Status is drawn as the node outline plus a short label.
 * @param {SVGElement} root
 * @param {{main:{id:string,name:string,state:string}|null, subagents:{id:string,name:string,state:string,lane:number|null,dependsOn:{label?:string}|null,elapsed?:string|null}[]}} data
 */
export function renderTaskGraph(root, data) {
  root.replaceChildren();
  const subs = data?.subagents ?? [];
  const height = Math.max(90, 54 + subs.length * 42);
  root.setAttribute('viewBox', `0 0 320 ${height}`);
  const laneWord = (lane) => lane != null ? `레인 ${Number(lane) + 1}` : '레인 미보고';
  nameChart(root,
    subs.length
      ? `작업 관계도: 메인 작업 1개에서 갈라진 하위 에이전트 ${subs.length}개`
      : '작업 관계도: 하위 에이전트 없음',
    subs.length
      ? `메인 작업에서 각 하위 에이전트로 의존 관계가 이어집니다. 목록은 메인 작업과 하위 에이전트의 이름·상태·레인을 보고된 값 그대로 나열합니다.`
      : '목록은 메인 작업 하나의 이름과 상태를 보여 줍니다. 보고된 하위 에이전트는 없습니다.');
  const main = data?.main ?? null;
  const g = svgNode('g');
  const edges = svgNode('g', { 'aria-hidden':'true' });
  const items = chartList(subs.length
    ? `메인 작업과 하위 에이전트 ${subs.length}개의 이름·상태·레인`
    : '메인 작업의 이름과 상태');
  g.append(edges, items);
  root.append(g);

  const box = (x, y, w, h, state, label, alt, elapsed = null) => {
    const { item, visual } = chartItem(alt);
    visual.append(svgNode('rect', {
      x, y, width:w, height:h, rx:8,
      fill:'rgb(var(--md-sys-rgb-overlay) / .05)',
      stroke:STATE_COLOR[state] ?? STATE_COLOR.idle,
      'stroke-width':1.4
    }));
    visual.append(svgNode('circle', { cx:x + 11, cy:y + 13, r:3.5, fill:STATE_COLOR[state] ?? STATE_COLOR.idle }));
    const title = svgNode('text', { x:x + 20, y:y + 16.5, ...text(10, 'var(--md-sys-neutral-ed)') });
    title.textContent = String(label ?? '').slice(0, elapsed ? 22 : 20);
    visual.append(title);
    const stateText = svgNode('text', { x:x + 20, y:y + 29, ...text(8.5, 'var(--md-sys-neutral-8f)') });
    stateText.textContent = stateWord(state);
    if (elapsed) stateText.textContent += ` · ${elapsed}`;
    visual.append(stateText);
    items.append(item);
    return visual;
  };

  const mainX = 10, mainW = 116, mainH = 40;
  const mainY = subs.length ? Math.max(8, height / 2 - mainH / 2) : 10;
  const mainName = String(main?.name ?? '메인 작업');
  box(mainX, mainY, mainW, mainH, main?.state, mainName,
    `메인 작업 ${mainName} · 상태 ${stateWord(main?.state)} · 의존 관계의 출발점`);
  if (!subs.length) {
    const note = svgNode('text', { x:136, y:mainY + 22, ...text(9, 'var(--md-sys-neutral-8f)') });
    note.textContent = '보고된 하위 에이전트 없음';
    g.append(note);
  }
  subs.forEach((sub, index) => {
    const x = 176, y = 10 + index * 42, w = 134, h = 36;
    const midY = mainY + mainH / 2;
    const edge = svgNode('path', {
      d:`M ${mainX + mainW} ${midY} C ${mainX + mainW + 22} ${midY}, 158 ${y + h / 2}, ${x} ${y + h / 2}`,
      fill:'none', stroke:'rgb(var(--md-sys-rgb-overlay) / .28)', 'stroke-width':1.1
    });
    edges.append(edge);
    const name = String(sub.name ?? '하위 에이전트');
    const visual = box(x, y, w, h, sub.state, sub.name,
      `하위 에이전트 ${name} · 메인 작업에 의존 · 상태 ${stateWord(sub.state)}${sub.elapsed ? ` · 경과 ${sub.elapsed}` : ''} · ${laneWord(sub.lane)}`,
      sub.elapsed ?? null);
    const lane = svgNode('text', { x:314, y:y + 16, 'text-anchor':'end', ...text(8, 'var(--md-sys-neutral-8a)') });
    lane.textContent = laneWord(sub.lane);
    visual.append(lane);
  });
}

function arc(cx, cy, r, start, end) {
  const a0 = start * Math.PI * 2 - Math.PI / 2;
  const a1 = end * Math.PI * 2 - Math.PI / 2;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${end - start >= .5 ? 1 : 0} 1 ${x1} ${y1}`;
}

/**
 * Per-task token bars. When the DX overview is available it is drawn as a
 * second, clearly labelled series instead of being mixed into the local bars.
 * @param {SVGElement} root
 * @param {{tasks:{name:string,tokens:number|null,cost:number|null}[], dx:{label:string,tokens:number|null,cost:number|null}|null}} data
 */
export function renderCostChart(root, data) {
  root.replaceChildren();
  const tasks = data?.tasks ?? [];
  const rows = tasks.map(task => {
    const name = String(task.name ?? '작업');
    return {
      // The label carries the whole reported identity; only the drawing truncates.
      name,
      label:name.slice(0, 14),
      tokens:Number.isFinite(task.tokens) ? task.tokens : null,
      cost:Number.isFinite(task.cost) ? task.cost : null
    };
  });
  const tokenWord = (tokens) => tokens != null ? `${Math.round(tokens).toLocaleString()} 토큰` : '토큰 미보고';
  const costWord = (cost) => cost != null ? `비용 ${String(cost)}` : '비용 미보고';
  const dx = data?.dx ?? null;
  const height = Math.max(96, 40 + rows.length * 26 + (dx ? 22 : 0));
  root.setAttribute('viewBox', `0 0 320 ${height}`);
  nameChart(root,
    rows.length ? `토큰·비용 막대: 작업 ${rows.length}개의 보고된 사용량` : '토큰·비용 막대: 보고된 작업 없음',
    '막대 길이는 작업별 토큰과 비용의 상대 크기입니다. 목록은 작업별로 보고된 토큰과 비용을 값 그대로 나열하며, 보고되지 않은 값은 0이 아니라 미보고로 남깁니다.'
      + (dx ? ` 외부 누적값은 별도 행(${dx.label})으로 보고된 값만 표시합니다.` : ''));
  const g = svgNode('g');
  const items = chartList(rows.length ? `작업 ${rows.length}개의 이름·토큰·비용` : '보고된 토큰·비용 값 없음');
  g.append(items);
  root.append(g);
  const maxTokens = Math.max(1, ...rows.map(row => row.tokens ?? 0));
  const maxCost = Math.max(0.0001, ...rows.map(row => row.cost ?? 0));
  const left = 70, width = 216;
  rows.forEach((row, index) => {
    const y = 14 + index * 26;
    const { item, visual } = chartItem(`${row.name} · ${tokenWord(row.tokens)} · ${costWord(row.cost)}`);
    const label = svgNode('text', { x:2, y:y + 10, ...text(8.5, 'var(--md-sys-neutral-a0)') });
    label.textContent = row.label;
    visual.append(label);
    visual.append(svgNode('rect', { x:left, y, width, height:9, rx:3, fill:'rgb(var(--md-sys-rgb-overlay) / .06)' }));
    if (row.tokens != null) {
      const tokenWidth = Math.max(1, (row.tokens / maxTokens) * width * 0.62);
      visual.append(svgNode('rect', { x:left, y, width:tokenWidth, height:9, rx:3, fill:'var(--blue)' }));
    }
    if (row.cost != null) {
      const costWidth = Math.max(1, (row.cost / maxCost) * width * 0.3);
      visual.append(svgNode('rect', { x:left + 2, y:y + 11, width:costWidth, height:4, rx:2, fill:'var(--amber)' }));
    }
    const value = svgNode('text', { x:314, y:y + 10, 'text-anchor':'end', ...text(8.5, 'var(--md-sys-neutral-ca)') });
    value.textContent = row.tokens != null ? `${Math.round(row.tokens).toLocaleString()} 토큰` : '미보고';
    visual.append(value);
    items.append(item);
  });
  const legendY = 14 + rows.length * 26 + 6;
  const legend = svgNode('g', { 'aria-hidden':'true' });
  const token = svgNode('text', { x:left, y:legendY, ...text(8, 'var(--blue)') });
  token.textContent = '■ 토큰';
  const cost = svgNode('text', { x:left + 52, y:legendY, ...text(8, 'var(--amber)') });
  cost.textContent = '■ 비용';
  legend.append(token, cost);
  g.append(legend);
  if (dx) {
    const { item, visual } = chartItem(`외부 누적 ${dx.label} · ${tokenWord(dx.tokens)} · ${costWord(dx.cost)}`);
    const dxText = svgNode('text', { x:314, y:legendY, 'text-anchor':'end', ...text(8, 'var(--md-sys-neutral-8f)') });
    dxText.textContent = dx.label;
    visual.append(dxText);
    items.append(item);
  }
}

/**
 * Turn `/api/memory/status` into the chart's rows. `typeBreakdown` (or its map form
 * `typeCounts`) is the server's own per-type aggregate; a type the server only names
 * stays `null` so the chart prints 미집계 instead of inventing a figure. A state total
 * the payload omits stays `null` too: missing is 미보고, not 0, while a reported 0
 * stays 0 and is drawn.
 * @param {any} status
 */
export function memoryChartData(status) {
  const rows = Array.isArray(status?.typeBreakdown)
    ? status.typeBreakdown
    : status?.typeCounts && typeof status.typeCounts === 'object'
      ? Object.entries(status.typeCounts).map(([type, count]) => ({ type, count }))
      : null;
  const types = rows
    ? rows.filter(row => row && row.type)
      .map(row => ({ type:String(row.type), count:row.count === null || row.count === undefined ? null : Number.isFinite(Number(row.count)) ? Math.max(0, Number(row.count)) : null }))
    : (Array.isArray(status?.types) ? status.types : []).map(type => ({ type:String(type), count:null }));
  return {
    active:countOrNull(status?.active),
    superseded:countOrNull(status?.superseded),
    quarantined:countOrNull(status?.quarantined),
    types,
  };
}

/**
 * A count as the source reported it: absent or unparseable stays `null`, a
 * reported 0 stays 0. Missing is not zero.
 * @param {unknown} value
 */
function countOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : null;
}

/**
 * Active / superseded / quarantined donut plus a type bar list.
 * A type the server listed without a figure stays uncounted: it renders 미집계,
 * never a 0 or a made-up bar. A state total the payload omitted renders 미보고,
 * while an explicitly reported 0 renders 0건.
 * @param {SVGElement} root
 * @param {{active:number|null,superseded:number|null,quarantined:number|null,types:{type:string,count:number|null}[]}} data
 */
export function renderMemoryChart(root, data) {
  root.replaceChildren();
  const states = [
    { label:'활성', value:countOrNull(data?.active), color:'var(--green)' },
    { label:'대체됨', value:countOrNull(data?.superseded), color:'var(--md-sys-neutral-7c)' },
    { label:'격리', value:countOrNull(data?.quarantined), color:'var(--amber)' },
  ];
  const reportedStates = states.filter(state => state.value !== null);
  const total = reportedStates.reduce((sum, state) => sum + state.value, 0);
  const allStatesReported = reportedStates.length === states.length;
  const types = (Array.isArray(data?.types) ? data.types : [])
    .filter(item => item && item.type)
    .map(item => ({ type:String(item.type), count:Number.isFinite(item.count) ? Math.max(0, item.count) : null }));
  const counted = types.filter(item => item.count !== null);
  const max = Math.max(1, ...counted.map(item => item.count));
  const countWord = (item) => item.count !== null ? `${item.count}건` : '미집계';
  const stateWord = (state) => state.value !== null ? `${state.value}건` : '미보고';
  const g = svgNode('g');
  root.append(g);
  if (!reportedStates.length && !types.length) {
    nameChart(root, '메모리 구성: 보고된 현황 없음', '메모리 저장소가 상태와 유형별 건수를 보고하지 않았습니다. 수치를 지어내지 않고 미보고로 남깁니다.');
    const note = svgNode('text', { x:10, y:40, ...text(9.5, 'var(--md-sys-neutral-8f)') });
    note.textContent = '메모리 현황 미보고';
    g.append(note);
    return;
  }
  nameChart(root,
    `메모리 구성: 활성·대체됨·격리 합계와 유형 ${types.length}종`,
    '도넛은 상태별 합계를, 막대는 유형별 건수를 그립니다. 목록은 상태별 합계와 유형별 건수를 서버가 보고한 값 그대로 나열합니다. 서버가 보고하지 않은 상태 합계는 미보고, 세지 않은 유형은 미집계로 남기며, 보고된 0은 0건으로 그대로 보입니다.');
  const items = chartList('메모리 상태별 합계와 유형별 건수');
  g.append(items);
  if (allStatesReported && total > 0) {
    const cx = 62, cy = 54, r = 34;
    let start = 0;
    for (const state of states) {
      if (!state.value) continue;
      const end = start + state.value / total;
      g.append(svgNode('path', { d:arc(cx, cy, r, start, end), fill:'none', stroke:state.color, 'stroke-width':10, 'stroke-linecap':'butt' }));
      start = end;
    }
  }
  states.forEach((state, index) => {
    const y = 20 + index * 22;
    const { item:row, visual } = chartItem(`상태 ${state.label} ${stateWord(state)}`);
    visual.append(svgNode('rect', { x:126, y:y - 7, width:7, height:7, rx:2, fill:state.color }));
    const label = svgNode('text', { x:138, y, ...text(9, 'var(--md-sys-neutral-b8)') });
    label.textContent = `${state.label} ${stateWord(state)}`;
    visual.append(label);
    items.append(row);
  });
  const typeTop = 20 + states.length * 22;
  root.setAttribute('viewBox', `0 0 320 ${Math.max(96, typeTop + (types.length ? types.length * 16 : 0))}`);
  types.forEach((item, index) => {
    const y = typeTop + index * 16;
    const { item:row, visual } = chartItem(`유형 ${item.type} ${countWord(item)}`);
    const label = svgNode('text', { x:10, y:y + 8, ...text(8.5, 'var(--md-sys-neutral-9a)') });
    label.textContent = item.type.slice(0, 16);
    visual.append(label);
    const countedHere = item.count !== null;
    visual.append(svgNode('rect', { x:118, y, width:countedHere ? (item.count > 0 ? Math.max(2, (item.count / max) * 150) : 0) : 150, height:8, rx:3, fill:countedHere ? 'rgb(var(--md-sys-rgb-blue) / .5)' : 'none', stroke:countedHere ? 'none' : 'rgb(var(--md-sys-rgb-overlay) / .18)' }));
    const count = svgNode('text', { x:274, y:y + 8, 'text-anchor':'end', ...text(8.5, 'var(--md-sys-neutral-a0)') });
    count.textContent = countWord(item);
    visual.append(count);
    items.append(row);
  });
}

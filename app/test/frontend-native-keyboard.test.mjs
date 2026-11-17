// Genuine browser keyboard activation, driven through the Chrome DevTools Protocol over
// --remote-debugging-pipe (Node built-ins only, no new dependency). Input.dispatchKeyEvent
// produces trusted key events, so Enter/Space reach a focused button as the browser's own
// activation ??the native click a synthetic in-page KeyboardEvent never triggers.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../server.mjs';

// Any Chromium-family browser dispatches these trusted key events, so an explicitly set
// CHROME_PATH wins and otherwise the standard install locations of Chrome, Edge and
// Chromium are searched at runtime ??the skip then names the one thing really missing.
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

const chromePath = browserCandidates().find(path => path && existsSync(path));

async function launch() {
  const profile = await mkdtemp(join(tmpdir(), 'omp-native-keyboard-'));
  const child = spawn(chromePath, [
    '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--window-size=1440,900', `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let nextId = 0;
  let buffer = '';
  const pending = new Map();
  child.stdio[4].on('data', chunk => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  const { targetInfos } = await send('Target.getTargets');
  const { sessionId } = await send('Target.attachToTarget', { targetId: targetInfos.find(info => info.type === 'page').targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const evaluate = async expression => {
    const { result, exceptionDetails } = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const keys = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }
  };
  const press = async (name, modifiers = 0) => {
    const key = { ...keys[name], nativeVirtualKeyCode: keys[name].windowsVirtualKeyCode, modifiers };
    await page('Input.dispatchKeyEvent', { type: 'keyDown', ...key, unmodifiedText: key.text });
    await page('Input.dispatchKeyEvent', { type: 'keyUp', ...key, text: undefined });
  };
  const mouse = async (type, x, y) => page('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  const navigate = async url => {
    await page('Page.navigate', { url });
    await until(`document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`, `load of ${url}`);
  };
  const close = async () => {
    await send('Browser.close').catch(() => {});
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  const touch = async (x, y) => {
    await page('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const viewport = (width, height = 800) => page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page('Page.enable');
  // A headless background target never holds OS focus; emulate it so focus events fire as in a real window.
  await page('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { evaluate, until, press, mouse, touch, viewport, navigate, close };
}

const skip = chromePath ? false
  : 'No Chromium-family browser (Chrome, Edge or Chromium) found at a standard install location and CHROME_PATH is unset, so trusted native key events cannot be dispatched';

test('Design mode: native Enter/Space activation stays native, Alt+Enter inspects the focused control after pointer movement, a pointer press inspects', { skip }, async () => {
  const bridge = await createBridge({ mock: true });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await browser.navigate(`${baseUrl}/preview/index.html`);
    const other = await browser.evaluate(`(async () => {
      document.body.innerHTML = '<button id="probe">踰꾪듉</button> <button id="other">?ㅻⅨ 踰꾪듉</button>';
      window.__log = { probe: 0, other: 0, selected: [] };
      document.getElementById('probe').addEventListener('click', () => __log.probe++);
      document.getElementById('other').addEventListener('click', () => __log.other++);
      addEventListener('message', event => { if (event.data?.type === 'omp:element-selected') __log.selected.push(event.data.selector); });
      if (!window.__ompInspector) await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/preview-inspector.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('preview-inspector.js did not load'));
        document.documentElement.append(script);
      });
      postMessage({ type: 'omp:design-mode', enabled: true }, location.origin);
      await new Promise(resolve => setTimeout(resolve, 50));
      const box = document.getElementById('other').getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    const log = () => browser.evaluate('JSON.parse(JSON.stringify(__log))');

    await browser.evaluate(`document.getElementById('probe').focus()`);
    await browser.press('Enter');
    await browser.press('Space');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await log(), { probe: 2, other: 0, selected: [] }, 'Native Enter/Space on a focused button must activate it, not inspect it');

    await browser.mouse('mouseMoved', other.x, other.y);
    await browser.press('Enter', 1 /* Alt */);
    await browser.until('__log.selected.length === 1', 'the Alt+Enter inspection');
    assert.deepEqual(await log(), { probe: 2, other: 0, selected: ['#probe'] }, 'Alt+Enter must inspect the focused control, not the one under the pointer, and not activate it');

    await browser.mouse('mousePressed', other.x, other.y);
    await browser.mouse('mouseReleased', other.x, other.y);
    await browser.until('__log.selected.length === 2', 'the pointer inspection');
    assert.deepEqual(await log(), { probe: 2, other: 0, selected: ['#probe', '#other'] }, 'A pointer click must inspect the pressed control instead of activating it');
  } finally {
    await browser.close();
    await bridge.close();
  }
});



/** A dialog's own modal state: open, in the top layer. */
const sheetState = id => `(() => {
  const box = document.getElementById(${JSON.stringify(id)});
  return { open: box.open, modal: box.matches(':modal') };
})()`;

async function openApp(browser, baseUrl) {
  await browser.navigate(`${baseUrl}/`);
  await browser.until(`!!document.getElementById('prompt') && !!document.getElementById('sidebar') && !!document.getElementById('inspector')`, 'the app shell');
}

test('Theme studio: seven presets, and a real Space re-tones the shell without losing focus', { skip }, async () => {
  const bridge = await createBridge({ mock: true });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await openApp(browser, baseUrl);
    await browser.evaluate(`document.getElementById('theme-toggle').focus()`);
    await browser.press('Enter');
    await browser.until(`document.getElementById('theme-studio').open`, 'the theme studio to open');
    assert.equal(await browser.evaluate(`document.querySelectorAll('#studio-presets .preset-card').length`), 7, 'the theme studio offers its seven presets');
    assert.equal(await browser.evaluate(`document.getElementById('theme-toggle').getAttribute('aria-expanded')`), 'true', 'the trigger reports the open dialog');

    await browser.evaluate(`document.querySelector('#studio-presets .preset-card[data-preset=maritime]').focus()`);
    await browser.press('Space');
    assert.deepEqual(await browser.evaluate(`(() => {
      const card = document.querySelector('#studio-presets .preset-card[data-preset=maritime]');
      return { checked: card.getAttribute('aria-checked'), theme: document.documentElement.dataset.theme, focused: document.activeElement.dataset.preset };
    })()`), { checked:'true', theme:'maritime', focused:'maritime' }, 'Space on a preset selects it, re-tones the shell and leaves focus on the preset');
    assert.equal(await browser.evaluate(`getComputedStyle(document.documentElement).colorScheme`), 'dark', 'the maritime preset must declare a dark colour scheme');
  } finally {
    await browser.close();
    await bridge.close();
  }
});

test('The theme studio is a native modal: Escape closes it and returns focus to the header trigger', { skip }, async () => {
  const bridge = await createBridge({ mock: true });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await openApp(browser, baseUrl);
    await browser.evaluate(`document.getElementById('theme-toggle').focus()`);
    await browser.press('Enter');
    await browser.until(`document.getElementById('theme-studio').open`, 'the theme studio to open');
    assert.deepEqual(await browser.evaluate(sheetState('theme-studio')), { open: true, modal: true }, 'the theme studio must be a modal dialog');
    await browser.press('Escape');
    await browser.until(`!document.getElementById('theme-studio').open`, 'Escape to close the theme studio');
    // The dialog's close event and the browser's focus return both land after `open` flips false.
    await browser.until(`document.activeElement.id === 'theme-toggle' && document.getElementById('theme-toggle').getAttribute('aria-expanded') === 'false'`,
      'focus and the closed state to return to the theme toggle');
  } finally {
    await browser.close();
    await bridge.close();
  }
});

test('1280 layout keeps the three columns: 260 sidebar, 364 inspector, conversation between them', { skip }, async () => {
  const bridge = await createBridge({ mock: true });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await browser.viewport(1280, 720);
    await openApp(browser, baseUrl);
    const layout = await browser.evaluate(`(() => {
      const width = id => Math.round(document.getElementById(id).getBoundingClientRect().width);
      return {
        sidebar: width('sidebar'),
        inspector: width('inspector'),
        thread: width('thread'),
        sidebarPressed: document.getElementById('toggle-sidebar').getAttribute('aria-pressed'),
        inspectorPressed: document.getElementById('toggle-inspector').getAttribute('aria-pressed'),
        overflow: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth
      };
    })()`);
    assert.equal(layout.sidebar, 260, 'the sidebar keeps its 260px column');
    assert.equal(layout.inspector, 364, 'the inspector keeps its 364px column');
    assert.ok(layout.thread >= 556, `the conversation column must keep >= 556px at 1280: ${layout.thread}`);
    assert.equal(layout.sidebarPressed, 'true', 'both side panels start open');
    assert.equal(layout.inspectorPressed, 'true', 'both side panels start open');
    assert.equal(layout.overflow, false, 'the 1280 shell must not scroll horizontally');

    await browser.evaluate(`document.getElementById('toggle-inspector').click()`);
    assert.deepEqual(await browser.evaluate(`(() => ({
      pressed: document.getElementById('toggle-inspector').getAttribute('aria-pressed'),
      width: Math.round(document.getElementById('inspector').getBoundingClientRect().width)
    }))()`), { pressed:'false', width:0 }, 'the header toggle closes the inspector column');
    await browser.evaluate(`document.getElementById('toggle-sidebar').click()`);
    assert.deepEqual(await browser.evaluate(`(() => ({
      pressed: document.getElementById('toggle-sidebar').getAttribute('aria-pressed'),
      width: Math.round(document.getElementById('sidebar').getBoundingClientRect().width)
    }))()`), { pressed:'false', width:0 }, 'the header toggle closes the sidebar column');
  } finally {
    await browser.close();
    await bridge.close();
  }
});

test('Approval gate: role=alert, the title takes focus, and answering returns focus to the composer', { skip }, async () => {
  // The page only sends when a local upstream answers, so the gate test needs a
  // served local slot: a loopback model-list stub is enough for /api/config.
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ object:'list', data:[{ id:'stub-7b', object:'model' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${upstream.address().port}/v1`;
  const bridge = await createBridge({ mock: true, config:{ local:{ label:'stub', provider:'openai', model:'stub-7b', endpoint } } });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await openApp(browser, baseUrl);
    // The restored shell sends only on a consented route: the header toggle is the one consent control.
    await browser.evaluate(`document.getElementById('consent-toggle').click()`);
    await browser.until(`!document.getElementById('send').disabled`, 'a consented route with a served local slot');
    await browser.evaluate(`document.getElementById('prompt').value = '/approval'; document.getElementById('composer').requestSubmit();`);
    await browser.until(`!document.getElementById('approvals').hidden && document.activeElement.id === 'gate-title'`, 'the gate to take focus');
    // The restored gate sits in the conversation column and leaves the composer in place.
    assert.deepEqual(await browser.evaluate(`(() => ({
      role: document.getElementById('gate').getAttribute('role'),
      label: document.getElementById('approval-approve').textContent,
      deny: document.getElementById('approval-deny').textContent
    }))()`), { role:'alert', label:'승인', deny:'거절' },
      'the gate is an alert answered with exactly 승인 and 거절');
    await browser.evaluate(`document.getElementById('approval-approve').focus()`);
    await browser.press('Enter');
    await browser.until(`document.getElementById('approvals').hidden`, 'the answered gate to clear');
    assert.equal(await browser.evaluate(`document.activeElement.id`), 'prompt', 'focus returns to the composer after the answer');
  } finally {
    await browser.close();
    await bridge.close();
    upstream.close();
  }
});

// The example chips were part of the discarded rail/dock redesign; the restored shell has no
// suggested-prompt surface, so this test had no product behaviour left to measure.

test('Session list: keyboard activation of a recent task switches the active session', { skip }, async () => {
  const bridge = await createBridge({ mock: true });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await openApp(browser, baseUrl);
    await browser.evaluate(`document.getElementById('new-session').click()`);
    await browser.until(`document.querySelectorAll('#recent-list .recent-sub[data-session-key]').length >= 2`, 'two sessions in the recent list');
    const key = await browser.evaluate(`document.querySelectorAll('#recent-list .recent-sub[data-session-key]')[1].dataset.sessionKey`);
    await browser.evaluate(`document.querySelectorAll('#recent-list .recent-sub[data-session-key]')[1].focus()`);
    await browser.press('Enter');
    await browser.until(`document.querySelector('#recent-list .recent-sub[aria-current="true"]')?.dataset.sessionKey === ${JSON.stringify(key)}`, 'the activated session row');
    assert.deepEqual(await browser.evaluate(`(() => ({
      active: document.querySelectorAll('#recent-list .recent-sub[aria-current="true"]').length,
      focused: document.activeElement.dataset.sessionKey
    }))()`), { active:1, focused:key },
      'choosing a task marks exactly one active row and leaves focus in the list');
  } finally {
    await browser.close();
    await bridge.close();
  }
});

test('Sidebar first: five menu entries with Korean names, and a keyboard activation opens what it names', { skip }, async () => {
  const bridge = await createBridge({ mock: true });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await openApp(browser, baseUrl);
    const menu = await browser.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.menu .menu-row')];
      return { count: rows.length, labels: rows.map(row => row.querySelector('span').textContent.trim()) };
    })()`);
    assert.deepEqual(menu, { count:5, labels:['새 작업', '검색', '에이전트 목록', '메모리', '더 보기'] },
      'the sidebar is five menu entries with Korean accessible names');
    await browser.evaluate(`document.getElementById('menu-search').focus()`);
    await browser.press('Enter');
    await browser.until(`!document.getElementById('search-bar').hidden && document.activeElement.id === 'search-input'`, 'the search field to take focus');
  } finally {
    await browser.close();
    await bridge.close();
  }
});


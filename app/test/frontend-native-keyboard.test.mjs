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
  await browser.until(`!!document.getElementById('prompt') && !!document.getElementById('rail-safety')`, 'the app shell');
}

test('Settings sheet: exactly three theme modes, no sliders, and a real key press re-tones the shell', { skip }, async () => {
  const bridge = await createBridge({ mock: true });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await openApp(browser, baseUrl);
    await browser.evaluate(`document.getElementById('rail-settings').focus()`);
    await browser.press('Enter');
    await browser.until(`document.getElementById('sheet-settings').open`, 'the settings sheet to open');
    assert.equal(await browser.evaluate(`document.querySelectorAll('#theme-modes input[type=radio]').length`), 3, 'the theme control is exactly three modes');
    assert.equal(await browser.evaluate(`document.querySelectorAll('#settings-body input[type=range]').length`), 0, 'no slider belongs in this app');

    await browser.evaluate(`document.querySelector('#theme-modes input[value=daylight]').focus()`);
    await browser.press('Space');
    assert.deepEqual(await browser.evaluate(`(() => {
      const input = document.querySelector('#theme-modes input[value=daylight]');
      return { checked: input.checked, theme: document.documentElement.dataset.theme, focused: document.activeElement === input };
    })()`), { checked: true, theme: 'daylight', focused: true }, 'Space on a theme radio selects it, re-tones the shell and leaves focus on it');
    assert.equal(await browser.evaluate(`getComputedStyle(document.documentElement).colorScheme`), 'light', 'the light theme must declare a light colour scheme');
  } finally {
    await browser.close();
    await bridge.close();
  }
});

test('Sheets are native modals: Escape closes and returns focus to the rail trigger', { skip }, async () => {
  const bridge = await createBridge({ mock: true });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await openApp(browser, baseUrl);
    for (const [trigger, sheet] of [['rail-safety', 'sheet-safety'], ['rail-tasks', 'sheet-tasks'], ['rail-settings', 'sheet-settings']]) {
      await browser.evaluate(`document.getElementById(${JSON.stringify(trigger)}).focus()`);
      await browser.press('Enter');
      await browser.until(`document.getElementById(${JSON.stringify(sheet)}).open`, `the ${sheet} to open`);
      assert.deepEqual(await browser.evaluate(sheetState(sheet)), { open: true, modal: true }, `the ${sheet} must be a modal dialog`);
      await browser.press('Escape');
      await browser.until(`!document.getElementById(${JSON.stringify(sheet)}).open`, `Escape to close the ${sheet}`);
      assert.equal(await browser.evaluate(`document.activeElement.id`), trigger, `closing the ${sheet} must return focus to ${trigger}`);
      await browser.press('Tab');
      assert.notEqual(await browser.evaluate(`document.activeElement.tagName`), 'BODY', `Tab after closing the ${sheet} landed on <body>`);
    }
  } finally {
    await browser.close();
    await bridge.close();
  }
});

test('1280 layout keeps the conversation column and never opens the dock by itself', { skip }, async () => {
  const bridge = await createBridge({ mock: true });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await browser.viewport(1280, 720);
    await openApp(browser, baseUrl);
    const closed = await browser.evaluate(`(() => {
      const dock = document.getElementById('dock').getBoundingClientRect();
      const thread = document.getElementById('thread').getBoundingClientRect();
      return {
        dockWidth: Math.round(dock.width),
        threadWidth: Math.round(thread.width),
        dockOpen: document.body.dataset.dock === 'open',
        rail: Math.round(document.querySelector('.rail').getBoundingClientRect().width),
        header: Math.round(document.getElementById('top-head').getBoundingClientRect().height),
        strip: Math.round(document.getElementById('status-bar').getBoundingClientRect().height),
        overflow: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth
      };
    })()`);
    assert.equal(closed.dockOpen, false, 'a result must not open the dock by itself at 1280 (P-5)');
    assert.equal(closed.dockWidth, 0, 'a closed dock takes no width');
    assert.equal(closed.rail, 56, 'the rail is 56px');
    assert.ok(closed.header === 48 && closed.strip === 36, `header 48 and strip 36 are the contract: ${closed.header}/${closed.strip}`);
    assert.ok(closed.threadWidth >= 738, `the conversation column must keep >= 738px at 1280: ${closed.threadWidth}`);
    assert.equal(closed.overflow, false, 'the 1280 shell must not scroll horizontally');
  } finally {
    await browser.close();
    await bridge.close();
  }
});

test('Approval gate: role=alert, the title takes focus, and it replaces the composer until answered', { skip }, async () => {
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
    await browser.until(`!document.getElementById('send').disabled`, 'a served local slot');
    await browser.evaluate(`document.getElementById('prompt').value = '/approval'; document.getElementById('composer').requestSubmit();`);
    await browser.until(`!document.getElementById('approvals').hidden && document.activeElement.id === 'gate-title'`, 'the gate to take focus');
    assert.deepEqual(await browser.evaluate(`(() => ({
      role: document.getElementById('gate').getAttribute('role'),
      composerHidden: document.getElementById('composer').hidden,
      title: document.title.startsWith('\u25CF '),
      status: document.getElementById('head-status-label').textContent,
      label: document.getElementById('approval-approve').textContent,
      bar: document.getElementById('composer-blocked').hidden ? null : document.getElementById('composer-blocked').textContent
    }))()`), { role:'alert', composerHidden:true, title:true, status:'답변 기다리는 중', label:'승인', bar:'승인을 마치면 다시 요청할 수 있습니다.' },
      'the gate is an alert, replaces the composer, marks the title and states one status');
    await browser.evaluate(`document.getElementById('approval-approve').focus()`);
    await browser.press('Enter');
    await browser.until(`document.getElementById('approvals').hidden`, 'the answered gate to clear');
    assert.equal(await browser.evaluate(`document.getElementById('composer').hidden`), false, 'answering returns the composer to its place');
    assert.equal(await browser.evaluate(`document.activeElement.id`), 'prompt', 'focus returns to the composer after the answer');
    assert.equal(await browser.evaluate(`document.title.startsWith('\u25CF ')`), false, 'the pending mark leaves the title');
  } finally {
    await browser.close();
    await bridge.close();
    upstream.close();
  }
});

test('Example chips fill the composer on a keyboard activation and leave focus in the input', { skip }, async () => {
  const bridge = await createBridge({ mock: true });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await openApp(browser, baseUrl);
    const expected = await browser.evaluate(`document.querySelector('.example').dataset.example`);
    await browser.evaluate(`document.querySelector('.example').focus()`);
    await browser.press('Enter');
    assert.deepEqual(await browser.evaluate(`(() => ({ value: document.getElementById('prompt').value, focused: document.activeElement.id }))()`),
      { value: expected, focused: 'prompt' }, 'an example fills the prompt and hands focus to it');
  } finally {
    await browser.close();
    await bridge.close();
  }
});

test('Task sheet: choosing another task closes the sheet and leaves the composer focused', { skip }, async () => {
  const bridge = await createBridge({ mock: true });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await openApp(browser, baseUrl);
    await browser.evaluate(`document.getElementById('rail-new').click()`);
    await browser.until(`document.getElementById('rail-task-count').hidden === false`, 'two sessions');
    await browser.evaluate(`document.getElementById('rail-tasks').click()`);
    await browser.until(`document.getElementById('sheet-tasks').open && document.querySelectorAll('#tasks-body .task-row[data-session-key]').length >= 2`, 'the task rows');
    await browser.evaluate(`document.querySelectorAll('#tasks-body .task-row[data-session-key]')[1].focus()`);
    await browser.press('Enter');
    await browser.until(`!document.getElementById('sheet-tasks').open`, 'the sheet to close on activation');
    assert.deepEqual(await browser.evaluate(`(() => ({ focused: document.activeElement.id }))()`), { focused:'prompt' },
      'choosing a task closes the sheet and leaves the composer focused');
  } finally {
    await browser.close();
    await bridge.close();
  }
});

test('Rail first: five working rail entries with Korean names, and the composer owns the initial focus', { skip }, async () => {
  const bridge = await createBridge({ mock: true });
  const baseUrl = await bridge.start(0);
  const browser = await launch();
  try {
    await openApp(browser, baseUrl);
    const rail = await browser.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.rail .rail-btn')];
      return { count: buttons.length, disabled: buttons.filter(b => b.disabled).length, labels: buttons.map(b => b.getAttribute('aria-label')) };
    })()`);
    assert.deepEqual(rail, { count:5, disabled:0, labels:['새 작업','작업 목록','결과','안전','설정'] },
      'the rail is five working entries with Korean accessible names');
    assert.equal(await browser.evaluate(`document.activeElement.id`), 'prompt', 'the page loads with the composer focused');
    assert.equal(await browser.evaluate(`document.getElementById('hero-note').textContent`), '무엇을 만들지 한국어로 적어 주세요.',
      'the first screen states the one instruction');
  } finally {
    await browser.close();
    await bridge.close();
  }
});


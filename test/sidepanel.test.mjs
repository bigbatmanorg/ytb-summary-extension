import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Fake chrome.sidePanel that models per-tab options over a global default.
function fakeChrome() {
  const calls = [];
  const tabOpts = new Map();
  let global = { enabled: true, path: 'src/panel/panel.html' };
  const listeners = { clicked: [], connect: [], updated: [], removed: [] };
  const ev = (k) => ({ addListener: (f) => listeners[k].push(f) });
  return {
    calls, tabOpts, listeners,
    get global() { return global; },
    sidePanel: {
      setPanelBehavior: async (b) => { calls.push(['behavior', b]); },
      setOptions: async (o) => {
        calls.push(['setOptions', o]);
        if (o.tabId == null) global = { ...global, ...o };
        else tabOpts.set(o.tabId, { ...(tabOpts.get(o.tabId) || {}), ...o });
      },
      getOptions: async ({ tabId }) => ({ ...global, ...(tabOpts.get(tabId) || {}) }),
      open: async (o) => { calls.push(['open', o]); },
    },
    action: { onClicked: ev('clicked') },
    runtime: { onConnect: ev('connect') },
    tabs: { onUpdated: ev('updated'), onRemoved: ev('removed') },
  };
}

function fakePort(name) {
  const onDisc = [];
  return { name, onDisconnect: { addListener: (f) => onDisc.push(f) }, onMessage: { addListener() {} }, disconnect: () => onDisc.forEach((f) => f()) };
}

const sp = await import('../src/sidepanel.js');
let chrome;
beforeEach(() => {
  chrome = fakeChrome();
  globalThis.chrome = chrome;
  sp.openTabs.clear();
});
const shownOn = (tabId) => ({ ...chrome.global, ...(chrome.tabOpts.get(tabId) || {}) }).enabled;

test('defaults: panel disabled globally, icon click not auto-opening', async () => {
  await sp.initPanelDefaults();
  assert.deepEqual(chrome.calls, [['behavior', { openPanelOnActionClick: false }], ['setOptions', { enabled: false }]]);
  assert.equal(shownOn(1), false);
});

test('first click enables the panel for that tab only and opens it synchronously', async () => {
  await sp.initPanelDefaults();
  chrome.calls.length = 0;
  const p = sp.togglePanel(7);
  // Both calls happen before any await (user gesture requirement).
  assert.deepEqual(chrome.calls, [
    ['setOptions', { tabId: 7, path: 'src/panel/panel.html?tabId=7', enabled: true }],
    ['open', { tabId: 7 }],
  ]);
  await p;
  assert.equal(shownOn(7), true);
  assert.equal(shownOn(8), false, 'other tab (or window) does not get the panel');
});

test('second click on the same tab closes it; a third reopens', async () => {
  await sp.initPanelDefaults();
  await sp.togglePanel(7);
  sp.registerPanelPort(fakePort('panel:7')); // the panel page connects on load
  assert.ok(sp.openTabs.has(7));
  chrome.calls.length = 0;
  await sp.togglePanel(7);
  assert.deepEqual(chrome.calls, [['setOptions', { tabId: 7, enabled: false }]]);
  assert.equal(shownOn(7), false);
  assert.equal(sp.openTabs.has(7), false);
  await sp.togglePanel(7);
  assert.equal(shownOn(7), true);
});

test('panel closed by the user (X button) -> next click opens again', async () => {
  await sp.togglePanel(3);
  const port = fakePort('panel:3');
  sp.registerPanelPort(port);
  port.disconnect(); // panel document went away
  chrome.calls.length = 0;
  sp.togglePanel(3);
  assert.equal(chrome.calls.at(-1)[0], 'open');
});

test('navigating off a video closes the panel; another video keeps it', async () => {
  await sp.initPanelDefaults();
  await sp.togglePanel(5);
  sp.registerPanelPort(fakePort('panel:5'));
  await sp.onTabUrlChanged(5, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  assert.equal(shownOn(5), true);
  await sp.onTabUrlChanged(5, 'https://www.youtube.com/');
  assert.equal(shownOn(5), false);
  assert.equal(sp.openTabs.has(5), false);
});

test('navigation close also works when the panel is enabled but not registered (worker restart)', async () => {
  await sp.initPanelDefaults();
  await sp.togglePanel(9);
  await sp.onTabUrlChanged(9, 'https://example.com/');
  assert.equal(shownOn(9), false);
  // Untouched tabs get no per-tab options written.
  await sp.onTabUrlChanged(10, 'https://example.com/');
  assert.equal(chrome.tabOpts.has(10), false);
});

test('installPanelHandlers wires click, port, navigation and tab removal', async () => {
  sp.installPanelHandlers();
  chrome.listeners.clicked[0]({ id: 4 });
  assert.deepEqual(chrome.calls.at(-1), ['open', { tabId: 4 }]);
  chrome.listeners.connect[0](fakePort('panel:4'));
  assert.ok(sp.openTabs.has(4));
  chrome.listeners.connect[0](fakePort('something-else'));
  chrome.listeners.removed[0](4);
  assert.equal(sp.openTabs.has(4), false);
});

test('isWatchUrl', () => {
  assert.ok(sp.isWatchUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'));
  assert.ok(sp.isWatchUrl('https://m.youtube.com/shorts/dQw4w9WgXcQ'));
  assert.equal(sp.isWatchUrl('https://www.youtube.com/results?search_query=x'), false);
  assert.equal(sp.isWatchUrl('https://evil.example/watch?v=x&youtube.com'), false);
  assert.equal(sp.isWatchUrl('chrome://newtab'), false);
});

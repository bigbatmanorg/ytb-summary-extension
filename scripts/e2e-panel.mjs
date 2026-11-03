// Headless check that the side panel is tab-scoped and the toolbar icon toggles it.
//
//   node scripts/e2e-panel.mjs
//
// Clicks the real toolbar action through the DevTools protocol
// (Extensions.triggerAction, which carries a user gesture like a real click) and
// inspects which side-panel documents exist (chrome.runtime.getContexts) and what
// each tab's panel options are (chrome.sidePanel.getOptions).
import { chromium } from 'playwright';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// --ext DIR tests another checkout (e.g. an older release) instead of this one.
const extArg = process.argv.indexOf('--ext');
const root = extArg > 0 ? resolve(process.argv[extArg + 1]) : resolve(import.meta.dirname, '..');
const extDir = mkdtempSync(join(tmpdir(), 'ytsum-ext-'));
for (const p of ['manifest.json', 'src', 'icons']) cpSync(join(root, p), join(extDir, p), { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'ytsum-profile-'));

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--enable-unsafe-extension-debugging', '--mute-audio'],
});
const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await context.waitForEvent('page', { predicate: (p) => p.url().includes('options.html'), timeout: 5000 }).catch(() => {});
for (const p of context.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

async function tabIdOf(page) {
  const url = page.url();
  return sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u || t.pendingUrl === u)?.id, url);
}
// Extensions.* is a browser-level domain; the tab is addressed by its target id.
const browserCdp = await context.browser().newBrowserCDPSession();
async function clickIcon(page) {
  const cdp = await context.newCDPSession(page);
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  await cdp.detach();
  // The action wants the "tab" target that wraps the page target.
  const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = targetInfos.find((t) => t.targetId === targetInfo.targetId)
    || targetInfos.find((t) => t.url === targetInfo.url);
  if (!tab) throw new Error(`no tab target for ${targetInfo.url}: ${JSON.stringify(targetInfos.map((t) => [t.type, t.url]))}`);
  await browserCdp.send('Extensions.triggerAction', { id: extId, targetId: tab.targetId });
  await page.waitForTimeout(800);
}
/** Side-panel documents currently alive, as tab ids from their ?tabId= URL. */
async function panels() {
  return sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }))
    .map((c) => ({ tabId: Number(new URL(c.documentUrl).searchParams.get('tabId')), windowId: c.windowId })));
}
const enabledFor = (tabId) => sw.evaluate(async (id) => (await chrome.sidePanel.getOptions({ tabId: id })).enabled, tabId);
async function state(label) {
  const p = await panels();
  console.log(`     [${label}] panel documents: ${JSON.stringify(p)}`);
  return p;
}

// Tab A: a YouTube video. Tab B: another page in the same window.
const a = await context.newPage();
await a.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
if (a.url().includes('consent.')) {
  await a.getByRole('button', { name: /reject all/i }).first().click();
  await a.waitForURL(/watch/);
}
const b = await context.newPage();
await b.goto('https://example.com/');
const A = await tabIdOf(a);
const B = await tabIdOf(b);

check('nothing open initially', (await panels()).length === 0);
check('panel disabled globally (tab B)', (await enabledFor(B)) === false);

await a.bringToFront();
await clickIcon(a);
let p = await state('icon on A');
check('icon on A opens a panel for A', p.some((x) => x.tabId === A));
check('panel enabled for A only', (await enabledFor(A)) === true && (await enabledFor(B)) === false);

await b.bringToFront();
await b.waitForTimeout(600);
p = await state('switched to B');
check('tab B shows no panel', !p.some((x) => x.tabId === B) && (await enabledFor(B)) === false);

await a.bringToFront();
await a.waitForTimeout(600);
p = await state('back on A');
check('back on A the panel is there', p.some((x) => x.tabId === A));

await clickIcon(a);
p = await state('icon on A again');
check('second click on A closes it', !p.some((x) => x.tabId === A) && (await enabledFor(A)) === false);

await clickIcon(a);
p = await state('icon on A a third time');
check('third click reopens it', p.some((x) => x.tabId === A));

// Another window: its tabs are unaffected, and its own panel is independent.
const winTab = await sw.evaluate(async () => (await chrome.windows.create({ url: 'https://example.org/' })).tabs[0].id);
await new Promise((r) => setTimeout(r, 1500));
const c = context.pages().find((pg) => pg.url().startsWith('https://example.org'));
p = await state('new window');
check('new window shows no panel', !p.some((x) => x.tabId === winTab) && (await enabledFor(winTab)) === false);
check('A keeps its panel meanwhile', p.some((x) => x.tabId === A));
await clickIcon(c);
p = await state('icon in new window');
check('icon in the other window opens a panel for that tab only', p.some((x) => x.tabId === winTab) && p.some((x) => x.tabId === A));
await clickIcon(c);
p = await state('icon in new window again');
check('and closes it again, leaving A alone', !p.some((x) => x.tabId === winTab) && p.some((x) => x.tabId === A));

// The panel follows its tab to another video, and closes when the tab leaves video pages.
await a.bringToFront();
await a.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded' });
await a.waitForTimeout(1200);
p = await state('A to another video');
check('another video in A keeps the panel', p.some((x) => x.tabId === A));
await a.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
await a.waitForTimeout(1200);
p = await state('A navigated away');
check('navigating A off YouTube videos closes the panel', !p.some((x) => x.tabId === A) && (await enabledFor(A)) === false);

// Closing the tab cleans up.
await clickIcon(b);
await b.close();
await new Promise((r) => setTimeout(r, 800));
check('closing a tab removes its panel', !(await panels()).some((x) => x.tabId === B));

await context.close();
rmSync(profile, { recursive: true, force: true });
rmSync(extDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

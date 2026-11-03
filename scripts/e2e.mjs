// End-to-end check in a real (headless) Chromium with the unpacked extension.
//
//   node scripts/e2e.mjs [--shots docs/screenshots] [--stt] VIDEO_ID...
//
// Reads YTSUM_BASE_URL / YTSUM_API_KEY / YTSUM_CHAT_MODEL / YTSUM_STT_MODEL from
// .env.local (gitignored). The extension is copied to a temp dir and the endpoint
// origin is added to host_permissions, because a headless run cannot click the
// runtime permission prompt that the options page normally shows.
import { chromium } from 'playwright';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
const forceStt = args.includes('--stt');
const headed = args.includes('--headed');
const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--shots');
if (!ids.length) ids.push('dQw4w9WgXcQ');

const env = Object.fromEntries(
  (existsSync(join(root, '.env.local')) ? readFileSync(join(root, '.env.local'), 'utf8') : '')
    .split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const settings = {
  baseUrl: env.YTSUM_BASE_URL || '',
  apiKey: env.YTSUM_API_KEY || '',
  chatModel: env.YTSUM_CHAT_MODEL || '',
  sttModel: env.YTSUM_STT_MODEL || 'whisper-1',
  language: env.YTSUM_LANGUAGE || 'auto',
  autoSummarize: true,
};

const extDir = mkdtempSync(join(tmpdir(), 'ytsum-ext-'));
for (const p of ['manifest.json', 'src', 'icons']) cpSync(join(root, p), join(extDir, p), { recursive: true });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
if (settings.baseUrl) {
  const u = new URL(settings.baseUrl);
  manifest.host_permissions.push(`${u.protocol}//${u.hostname}/*`);
}
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const profile = mkdtempSync(join(tmpdir(), 'ytsum-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !headed,
  viewport: { width: 1280, height: 800 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  locale: 'en-US',
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await sw.evaluate((s) => chrome.storage.local.set(s), settings);
// The options page opens on install; let it appear, then close it.
await context.waitForEvent('page', { predicate: (p) => p.url().includes('options.html'), timeout: 5000 }).catch(() => {});
for (const p of context.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();

async function dismissConsent(page) {
  if (!page.url().includes('consent.')) return;
  const reject = page.getByRole('button', { name: /reject all/i }).first();
  await reject.click({ timeout: 10000 });
  await page.waitForURL(/youtube\.com\/watch/, { timeout: 20000 });
}

const results = [];
let failed = false;
for (const id of ids) {
  const t0 = Date.now();
  const yt = await context.newPage();
  await yt.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded' });
  await dismissConsent(yt);
  await yt.waitForSelector('video', { timeout: 30000 });
  await yt.waitForTimeout(2500);
  const tabId = await sw.evaluate(async (vid) => (await chrome.tabs.query({ url: `https://www.youtube.com/watch?v=${vid}*` }))[0]?.id, id);

  const panel = await context.newPage();
  await panel.setViewportSize({ width: 420, height: 900 });
  const logs = [];
  panel.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  await panel.goto(`chrome-extension://${extId}/src/panel/panel.html?tabId=${tabId}`);
  await panel.waitForFunction(() => document.querySelector('#title').textContent !== 'YouTube Summary'
    || document.querySelector('#status').classList.contains('error'), null, { timeout: 120000 }).catch(() => {});

  if (forceStt) {
    await panel.evaluate(() => { document.querySelector('[data-tab=transcript]').click(); });
    await panel.waitForFunction(() => !document.querySelector('#summary .empty')?.textContent?.startsWith('Summarizing') , null, { timeout: 300000 }).catch(() => {});
    await panel.click('#stt');
    await panel.waitForTimeout(1000);
  }

  // Done when a summary is rendered or an error is shown.
  await panel.waitForFunction(() => {
    const s = document.querySelector('#summary');
    const st = document.querySelector('#status');
    return (s.querySelector('p:not(.empty), li') && !st.textContent) || st.classList.contains('error');
  }, null, { timeout: 15 * 60000, polling: 1000 }).catch(() => {});

  const r = await panel.evaluate(() => ({
    title: document.querySelector('#title').textContent,
    status: document.querySelector('#status').textContent,
    error: document.querySelector('#status').classList.contains('error'),
    segments: document.querySelectorAll('#transcript li[data-i]').length,
    transcriptSource: document.querySelector('#transcriptSource').textContent,
    chapters: document.querySelectorAll('#chapters li').length,
    chapterSource: document.querySelector('#chapterSource').textContent,
    summaryChars: document.querySelector('#summary').textContent.length,
    summaryHead: document.querySelector('#summary').textContent.slice(0, 160),
  }));

  // Seek check: click the 2nd chapter (or a transcript line) and read the video time.
  let seek = null;
  const target = await panel.evaluate(() => {
    const b = document.querySelector('#chapters li:nth-child(2) .ts') || document.querySelector('#transcript li:nth-child(5) .ts');
    if (!b) return null;
    b.click();
    return Number(b.dataset.t);
  });
  if (target != null) {
    await yt.waitForTimeout(1500);
    seek = { target, videoTime: Math.round(await yt.evaluate(() => document.querySelector('video').currentTime)) };
  }

  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    await yt.screenshot({ path: join(shotsDir, `${id}-page.png`) });
    for (const tab of ['summary', 'chapters', 'transcript']) {
      await panel.click(`[data-tab=${tab}]`);
      await panel.waitForTimeout(300);
      await panel.screenshot({ path: join(shotsDir, `${id}-${tab}.png`) });
    }
  }
  const res = { id, seconds: Math.round((Date.now() - t0) / 1000), ...r, seek, log: logs.filter((l) => l.includes('[ytsum]') || l.startsWith('error')) };
  results.push(res);
  const ok = !r.error && r.segments > 0 && r.summaryChars > 50 && (!seek || Math.abs(seek.videoTime - seek.target) <= 3);
  failed ||= !ok;
  console.log(JSON.stringify({ ok, ...res }, null, 2));
  await panel.close();
}

await context.close();
rmSync(profile, { recursive: true, force: true });
rmSync(extDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);

import {
  loadVideo, listCaptionTracks, fetchTranscript, getAudioUrl, downloadAudioChunks,
  getPlayerResponse, formatTimestamp, parseTimestamp, parseVideoId,
} from '../lib/youtube.js';
import { streamChat, transcribe } from '../lib/openai.js';
import {
  VideoSummarizer, TIERS, TIER_IDS, LONG_TIER_MIN_SECONDS, parseVerdict, parseModelReply, readingTime,
} from '../lib/summarize.js';
import { loadSettings } from '../settings.js';
import { renderMarkdown } from './md.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// The background opens one panel per tab as panel.html?tabId=N (tests open it as a page the same way).
const pinnedTabId = params.has('tabId') ? Number(params.get('tabId')) : null;

// Tell the background this tab's panel is open, so the next icon click closes it.
// The port also keeps the service worker (and that knowledge) alive.
function connectToBackground() {
  if (pinnedTabId == null) return;
  const port = chrome.runtime.connect({ name: `panel:${pinnedTabId}` });
  const ping = setInterval(() => port.postMessage('ping'), 20000);
  port.onDisconnect.addListener(() => {
    clearInterval(ping);
    setTimeout(connectToBackground, 500); // service worker restarted
  });
}
connectToBackground();

const state = {
  tabId: null,
  videoId: null,
  run: 0, // increments on every (re)load; stale async work checks it
  data: null, // { meta, tracks, trackIndex, segments, segmentSource, chapters, chapterSource, tiers, playerResponse? }
  abort: null,
  summarizer: null, // VideoSummarizer for the current transcript + settings (keeps long-transcript notes)
  summarizerKey: null,
};

// ---------- tab plumbing ----------

async function send(msg) {
  return chrome.tabs.sendMessage(state.tabId, msg);
}

async function ensureContentScript(tabId) {
  try {
    if ((await chrome.tabs.sendMessage(tabId, { type: 'ping' }))?.ok) return;
  } catch { /* not injected yet (tab opened before install) */ }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/page.js'], world: 'MAIN' });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
}

/** fetch() that runs inside the YouTube tab (same origin as youtube.com). */
async function tabFetch(url, init = {}) {
  const r = await send({ type: 'fetch', url: String(url), init: { method: init.method, headers: init.headers, body: init.body, credentials: init.credentials } });
  if (r?.error) throw new Error(r.error);
  return new Response(r.body, { status: r.status, statusText: r.statusText });
}

async function askPage(what, args, timeoutMs) {
  const r = await send({ type: 'page', what, args, timeoutMs });
  if (r?.error) throw new Error(r.error);
  return r?.value ?? null;
}

const page = {
  getPlayerResponse: () => askPage('playerResponse'),
  getInitialData: () => askPage('initialData', { videoId: state.videoId }),
  getPoToken: () => askPage('pot', { videoId: state.videoId }, 60000),
};

// ---------- UI helpers ----------

function setStatus(text, isError = false) {
  $('status').textContent = text || '';
  $('status').classList.toggle('error', !!isError);
}

function selectTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of document.querySelectorAll('[role=tabpanel]')) s.hidden = s.id !== `tab-${name}`;
}

function tsButton(sec) {
  const b = document.createElement('button');
  b.className = 'ts';
  b.dataset.t = String(Math.floor(sec));
  b.textContent = formatTimestamp(sec);
  return b;
}

async function seek(sec) {
  try {
    await send({ type: 'seek', time: sec });
  } catch (e) {
    setStatus(`Could not seek: ${e.message}`, true);
  }
}

document.addEventListener('click', (e) => {
  const ts = e.target.closest('button.ts');
  if (ts) {
    const t = ts.dataset.t;
    seek(/:/.test(t) ? parseTimestamp(t) : Number(t));
    return;
  }
  const seg = e.target.closest('.timeline div');
  if (seg) seek(Number(seg.dataset.t));
});
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab));
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('refresh').addEventListener('click', () => start({ force: true }));
for (const id of TIER_IDS) {
  const card = tierCard(id);
  card.querySelector('.generate').addEventListener('click', () => runTier(id));
  card.querySelector('.copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(tierDisplay(id).copy);
    setStatus(`${TIERS[id].label} copied.`);
  });
}
$('stt').addEventListener('click', () => runStt());
$('copy').addEventListener('click', async () => {
  const segs = state.data?.segments || [];
  await navigator.clipboard.writeText(segs.map((s) => `[${formatTimestamp(s.start)}] ${s.text}`).join('\n'));
  setStatus('Transcript copied.');
});
$('filter').addEventListener('input', () => renderTranscript());
$('track').addEventListener('change', () => switchTrack($('track').value));

// ---------- rendering ----------

function renderHeader() {
  const m = state.data?.meta;
  $('title').textContent = m?.title || 'YouTube Summary';
  $('channel').textContent = m ? [m.channel, m.duration && formatTimestamp(m.duration)].filter(Boolean).join(' · ') : '';
}

function renderTracks() {
  const sel = $('track');
  sel.replaceChildren();
  const tracks = state.data?.tracks || [];
  if (!tracks.length) {
    sel.append(new Option(state.data?.segmentSource === 'stt' ? 'Speech-to-text' : 'No captions', ''));
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  tracks.forEach((t, i) => sel.append(new Option(t.name, String(i))));
  if (state.data.segmentSource === 'stt') sel.append(new Option('Speech-to-text', 'stt'));
  sel.value = state.data.segmentSource === 'stt' ? 'stt' : String(state.data.trackIndex ?? 0);
}

function renderTranscript() {
  const list = $('transcript');
  list.replaceChildren();
  const segs = state.data?.segments;
  $('segCount').textContent = segs?.length ? `(${segs.length})` : '';
  $('transcriptSource').textContent = state.data?.segmentNote || '';
  if (!segs?.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = state.data ? 'No transcript yet.' : '';
    list.append(li);
    return;
  }
  const q = $('filter').value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  segs.forEach((s, i) => {
    if (q && !s.text.toLowerCase().includes(q)) return;
    const li = document.createElement('li');
    li.dataset.i = String(i);
    const span = document.createElement('span');
    span.textContent = s.text;
    li.append(tsButton(s.start), span);
    frag.append(li);
  });
  list.append(frag);
}

function renderChapters() {
  const list = $('chapters');
  const tl = $('timeline');
  list.replaceChildren();
  tl.replaceChildren();
  const d = state.data;
  const chapters = d?.chapters || [];
  $('chapterCount').textContent = chapters.length ? `(${chapters.length})` : '';
  $('chapterSource').textContent = {
    youtube: 'Chapters from YouTube.',
    description: 'Chapters from the video description.',
    ai: 'No chapters on this video: generated by your model from the transcript.',
  }[d?.chapterSource] || (d ? 'No chapters yet. They are generated together with the short summary.' : '');
  const total = d?.meta?.duration || chapters.at(-1)?.end || 0;
  for (const c of chapters) {
    const li = document.createElement('li');
    li.dataset.t = String(c.start);
    const span = document.createElement('span');
    span.textContent = c.title;
    li.append(tsButton(c.start), span);
    list.append(li);
    if (total) {
      const seg = document.createElement('div');
      seg.dataset.t = String(c.start);
      seg.title = `${formatTimestamp(c.start)} ${c.title}`;
      seg.style.flexGrow = String(Math.max(1, ((c.end ?? total) - c.start) / total * 1000));
      tl.append(seg);
    }
  }
}

// ---------- summary tiers ----------

function tierCard(id) {
  return document.querySelector(`.tier[data-tier="${id}"]`);
}

/** What a tier card shows: the model text minus the verdict line / CHAPTERS section. */
function tierDisplay(id) {
  const t = state.data?.tiers?.[id];
  let text = t?.text || '';
  let verdict = null;
  if (id === 'quick') {
    ({ verdict, body: text } = parseVerdict(text));
    if (!verdict && /^\s*\**\s*V(E(R(D(I(C(T)?)?)?)?)?)?\s*$/i.test(text)) text = ''; // verdict line still streaming in
  } else if (id === 'short') {
    text = parseModelReply(text).summary.replace(/\n\s*\**\s*C(H(A(P(T(E(R(S)?)?)?)?)?)?)?\s*$/i, '');
  }
  return { text, verdict, copy: verdict ? `${verdict}\n\n${text}` : text };
}

function renderSummary() {
  const d = state.data;
  $('summaryNote').textContent = d?.summaryNote || '';
  $('tiers').hidden = !d?.segments?.length;
  if (d?.segments?.length) for (const id of TIER_IDS) renderTier(id);
}

function renderTier(id) {
  const d = state.data;
  if (!d?.segments?.length) return;
  const card = tierCard(id);
  const t = d.tiers?.[id];
  const body = card.querySelector('.body');
  const gen = card.querySelector('.generate');
  const verdictEl = card.querySelector('.verdict');
  const { text, verdict } = tierDisplay(id);
  const shortVideo = id === 'long' && d.meta?.duration && d.meta.duration < LONG_TIER_MIN_SECONDS;

  card.querySelector('.time').textContent = text ? readingTime(text) : TIERS[id].target;
  card.querySelector('.copy').hidden = t?.status !== 'done';
  gen.hidden = t?.status === 'running' || t?.status === 'done';
  gen.textContent = t?.status === 'error' ? 'Retry'
    : id === 'quick' ? 'Get the verdict'
      : id === 'short' ? 'Generate short summary'
        : shortVideo ? 'Generate anyway' : 'Generate detailed summary';
  if (verdictEl) {
    verdictEl.hidden = !verdict;
    verdictEl.className = `verdict ${verdict || ''}`;
    verdictEl.textContent = verdict || '';
  }

  if (!t) {
    body.replaceChildren();
    if (shortVideo) body.append(note('Short video: the short summary already covers it.'));
    return;
  }
  if (t.status === 'error') {
    const div = document.createElement('div');
    div.className = 'error';
    div.textContent = t.error;
    body.replaceChildren(div);
    return;
  }
  if (text) {
    body.innerHTML = renderMarkdown(text);
    if (t.truncated) body.append(note('(Cut off: the model hit its output limit.)'));
    return;
  }
  // Running, nothing to show yet: say what is happening.
  const secs = Math.round((Date.now() - t.started) / 1000);
  const what = t.progress && t.progress.done < t.progress.total && id !== 'quick'
    ? `Condensing the long transcript: part ${t.progress.done + 1} of ${t.progress.total}…`
    : t.reasoning ? `Thinking… (${t.reasoning.toLocaleString('en')} characters of reasoning)` : 'Waiting for the model…';
  const p = note(`${what} ${secs} s`);
  p.className = 'working';
  body.replaceChildren(p);
}

function note(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

// Streaming updates arrive per token; render at most once per frame.
const pendingRender = new Set();
function scheduleRender(id) {
  if (pendingRender.has(id)) return;
  pendingRender.add(id);
  requestAnimationFrame(() => {
    pendingRender.delete(id);
    renderTier(id);
  });
}
// Elapsed-time counter on running tiers (reasoning models can think for a minute).
setInterval(() => {
  for (const id of TIER_IDS) if (state.data?.tiers?.[id]?.status === 'running' && !state.data.tiers[id].text) renderTier(id);
}, 1000);

function renderAll() {
  renderHeader();
  renderTracks();
  renderTranscript();
  renderChapters();
  renderSummary();
}

function highlight(time) {
  if (!state.data) return;
  const segs = state.data.segments || [];
  let idx = -1;
  for (let i = 0; i < segs.length && segs[i].start <= time; i++) idx = i;
  for (const li of $('transcript').querySelectorAll('li.now')) li.classList.remove('now');
  const cur = $('transcript').querySelector(`li[data-i="${idx}"]`);
  if (cur) {
    cur.classList.add('now');
    if ($('follow').checked && !$('tab-transcript').hidden) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  const chapters = [...$('chapters').children];
  const ci = chapters.findLastIndex((li) => Number(li.dataset.t) <= time);
  chapters.forEach((li, i) => li.classList.toggle('now', i === ci));
  [...$('timeline').children].forEach((d, i) => d.classList.toggle('now', i === ci));
}

// ---------- cache ----------

const cacheKey = (id) => `video:${id}`;
async function saveCache() {
  if (!state.data?.meta?.videoId) return;
  const { playerResponse, tiers = {}, ...rest } = state.data;
  rest.tiers = Object.fromEntries(Object.entries(tiers).filter(([, t]) => t.status === 'done').map(([k, t]) => [k, { status: 'done', text: t.text }]));
  await chrome.storage.session.set({ [cacheKey(state.data.meta.videoId)]: rest }).catch(() => {});
}

// ---------- pipeline ----------

async function start({ force = false } = {}) {
  const run = ++state.run;
  state.abort?.abort();
  state.abort = new AbortController();
  state.data = null;
  renderAll();
  const tab = pinnedTabId != null ? await chrome.tabs.get(pinnedTabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab) return setStatus('No tab.');
  state.tabId = tab.id;
  const videoId = parseVideoId(tab.url) && /youtube\.com$/.test(new URL(tab.url).hostname) ? parseVideoId(tab.url) : null;
  state.videoId = videoId;
  if (!videoId) {
    $('title').textContent = 'YouTube Summary';
    return setStatus('Open a YouTube video (youtube.com/watch?v=…) and click the toolbar icon.');
  }

  const settings = await loadSettings();
  if (!force) {
    const cached = (await chrome.storage.session.get(cacheKey(videoId)))[cacheKey(videoId)];
    if (cached) {
      await ensureContentScript(tab.id).catch(() => {});
      // v0.1.x cached a single summary: show it as the short tier.
      if (cached.summary && !cached.tiers) cached.tiers = { short: { status: 'done', text: cached.summary } };
      state.data = { tiers: {}, ...cached };
      renderAll();
      setStatus('');
      runAutoTiers(settings);
      return;
    }
  }

  try {
    setStatus('Loading video…');
    await ensureContentScript(tab.id);
    const cfg = await askPage('ytcfg').catch(() => ({}));
    const r = await loadVideo(videoId, {
      fetch: tabFetch, page, visitorData: cfg?.visitorData, clientVersion: cfg?.clientVersion,
      onStatus: (t) => run === state.run && setStatus(t),
    });
    if (run !== state.run) return;
    console.info('[ytsum]', r.log.join('\n'));
    state.data = {
      meta: r.meta,
      playerResponse: r.playerResponse,
      client: r.client,
      tracks: r.tracks,
      trackIndex: r.track ? r.tracks.indexOf(r.track) : null,
      segments: r.segments,
      segmentSource: r.segments ? 'captions' : null,
      segmentNote: r.segments ? `Captions: ${r.track.name}.` : '',
      chapters: r.chapters,
      chapterSource: r.chapterSource,
      tiers: {},
      summaryNote: '',
      log: r.log,
    };
    renderAll();
    setStatus('');
    await saveCache();
    if (!r.segments) {
      const reason = r.log.filter((l) => /captions/.test(l)).at(-1);
      const why = r.tracks.length
        ? `This video has captions, but YouTube did not hand them out (${reason || 'unknown reason'}).`
        : 'This video has no captions.';
      if (settings.baseUrl && settings.sttModel && settings.autoSummarize) {
        state.data.summaryNote = `${why} Transcribing the audio instead…`;
        renderSummary();
        await runStt();
      } else {
        state.data.summaryNote = `${why} Set a speech-to-text model in Settings to transcribe the audio.`;
        renderSummary();
        setStatus(why, true);
      }
      return;
    }
    await runAutoTiers(settings);
  } catch (e) {
    if (run !== state.run) return;
    console.error(e);
    setStatus(e.message, true);
  }
}

async function switchTrack(value) {
  const d = state.data;
  if (!d || value === 'stt' || value === '') return;
  const track = d.tracks[Number(value)];
  try {
    setStatus(`Loading ${track.name}…`);
    let segments;
    try {
      segments = await fetchTranscript(track, { fetch: tabFetch });
    } catch (e) {
      if (e.code !== 'PO_TOKEN_REQUIRED') throw e;
      segments = await fetchTranscript(track, { fetch: tabFetch, pot: await page.getPoToken() });
    }
    Object.assign(d, { segments, trackIndex: Number(value), segmentSource: 'captions', segmentNote: `Captions: ${track.name}.` });
    renderTranscript();
    setStatus('');
    await saveCache();
  } catch (e) {
    setStatus(`${track.name}: ${e.message}`, true);
  }
}

async function requireSettings(...keys) {
  const s = await loadSettings();
  const missing = keys.filter((k) => !s[k]);
  if (missing.length) {
    throw new Error(`Open Settings (⚙) and set: ${missing.map((k) => ({ baseUrl: 'Base URL', chatModel: 'Chat model', sttModel: 'Speech-to-text model' }[k] || k)).join(', ')}.`);
  }
  return s;
}

/** The tiers that run without a click: the verdict, and the short summary if enabled. */
function runAutoTiers(settings) {
  const d = state.data;
  if (!d?.segments?.length || !settings.autoSummarize || !settings.baseUrl || !settings.chatModel) return Promise.resolve();
  const wanted = settings.autoShort ? ['quick', 'short'] : ['quick'];
  return Promise.all(wanted.filter((id) => !d.tiers?.[id]).map((id) => runTier(id)));
}

function summarizerFor(s) {
  const d = state.data;
  const key = JSON.stringify([d.meta?.videoId, d.segments.length, d.segmentSource, s.baseUrl, s.chatModel, s.fastModel, s.language]);
  if (state.summarizerKey !== key) {
    state.summarizerKey = key;
    state.summarizer = new VideoSummarizer({
      segments: d.segments,
      meta: d.meta,
      settings: s,
      streamFn: (messages, { model, signal }) => streamChat(messages, { baseUrl: s.baseUrl, apiKey: s.apiKey, model, signal }),
    });
  }
  return state.summarizer;
}

async function runTier(id) {
  const run = state.run;
  const d = state.data;
  if (!d?.segments?.length || d.tiers?.[id]?.status === 'running') return;
  d.tiers ||= {};
  const t = (d.tiers[id] = { status: 'running', text: '', reasoning: 0, started: Date.now() });
  renderTier(id);
  try {
    const s = await requireSettings('baseUrl', 'chatModel');
    const needChapters = id === 'short' && (!d.chapters?.length || d.chapterSource === 'ai');
    const out = await summarizerFor(s).runTier(id, {
      needChapters,
      signal: state.abort.signal,
      onEvent: (ev, soFar) => {
        if (ev.type === 'reasoning') t.reasoning += ev.text.length;
        else if (ev.type === 'truncated') t.truncated = true;
        else t.text = soFar;
        if (run === state.run) scheduleRender(id);
      },
      onProgress: (p) => {
        t.progress = p;
        if (run === state.run) scheduleRender(id);
      },
    });
    if (run !== state.run) return;
    Object.assign(t, { status: 'done', text: out.text || '(The model returned an empty answer.)' });
    if (needChapters && out.chapters.length) {
      d.chapters = out.chapters;
      d.chapterSource = 'ai';
      renderChapters();
    }
    await saveCache();
  } catch (e) {
    if (run !== state.run) return;
    if (e.name === 'AbortError') delete d.tiers[id];
    else Object.assign(t, { status: 'error', error: e.message });
  }
  renderTier(id);
}

async function runStt() {
  const run = state.run;
  const d = state.data;
  if (!d) return;
  const btn = $('stt');
  try {
    const s = await requireSettings('baseUrl', 'sttModel');
    btn.disabled = true;
    // Audio URLs must come from a JS-less client; the page's own (web) response is SABR-only.
    let pr = d.playerResponse;
    if (!pr || d.client === 'page' || !pr.streamingData) {
      setStatus('Getting audio formats…');
      try {
        ({ playerResponse: pr } = await getPlayerResponse(d.meta.videoId, { fetch: tabFetch }));
      } catch (e) {
        throw new Error(/not a bot/i.test(e.message)
          ? 'Audio transcription is unavailable for this video right now: YouTube answers the audio-capable clients with "Sign in to confirm you’re not a bot" from your network. Captions (if any) still work.'
          : e.message);
      }
    }
    const audio = getAudioUrl(pr);
    if (audio.error) throw new Error(`No downloadable audio: ${audio.error}`);
    const mb = audio.contentLength ? ` (${(audio.contentLength / 1048576).toFixed(1)} MB)` : '';
    setStatus(`Downloading audio${mb}…`);
    const segments = [];
    let i = 0;
    for await (const chunk of downloadAudioChunks(audio, {
      signal: state.abort.signal,
      onProgress: (p) => run === state.run && setStatus(`Downloading audio${mb}: ${Math.round(p * 100)}%…`),
    })) {
      i += 1;
      if (run !== state.run) return;
      setStatus(`Transcribing part ${i} (${formatTimestamp(chunk.t0)}–${formatTimestamp(chunk.t1)})…`);
      const segs = await transcribe(chunk.bytes, {
        baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.sttModel, filename: `audio-${i}.${chunk.ext}`,
        mimeType: chunk.mimeType, signal: state.abort.signal, duration: chunk.t1 - chunk.t0,
      });
      for (const g of segs) segments.push({ start: g.start + chunk.t0, end: g.end + chunk.t0, text: g.text });
      Object.assign(d, { segments: [...segments], segmentSource: 'stt', segmentNote: `Speech-to-text (${s.sttModel}), ${i} part(s) so far…` });
      renderTranscript();
    }
    if (!segments.length) throw new Error('The STT model returned no text.');
    Object.assign(d, { segmentNote: `Speech-to-text (${s.sttModel}) from audio itag ${audio.itag}.`, tiers: {}, summaryNote: '' });
    renderTracks();
    renderTranscript();
    renderSummary();
    setStatus('');
    await saveCache();
    await runAutoTiers(s);
  } catch (e) {
    if (run !== state.run) return;
    d.summaryNote = [(d.summaryNote || '').replace(/ Transcribing the audio instead…$/, ''), e.message].filter(Boolean).join(' ');
    renderSummary();
    setStatus(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- events ----------

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.tab?.id !== state.tabId) return;
  if (msg.type === 'time' && msg.videoId === state.videoId) highlight(msg.currentTime);
});
// YouTube navigates as an SPA; the URL change still shows up in tabs.onUpdated.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === state.tabId && info.url && parseVideoId(info.url) !== state.videoId) start();
});
if (pinnedTabId == null) chrome.tabs.onActivated.addListener(() => start());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.baseUrl || changes.chatModel || changes.fastModel)) return;
  // Settings fixed after an error: retry the failed / missing automatic tiers.
  const d = state.data;
  for (const id of TIER_IDS) if (d?.tiers?.[id]?.status === 'error') delete d.tiers[id];
  loadSettings().then(runAutoTiers);
});

start();

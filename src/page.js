// MAIN-world script on www.youtube.com (runs at document_start).
// It can see what the isolated content script cannot: the page player
// (#movie_player API), ytcfg, ytInitialData, and the player's own network calls.
//
// The player itself attaches a PO token ("pot") to its /api/timedtext requests.
// We record those URLs so the extension can reuse the token for the same video
// (subtitle PO tokens are bound to the video id), which is the fallback when
// caption URLs carry the `exp=xpe` PO-token experiment.
(() => {
  if (window.__ytsumPage) return;
  window.__ytsumPage = true;

  const timedtext = new Map(); // videoId -> last timedtext URL with pot
  const remember = (url) => {
    try {
      const u = new URL(url, location.origin);
      if (!u.pathname.endsWith('/api/timedtext') || !u.searchParams.get('pot')) return;
      timedtext.set(u.searchParams.get('v'), u.href);
    } catch { /* ignore */ }
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
    remember(String(url));
    return origOpen.call(this, method, url, ...rest);
  };
  const origFetch = window.fetch;
  window.fetch = function fetch(input, init) {
    remember(typeof input === 'string' ? input : input?.url || String(input));
    return origFetch.call(this, input, init);
  };

  const player = () => document.getElementById('movie_player');

  function playerResponse() {
    return player()?.getPlayerResponse?.() || window.ytInitialPlayerResponse || null;
  }

  function initialData(videoId) {
    const candidates = [
      document.querySelector('ytd-watch-flexy')?.__data?.watchNextData,
      document.querySelector('ytd-watch-flexy')?.watchNextData,
      window.ytInitialData,
    ];
    return candidates.find((d) => d && (!videoId
      || d.currentVideoEndpoint?.watchEndpoint?.videoId === videoId)) || null;
  }

  function findPot(videoId) {
    if (!timedtext.has(videoId)) {
      for (const e of performance.getEntriesByType('resource')) remember(e.name);
    }
    const url = timedtext.get(videoId);
    if (!url) return null;
    const q = new URL(url).searchParams;
    return { pot: q.get('pot'), c: q.get('c') || 'WEB', cver: q.get('cver') };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Make the player fetch captions once (CC on), capture the pot, restore CC state.
  async function capturePot(videoId) {
    let found = findPot(videoId);
    if (found) return found;
    const p = player();
    // During a pre-roll ad the player fetches the *ad's* captions; wait it out.
    const t0 = Date.now();
    while (p?.classList.contains('ad-showing') && Date.now() - t0 < 45000) {
      await sleep(500);
      if ((found = findPot(videoId))) return found;
    }
    const btn = document.querySelector('.ytp-subtitles-button');
    const wasOn = btn?.getAttribute('aria-pressed') === 'true';
    const toggle = () => (p?.toggleSubtitles ? p.toggleSubtitles() : btn?.click());
    if (wasOn) { toggle(); await sleep(300); }
    toggle();
    const t1 = Date.now();
    while (!found && Date.now() - t1 < 8000) {
      await sleep(250);
      found = findPot(videoId);
    }
    const nowOn = btn?.getAttribute('aria-pressed') === 'true';
    if (nowOn !== wasOn) toggle();
    return found;
  }

  const handlers = {
    playerResponse: () => playerResponse(),
    initialData: ({ videoId } = {}) => initialData(videoId),
    ytcfg: () => ({
      visitorData: window.ytcfg?.get?.('VISITOR_DATA') || null,
      clientVersion: window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || null,
      hl: window.ytcfg?.get?.('HL') || null,
      loggedIn: !!window.ytcfg?.get?.('LOGGED_IN'),
    }),
    pot: ({ videoId }) => capturePot(videoId),
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.ytsum !== 'req') return;
    const { id, what, args } = e.data;
    let reply;
    try {
      const value = await handlers[what]?.(args);
      // Structured-clone friendly copy (player objects can hold functions).
      reply = { ytsum: 'res', id, value: value == null ? null : JSON.parse(JSON.stringify(value)) };
    } catch (err) {
      reply = { ytsum: 'res', id, error: String(err?.message || err) };
    }
    window.postMessage(reply, location.origin);
  });
})();

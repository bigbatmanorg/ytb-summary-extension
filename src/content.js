// Content script (isolated world) on www.youtube.com.
// - Proxies same-origin requests for the side panel, so InnerTube and timedtext
//   calls are made from youtube.com exactly as the site's own scripts make them.
// - Seeks the <video>, reports the playback position and SPA navigations.
// - Relays questions to page.js (MAIN world), which can see the page player.
(() => {
  if (window.__ytsumContent) return;
  window.__ytsumContent = true;

  const videoIdOf = (href) => {
    try {
      const u = new URL(href);
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  };

  const video = () => document.querySelector('#movie_player video, video.html5-main-video, video');

  let seq = 0;
  const pending = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.ytsum !== 'res') return;
    const p = pending.get(e.data.id);
    if (p) {
      pending.delete(e.data.id);
      p(e.data);
    }
  });
  function askPage(what, args, timeoutMs = 12000) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${++seq}`;
      const timer = setTimeout(() => { pending.delete(id); resolve({ error: 'page script did not answer' }); }, timeoutMs);
      pending.set(id, (d) => { clearTimeout(timer); resolve(d); });
      window.postMessage({ ytsum: 'req', id, what, args }, location.origin);
    });
  }

  async function proxyFetch({ url, init }) {
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin) return { error: `refusing to proxy ${u.origin}` };
    const res = await fetch(u.href, init);
    return { status: res.status, statusText: res.statusText, body: await res.text() };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    (async () => {
      switch (msg.type) {
        case 'ping':
          return { ok: true };
        case 'state': {
          const v = video();
          return { videoId: videoIdOf(location.href), url: location.href, currentTime: v?.currentTime ?? null, paused: v?.paused ?? null };
        }
        case 'seek': {
          const v = video();
          if (!v) return { error: 'no video element' };
          v.currentTime = msg.time;
          if (v.paused) v.play().catch(() => {});
          return { ok: true };
        }
        case 'fetch':
          return proxyFetch(msg);
        case 'page':
          return askPage(msg.what, msg.args, msg.timeoutMs);
        default:
          return { error: `unknown message ${msg.type}` };
      }
    })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  });

  // SPA navigation + playback position, for the side panel (ignored when it is closed).
  const notify = (m) => chrome.runtime.sendMessage(m).catch(() => {});
  let lastId = videoIdOf(location.href);
  document.addEventListener('yt-navigate-finish', () => {
    const id = videoIdOf(location.href);
    if (id !== lastId) {
      lastId = id;
      notify({ type: 'nav', videoId: id, url: location.href });
    }
  });
  let lastTick = 0;
  document.addEventListener('timeupdate', (e) => {
    if (!(e.target instanceof HTMLVideoElement) || Date.now() - lastTick < 700) return;
    lastTick = Date.now();
    notify({ type: 'time', videoId: lastId, currentTime: e.target.currentTime });
  }, true);
})();

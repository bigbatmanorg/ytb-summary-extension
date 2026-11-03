// Orchestration: player response -> caption track -> transcript, plus chapters.
// Every network call goes through the injected `fetch`, so the same code runs in
// the extension (fetch proxied through the youtube.com tab) and in Node.
import { getPlayerResponse, getNextResponse, YouTubeError } from './innertube.js';
import { listCaptionTracks, pickTrack, fetchTranscript } from './captions.js';
import { getChapters } from './chapters.js';

export * from './innertube.js';
export * from './captions.js';
export * from './chapters.js';
export * from './audio.js';

export function videoMeta(pr) {
  const d = pr?.videoDetails || {};
  return {
    videoId: d.videoId,
    title: d.title,
    channel: d.author,
    duration: Number(d.lengthSeconds) || null,
    description: d.shortDescription || '',
    isLive: !!d.isLiveContent && !!d.isLive,
  };
}

/**
 * Load everything except the summary.
 *
 * Caption strategy, cheapest and least intrusive first:
 *  1. the page player's own tracks, if they do not carry the PO-token experiment;
 *  2. InnerTube with a JS-less client (ANDROID_VR, VISIONOS): its caption URLs
 *     need no PO token, and it also yields plain audio URLs for STT;
 *  3. the page's tracks + a PO token captured from the page player's own
 *     /api/timedtext request (briefly turns CC on).
 *
 * options.page (optional, extension only):
 *   getPlayerResponse() -> the page player's own response
 *   getPoToken(track)   -> {pot, c} captured from the page player's own timedtext request
 *   getInitialData()    -> ytInitialData (chapters fallback when /next fails)
 * Returns {meta, playerResponse, client, tracks, track, segments, chapters, chapterSource, log}.
 * `client` names where `playerResponse` came from ('page' has no usable audio URLs).
 */
export async function loadVideo(videoId, { fetch = globalThis.fetch, page, preferLang, hl, visitorData, clientVersion, onStatus } = {}) {
  const log = [];
  let pagePr = null;
  if (page?.getPlayerResponse) {
    pagePr = await page.getPlayerResponse().catch(() => null);
    if (pagePr?.videoDetails?.videoId !== videoId) pagePr = null;
  }
  const pageTracks = listCaptionTracks(pagePr);
  const pageTrack = pickTrack(pageTracks, { preferLang });

  let playerResponse = pagePr;
  let client = pagePr ? 'page' : null;
  let tracks = pageTracks;
  let track = pageTrack;
  let segments = null;

  // 1. Page tracks that need no PO token.
  if (pageTrack && !pageTrack.requiresPoToken) {
    try {
      segments = await fetchTranscript(pageTrack, { fetch });
      log.push(`captions: ${pageTrack.name} (${pageTrack.kind}) via page player`);
    } catch (e) {
      log.push(`page captions failed: ${e.message}`);
    }
  }

  // 2. InnerTube JS-less clients (also needed later for STT audio URLs).
  if (!segments) {
    try {
      const r = await getPlayerResponse(videoId, { fetch, hl, visitorData });
      log.push(`player response via ${r.client} client`);
      playerResponse = r.playerResponse;
      client = r.client;
      const itTracks = listCaptionTracks(playerResponse);
      const itTrack = pickTrack(itTracks, { preferLang });
      if (itTrack) {
        tracks = itTracks;
        track = itTrack;
        segments = await fetchTranscript(itTrack, { fetch });
        log.push(`captions: ${itTrack.name} (${itTrack.kind}) via ${r.client}`);
      } else if (!pageTrack) {
        tracks = itTracks;
        track = null;
      }
    } catch (e) {
      log.push(e.message);
    }
  }
  if (!playerResponse) throw new YouTubeError(`Could not load video ${videoId}: ${log.join('; ')}`);

  // 3. Page tracks with a PO token borrowed from the page player.
  if (!segments && pageTrack?.requiresPoToken && page?.getPoToken) {
    try {
      onStatus?.('Getting a caption token from the YouTube player (turns CC on briefly)…');
      const pot = await page.getPoToken(pageTrack);
      if (!pot?.pot) throw new YouTubeError('the player did not request captions (is an ad playing?)');
      segments = await fetchTranscript(pageTrack, { fetch, pot });
      tracks = pageTracks;
      track = pageTrack;
      log.push(`captions: ${pageTrack.name} (${pageTrack.kind}) via page player + PO token`);
    } catch (e) {
      log.push(`page captions with PO token failed: ${e.message}`);
    }
  }

  onStatus?.('Loading chapters…');
  let chapters = [];
  let chapterSource = null;
  try {
    const nextData = await getNextResponse(videoId, { fetch, hl, visitorData, clientVersion });
    ({ chapters, source: chapterSource } = getChapters({ nextData, playerResponse }));
  } catch (e) {
    log.push(`chapters (/next) failed: ${e.message}`);
    const nextData = await page?.getInitialData?.().catch(() => null);
    ({ chapters, source: chapterSource } = getChapters({ nextData, playerResponse }));
  }

  return { meta: videoMeta(playerResponse), playerResponse, client, tracks, track, segments, chapters, chapterSource, log };
}

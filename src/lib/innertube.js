// Minimal InnerTube client: the same /youtubei/v1/player call yt-dlp makes.
// Plain ES module: runs in the extension (via a fetch that is proxied through the
// youtube.com content script) and in Node 18+ (global fetch) for tests.

export const YT_ORIGIN = 'https://www.youtube.com';

// Client contexts copied from yt-dlp's INNERTUBE_CLIENTS (extractor/youtube/_base.py,
// yt-dlp 2026.10.21). Only "JS-less" clients are listed: their stream URLs carry no
// signature/n challenge, and their caption URLs do not carry the `exp=xpe` experiment
// that makes /api/timedtext demand a PO token. Order = preference.
export const CLIENTS = {
  ANDROID_VR: {
    id: 28,
    client: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      androidSdkVersion: 32,
      osName: 'Android',
      osVersion: '12L',
    },
  },
  VISIONOS: {
    id: 101,
    client: {
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.5.23O471',
    },
  },
};

// The desktop web client. Only used for /next (chapters), never for streams.
export const WEB_CLIENT = { id: 1, client: { clientName: 'WEB', clientVersion: '2.20261030.02.00' } };

export class YouTubeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'YouTubeError';
    Object.assign(this, details);
  }
}

export function parseVideoId(input) {
  if (!input) return null;
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const u = new URL(input);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function innertube(endpoint, body, { client, fetch = globalThis.fetch, hl = 'en', visitorData }) {
  const res = await fetch(`${YT_ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    // Anonymous on purpose: with cookies YouTube expects SAPISIDHASH auth headers.
    credentials: 'omit',
    headers: {
      'content-type': 'application/json',
      'x-youtube-client-name': String(client.id),
      'x-youtube-client-version': client.client.clientVersion,
      // The page's visitor id (ytcfg VISITOR_DATA) makes us look like that visitor, as yt-dlp does.
      ...(visitorData ? { 'x-goog-visitor-id': visitorData } : {}),
    },
    body: JSON.stringify({ context: { client: { ...client.client, hl, ...(visitorData ? { visitorData } : {}) } }, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new YouTubeError(`InnerTube ${endpoint} HTTP ${res.status}`, { status: res.status });
  try {
    return JSON.parse(text);
  } catch {
    // e.g. the "Sorry... automated queries" HTML page when the IP is rate-limited.
    throw new YouTubeError(`InnerTube ${endpoint} returned non-JSON (rate-limited?)`, { status: res.status });
  }
}

export function playabilityError(pr) {
  const ps = pr?.playabilityStatus;
  if (!ps) return 'empty player response';
  if (ps.status === 'OK') return null;
  return `${ps.status}${ps.reason ? `: ${ps.reason}` : ''}`;
}

/**
 * Fetch a player response for a video, trying JS-less clients in order.
 * Returns { playerResponse, client } for the first playable one.
 */
export async function getPlayerResponse(videoId, { fetch, clients = ['ANDROID_VR', 'VISIONOS'], hl, visitorData } = {}) {
  const errors = [];
  for (const name of clients) {
    try {
      const pr = await innertube('player', {
        videoId,
        playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
        contentCheckOk: true,
        racyCheckOk: true,
      }, { client: CLIENTS[name], fetch, hl, visitorData });
      const err = playabilityError(pr);
      if (!err && pr.videoDetails?.videoId === videoId) return { playerResponse: pr, client: name };
      errors.push(`${name}: ${err || 'response for a different video'}`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new YouTubeError(`No usable player response (${errors.join('; ')})`, { errors });
}

/** The /next response holds chapters (playerOverlays, engagementPanels), like ytInitialData. */
export async function getNextResponse(videoId, { fetch, hl, visitorData, clientVersion } = {}) {
  const client = clientVersion ? { ...WEB_CLIENT, client: { ...WEB_CLIENT.client, clientVersion } } : WEB_CLIENT;
  return innertube('next', { videoId }, { client, fetch, hl, visitorData });
}

/** Pull `ytInitialPlayerResponse` / `ytInitialData` JSON out of a watch page's HTML. */
export function extractInitialJson(html, name) {
  const start = html.search(new RegExp(`(?:var\\s+|window\\[["'])${name}(?:["']\\])?\\s*=\\s*\\{`));
  if (start < 0) return null;
  const open = html.indexOf('{', start);
  // Walk braces, respecting strings, to find the end of the object literal.
  let depth = 0;
  let inStr = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(open, i + 1));
  }
  return null;
}

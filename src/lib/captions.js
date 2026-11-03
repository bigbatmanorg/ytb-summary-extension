// Caption track listing, selection and json3 parsing.
import { YT_ORIGIN, YouTubeError } from './innertube.js';

function text(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (obj.simpleText != null) return obj.simpleText;
  return (obj.runs || []).map((r) => r.text).join('');
}

/**
 * Normalised list of caption tracks from a player response's
 * captions.playerCaptionsTracklistRenderer.
 */
export function listCaptionTracks(playerResponse) {
  const r = playerResponse?.captions?.playerCaptionsTracklistRenderer;
  if (!r?.captionTracks) return [];
  const defaultIdx = r.audioTracks?.[r.defaultAudioTrackIndex ?? 0]?.defaultCaptionTrackIndex;
  return r.captionTracks.map((t, i) => {
    const qs = new URL(t.baseUrl, YT_ORIGIN).searchParams;
    const exp = (qs.get('exp') || '').split(',');
    return {
      baseUrl: new URL(t.baseUrl, YT_ORIGIN).href,
      languageCode: t.languageCode,
      name: text(t.name),
      vssId: t.vssId,
      kind: t.kind === 'asr' ? 'asr' : 'manual',
      isTranslatable: !!t.isTranslatable,
      isDefault: i === defaultIdx,
      // yt-dlp's detection of the PO-token experiment for subtitles.
      requiresPoToken: exp.includes('xpe') || exp.includes('xpv'),
    };
  });
}

export function listTranslationLanguages(playerResponse) {
  const r = playerResponse?.captions?.playerCaptionsTracklistRenderer;
  return (r?.translationLanguages || []).map((l) => ({ languageCode: l.languageCode, name: text(l.languageName) }));
}

const base = (code) => (code || '').toLowerCase().split('-')[0];

/**
 * Pick the track that best represents the spoken content:
 * manual track in the preferred language > ASR (auto) track in the original language
 * > manual track flagged default > any manual > any.
 */
export function pickTrack(tracks, { preferLang } = {}) {
  if (!tracks.length) return null;
  const asr = tracks.find((t) => t.kind === 'asr');
  const spoken = asr ? base(asr.languageCode) : null;
  const wanted = preferLang ? base(preferLang) : spoken;
  return (
    tracks.find((t) => t.kind === 'manual' && wanted && base(t.languageCode) === wanted)
    || (asr && (!wanted || base(asr.languageCode) === wanted) && asr)
    || tracks.find((t) => t.kind === 'manual' && t.isDefault)
    || tracks.find((t) => t.kind === 'manual')
    || tracks[0]
  );
}

/** Build the timedtext URL. `tlang` = machine translation, `pot` = PO token params. */
export function buildTimedtextUrl(track, { fmt = 'json3', tlang, pot } = {}) {
  const u = new URL(track.baseUrl, YT_ORIGIN);
  u.searchParams.set('fmt', fmt);
  // yt-dlp drops xosf: it adds positioning noise to json3/vtt.
  u.searchParams.delete('xosf');
  // Setting tlang to the track's own language returns damaged subtitles (yt-dlp note).
  if (tlang && base(tlang) !== base(track.languageCode)) u.searchParams.set('tlang', tlang);
  if (pot?.pot) {
    u.searchParams.set('pot', pot.pot);
    u.searchParams.set('potc', '1');
    if (pot.c) u.searchParams.set('c', pot.c);
  }
  return u.href;
}

const clean = (s) => s.replace(/​/g, '').replace(/\s+/g, ' ').trim();

/**
 * Parse YouTube's json3 timedtext into segments {start, end, text} (seconds).
 * ASR tracks come as "window" events (with wWinId) plus word-level events and
 * "\n" append events; we keep events with text and drop pure line breaks.
 */
export function parseJson3(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const out = [];
  for (const ev of data?.events || []) {
    if (!ev.segs) continue;
    const t = clean(ev.segs.map((s) => s.utf8 || '').join(''));
    if (!t) continue;
    const start = (ev.tStartMs || 0) / 1000;
    const end = ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000;
    out.push({ start, end, text: t });
  }
  // ASR events overlap (each line stays on screen until the next-but-one); clamp ends.
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start;
  }
  return out;
}

/** Parse WebVTT (also what OpenAI-style STT returns with response_format=vtt). */
export function parseVtt(vtt) {
  const out = [];
  const ts = (s) => {
    const p = s.trim().split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  };
  for (const block of vtt.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const t = clean(lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, ''));
    if (t) out.push({ start: ts(a), end: ts(b.trim().split(/\s/)[0]), text: t });
  }
  return out;
}

/**
 * Fetch a track as json3 and parse it. Throws a YouTubeError with
 * code 'PO_TOKEN_REQUIRED' when YouTube answers with an empty body (which is what
 * /api/timedtext does for `exp=xpe` URLs without a valid pot).
 */
export async function fetchTranscript(track, { fetch = globalThis.fetch, tlang, pot } = {}) {
  const res = await fetch(buildTimedtextUrl(track, { tlang, pot }), { credentials: 'omit' });
  if (!res.ok) throw new YouTubeError(`timedtext HTTP ${res.status}`, { status: res.status });
  const body = await res.text();
  if (!body.trim()) {
    throw new YouTubeError(
      track.requiresPoToken && !pot ? 'Caption track needs a PO token' : 'Empty caption response',
      { code: track.requiresPoToken && !pot ? 'PO_TOKEN_REQUIRED' : 'EMPTY' },
    );
  }
  return parseJson3(body);
}

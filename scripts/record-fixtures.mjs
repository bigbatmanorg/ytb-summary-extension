// Re-record the test fixtures from live YouTube (run rarely; YouTube rate-limits).
//   node scripts/record-fixtures.mjs
// URLs are sanitized (ip, signature, ei…) and large parts are trimmed away.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getPlayerResponse, getNextResponse, listCaptionTracks, buildTimedtextUrl, getAudioUrl } from '../src/lib/youtube.js';

const dir = join(import.meta.dirname, '..', 'test', 'fixtures');
mkdirSync(dir, { recursive: true });
// Belt and braces: no IP address of the recording machine may end up in the repo.
const scrubIps = (t) => t
  .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => (/^(0\.0\.0\.0|\d+\.\d+\.\d+\.\d+)$/.test(ip) && !ip.startsWith('0.') ? '0.0.0.0' : ip))
  .replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){4,7}\b/gi, '::')
  .replace(/\b[0-9a-f]{1,4}(?:%3A[0-9a-f]{0,4}){4,7}\b/gi, '%3A%3A');
const save = (name, data) => writeFileSync(join(dir, name), scrubIps(typeof data === 'string' ? data : `${JSON.stringify(data, null, 1)}\n`));

function sanitizeUrl(url) {
  const u = new URL(url);
  for (const k of ['ip', 'signature', 'sig', 'ei', 'key', 'opi', 'sparams', 'lsig', 'expire', 'mn', 'ms', 'mv', 'initcwndbps', 'pl', 'rms', 'id', 'pcm2', 'bui', 'spc', 'vprv', 'svpuc', 'xpc', 'lsparams', 'met', 'mh', 'mm', 'ipbits']) {
    if (u.searchParams.has(k)) u.searchParams.set(k, k === 'ip' ? '0.0.0.0' : 'x');
  }
  if (u.hostname.endsWith('googlevideo.com')) u.hostname = 'rr1---sn-example.googlevideo.com';
  return u.href;
}
function slimPlayerResponse(pr) {
  const keep = ({ itag, mimeType, contentLength, approxDurationMs, initRange, indexRange, url, signatureCipher, audioTrack, bitrate }) =>
    ({ itag, mimeType, contentLength, approxDurationMs, initRange, indexRange, bitrate, audioTrack, ...(url ? { url: sanitizeUrl(url) } : {}), ...(signatureCipher ? { signatureCipher: 'x' } : {}) });
  const ctr = pr.captions?.playerCaptionsTracklistRenderer;
  return {
    playabilityStatus: { status: pr.playabilityStatus.status },
    videoDetails: pr.videoDetails && { ...pr.videoDetails, thumbnail: undefined, keywords: undefined },
    captions: ctr && {
      playerCaptionsTracklistRenderer: {
        ...ctr,
        captionTracks: ctr.captionTracks?.map((t) => ({ ...t, baseUrl: sanitizeUrl(new URL(t.baseUrl, 'https://www.youtube.com').href) })),
        translationLanguages: ctr.translationLanguages?.slice(0, 5),
      },
    },
    streamingData: pr.streamingData && {
      adaptiveFormats: pr.streamingData.adaptiveFormats?.filter((f) => f.mimeType.startsWith('audio/')).map(keep),
      serverAbrStreamingUrl: pr.streamingData.serverAbrStreamingUrl ? 'https://rr1---sn-example.googlevideo.com/videoplayback?sabr=1' : undefined,
    },
  };
}

// 1. Player response + caption structure. The ASR track's words are replaced by
//    placeholders ("w1 w2 …") so no song lyrics end up in the repo; timing and
//    event structure (wWinId windows, aAppend line breaks, tOffsetMs words) are real.
const ID = 'dQw4w9WgXcQ';
const { playerResponse } = await getPlayerResponse(ID);
save(`player-${ID}.json`, slimPlayerResponse(playerResponse));
const asr = listCaptionTracks(playerResponse).find((t) => t.kind === 'asr');
const j = JSON.parse(await (await fetch(buildTimedtextUrl(asr))).text());
let n = 0;
for (const ev of j.events || []) for (const seg of ev.segs || []) {
  if (seg.utf8 && seg.utf8.trim()) seg.utf8 = seg.utf8.replace(/\S+/g, () => `w${++n}`);
}
j.events = j.events.slice(0, 60);
save(`json3-${ID}-asr.json`, j);
// The manual English track of "Me at the zoo" (19 s of speech) is recorded by
// hand from a browser session, see test/fixtures/README.md.

// 2. The audio head (init + sidx) of an audio-only stream, for the sidx parser.
const audio = getAudioUrl(playerResponse);
const head = new Uint8Array(await (await fetch(audio.url, { headers: { range: `bytes=0-${audio.indexRange.end}` } })).arrayBuffer());
writeFileSync(join(dir, `audio-head-${ID}.bin`), head);
save(`audio-head-${ID}.meta.json`, { itag: audio.itag, contentLength: audio.contentLength, initRange: audio.initRange, indexRange: audio.indexRange, durationSec: audio.durationSec });

// 3. Chapters: /next for a long video with chapters, trimmed to the chapter parts.
const next = await getNextResponse('iKx3gAODybU');
save('next-iKx3gAODybU.json', {
  playerOverlays: { playerOverlayRenderer: { decoratedPlayerBarRenderer: next.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer } },
  engagementPanels: next.engagementPanels?.filter((p) => p.engagementPanelSectionListRenderer?.content?.macroMarkersListRenderer),
});
console.log('fixtures written to', dir);

// Audio stream selection and chunked download for the speech-to-text fallback.
//
// JS-less InnerTube clients (ANDROID_VR, VISIONOS) return plain `url`s: no
// signatureCipher and no `n` parameter, so nothing needs deciphering. YouTube
// throttles one-shot downloads of whole files to about playback speed, so like
// yt-dlp (http_chunk_size = 10 MiB) we fetch in Range-requested pieces.

export const CHUNK_SIZE = 10 << 20;

// Smallest first: we only need speech. 139 = AAC 48k (m4a), 140 = AAC 128k,
// 249/250/251 = Opus in WebM.
const ITAG_PREFERENCE = [139, 140, 249, 250, 251];

/**
 * Pick an audio-only format with a directly usable URL.
 * Returns {url, itag, mimeType, container, contentLength, durationSec, initRange, indexRange}
 * or {error} explaining why none is usable.
 */
export function getAudioUrl(playerResponse) {
  const sd = playerResponse?.streamingData;
  if (!sd) return { error: 'No streamingData in player response' };
  const audio = (sd.adaptiveFormats || []).filter((f) => f.mimeType?.startsWith('audio/'));
  if (!audio.length) {
    return { error: sd.serverAbrStreamingUrl ? 'Only SABR streaming offered (no plain audio URLs)' : 'No audio formats' };
  }
  const usable = audio.filter((f) => f.url && !new URL(f.url).searchParams.has('n'));
  if (!usable.length) {
    return { error: audio.some((f) => f.signatureCipher)
      ? 'Audio URLs are signature-ciphered (needs the player JS to decipher)'
      : 'Audio URLs carry an n-challenge (needs the player JS to solve)' };
  }
  // Prefer the original-language track when a video has dubbed audio tracks.
  const orig = usable.filter((f) => !f.audioTrack || f.audioTrack.audioIsDefault);
  const pool = orig.length ? orig : usable;
  pool.sort((a, b) => {
    const ia = ITAG_PREFERENCE.indexOf(a.itag), ib = ITAG_PREFERENCE.indexOf(b.itag);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || Number(a.contentLength || 0) - Number(b.contentLength || 0);
  });
  const f = pool[0];
  const range = (r) => (r ? { start: Number(r.start), end: Number(r.end) } : null);
  return {
    url: f.url,
    itag: f.itag,
    mimeType: f.mimeType,
    container: f.mimeType.includes('mp4') ? 'mp4' : 'webm',
    contentLength: Number(f.contentLength) || null,
    durationSec: Number(f.approxDurationMs) / 1000 || Number(playerResponse.videoDetails?.lengthSeconds) || null,
    initRange: range(f.initRange),
    indexRange: range(f.indexRange),
  };
}

/** Parse an ISO-BMFF `sidx` box. `offset` = absolute file offset of the box. */
export function parseSidx(buf, offset = 0) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const size = dv.getUint32(0);
  const type = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
  if (type !== 'sidx') throw new Error(`expected sidx box, got ${type}`);
  const version = buf[8];
  const timescale = dv.getUint32(16);
  let p = 20;
  let earliest, firstOffset;
  if (version === 0) {
    earliest = dv.getUint32(p); firstOffset = dv.getUint32(p + 4); p += 8;
  } else {
    earliest = Number(dv.getBigUint64(p)); firstOffset = Number(dv.getBigUint64(p + 8)); p += 16;
  }
  const count = dv.getUint16(p + 2);
  p += 4;
  const refs = [];
  let byte = offset + size + firstOffset;
  let t = earliest;
  for (let i = 0; i < count; i++, p += 12) {
    const sizeWord = dv.getUint32(p);
    const dur = dv.getUint32(p + 4);
    const len = sizeWord & 0x7fffffff;
    refs.push({ start: byte, end: byte + len - 1, t0: t / timescale, t1: (t + dur) / timescale });
    byte += len;
    t += dur;
  }
  return refs;
}

/** Group sidx references into pieces of at most `maxBytes` (plus the init segment). */
export function planChunks(refs, maxBytes) {
  const chunks = [];
  let cur = null;
  for (const r of refs) {
    if (cur && r.end - cur.start + 1 > maxBytes) {
      chunks.push(cur);
      cur = null;
    }
    cur = cur ? { ...cur, end: r.end, t1: r.t1 } : { ...r };
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function fetchRange(url, start, end, fetch, signal) {
  const out = [];
  for (let a = start; a <= end; a += CHUNK_SIZE) {
    const b = Math.min(end, a + CHUNK_SIZE - 1);
    const res = await fetch(url, { headers: { range: `bytes=${a}-${b}` }, credentials: 'omit', signal });
    if (!res.ok) throw new Error(`audio download HTTP ${res.status}`);
    out.push(new Uint8Array(await res.arrayBuffer()));
  }
  return concat(out);
}

function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Download audio as a list of standalone, individually decodable files, each at
 * most ~maxBytes, with their time offsets. For fragmented MP4 (the usual DASH
 * audio) every piece is init segment + a run of whole moof/mdat fragments, so
 * no re-encoding is needed. Yields {bytes, t0, t1, mimeType, ext}.
 */
export async function* downloadAudioChunks(audio, { fetch = globalThis.fetch, maxBytes = 20 << 20, signal, onProgress } = {}) {
  const ext = audio.container === 'mp4' ? 'm4a' : 'webm';
  const mimeType = audio.container === 'mp4' ? 'audio/mp4' : 'audio/webm';
  const total = audio.contentLength;
  if (total && total <= maxBytes || !audio.indexRange || audio.container !== 'mp4') {
    if (total && total > maxBytes) {
      throw new Error(`Audio is ${(total / 1048576).toFixed(1)} MB and cannot be split (no MP4 index)`);
    }
    const bytes = total
      ? await fetchRange(audio.url, 0, total - 1, fetch, signal)
      : new Uint8Array(await (await fetch(audio.url, { credentials: 'omit', signal })).arrayBuffer());
    onProgress?.(1);
    yield { bytes, t0: 0, t1: audio.durationSec, mimeType, ext };
    return;
  }
  const head = await fetchRange(audio.url, 0, audio.indexRange.end, fetch, signal);
  const init = head.slice(0, audio.initRange.end + 1);
  const refs = parseSidx(head.slice(audio.indexRange.start), audio.indexRange.start);
  const chunks = planChunks(refs, maxBytes - init.length);
  let done = 0;
  for (const c of chunks) {
    const body = await fetchRange(audio.url, c.start, c.end, fetch, signal);
    done += 1;
    onProgress?.(done / chunks.length);
    yield { bytes: concat([init, body]), t0: c.t0, t1: c.t1, mimeType, ext };
  }
}

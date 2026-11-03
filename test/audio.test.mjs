import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAudioUrl, parseSidx, planChunks, downloadAudioChunks } from '../src/lib/audio.js';
import { fixture, json, fakeFetch } from './helpers.mjs';

const pr = json('player-dQw4w9WgXcQ.json');
const meta = json('audio-head-dQw4w9WgXcQ.meta.json');
const head = new Uint8Array(fixture('audio-head-dQw4w9WgXcQ.bin'));

test('getAudioUrl picks the smallest m4a audio with a plain URL', () => {
  const a = getAudioUrl(pr);
  assert.equal(a.itag, 139);
  assert.equal(a.container, 'mp4');
  assert.ok(a.url.includes('googlevideo.com'));
  assert.deepEqual(a.indexRange, meta.indexRange);
});

test('getAudioUrl explains why nothing is usable', () => {
  assert.match(getAudioUrl({}).error, /streamingData/);
  assert.match(getAudioUrl({ streamingData: { serverAbrStreamingUrl: 'x', adaptiveFormats: [] } }).error, /SABR/);
  const ciphered = { streamingData: { adaptiveFormats: [{ itag: 140, mimeType: 'audio/mp4', signatureCipher: 's=..' }] } };
  assert.match(getAudioUrl(ciphered).error, /signature/);
  const nparam = { streamingData: { adaptiveFormats: [{ itag: 140, mimeType: 'audio/mp4', url: 'https://x.googlevideo.com/videoplayback?n=abc' }] } };
  assert.match(getAudioUrl(nparam).error, /n-challenge/);
});

test('parseSidx reads fragment byte ranges and times', () => {
  const refs = parseSidx(head.slice(meta.indexRange.start), meta.indexRange.start);
  assert.ok(refs.length > 10);
  assert.equal(refs[0].start, meta.indexRange.end + 1);
  assert.equal(refs[0].t0, 0);
  assert.equal(refs.at(-1).end, meta.contentLength - 1);
  assert.ok(Math.abs(refs.at(-1).t1 - meta.durationSec) < 1);
  for (let i = 1; i < refs.length; i++) assert.equal(refs[i].start, refs[i - 1].end + 1);
});

test('planChunks keeps whole fragments under the byte budget', () => {
  const refs = parseSidx(head.slice(meta.indexRange.start), meta.indexRange.start);
  const chunks = planChunks(refs, 400_000);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.end - c.start + 1 <= 400_000));
  assert.equal(chunks[0].start, refs[0].start);
  assert.equal(chunks.at(-1).end, refs.at(-1).end);
  assert.equal(chunks[1].t0, chunks[0].t1);
});

test('downloadAudioChunks yields init segment + fragments with ranges', async () => {
  const audio = getAudioUrl(pr);
  const fetch = fakeFetch([[() => true, (url, init) => {
    const [, a, b] = init.headers.range.match(/bytes=(\d+)-(\d+)/).map(Number);
    if (b <= meta.indexRange.end) return { status: 206, body: head.slice(a, b + 1) };
    return { status: 206, body: new Uint8Array(b - a + 1).fill(7) };
  }]]);
  const chunks = [];
  for await (const c of downloadAudioChunks(audio, { fetch, maxBytes: 500_000 })) chunks.push(c);
  assert.ok(chunks.length >= 3);
  const initLen = meta.initRange.end + 1;
  for (const c of chunks) {
    assert.deepEqual(c.bytes.slice(0, initLen), head.slice(0, initLen));
    assert.equal(String.fromCharCode(...c.bytes.slice(4, 8)), 'ftyp');
    assert.equal(c.ext, 'm4a');
  }
  const total = chunks.reduce((s, c) => s + c.bytes.length - initLen, 0);
  assert.equal(total, meta.contentLength - meta.indexRange.end - 1);
  // No single HTTP request asks for more than 10 MiB.
  assert.ok(fetch.calls.every((c) => { const [, a, b] = c.init.headers.range.match(/(\d+)-(\d+)/).map(Number); return b - a < 10 << 20; }));
});

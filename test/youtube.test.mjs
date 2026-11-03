import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadVideo, parseVideoId, extractInitialJson, getPlayerResponse } from '../src/lib/youtube.js';
import { fixture, json, fakeFetch } from './helpers.mjs';

const pr = json('player-dQw4w9WgXcQ.json');
const next = json('next-iKx3gAODybU.json');
const zoo = fixture('json3-jNQXAC9IVRw-en.json');
const ID = 'dQw4w9WgXcQ';

const botCheck = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } };
const webPr = { videoDetails: pr.videoDetails, streamingData: { serverAbrStreamingUrl: 'x' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [
  { baseUrl: `/api/timedtext?v=${ID}&exp=xpe&lang=en`, languageCode: 'en', name: { simpleText: 'English' }, vssId: '.en' },
] } } };

test('parseVideoId', () => {
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1'), ID);
  assert.equal(parseVideoId('https://youtu.be/dQw4w9WgXcQ'), ID);
  assert.equal(parseVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), ID);
  assert.equal(parseVideoId('https://www.youtube.com/feed'), null);
});

test('extractInitialJson finds ytInitialPlayerResponse with braces in strings', () => {
  const html = '<script>var ytInitialPlayerResponse = {"a":"}{","b":{"c":1}};var x=1;</script>';
  assert.deepEqual(extractInitialJson(html, 'ytInitialPlayerResponse'), { a: '}{', b: { c: 1 } });
  assert.equal(extractInitialJson('<html></html>', 'ytInitialData'), null);
});

test('getPlayerResponse sends the ANDROID_VR context and falls through on bot checks', async () => {
  const fetch = fakeFetch([[(u) => u.includes('/player'), (u, init) => {
    const body = JSON.parse(init.body);
    return { body: body.context.client.clientName === 'ANDROID_VR' ? botCheck : pr };
  }]]);
  const r = await getPlayerResponse(ID, { fetch, visitorData: 'VD' });
  assert.equal(r.client, 'VISIONOS');
  const first = fetch.calls[0];
  assert.equal(first.init.credentials, 'omit');
  assert.equal(first.init.headers['x-youtube-client-name'], '28');
  assert.equal(first.init.headers['x-goog-visitor-id'], 'VD');
  assert.equal(JSON.parse(first.init.body).videoId, ID);
});

test('loadVideo: InnerTube path', async () => {
  const fetch = fakeFetch([
    [(u) => u.includes('/youtubei/v1/player'), () => ({ body: pr })],
    [(u) => u.includes('/youtubei/v1/next'), () => ({ body: next })],
    [(u) => u.includes('/api/timedtext'), () => ({ body: zoo })],
  ]);
  const r = await loadVideo(ID, { fetch });
  assert.equal(r.client, 'ANDROID_VR');
  assert.equal(r.track.vssId, '.en');
  assert.equal(r.segments.length, 6);
  assert.equal(r.chapterSource, 'youtube');
  assert.equal(r.meta.videoId, ID);
});

test('loadVideo: bot-checked InnerTube falls back to the page player + PO token', async () => {
  const fetch = fakeFetch([
    [(u) => u.includes('/youtubei/v1/player'), () => ({ body: botCheck })],
    [(u) => u.includes('/youtubei/v1/next'), () => ({ status: 500, body: 'x' })],
    [(u) => u.includes('/api/timedtext') && u.includes('pot=PAGE'), () => ({ body: zoo })],
    [(u) => u.includes('/api/timedtext'), () => ({ body: '' })],
  ]);
  const page = {
    getPlayerResponse: async () => webPr,
    getPoToken: async () => ({ pot: 'PAGE', c: 'WEB' }),
    getInitialData: async () => next,
  };
  const r = await loadVideo(ID, { fetch, page });
  assert.equal(r.client, 'page');
  assert.equal(r.segments.length, 6);
  assert.equal(r.chapterSource, 'youtube');
  assert.ok(r.log.some((l) => l.includes('PO token')));
});

test('loadVideo: page tracks without xpe are used directly, without InnerTube', async () => {
  const plain = structuredClone(webPr);
  plain.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl = `/api/timedtext?v=${ID}&lang=en`;
  const fetch = fakeFetch([
    [(u) => u.includes('/api/timedtext'), () => ({ body: zoo })],
    [(u) => u.includes('/youtubei/v1/next'), () => ({ body: next })],
  ]);
  const r = await loadVideo(ID, { fetch, page: { getPlayerResponse: async () => plain } });
  assert.equal(r.segments.length, 6);
  assert.ok(!fetch.calls.some((c) => c.url.includes('/player')));
});

test('loadVideo: no captions anywhere -> segments null, tracks empty (STT case)', async () => {
  const noCaps = { ...pr, captions: undefined };
  const fetch = fakeFetch([
    [(u) => u.includes('/youtubei/v1/player'), () => ({ body: noCaps })],
    [(u) => u.includes('/youtubei/v1/next'), () => ({ body: {} })],
  ]);
  const r = await loadVideo(ID, { fetch });
  assert.equal(r.segments, null);
  assert.deepEqual(r.tracks, []);
  assert.equal(r.client, 'ANDROID_VR');
});

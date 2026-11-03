import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listCaptionTracks, pickTrack, buildTimedtextUrl, parseJson3, parseVtt, fetchTranscript } from '../src/lib/captions.js';
import { fixture, json, fakeFetch } from './helpers.mjs';

const pr = json('player-dQw4w9WgXcQ.json');

test('listCaptionTracks normalises tracks from the ANDROID_VR player response', () => {
  const tracks = listCaptionTracks(pr);
  assert.ok(tracks.length >= 2);
  const asr = tracks.find((t) => t.kind === 'asr');
  assert.equal(asr.languageCode, 'en');
  assert.equal(asr.vssId, 'a.en');
  assert.match(asr.name, /auto-generated/);
  assert.ok(tracks.every((t) => t.baseUrl.startsWith('https://www.youtube.com/api/timedtext?')));
  // JS-less client tracks do not carry the PO-token experiment.
  assert.ok(tracks.every((t) => t.requiresPoToken === false));
});

test('listCaptionTracks flags exp=xpe tracks as needing a PO token', () => {
  const web = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { baseUrl: '/api/timedtext?v=abc&exp=xpo,xwmhp,xpe&lang=en', languageCode: 'en', name: { simpleText: 'English' }, vssId: '.en' },
  ] } } };
  const [t] = listCaptionTracks(web);
  assert.equal(t.requiresPoToken, true);
  assert.equal(t.name, 'English');
});

test('listCaptionTracks returns [] without captions', () => {
  assert.deepEqual(listCaptionTracks({}), []);
  assert.deepEqual(listCaptionTracks(null), []);
});

test('pickTrack prefers a manual track in the spoken language over ASR', () => {
  const tracks = listCaptionTracks(pr);
  assert.equal(pickTrack(tracks).vssId, '.en');
  assert.equal(pickTrack(tracks, { preferLang: 'ja' }).languageCode, 'ja');
  const asrOnly = tracks.filter((t) => t.kind === 'asr');
  assert.equal(pickTrack(asrOnly).kind, 'asr');
  assert.equal(pickTrack([]), null);
});

test('buildTimedtextUrl sets fmt, tlang, pot and drops xosf', () => {
  const t = { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&lang=en&xosf=1', languageCode: 'en' };
  const u = new URL(buildTimedtextUrl(t, { tlang: 'de', pot: { pot: 'TOKEN', c: 'WEB' } }));
  assert.equal(u.searchParams.get('fmt'), 'json3');
  assert.equal(u.searchParams.get('tlang'), 'de');
  assert.equal(u.searchParams.get('pot'), 'TOKEN');
  assert.equal(u.searchParams.get('potc'), '1');
  assert.equal(u.searchParams.get('c'), 'WEB');
  assert.equal(u.searchParams.has('xosf'), false);
  // tlang equal to the track language is skipped (YouTube returns damaged subs).
  assert.equal(new URL(buildTimedtextUrl(t, { tlang: 'en-US' })).searchParams.has('tlang'), false);
});

test('parseJson3: manual track', () => {
  const segs = parseJson3(fixture('json3-jNQXAC9IVRw-en.json'));
  assert.equal(segs.length, 6);
  assert.deepEqual(segs[0], { start: 1.2, end: 3.36, text: 'All right, so here we are, in front of the elephants' });
  assert.equal(segs.at(-1).text, "and that's pretty much all there is to say");
});

test('parseJson3: ASR track drops window/newline events and clamps overlaps', () => {
  const segs = parseJson3(fixture('json3-dQw4w9WgXcQ-asr.json'));
  assert.ok(segs.length > 10);
  assert.ok(segs.every((s) => s.text && !s.text.includes('\n')));
  assert.equal(segs[1].text, 'w2 w3 w4 w5');
  for (let i = 1; i < segs.length; i++) {
    assert.ok(segs[i].start >= segs[i - 1].start);
    assert.ok(segs[i - 1].end <= segs[i].start + 1e-9);
  }
});

test('parseVtt handles hour timestamps, cue settings and tags', () => {
  const segs = parseVtt('WEBVTT\n\n00:00:18.800 --> 00:00:20.720 align:start\n<c>Hello</c> there\n\n1\n01:02:03.500 --> 01:02:05.000\nLate line\n');
  assert.deepEqual(segs, [
    { start: 18.8, end: 20.72, text: 'Hello there' },
    { start: 3723.5, end: 3725, text: 'Late line' },
  ]);
});

test('fetchTranscript reports PO_TOKEN_REQUIRED for empty xpe responses', async () => {
  const fetch = fakeFetch([[() => true, () => ({ body: '' })]]);
  const track = { baseUrl: 'https://www.youtube.com/api/timedtext?v=x&exp=xpe', languageCode: 'en', requiresPoToken: true };
  await assert.rejects(fetchTranscript(track, { fetch }), (e) => e.code === 'PO_TOKEN_REQUIRED');
  const fetch2 = fakeFetch([[(u) => u.includes('pot=P'), () => ({ body: fixture('json3-jNQXAC9IVRw-en.json') })]]);
  const segs = await fetchTranscript(track, { fetch: fetch2, pot: { pot: 'P', c: 'WEB' } });
  assert.equal(segs.length, 6);
});

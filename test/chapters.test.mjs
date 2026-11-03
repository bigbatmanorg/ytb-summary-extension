import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getChapters, chaptersFromPlayerBar, chaptersFromEngagementPanels, chaptersFromDescription, parseTimestamp, formatTimestamp, normalizeChapters } from '../src/lib/chapters.js';
import { json } from './helpers.mjs';

const next = json('next-iKx3gAODybU.json');
const pr = { videoDetails: { lengthSeconds: '7404', shortDescription: '' } };

test('timestamps', () => {
  assert.equal(parseTimestamp('1:02:03'), 3723);
  assert.equal(parseTimestamp('0:07'), 7);
  assert.equal(parseTimestamp('abc'), null);
  assert.equal(formatTimestamp(3723.9), '1:02:03');
  assert.equal(formatTimestamp(65), '1:05');
});

test('player bar chapters (multiMarkersPlayerBarRenderer / DESCRIPTION_CHAPTERS)', () => {
  const c = chaptersFromPlayerBar(next, 7404);
  assert.ok(c.length >= 5);
  assert.equal(c[0].start, 0);
  assert.ok(c[0].title.length > 0);
  assert.equal(c.at(-1).end, 7404);
  for (let i = 1; i < c.length; i++) assert.ok(c[i].start > c[i - 1].start && c[i - 1].end === c[i].start);
});

test('engagement panel chapters agree with the player bar', () => {
  const a = chaptersFromPlayerBar(next, 7404);
  const b = chaptersFromEngagementPanels(next, 7404);
  assert.deepEqual(b.map((x) => x.start), a.map((x) => x.start));
});

test('legacy chapteredPlayerBarRenderer layout', () => {
  const data = { playerOverlays: { playerOverlayRenderer: { decoratedPlayerBarRenderer: { decoratedPlayerBarRenderer: { playerBar: { chapteredPlayerBarRenderer: { chapters: [
    { chapterRenderer: { title: { simpleText: 'Intro' }, timeRangeStartMillis: 0 } },
    { chapterRenderer: { title: { simpleText: 'Main' }, timeRangeStartMillis: 61000 } },
  ] } } } } } } };
  assert.deepEqual(chaptersFromPlayerBar(data, 120), [{ start: 0, title: 'Intro', end: 61 }, { start: 61, title: 'Main', end: 120 }]);
});

test('description chapters: "time title" and "title time" lines', () => {
  const d1 = 'Links below\n0:00 Intro\n1:30 - Setup\n12:05 – Results\n1:02:00 Q&A\nthanks';
  assert.deepEqual(chaptersFromDescription(d1, 4000).map((c) => [c.start, c.title]), [[0, 'Intro'], [90, 'Setup'], [725, 'Results'], [3720, 'Q&A']]);
  const d2 = 'Intro 0:00\nThe middle part 3:10\n';
  assert.deepEqual(chaptersFromDescription(d2, 400).map((c) => [c.start, c.title]), [[0, 'Intro'], [190, 'The middle part']]);
  assert.deepEqual(chaptersFromDescription('see 1:30 for the fun part', 400), []);
  // Out-of-range timestamps are dropped.
  assert.deepEqual(chaptersFromDescription('0:00 a\n9:00 b\n', 300).map((c) => c.start), []);
});

test('normalizeChapters drops descending / duplicate starts', () => {
  const c = normalizeChapters([{ start: 0, title: 'a' }, { start: 50, title: 'b' }, { start: 20, title: 'x' }, { start: 50, title: 'dup' }, { start: 80, title: 'c' }], 100);
  assert.deepEqual(c.map((x) => x.title), ['a', 'b', 'c']);
});

test('getChapters picks the first available source', () => {
  assert.equal(getChapters({ nextData: next, playerResponse: pr }).source, 'youtube');
  const withDesc = { videoDetails: { lengthSeconds: '300', shortDescription: '0:00 Start\n2:00 End' } };
  assert.deepEqual(getChapters({ nextData: {}, playerResponse: withDesc }), {
    source: 'description', chapters: [{ start: 0, title: 'Start', end: 120 }, { start: 120, title: 'End', end: 300 }],
  });
  assert.deepEqual(getChapters({ nextData: null, playerResponse: {} }), { chapters: [], source: null });
});

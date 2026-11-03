import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactTranscript, splitText, parseModelReply, chaptersFromModel, buildTierMessages, parseVerdict, readingTime, VideoSummarizer, TIER_IDS } from '../src/lib/summarize.js';
import { renderMarkdown } from '../src/panel/md.js';

const segs = [
  { start: 0, end: 2, text: 'hello' }, { start: 10, end: 12, text: 'world' },
  { start: 31, end: 33, text: 'second' }, { start: 3700, end: 3701, text: 'late' },
];

test('compactTranscript merges into timestamped blocks', () => {
  assert.equal(compactTranscript(segs, 30), '[0:00] hello world\n[0:31] second\n[1:01:40] late');
});

test('splitText splits on line boundaries', () => {
  const parts = splitText('aaaa\nbbbb\ncccc', 9);
  assert.deepEqual(parts, ['aaaa\nbbbb', 'cccc']);
});

test('parseModelReply: SUMMARY/CHAPTERS sections', () => {
  const r = parseModelReply('<think>plan {x}</think>\nSUMMARY:\nOverview „quoted" text.\n\n## Key points\n- one [0:05]\n\nCHAPTERS:\n0:00 Intro\n- [1:30] – Middle part\n2. 1:02:03: **Late**\nnot a chapter\n');
  assert.equal(r.summary, 'Overview „quoted" text.\n\n## Key points\n- one [0:05]');
  assert.deepEqual(r.chapters, [{ start: '0:00', title: 'Intro' }, { start: '1:30', title: 'Middle part' }, { start: '1:02:03', title: 'Late' }]);
});

test('parseModelReply: JSON (fenced) and plain text fallbacks', () => {
  assert.deepEqual(parseModelReply('```json\n{"summary":"x","chapters":[{"start":"0:00","title":"A"}]}\n```'), { summary: 'x', chapters: [{ start: '0:00', title: 'A' }] });
  assert.deepEqual(parseModelReply('Just text'), { summary: 'Just text', chapters: [] });
  assert.deepEqual(parseModelReply('**SUMMARY:**\nHi\n**CHAPTERS:**\n0:00 Start'), { summary: 'Hi', chapters: [{ start: '0:00', title: 'Start' }] });
});

test('chaptersFromModel parses m:ss strings and sorts', () => {
  const c = chaptersFromModel([{ start: '[1:00]', title: 'B' }, { start: '0:00', title: 'A' }, { start: 'bad', title: 'X' }], 120);
  assert.deepEqual(c, [{ start: 0, title: 'A', end: 60 }, { start: 60, title: 'B', end: 120 }]);
});

const meta = { videoId: 'x', title: 'T', channel: 'C', duration: 600 };

test('tier prompts share the transcript prefix and differ only in the task', () => {
  const opts = { meta, body: '[0:00] hello', words: 400, language: 'Deutsch' };
  const [q, sh, lg] = ['quick', 'short', 'long'].map((t) => buildTierMessages(t, { ...opts, needChapters: true }));
  assert.equal(q[0].content, sh[0].content);
  const prefix = (m) => m[1].content.slice(0, m[1].content.indexOf('</transcript>'));
  assert.equal(prefix(q), prefix(sh));
  assert.equal(prefix(sh), prefix(lg));
  assert.match(q[1].content, /VERDICT: WATCH \| SKIM \| SKIP/);
  assert.match(sh[1].content, /CHAPTERS:/);
  assert.doesNotMatch(q[1].content, /CHAPTERS:/);
  assert.match(lg[1].content, /## Main topics/);
  assert.match(lg[1].content, /Deutsch/);
  assert.doesNotMatch(buildTierMessages('short', { ...opts, needChapters: false })[1].content, /CHAPTERS:/);
  assert.match(buildTierMessages('quick', { ...opts, language: 'auto' })[1].content, /language of the transcript/);
  assert.throws(() => buildTierMessages('nope', opts));
});

test('parseVerdict', () => {
  assert.deepEqual(parseVerdict('VERDICT: WATCH\n**For:** devs\nGood.'), { verdict: 'WATCH', body: '**For:** devs\nGood.' });
  assert.equal(parseVerdict('**VERDICT:** skim — partly').verdict, 'SKIM');
  assert.deepEqual(parseVerdict('no verdict here'), { verdict: null, body: 'no verdict here' });
});

test('readingTime', () => {
  assert.equal(readingTime('word '.repeat(60)), '~15 s read');
  assert.equal(readingTime('word '.repeat(460)), '~2 min read');
});

/** Fake streamFn: records calls, answers by task, streams in two pieces with some reasoning. */
function fakeStream(answers) {
  const calls = [];
  const fn = async function* (messages, { model }) {
    calls.push({ model, user: messages[1].content });
    const u = messages[1].content;
    const text = u.includes('dense notes') ? '- [0:00] note'
      : u.includes('VERDICT:') ? answers.quick : u.includes('Main topics') ? answers.long : answers.short;
    yield { type: 'reasoning', text: 'hmm' };
    yield { type: 'content', text: text.slice(0, 5) };
    yield { type: 'content', text: text.slice(5) };
  };
  fn.calls = calls;
  return fn;
}
const answers = { quick: 'VERDICT: SKIP\n**For:** nobody', short: 'Overview.\n\n**Key points**\n- a [0:05]\n\nCHAPTERS:\n0:00 Start\n2:00 End', long: '## Overview\nLong.' };
const tierSegs = [{ start: 0, end: 2, text: 'hello' }, { start: 130, end: 132, text: 'world' }];

test('VideoSummarizer: quick tier uses the fast model, others the chat model; short returns chapters', async () => {
  const streamFn = fakeStream(answers);
  const vs = new VideoSummarizer({ segments: tierSegs, meta, settings: { chatModel: 'big', fastModel: 'small', language: 'auto' }, streamFn });
  const events = [];
  const q = await vs.runTier('quick', { onEvent: (ev, soFar) => events.push([ev.type, soFar]) });
  assert.equal(q.text, answers.quick);
  assert.deepEqual(events.map((e) => e[0]), ['reasoning', 'content', 'content']);
  assert.equal(events.at(-1)[1], answers.quick);
  const sh = await vs.runTier('short', { needChapters: true });
  assert.equal(sh.text, 'Overview.\n\n**Key points**\n- a [0:05]');
  assert.deepEqual(sh.chapters, [{ start: 0, title: 'Start', end: 120 }, { start: 120, title: 'End', end: 600 }]);
  const lg = await vs.runTier('long');
  assert.equal(lg.text, '## Overview\nLong.');
  assert.deepEqual(streamFn.calls.map((c) => c.model), ['small', 'big', 'big']);
  // Without a fast model everything uses the chat model.
  const vs2 = new VideoSummarizer({ segments: tierSegs, meta, settings: { chatModel: 'big' }, streamFn });
  assert.equal(vs2.modelFor('quick'), 'big');
});

test('VideoSummarizer: transcript line window scales with video length', () => {
  const segsShort = [{ start: 1, end: 2, text: 'a' }, { start: 7, end: 8, text: 'b' }, { start: 13, end: 14, text: 'c' }];
  const short = new VideoSummarizer({ segments: segsShort, meta: { ...meta, duration: 19 }, settings: {}, streamFn: null });
  assert.equal(short.transcript, '[0:01] a\n[0:07] b\n[0:13] c');
  const long = new VideoSummarizer({ segments: segsShort, meta: { ...meta, duration: 7200 }, settings: {}, streamFn: null });
  assert.equal(long.transcript, '[0:01] a b c');
});

test('VideoSummarizer: long transcripts are condensed once and shared; quick reads only part 1', async () => {
  const streamFn = fakeStream(answers);
  const long = Array.from({ length: 200 }, (_, i) => ({ start: i * 40, end: i * 40 + 5, text: 'x'.repeat(100) }));
  const vs = new VideoSummarizer({ segments: long, meta, settings: { chatModel: 'big', fastModel: 'small' }, streamFn, maxChars: 15000 });
  assert.ok(vs.needsChunking);
  const parts = vs.parts().length;
  const progress = [];
  await Promise.all([
    vs.runTier('quick'),
    vs.runTier('short', { onProgress: (p) => progress.push(p) }),
    vs.runTier('long'),
  ]);
  const notes = streamFn.calls.filter((c) => c.user.includes('dense notes'));
  assert.equal(notes.length, parts, 'notes taken once per part, shared by short and long');
  assert.ok(notes.every((c) => c.model === 'small'));
  const quick = streamFn.calls.find((c) => c.user.includes('VERDICT:'));
  assert.match(quick.user, new RegExp(`part 1 of ${parts}`));
  const short = streamFn.calls.find((c) => c.user.includes('Key points'));
  assert.match(short.user, /<notes>/);
  assert.deepEqual(progress.at(-1), { done: parts, total: parts });
});

test('VideoSummarizer: failed notes can be retried', async () => {
  let fail = true;
  const streamFn = async function* (messages) {
    if (fail && messages[1].content.includes('dense notes')) throw new Error('boom');
    yield { type: 'content', text: 'ok' };
  };
  const long = Array.from({ length: 200 }, (_, i) => ({ start: i * 40, end: i * 40 + 5, text: 'x'.repeat(100) }));
  const vs = new VideoSummarizer({ segments: long, meta, settings: { chatModel: 'big' }, streamFn, maxChars: 15000 });
  await assert.rejects(vs.runTier('long'), /boom/);
  fail = false;
  assert.equal((await vs.runTier('long')).text, 'ok');
  assert.ok(TIER_IDS.includes('long'));
});

test('renderMarkdown escapes HTML and links timestamps', () => {
  const html = renderMarkdown('## Key points\n- **Bold** at [1:05] <script>x</script>\n- two\n\nPara *it*');
  assert.match(html, /<h4>Key points<\/h4>/);
  assert.match(html, /<button class="ts" data-t="1:05">1:05<\/button>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<li>two<\/li>/);
  assert.match(html, /<em>it<\/em>/);
});

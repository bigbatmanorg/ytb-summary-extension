import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactTranscript, splitText, parseModelReply, chaptersFromModel, summarize, buildSummaryMessages } from '../src/lib/summarize.js';
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

test('summary prompt asks for chapters only when needed, in the chosen language', () => {
  const m1 = buildSummaryMessages({ transcript: 't', needChapters: true, language: 'Deutsch', duration: 600 });
  assert.match(m1[0].content, /CHAPTERS:/);
  assert.match(m1[0].content, /Deutsch/);
  const m2 = buildSummaryMessages({ transcript: 't', needChapters: false, language: 'auto' });
  assert.doesNotMatch(m2[0].content, /CHAPTERS:/);
  assert.match(m2[0].content, /language of the transcript/);
});

test('summarize map-reduces long transcripts', async () => {
  const calls = [];
  const chatFn = async (messages) => {
    calls.push(messages);
    return calls.length < 3 ? '- [0:00] note' : 'SUMMARY:\nfinal\n\nCHAPTERS:\n0:00 All';
  };
  const long = Array.from({ length: 200 }, (_, i) => ({ start: i * 40, end: i * 40 + 5, text: 'x'.repeat(100) }));
  const out = await summarize({ segments: long, needChapters: true, duration: 8000, chatFn, maxChars: 15000 });
  assert.ok(calls.length >= 3);
  assert.match(calls.at(-1)[1].content, /Condensed notes/);
  assert.equal(out.summary, 'final');
  assert.deepEqual(out.chapters, [{ start: 0, title: 'All', end: 8000 }]);
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

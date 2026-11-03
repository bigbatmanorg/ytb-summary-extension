// Prompts and response parsing for the summary + chapter timeline.
import { formatTimestamp, normalizeChapters, parseTimestamp } from './chapters.js';

/** Merge caption segments into ~`seconds`-long timestamped lines to save tokens. */
export function compactTranscript(segments, seconds = 30) {
  const lines = [];
  let cur = null;
  for (const s of segments) {
    if (!cur || s.start - cur.start >= seconds) {
      if (cur) lines.push(cur);
      cur = { start: s.start, text: s.text };
    } else {
      cur.text += ` ${s.text}`;
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => `[${formatTimestamp(l.start)}] ${l.text}`).join('\n');
}

/** Split compacted transcript text into pieces of at most maxChars, on line boundaries. */
export function splitText(text, maxChars) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > maxChars) {
      parts.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur) parts.push(cur);
  return parts;
}

function langLine(language) {
  return language && language !== 'auto'
    ? `Write everything in ${language}.`
    : 'Write in the language of the transcript.';
}

// Plain-text sections instead of JSON: reasoning models regularly break JSON
// (e.g. an unescaped " closing a German „quote"), section headers survive that.
export function buildSummaryMessages({ title, channel, transcript, needChapters, language, duration }) {
  return [
    {
      role: 'system',
      content: [
        'You summarize YouTube videos from their transcript. Reply in exactly this format, with nothing before or after:',
        '',
        'SUMMARY:',
        '<one short overview paragraph>',
        '',
        '## Key points',
        '- <4-10 bullets, citing moments as [m:ss] timestamps from the transcript>',
        ...(needChapters ? [
          '',
          'CHAPTERS:',
          '0:00 <title>',
          '<m:ss> <title>',
          '',
          `Chapters: 4-12 lines covering the whole video${duration ? ` (length ${formatTimestamp(duration)})` : ''}, first at 0:00, ascending, start times taken from the transcript timestamps, titles under 8 words. Fewer for very short videos.`,
        ] : []),
        '',
        langLine(language),
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Title: ${title || 'unknown'}\nChannel: ${channel || 'unknown'}\n\nTranscript:\n${transcript}`,
    },
  ];
}

export function buildNotesMessages({ title, part, index, total, language }) {
  return [
    {
      role: 'system',
      content: `You take dense notes on part ${index} of ${total} of a YouTube video transcript. Output 5-15 Markdown bullets, each starting with the [m:ss] timestamp it refers to. Keep names, numbers and claims. ${langLine(language)}`,
    },
    { role: 'user', content: `Title: ${title || 'unknown'}\n\nTranscript part ${index}/${total}:\n${part}` },
  ];
}

const TS = String.raw`(?:\d+:)?\d{1,2}:\d{2}`;
const CHAPTER_LINE = new RegExp(String.raw`^\s*(?:[-*]|\d+[.)])?\s*\[?(${TS})\]?\s*(?:[-–—:|]\s*)?(.+?)\s*$`);

/**
 * Parse the model reply: SUMMARY:/CHAPTERS: sections, or a JSON object
 * {summary, chapters} as a fallback. Strips <think> blocks and code fences.
 */
export function parseModelReply(content) {
  const s = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  const body = (fenced ? fenced[1] : s).trim();
  if (body.startsWith('{')) {
    try {
      const j = JSON.parse(body);
      if (j && typeof j.summary === 'string') return { summary: j.summary, chapters: Array.isArray(j.chapters) ? j.chapters : [] };
    } catch { /* not JSON after all */ }
  }
  const m = body.match(/^\s*(?:\*\*|#+\s*)?CHAPTERS:?(?:\*\*)?\s*$/im);
  const summaryPart = m ? body.slice(0, m.index) : body;
  const chapterPart = m ? body.slice(m.index + m[0].length) : '';
  const chapters = chapterPart.split('\n').map((l) => l.match(CHAPTER_LINE)).filter(Boolean)
    .map((x) => ({ start: x[1], title: x[2].replace(/^\*\*|\*\*$/g, '') }));
  const summary = summaryPart.replace(/^\s*(?:\*\*|#+\s*)?SUMMARY:?(?:\*\*)?\s*/i, '').trim();
  return { summary, chapters };
}

export function chaptersFromModel(list, duration) {
  if (!Array.isArray(list)) return [];
  return normalizeChapters(list.map((c) => ({
    start: typeof c.start === 'number' ? c.start : parseTimestamp(String(c.start || '').replace(/[[\]]/g, '')),
    title: String(c.title || ''),
  })), duration, { sort: true });
}

/**
 * Full pipeline. `chatFn(messages)` returns the model's text.
 * Long transcripts are first condensed part by part ("map"), then summarized ("reduce").
 */
export async function summarize({ segments, title, channel, duration, needChapters, language, chatFn, maxChars = 60000, onStatus }) {
  let transcript = compactTranscript(segments);
  if (transcript.length > maxChars) {
    const parts = splitText(transcript, maxChars);
    const notes = [];
    for (let i = 0; i < parts.length; i++) {
      onStatus?.(`Condensing part ${i + 1}/${parts.length}…`);
      notes.push(await chatFn(buildNotesMessages({ title, part: parts[i], index: i + 1, total: parts.length, language })));
    }
    transcript = `(Condensed notes of a long transcript, in order.)\n${notes.join('\n')}`;
  }
  onStatus?.('Summarizing…');
  const out = parseModelReply(await chatFn(buildSummaryMessages({ title, channel, transcript, needChapters, language, duration })));
  return {
    summary: String(out.summary || '').trim(),
    chapters: needChapters ? chaptersFromModel(out.chapters, duration) : [],
  };
}

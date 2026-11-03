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
    ? `Write everything in ${language}, even if the video is in another language.`
    : 'Write in the language of the transcript.';
}

// Three tiers, like the page-summary extension: a fast "worth watching?" brief
// (optionally from a small, fast model), a short summary, and a detailed one.
export const TIERS = {
  quick: { label: 'Worth watching?', target: '~20 s read' },
  short: { label: 'Short summary', target: '~2 min read' },
  long: { label: 'Detailed summary', target: '~5 min read' },
};
export const TIER_IDS = Object.keys(TIERS);

/** Videos shorter than this (seconds) don't get the detailed tier unless asked. */
export const LONG_TIER_MIN_SECONDS = 8 * 60;

const SYSTEM_PROMPT = `You summarize YouTube videos from their timestamped transcript for a busy reader who wants to know quickly what a video says and whether it is worth their time.

Rules:
- Be faithful to the transcript. Use only the title, channel and transcript: do not add dates, places, names or background from your own knowledge, even if you think you recognize the video. Transcripts can be auto-generated: fix obvious mis-hearings of names silently, and say so if the transcript is too garbled or mostly music.
- Be concrete: keep names, numbers, products, steps and conclusions; drop filler, greetings, sponsor reads and calls to subscribe.
- Cite moments as [m:ss] or [h:mm:ss] timestamps taken from the transcript lines.
- No preamble ("In this video…", "Sure, here is…") and do not repeat the title as a heading; start directly with the requested format.
- Use Markdown.`;

const countWords = (t) => (t.match(/\S+/g) || []).length;

/** Reading time of a text, as "~20 s read" / "~3 min read". */
export function readingTime(text) {
  const sec = Math.round(countWords(text) / 230 * 60);
  return sec < 60 ? `~${Math.max(5, Math.round(sec / 5) * 5)} s read` : `~${Math.round(sec / 60)} min read`;
}

const QUICK = `Task: a "worth watching?" brief that can be read in 15–20 seconds (at most ~70 words after the first line).

Use exactly this format:
VERDICT: WATCH | SKIM | SKIP   ← pick one word
**For:** who will get the most out of it, in one short line.
2 short sentences (at most 45 words), with no label in front: the actual answer or main point, and what the video offers (e.g. tutorial, interview, news, review, opinion, entertainment, product pitch).
**Why:** one line justifying the verdict: depth, originality, evidence, practicality; flag clickbait, padding, or a video that is mostly a sponsor read.

Judge for the viewer named in "For:", not for everyone:
- WATCH: that viewer gets real value from watching that no summary replaces: a demonstration to follow along, original reporting or analysis, a performance, an argument worth hearing in full.
- SKIM: some value, but the summary and chapters cover most of it, or only some parts matter (name them with timestamps).
- SKIP: thin, padded, clickbait or promotional, or this brief already captures everything.
Use the full range; don't default to SKIM.`;

function shortTask(words, needChapters, duration) {
  const target = Math.round(Math.max(120, Math.min(500, words * 0.3)));
  return `Task: a short summary that can be read in about 2 minutes (about ${target} words; never longer than that).

Structure:
1. One opening paragraph (2–3 sentences): what the video is and its main point or answer.
2. "**Key points**" as 4–8 bullets, each one complete idea with its specifics and a [m:ss] timestamp.
3. A final line starting with "**Bottom line:**".
If the video is a tutorial or how-to, the key points should be the essential steps.${needChapters ? `

Then, after the summary, a line "CHAPTERS:" followed by 4–12 lines "m:ss Title" covering the whole video${duration ? ` (length ${formatTimestamp(duration)})` : ''}: first at 0:00, ascending, start times taken from the transcript timestamps, titles under 8 words. Fewer for very short videos.` : ''}`;
}

function longTask(words) {
  const target = Math.round(Math.max(400, Math.min(1500, words * 0.15)));
  return `Task: a detailed, structured summary of about ${target} words (never longer than that). This is a synthesis organized by topic, NOT a minute-by-minute retelling.

Use these sections (omit a section if the video has nothing for it):
## Overview
What the video is, who is speaking, and its thesis or purpose in 2–4 sentences.
## Main topics
Group the important points under 2–6 "###" topic headings, each with a [m:ss] timestamp where it starts. Under each, bullets with the supporting evidence, examples, numbers, steps or reasoning.
## Practical takeaways
Concrete steps, recommendations, tools, settings or decisions, if any.
## Caveats and open questions
Limitations, assumptions, missing evidence, possible bias or sponsorship, disagreements.
## Notable moments
2–4 short quotes or moments worth jumping to, each with its [m:ss] timestamp.`;
}

export function videoHeader(meta) {
  return [
    `Title: ${meta.title || 'unknown'}`,
    `Channel: ${meta.channel || 'unknown'}`,
    meta.duration && `Length: ${formatTimestamp(meta.duration)}`,
  ].filter(Boolean).join('\n');
}

/**
 * Messages for one tier. The system prompt + video header + transcript come first
 * and the tier task last, so servers with prefix caching reuse the transcript
 * tokens across tiers.
 */
export function buildTierMessages(tier, { meta, body, fromNotes = false, partial = null, words, needChapters, language }) {
  const wrapped = fromNotes
    ? `The transcript was too long to read in one pass. Below are detailed notes taken from each part, in order.\n\n<notes>\n${body}\n</notes>`
    : `<transcript>\n${body}\n</transcript>${partial ? `\n\n[… the video continues: this is part 1 of ${partial}, about ${Math.round(100 / partial)}% of the transcript]` : ''}`;
  const task = tier === 'quick' ? QUICK
    : tier === 'short' ? shortTask(words, needChapters, meta.duration)
      : tier === 'long' ? longTask(words)
        : null;
  if (!task) throw new Error(`unknown tier ${tier}`);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${videoHeader(meta)}\n\n${wrapped}\n\n${task}\n\n${langLine(language)}` },
  ];
}

export function buildNotesMessages({ meta, part, index, total }) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${videoHeader(meta)}\n\nThis is part ${index} of ${total} of the transcript.\n\n<transcript-part>\n${part}\n</transcript-part>\n\nTask: write dense notes on this part only, as Markdown bullets that each start with the [m:ss] timestamp they refer to. Capture every key claim, argument, step, name, number and notable quote, so that a summary of the whole video can be written from the notes alone. At most about 500 words. Write the notes in the language of the transcript.`,
    },
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

/** Split a quick-tier answer into its verdict and the rest. */
export function parseVerdict(text) {
  const m = text.match(/^\s*\**\s*VERDICT\s*\**\s*:?\s*\**\s*(WATCH|SKIM|SKIP)\b[^\n]*\n?/i);
  if (!m) return { verdict: null, body: text.trim() };
  return { verdict: m[1].toUpperCase(), body: text.slice(m[0].length).trim() };
}

async function collect(stream, onEvent) {
  let text = '';
  for await (const ev of stream) {
    if (ev.type === 'content') text += ev.text;
    onEvent?.(ev, text);
  }
  return text;
}

/**
 * Runs the tiers for one transcript. `streamFn(messages, {model, signal})` is an
 * async iterator of {type, text} events (openai.js streamChat with the endpoint bound).
 * Long transcripts are condensed into notes once ("map", with the fast model when
 * set) and every longer tier reuses them ("reduce"); the quick tier reads only the
 * first part so it stays fast.
 */
export class VideoSummarizer {
  constructor({ segments, meta, settings, streamFn, maxChars = 60000 }) {
    this.meta = meta;
    this.settings = settings;
    this.streamFn = streamFn;
    this.maxChars = maxChars;
    // ~5 s lines for short videos (precise timestamps), up to 30 s for long ones (fewer tokens).
    const span = meta.duration || segments.at(-1)?.end || 0;
    this.transcript = compactTranscript(segments, Math.min(30, Math.max(5, Math.round(span / 120))));
    this.words = countWords(this.transcript.replace(/\[[\d:]+\]/g, ''));
    this.notes = null;
  }

  get needsChunking() {
    return this.transcript.length > this.maxChars;
  }

  parts() {
    return splitText(this.transcript, this.maxChars);
  }

  modelFor(tier) {
    return (tier === 'quick' || tier === 'notes') && this.settings.fastModel ? this.settings.fastModel : this.settings.chatModel;
  }

  /** Condense a long transcript into notes, once; later tiers reuse the result. */
  prepare({ onProgress, signal } = {}) {
    if (!this.needsChunking) return Promise.resolve(null);
    if (!this.notes) {
      this.notes = this.#mapParts(onProgress, signal);
      this.notes.catch(() => { this.notes = null; }); // allow a retry
    }
    return this.notes;
  }

  async #mapParts(onProgress, signal) {
    const parts = this.parts();
    const notes = new Array(parts.length);
    let next = 0;
    let done = 0;
    onProgress?.({ done, total: parts.length });
    const worker = async () => {
      while (next < parts.length) {
        const i = next++;
        const messages = buildNotesMessages({ meta: this.meta, part: parts[i], index: i + 1, total: parts.length });
        notes[i] = (await collect(this.streamFn(messages, { model: this.modelFor('notes'), signal }))).trim();
        onProgress?.({ done: ++done, total: parts.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, parts.length) }, worker));
    return notes.join('\n');
  }

  /**
   * Run one tier; onEvent({type, text}, contentSoFar) is called while streaming.
   * Returns {text, chapters}: chapters only for the short tier with needChapters.
   */
  async runTier(tier, { needChapters = false, onEvent, onProgress, signal } = {}) {
    let body = this.transcript;
    let fromNotes = false;
    let partial = null;
    if (this.needsChunking && tier === 'quick') {
      const parts = this.parts();
      body = parts[0];
      partial = parts.length;
    } else if (this.needsChunking) {
      body = await this.prepare({ onProgress, signal });
      fromNotes = true;
    }
    const messages = buildTierMessages(tier, {
      meta: this.meta, body, fromNotes, partial, words: this.words, needChapters: tier === 'short' && needChapters, language: this.settings.language,
    });
    const raw = (await collect(this.streamFn(messages, { model: this.modelFor(tier), signal }), onEvent)).trim();
    if (tier !== 'short') return { text: raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), chapters: [] };
    const out = parseModelReply(raw);
    return { text: out.summary, chapters: needChapters ? chaptersFromModel(out.chapters, this.meta.duration) : [] };
  }
}

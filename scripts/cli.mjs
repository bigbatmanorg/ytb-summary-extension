// Run the same library code from Node:
//   node scripts/cli.mjs VIDEO_ID_OR_URL [--summary] [--json]
// --summary uses YTSUM_BASE_URL / YTSUM_API_KEY / YTSUM_CHAT_MODEL from .env.local or the environment.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadVideo, parseVideoId, formatTimestamp } from '../src/lib/youtube.js';
import { chat } from '../src/lib/openai.js';
import { summarize } from '../src/lib/summarize.js';

const args = process.argv.slice(2);
const id = parseVideoId(args.find((a) => !a.startsWith('--')) || '');
if (!id) {
  console.error('usage: node scripts/cli.mjs VIDEO_ID_OR_URL [--summary] [--json]');
  process.exit(2);
}
const envFile = join(import.meta.dirname, '..', '.env.local');
const env = { ...(existsSync(envFile) ? Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])) : {}), ...process.env };

const r = await loadVideo(id);
let summary = null;
if (args.includes('--summary') && r.segments?.length) {
  const opts = { baseUrl: env.YTSUM_BASE_URL, apiKey: env.YTSUM_API_KEY, model: env.YTSUM_CHAT_MODEL };
  summary = await summarize({
    segments: r.segments, title: r.meta.title, channel: r.meta.channel, duration: r.meta.duration,
    needChapters: !r.chapters.length, language: env.YTSUM_LANGUAGE || 'auto',
    chatFn: (m) => chat(m, opts), onStatus: (s) => console.error(s),
  });
}
if (args.includes('--json')) {
  const { playerResponse, ...rest } = r;
  console.log(JSON.stringify({ ...rest, summary }, null, 2));
} else {
  console.log(`${r.meta.title} — ${r.meta.channel} (${formatTimestamp(r.meta.duration || 0)})`);
  console.log(r.log.map((l) => `  · ${l}`).join('\n'));
  console.log(`\nChapters (${r.chapterSource || 'none'}):`);
  for (const c of r.chapters) console.log(`  ${formatTimestamp(c.start).padStart(8)}  ${c.title}`);
  console.log(`\nTranscript: ${r.segments?.length ?? 0} segments`);
  for (const s of (r.segments || []).slice(0, 10)) console.log(`  ${formatTimestamp(s.start).padStart(8)}  ${s.text}`);
  if (summary) {
    console.log(`\nSummary:\n${summary.summary}`);
    for (const c of summary.chapters) console.log(`  ${formatTimestamp(c.start).padStart(8)}  ${c.title}`);
  }
}

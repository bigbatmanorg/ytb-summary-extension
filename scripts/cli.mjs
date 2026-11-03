// Run the same library code from Node:
//   node scripts/cli.mjs VIDEO_ID_OR_URL [--summary[=quick,short,long]] [--json]
// --summary uses YTSUM_BASE_URL / YTSUM_API_KEY / YTSUM_CHAT_MODEL (/ YTSUM_FAST_MODEL)
// from .env.local or the environment; default tiers: quick,short.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadVideo, parseVideoId, formatTimestamp } from '../src/lib/youtube.js';
import { streamChat } from '../src/lib/openai.js';
import { VideoSummarizer, TIERS } from '../src/lib/summarize.js';

const args = process.argv.slice(2);
const id = parseVideoId(args.find((a) => !a.startsWith('--')) || '');
if (!id) {
  console.error('usage: node scripts/cli.mjs VIDEO_ID_OR_URL [--summary] [--json]');
  process.exit(2);
}
const envFile = join(import.meta.dirname, '..', '.env.local');
const env = { ...(existsSync(envFile) ? Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])) : {}), ...process.env };

const r = await loadVideo(id);
const summaryArg = args.find((a) => a.startsWith('--summary'));
const tiers = summaryArg ? (summaryArg.split('=')[1] || 'quick,short').split(',') : [];
const summary = {};
if (tiers.length && r.segments?.length) {
  const settings = { chatModel: env.YTSUM_CHAT_MODEL, fastModel: env.YTSUM_FAST_MODEL || '', language: env.YTSUM_LANGUAGE || 'auto' };
  const summarizer = new VideoSummarizer({
    segments: r.segments, meta: r.meta, settings,
    streamFn: (messages, { model, signal }) => streamChat(messages, { baseUrl: env.YTSUM_BASE_URL, apiKey: env.YTSUM_API_KEY, model, signal }),
  });
  for (const tier of tiers) {
    const t0 = Date.now();
    summary[tier] = await summarizer.runTier(tier, { needChapters: tier === 'short' && !r.chapters.length });
    summary[tier].seconds = Math.round((Date.now() - t0) / 1000);
    console.error(`${tier}: ${summary[tier].seconds} s (${summarizer.modelFor(tier)})`);
  }
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
  for (const [tier, out] of Object.entries(summary)) {
    console.log(`\n== ${TIERS[tier].label} (${out.seconds} s)\n${out.text}`);
    for (const c of out.chapters) console.log(`  ${formatTimestamp(c.start).padStart(8)}  ${c.title}`);
  }
}

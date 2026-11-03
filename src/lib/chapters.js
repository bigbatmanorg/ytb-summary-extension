// Chapters, in the same order of sources yt-dlp uses:
// 1. player bar chapters (playerOverlays…), 2. engagement-panel "macro markers",
// 3. timestamps in the description.

export function parseTimestamp(s) {
  if (s == null) return null;
  const p = String(s).trim().split(':');
  if (!p.every((x) => /^\d+$/.test(x)) || p.length < 2 || p.length > 3) return null;
  return p.reduce((acc, x) => acc * 60 + Number(x), 0);
}

export function formatTimestamp(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const text = (o) => (o == null ? '' : typeof o === 'string' ? o : o.simpleText ?? (o.runs || []).map((r) => r.text).join(''));

/** Port of yt-dlp's _extract_chapters_helper: keep ascending, in-range chapters; add `end`. */
export function normalizeChapters(list, duration, { sort = false } = {}) {
  if (!duration) duration = Infinity;
  let items = list.filter((c) => c.start != null && Number.isFinite(c.start));
  if (sort) items = [...items].sort((a, b) => a.start - b.start);
  const out = [];
  let last = 0;
  for (const c of items) {
    if (c.start >= last && c.start <= duration && !(out.length && out.at(-1).start === c.start)) {
      out.push({ start: c.start, title: (c.title || '').trim() });
      last = c.start;
    }
  }
  return out.map((c, i) => ({ ...c, end: out[i + 1]?.start ?? (Number.isFinite(duration) ? duration : null) }));
}

export function chaptersFromPlayerBar(nextData, duration) {
  const bar = nextData?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer
    ?.decoratedPlayerBarRenderer?.playerBar;
  // Older layout (the one yt-dlp traverses) and the current markersMap layout.
  let raw = bar?.chapteredPlayerBarRenderer?.chapters;
  if (!raw) {
    const maps = bar?.multiMarkersPlayerBarRenderer?.markersMap || [];
    const pick = maps.find((m) => m.key === 'DESCRIPTION_CHAPTERS') || maps.find((m) => m.value?.chapters);
    raw = pick?.value?.chapters;
  }
  if (!raw?.length) return [];
  return normalizeChapters(raw.map((c) => ({
    start: (c.chapterRenderer?.timeRangeStartMillis ?? NaN) / 1000,
    title: text(c.chapterRenderer?.title),
  })), duration);
}

export function chaptersFromEngagementPanels(nextData, duration) {
  for (const p of nextData?.engagementPanels || []) {
    const contents = p.engagementPanelSectionListRenderer?.content?.macroMarkersListRenderer?.contents;
    if (!contents) continue;
    const items = contents.map((c) => c.macroMarkersListItemRenderer).filter(Boolean).map((m) => ({
      start: m.onTap?.watchEndpoint?.startTimeSeconds ?? parseTimestamp(text(m.timeDescription)),
      title: text(m.title),
    }));
    const chapters = normalizeChapters(items, duration);
    if (chapters.length) return chapters;
  }
  return [];
}

// yt-dlp: r'(?m)^\s*(%s)\b\W*\s(%s)\s*$' with "time title" or "title time".
const TS = String.raw`(?:\d+:)?\d{1,2}:\d{2}`;
export function chaptersFromDescription(description, duration) {
  if (!description) return [];
  const tryRe = (re, ti, ni) => normalizeChapters(
    [...description.matchAll(re)].map((m) => ({ start: parseTimestamp(m[ti]), title: m[ni].replace(/^[\s\-–—:|.]+|[\s\-–—:|]+$/g, '') })),
    duration, { sort: true },
  );
  const a = tryRe(new RegExp(String.raw`^\s*(${TS})\b\W*\s(.+?)\s*$`, 'gm'), 1, 2);
  if (a.length >= 2) return a;
  const b = tryRe(new RegExp(String.raw`^\s*(.+?)\s(${TS})\s*$`, 'gm'), 2, 1);
  return b.length >= 2 ? b : [];
}

/**
 * Chapters for a video. `nextData` = /next response or ytInitialData, `playerResponse`
 * for duration and description. Returns {chapters, source}.
 */
export function getChapters({ nextData, playerResponse }) {
  const duration = Number(playerResponse?.videoDetails?.lengthSeconds) || null;
  let c = chaptersFromPlayerBar(nextData, duration);
  if (c.length) return { chapters: c, source: 'youtube' };
  c = chaptersFromEngagementPanels(nextData, duration);
  if (c.length) return { chapters: c, source: 'youtube' };
  c = chaptersFromDescription(playerResponse?.videoDetails?.shortDescription, duration);
  if (c.length) return { chapters: c, source: 'description' };
  return { chapters: [], source: null };
}

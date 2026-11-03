import { parseVtt } from './captions.js';

// Tiny client for an OpenAI-compatible /v1 endpoint (OpenAI, LiteLLM, vLLM, Ollama…).

export function normalizeBaseUrl(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

function headers(apiKey, extra = {}) {
  return apiKey ? { authorization: `Bearer ${apiKey}`, ...extra } : extra;
}

async function errorText(res) {
  const t = await res.text().catch(() => '');
  try {
    return JSON.parse(t).error?.message || t.slice(0, 300);
  } catch {
    return t.slice(0, 300);
  }
}

export async function listModels({ baseUrl, apiKey, fetch = globalThis.fetch }) {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, { headers: headers(apiKey) });
  if (!res.ok) throw new Error(`GET /models: HTTP ${res.status} ${await errorText(res)}`);
  return (await res.json()).data?.map((m) => m.id) || [];
}

export async function chat(messages, { baseUrl, apiKey, model, fetch = globalThis.fetch, signal, temperature = 0.2 }) {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: headers(apiKey, { 'content-type': 'application/json' }),
    body: JSON.stringify({ model, messages, temperature }),
    signal,
  });
  if (!res.ok) throw new Error(`chat/completions: HTTP ${res.status} ${await errorText(res)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`chat/completions returned no content (finish_reason: ${data.choices?.[0]?.finish_reason})`);
  return content;
}

/**
 * Streaming chat completion (SSE). Yields {type: 'content' | 'reasoning' | 'truncated', text}.
 * Reasoning models stream their thinking in `reasoning_content` / `reasoning`, or
 * inside <think>…</think> in the content; both are reported as 'reasoning'.
 * Servers that ignore `stream: true` and answer with plain JSON work too.
 */
export async function* streamChat(messages, { baseUrl, apiKey, model, fetch = globalThis.fetch, signal, temperature = 0.2 }) {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: headers(apiKey, { 'content-type': 'application/json' }),
    body: JSON.stringify({ model, messages, temperature, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`chat/completions: HTTP ${res.status} ${await errorText(res)}`);
  const think = thinkSplitter();
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const msg = (await res.json()).choices?.[0]?.message || {};
    const r = msg.reasoning_content ?? msg.reasoning;
    if (r) yield { type: 'reasoning', text: r };
    yield* think(msg.content || '');
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finish = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        if (finish === 'length') yield { type: 'truncated', text: '' };
        return;
      }
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error(`chat/completions: ${j.error.message || JSON.stringify(j.error)}`);
      const choice = j.choices?.[0];
      const delta = choice?.delta || {};
      const r = delta.reasoning_content ?? delta.reasoning;
      if (r) yield { type: 'reasoning', text: r };
      if (delta.content) yield* think(delta.content);
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
  }
  if (finish === 'length') yield { type: 'truncated', text: '' };
}

// Splits streamed content into reasoning (inside <think>…</think>) and content,
// holding back a tag that is split across chunks.
function thinkSplitter() {
  let inThink = false;
  let pending = '';
  return function* split(chunk) {
    let s = pending + chunk;
    pending = '';
    while (s) {
      const tag = inThink ? '</think>' : '<think>';
      const i = s.indexOf(tag);
      if (i >= 0) {
        if (i > 0) yield { type: inThink ? 'reasoning' : 'content', text: s.slice(0, i) };
        inThink = !inThink;
        s = s.slice(i + tag.length);
        continue;
      }
      let keep = 0;
      for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(-n))) { keep = n; break; }
      if (s.length > keep) yield { type: inThink ? 'reasoning' : 'content', text: s.slice(0, s.length - keep) };
      pending = s.slice(s.length - keep);
      break;
    }
  };
}

/**
 * POST one audio file to /audio/transcriptions and return [{start, end, text}]
 * relative to the file. Timestamps matter, so formats are tried in order:
 * verbose_json (OpenAI: has `segments`), then vtt (some proxies, e.g. LiteLLM,
 * drop verbose_json segments but pass VTT through, sometimes wrapped as
 * {"text": "WEBVTT..."}), then plain json (one segment for the whole file).
 */
export async function transcribe(bytes, { baseUrl, apiKey, model, language, filename = 'audio.m4a', mimeType = 'audio/mp4', fetch = globalThis.fetch, signal, duration }) {
  let plain = '';
  for (const format of ['verbose_json', 'vtt', 'json']) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType }), filename);
    form.append('model', model);
    form.append('response_format', format);
    if (format === 'verbose_json') form.append('timestamp_granularities[]', 'segment');
    if (language) form.append('language', language);
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/audio/transcriptions`, {
      method: 'POST', headers: headers(apiKey), body: form, signal,
    });
    if (!res.ok) {
      // Unsupported format -> try the next one; auth/size errors are final.
      if (format !== 'json' && res.status >= 400 && res.status < 500 && ![401, 403, 413].includes(res.status)) continue;
      throw new Error(`audio/transcriptions: HTTP ${res.status} ${await errorText(res)}`);
    }
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { text: raw }; }
    // A lone segment spanning a long file is a synthesized one (LiteLLM does this): no real timing.
    if (Array.isArray(data.segments) && (data.segments.length > 1 || (data.segments.length && Number(data.duration || duration) < 60))) {
      return data.segments
        .map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() }))
        .filter((s) => s.text);
    }
    const text = String(data.text ?? '').trim();
    if (/^WEBVTT/.test(text)) {
      const segs = parseVtt(text);
      if (segs.length) return segs;
    }
    if (format === 'verbose_json' || format === 'json') plain ||= text;
    if (format === 'json') break;
  }
  return plain ? [{ start: 0, end: duration || 0, text: plain }] : [];
}

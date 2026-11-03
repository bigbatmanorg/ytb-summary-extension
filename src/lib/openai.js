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

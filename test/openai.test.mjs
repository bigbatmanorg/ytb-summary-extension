import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, chat, listModels } from '../src/lib/openai.js';
import { fakeFetch } from './helpers.mjs';

const opts = { baseUrl: 'http://llm.test/v1/', apiKey: 'k', model: 'whisper-1', duration: 300 };
const format = async (init) => init.body.get('response_format');

test('transcribe uses real verbose_json segments', async () => {
  const fetch = fakeFetch([[() => true, () => ({ body: { text: 'a b', segments: [{ start: 0, end: 1, text: ' a' }, { start: 1, end: 2, text: ' b' }] } })]]);
  assert.deepEqual(await transcribe(new Uint8Array(4), { ...opts, fetch }), [{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'b' }]);
  assert.equal(fetch.calls[0].url, 'http://llm.test/v1/audio/transcriptions');
  assert.equal(fetch.calls[0].init.headers.authorization, 'Bearer k');
});

test('transcribe falls back to VTT when verbose_json has one synthetic segment (LiteLLM)', async () => {
  const fetch = fakeFetch([[() => true, async (u, init) => ((await format(init)) === 'verbose_json'
    ? { body: { text: 'all', duration: 300, segments: [{ start: 0, end: 300, text: 'all' }] } }
    : { body: { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\n\n00:00:03.000 --> 00:00:04.000\nTwo\n' } })]]);
  const segs = await transcribe(new Uint8Array(4), { ...opts, fetch });
  assert.deepEqual(segs.map((s) => s.text), ['One', 'Two']);
});

test('transcribe accepts raw text/vtt and finally plain json', async () => {
  const raw = fakeFetch([[() => true, async (u, init) => ((await format(init)) === 'vtt'
    ? { body: 'WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nRaw\n' } : { status: 400, body: { error: { message: 'nope' } } })]]);
  assert.deepEqual(await transcribe(new Uint8Array(4), { ...opts, fetch: raw }), [{ start: 5, end: 6, text: 'Raw' }]);
  const plain = fakeFetch([[() => true, async (u, init) => ((await format(init)) === 'json' ? { body: { text: 'only text' } } : { status: 400, body: 'bad' })]]);
  assert.deepEqual(await transcribe(new Uint8Array(4), { ...opts, fetch: plain }), [{ start: 0, end: 300, text: 'only text' }]);
});

test('transcribe stops on auth errors', async () => {
  const fetch = fakeFetch([[() => true, () => ({ status: 401, body: { error: { message: 'bad key' } } })]]);
  await assert.rejects(transcribe(new Uint8Array(4), { ...opts, fetch }), /401 bad key/);
  assert.equal(fetch.calls.length, 1);
});

test('chat and listModels', async () => {
  const fetch = fakeFetch([
    [(u) => u.endsWith('/models'), () => ({ body: { data: [{ id: 'a' }, { id: 'b' }] } })],
    [(u) => u.endsWith('/chat/completions'), (u, init) => ({ body: { choices: [{ message: { content: `model=${JSON.parse(init.body).model}` } }] } })],
  ]);
  assert.deepEqual(await listModels({ ...opts, fetch }), ['a', 'b']);
  assert.equal(await chat([{ role: 'user', content: 'hi' }], { ...opts, model: 'brain', fetch }), 'model=brain');
});

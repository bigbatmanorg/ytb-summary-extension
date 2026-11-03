import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const fixture = (name) => readFileSync(join(import.meta.dirname, 'fixtures', name), name.endsWith('.bin') ? undefined : 'utf8');
export const json = (name) => JSON.parse(fixture(name));

/** fetch stub: routes = [[predicate(url, init), handler(url, init) -> {status, body}]] */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, init });
    for (const [match, handle] of routes) {
      if (match(url, init)) {
        const r = await handle(url, init);
        return new Response(typeof r.body === 'string' || r.body instanceof Uint8Array ? r.body : JSON.stringify(r.body), { status: r.status || 200 });
      }
    }
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

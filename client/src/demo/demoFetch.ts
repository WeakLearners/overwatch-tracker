// Read-only demo mode (VITE_DEMO=1, scripts/build-demo.sh). There is no server
// behind the static build, so window.fetch is replaced: a GET is answered from
// the bundled snapshot (synthetic data, see scripts/buildDemoSnapshot.ts) and
// every other method is refused. The exact url wins; a url with a different
// query string falls back to the same path without its query, so the season
// filter and date-scoped reads show the one bundled snapshot. Anything not in
// the snapshot is a 404, which every page already handles as "no data".
import snapshot from './snapshot.json';

const data = snapshot as Record<string, unknown>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function lookup(url: string): unknown | undefined {
  if (url in data) return data[url];
  // "Today's matches" reads (from=today): the made-up matches are all in the past.
  if (/^\/api\/matches\?.*\bfrom=/.test(url)) return [];
  const path = url.split('?')[0];
  if (path in data) return data[path];
  // Plain-path list reads (matches) were snapshotted with a limit.
  const prefix = Object.keys(data).find(k => k.startsWith(path + '?'));
  return prefix ? data[prefix] : undefined;
}

export function installDemoFetch(): void {
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET') return json(403, { error: 'This is a read-only demo. Nothing is saved.' });
    const body = lookup(raw);
    return body === undefined ? json(404, { error: 'Not in the demo snapshot' }) : json(200, body);
  };
}

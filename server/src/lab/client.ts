// Lab client: the ONLY way lab code reads tracker data (split-plan-2026-09-28.md
// section 2). It calls the read-only /api/v1 routes over HTTP and nothing else.
// It must never import db/schema (slice 7 turns that into an enforced rule).
//
// Every response is checked: a body with no schema_version, or with a major
// version this client does not know, throws SchemaVersionError before any data
// reaches the caller. Lab code is not moved onto this module yet (slices 4-5).

/** Major version of the v1 contract this client understands. */
export const SUPPORTED_MAJOR = 1;

export class SchemaVersionError extends Error {
  constructor(public readonly got: unknown, public readonly path: string) {
    super(`lab client: ${path} returned schema_version ${JSON.stringify(got)}; this client supports major ${SUPPORTED_MAJOR}`);
    this.name = 'SchemaVersionError';
  }
}

export class ExportHttpError extends Error {
  constructor(public readonly status: number, public readonly path: string, body: string) {
    super(`lab client: GET ${path} failed with ${status}: ${body.slice(0, 200)}`);
    this.name = 'ExportHttpError';
  }
}

export interface Page<T> {
  schema_version: string;
  rows: T[];
  next_since: number | null;
  has_more: boolean;
}

export interface LabClientOptions {
  /** Origin of the tracker, for example http://127.0.0.1:3001. No trailing path. */
  baseUrl: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function majorOf(version: unknown): number | null {
  if (typeof version !== 'string') return null;
  const m = /^(\d+)\.\d+\.\d+$/.exec(version);
  return m ? Number(m[1]) : null;
}

export function createLabClient(opts: LabClientOptions) {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function get<T extends { schema_version: string }>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const full = `/api/v1${path}${qs ? `?${qs}` : ''}`;
    // GET only, by construction: this is the whole transport.
    const res = await doFetch(`${base}${full}`, { method: 'GET' });
    const text = await res.text();
    if (!res.ok) throw new ExportHttpError(res.status, full, text);
    const body = JSON.parse(text) as T;
    if (majorOf(body?.schema_version) !== SUPPORTED_MAJOR) throw new SchemaVersionError(body?.schema_version, full);
    return body;
  }

  // Follow next_since until the tracker reports no more rows.
  async function all<R>(path: string, params: Record<string, string | number | undefined>): Promise<R[]> {
    const out: R[] = [];
    let since = params.since === undefined ? 0 : Number(params.since);
    for (;;) {
      const p = await get<Page<R> & { schema_version: string }>(path, { ...params, since });
      out.push(...p.rows);
      if (!p.has_more || p.next_since === null) return out;
      since = p.next_since;
    }
  }

  return {
    manifest: () => get<any>('/manifest'),
    matchesPage: (a: { since?: number; limit?: number; fields?: string[] } = {}) =>
      get<Page<any>>('/export/matches', { since: a.since, limit: a.limit, fields: a.fields?.join(',') }),
    matches: (a: { since?: number; limit?: number; fields?: string[] } = {}) =>
      all<any>('/export/matches', { since: a.since, limit: a.limit, fields: a.fields?.join(',') }),
    deaths: (a: { since?: number; limit?: number } = {}) => all<any>('/export/deaths', { ...a }),
    aim: (a: { since?: number; limit?: number } = {}) => all<any>('/export/aim', { ...a }),
    experiments: () => get<{ schema_version: string; sets: any[]; stages: any[]; credits: any[] }>('/export/experiments'),
  };
}

export type LabClient = ReturnType<typeof createLabClient>;

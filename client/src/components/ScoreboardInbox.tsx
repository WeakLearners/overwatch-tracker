import { useState } from 'react';
import { useApi, revalidateAll } from '../hooks/useApi';

// Scoreboard screenshots that the server could not attach to a logged match
// (Settings, low-traffic spot). Read-only except the manual "attach to match"
// select. The server never guesses: zero or 2+ fitting matches land here.
interface Item { id: number; file_name: string; file_mtime: string; status: string; reason: string | null; self_name: string | null; self_role: string | null; row_count: number }
interface MatchOpt { id: number; date: string; time: string | null; hero: string; role: string; map: string; account: string | null }
interface Payload { items: Item[]; matches: MatchOpt[]; ignored: number }

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function ScoreboardInbox() {
  const { data } = useApi<Payload>('/api/scoreboards/unmatched');
  const [pick, setPick] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const attach = async (id: number) => {
    setError(null);
    try {
      const res = await fetch(`/api/scoreboards/${id}/attach`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_id: Number(pick[id]) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      revalidateAll();
    } catch (e) { setError((e as Error).message); }
  };

  const items = data?.items ?? [];
  return (
    <div className="card mt-6" data-inspect-id="settings-scoreboards">
      <div className="text-sm text-[var(--ink)] font-bold">Scoreboard screenshots</div>
      <div className="text-xs text-[var(--faint)]">
        {items.length ? `${items.length} not attached to a match.` : 'Every scoreboard is attached.'}
        {data && data.ignored > 0 ? ` ${data.ignored} non-scoreboard image(s) ignored.` : ''}
      </div>
      {error && <p className="text-xs text-red-500 mt-1" data-inspect-id="settings-scoreboards-error">{error}</p>}
      <div className="space-y-2 mt-2" data-inspect-id="settings-scoreboards-list">
        {items.map(it => (
          <div key={it.id} className="text-xs flex flex-wrap items-center gap-2" data-inspect-id="settings-scoreboards-item">
            <span className="text-[var(--ink)] font-bold">{it.file_name}</span>
            <span className="text-[var(--faint)]">{when(it.file_mtime)}</span>
            <span className="text-[var(--faint)]">{it.status === 'error' ? `error: ${it.reason}` : it.reason}</span>
            {it.status === 'unmatched' && (
              <>
                <select
                  value={pick[it.id] ?? ''}
                  onChange={e => setPick(p => ({ ...p, [it.id]: e.target.value }))}
                  data-inspect-id="settings-scoreboards-select"
                >
                  <option value="">Attach to match…</option>
                  {(data?.matches ?? []).map(m => (
                    <option key={m.id} value={m.id}>{`${m.date} ${m.time?.slice(11, 16) ?? ''} ${m.account ?? ''} ${m.hero} (${m.role}) ${m.map}`}</option>
                  ))}
                </select>
                <button type="button" disabled={!pick[it.id]} onClick={() => attach(it.id)} data-inspect-id="settings-scoreboards-attach">Attach</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

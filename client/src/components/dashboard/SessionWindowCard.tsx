import { useApi } from '../../hooks/useApi';
import EmptyState from '../EmptyState';
import { foldSessionRows, type DayHourRow } from '../../lib/sessionWindow';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

function hourLabel(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${h < 12 ? 'AM' : 'PM'}`;
}

// Session Window (split plan decision 5, 2026-09-29): a plain record of when
// the games were played. Every cell with a game shows its win rate and games
// played. No best/worst label, no highlight, no colour, no floor: the card
// states what happened and leaves "does it matter" to the lab. Rows are the
// hours that have at least one game, so the grid never carries empty rows.
export default function SessionWindowCard({ season = '' }: { season?: string }) {
  const { data, loading } = useApi<DayHourRow[]>(`/api/stats/by-day-hour${season ? `?season=${encodeURIComponent(season)}` : ''}`);

  const rows = foldSessionRows(data ?? [], DAYS);
  const hourRows = rows.filter(r => r.kind === 'hour');
  const firstOwn = hourRows[0]?.hours[0] ?? 0;
  const lastOwn = hourRows[hourRows.length - 1]?.hours[0] ?? 0;

  return (
    <div className="card" data-inspect-id="dash-session-window-card">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-sm card-title">Session Window</h2>
        <span className="text-xs text-[var(--faint-2)]">win rate · games, by day and hour · grey under 10 games</span>
      </div>
      {loading && !data ? (
        <div className="text-xs text-[var(--muted)]">Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          dataInspectId="dash-session-window-empty"
          title="No games with a day and hour yet"
          hint="Log a match and it appears here."
        />
      ) : (
        <div className="grid grid-cols-[auto_repeat(7,minmax(0,1fr))] gap-x-1 gap-y-1 text-center" data-inspect-id="dash-session-window-grid">
          <div />
          {DAYS.map(d => (
            <div key={d} className="text-[10px] uppercase tracking-wider text-[var(--muted)]">{d.slice(0, 3)}</div>
          ))}
          {rows.map(r => {
            const first = r.hours[0];
            const label = r.kind === 'before' ? `Before ${hourLabel(firstOwn)}`
              : r.kind === 'after' ? `After ${hourLabel(lastOwn)}` : hourLabel(first);
            const held = r.hours.length > 1 ? `, ${r.hours.map(hourLabel).join(', ')}` : '';
            return (
              <div key={r.key} className="contents">
                <div className="text-xs text-[var(--muted)] text-right pr-2 self-center whitespace-nowrap">{label}</div>
                {DAYS.map(d => {
                  const c = r.cells.get(d);
                  return c ? (
                    <div key={d} className="flex flex-wrap items-baseline justify-center gap-x-1 leading-tight py-0.5" title={`${d} ${label}${held}: ${c.games} ${c.games === 1 ? 'game' : 'games'}, ${c.wins}–${c.games - c.wins}`}>
                      <span className={`text-xs ${c.muted ? 'text-[var(--muted)]' : 'text-[var(--ink)]'}`}>{c.rate.toFixed(1)}%</span>
                      <span className="text-[10px] text-[var(--faint)]">{c.games}</span>
                    </div>
                  ) : (
                    <div key={d} className="text-xs text-[var(--faint-2)] self-center">—</div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useApi } from '../../hooks/useApi';
import EmptyState from '../EmptyState';

interface DayHourRow {
  day_of_week: string;
  hour: number;
  games: number;
  wins: number;
  win_rate: number;
}

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
export default function SessionWindowCard() {
  const { data, loading } = useApi<DayHourRow[]>('/api/stats/by-day-hour');

  const cells = new Map<string, DayHourRow>();
  for (const r of data ?? []) cells.set(`${r.day_of_week}|${r.hour}`, r);
  const hours = [...new Set((data ?? []).map(r => r.hour))].sort((a, b) => a - b);

  return (
    <div className="card" data-inspect-id="dash-session-window-card">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-sm card-title">Session Window</h2>
        <span className="text-xs text-[var(--faint-2)]">win rate on top, games played below, by day and hour</span>
      </div>
      {loading && !data ? (
        <div className="text-xs text-[var(--muted)]">Loading…</div>
      ) : hours.length === 0 ? (
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
          {hours.map(h => (
            <div key={h} className="contents">
              <div className="text-xs text-[var(--muted)] text-right pr-2 self-center whitespace-nowrap">{hourLabel(h)}</div>
              {DAYS.map(d => {
                const c = cells.get(`${d}|${h}`);
                return c ? (
                  <div key={d} className="leading-tight py-0.5" title={`${d} ${hourLabel(h)}: ${c.games} ${c.games === 1 ? 'game' : 'games'}, ${c.wins}–${c.games - c.wins}`}>
                    <div className="text-xs text-[var(--ink)]">{c.win_rate.toFixed(1)}%</div>
                    <div className="text-[10px] text-[var(--faint)]">{c.games}</div>
                  </div>
                ) : (
                  <div key={d} className="text-xs text-[var(--faint-2)] self-center">—</div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

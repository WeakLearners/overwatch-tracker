import { useApi } from '../../hooks/useApi';
import type { Finding } from '../FindingChip';
import { findingTooltip } from '../FindingChip';

type Status = 'holds' | 'none' | 'thin';
interface Group {
  label: string; finding: Finding; status: Status; weakLead: boolean;
  rest: { label: string; rate: number; n: number };
}
interface Row { id: string; label: string; status: Status; groups: Group[]; action: string | null }
interface Habits {
  window: { n: number; from: string | null; to: string | null };
  baseline: { n: number; rate: number | null };
  minGroup: number; groupsTested: number; threshold: number; positionExcluded: number;
  rows: Row[];
}

// Same words and colours as the lab verdict chip (FindingChip): never green or red.
const STATUS = {
  holds: { text: '✓ Holds up', cls: 'text-ow-blue' },
  none:  { text: 'No difference found', cls: 'text-[var(--faint)]' },
  thin:  { text: '· Too few games', cls: 'text-[var(--muted)]' },
} as const;

const pct = (x: number) => `${x.toFixed(1)}%`;

// Play habits (S1 of the 2026-11-08 win-rate report, section 7): does recent
// form, a long day, or a late match in a session move the comp win rate?
// Compute and rules are server-side, lib/habits.ts. A null result is shown on
// purpose; an action line appears only on a row that holds.
export default function PlayHabitsCard() {
  const { data } = useApi<Habits>('/api/stats/habits');
  if (!data || data.window.n === 0) return null;

  return (
    <div className="card" data-inspect-id="dash-play-habits-card">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-sm card-title" data-inspect-id="dash-play-habits-title">Play habits</h2>
        <span className="text-xs text-[var(--faint-2)]" data-inspect-id="dash-play-habits-window">
          last {data.window.n} comp, {data.window.from} to {data.window.to}
        </span>
      </div>
      <p className="text-xs text-[var(--faint-2)] mb-3" data-inspect-id="dash-play-habits-note">
        Each group needs {data.minGroup}+ matches. Verdicts are corrected over {data.groupsTested} groups (p under {data.threshold.toFixed(4)}).
        {data.positionExcluded > 0 ? ` ${data.positionExcluded} matches have no real start time and are left out of session position.` : ''}
      </p>
      <div className="divide-y divide-ow-border" data-inspect-id="dash-play-habits-rows">
        {data.rows.map(r => (
          <div key={r.id} className="py-2" data-inspect-id="dash-play-habits-row">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-bold text-[var(--ink)]" data-inspect-id="dash-play-habits-row-label">{r.label}</span>
              <span className={`text-xs font-bold whitespace-nowrap ${STATUS[r.status].cls}`} data-inspect-id="dash-play-habits-row-status">
                {STATUS[r.status].text}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--faint)]" data-inspect-id="dash-play-habits-row-groups">
              {r.groups.map(g => (
                <span key={g.label} title={findingTooltip(g.finding, g.rest.label)} data-inspect-id="dash-play-habits-group">
                  {g.label}{' '}
                  <b className="text-[var(--ink)]">{pct(g.finding.rate)}</b> (n={g.finding.n})
                  {' '}vs {g.rest.label} {pct(g.rest.rate)} (n={g.rest.n})
                  {g.status === 'thin' && <span className="text-[var(--muted)]"> · thin: {g.finding.n} of {data.minGroup}</span>}
                  {g.weakLead && <span className="text-amber-500"> · not reliable</span>}
                </span>
              ))}
            </div>
            {r.action && (
              <p className="mt-1 text-sm font-bold text-[var(--ink)]" data-inspect-id="dash-play-habits-action">{r.action}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

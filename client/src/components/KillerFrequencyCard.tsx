import { useApi } from '../hooks/useApi';
import EmptyState from './EmptyState';

interface KillerRow {
  killer: string;
  killer_role: string;
  deaths: number;
  ult_deaths: number;
  ult_share: number | null;
  reliable: boolean;
}
interface KillerFrequencyPayload {
  total_deaths: number;
  total_ult_deaths: number;
  overall_ult_share: number | null;
  min_n: number;
  killers: KillerRow[];
}

// Field registry Phase 1's dashboard card — the first read surface for
// match_deaths (see modular-tracking-roadmap.md). Gated by the `deaths`
// field in Dashboard.tsx, not here — this component fetches unconditionally
// whenever it's mounted, same as every other card on the page.
//
// Every per-killer row below min_n is greyed and captioned rather than
// hidden — "exposure, not lethality" per docs/metric-suggestions.md
// suggestion 2 — so a thin cell reads as unproven, not as a hole in the
// data. No "top killer" headline is rendered from an unreliable row.
export default function KillerFrequencyCard() {
  const { data, loading } = useApi<KillerFrequencyPayload>('/api/stats/killer-frequency');

  if (loading || !data) return null;

  if (data.total_deaths === 0) {
    return (
      <div className="card">
        <h2 className="text-sm card-title mb-2">Who Kills Me</h2>
        <EmptyState
          dataInspectId="dash-killer-frequency-empty"
          title="No deaths logged yet"
          hint="Turn on Combat tracking in Settings, then log a death in the Match Log's Deaths card."
        />
      </div>
    );
  }

  const reliable = data.killers.filter(k => k.reliable);
  const thin = data.killers.filter(k => !k.reliable);

  return (
    <div className="card" data-inspect-id="dash-killer-frequency-card">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm card-title">Who Kills Me</h2>
        <span className="text-xs text-[var(--faint)]" data-inspect-id="dash-killer-frequency-ult-share">
          {data.overall_ult_share != null ? `${data.overall_ult_share}% of deaths are to an ult` : ''}
        </span>
      </div>
      <p className="text-xs text-[var(--faint-2)] mb-3">
        {data.total_deaths} deaths logged. A hero needs {data.min_n}+ deaths before its rate is
        shown as reliable — below that, it's exposure, not lethality.
      </p>
      <div className="space-y-1" data-inspect-id="dash-killer-frequency-reliable-list">
        {reliable.map(k => (
          <div key={k.killer} className="flex items-center justify-between text-sm py-1" data-inspect-id="dash-killer-frequency-row">
            <span className="text-[var(--ink)] font-bold">{k.killer}</span>
            <span className="text-[var(--faint)]">{k.deaths} deaths{k.ult_share != null ? ` · ${k.ult_share}% ult` : ''}</span>
          </div>
        ))}
      </div>
      {thin.length > 0 && (
        <div className="mt-3 pt-2 border-t border-ow-border space-y-1" data-inspect-id="dash-killer-frequency-thin-list">
          <p className="text-[10px] text-[var(--faint-2)] uppercase tracking-wide">Below {data.min_n} deaths — not yet reliable</p>
          {thin.map(k => (
            <div key={k.killer} className="flex items-center justify-between text-xs py-0.5 text-[var(--faint-2)]" data-inspect-id="dash-killer-frequency-thin-row">
              <span>{k.killer}</span>
              <span>{k.deaths} deaths</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

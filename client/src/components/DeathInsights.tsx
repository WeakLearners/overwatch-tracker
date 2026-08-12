import { DeathInsights as DeathInsightsData } from '../types';

interface Props {
  data: DeathInsightsData | null | undefined;
  /** Subject for the empty-state copy, e.g. "Sojourn" or "Circuit Royale". */
  label: string;
  /** Hide the section heading when the parent already provides one. */
  hideHeading?: boolean;
  /** Lets an embedding page (e.g. HeroDrawer, MapDrawer) tag this instance for the inspector overlay. */
  dataInspectId?: string;
}

// Minimum tagged games before a breakdown is worth showing at all.
const MIN_TAGGED = 3;

export default function DeathInsights({ data, label, hideHeading, dataInspectId }: Props) {
  const heading = !hideHeading && (
    <h3 data-inspect-id="deathInsights-sectionHeading" className="text-xs font-bold uppercase tracking-widest text-[var(--muted)] mb-2">Death Patterns</h3>
  );

  if (!data || data.tagged_games < MIN_TAGGED || data.total_deaths === 0) {
    return (
      <div data-inspect-id={dataInspectId}>
        {heading}
        <p data-inspect-id="deathInsights-emptyStateBanner" className="text-xs text-[var(--faint-2)]">
          Not enough tagged death data for <span className="name-caps">{label}</span> yet
          {data && data.tagged_games > 0 ? ` (${data.tagged_games} game${data.tagged_games !== 1 ? 's' : ''} so far)` : ''}.
          {' '}Tag deaths as you log matches to unlock this.
        </p>
      </div>
    );
  }

  // "Costs you games": reasons that show up meaningfully more often in losses.
  const costly = data.has_outcome_split
    ? data.reasons.filter(r => r.loss_multiplier !== null && r.loss_multiplier >= 1.3 && r.in_losses >= 2).slice(0, 2)
    : [];

  return (
    <div data-inspect-id={dataInspectId}>
      {heading}
      <div data-inspect-id="deathInsights-summaryStatsRow" className="text-[10px] text-[var(--faint)] uppercase tracking-wider mb-2">
        {data.tagged_games} tagged game{data.tagged_games !== 1 ? 's' : ''} · {data.win_games}W / {data.loss_games}L · {data.total_deaths} deaths
      </div>

      {/* Breakdown bars */}
      <div data-inspect-id="deathInsights-breakdownBarChart" className="space-y-1 mb-3">
        {data.breakdown.slice(0, 6).map((s, i) => (
          <div key={s.reason} className="flex items-center gap-2">
            <span className={`text-xs w-28 shrink-0 ${i === 0 ? 'text-[var(--ink-2)] font-medium' : 'text-[var(--muted)]'}`}>{s.reason}</span>
            <div className="flex-1 h-2 rounded-full bg-ow-darker overflow-hidden">
              <div className={`h-full rounded-full ${i === 0 ? 'bg-ow-accent' : 'bg-ow-accent/40'}`} style={{ width: `${s.pct}%` }} />
            </div>
            <span className="text-[10px] text-[var(--faint)] w-12 text-right tabular-nums">{s.pct}% · {s.count}</span>
          </div>
        ))}
      </div>

      {/* What costs you games */}
      {data.has_outcome_split ? (
        costly.length > 0 ? (
          <div data-inspect-id="deathInsights-costsYouGamesPanel" className="rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2 mb-2">
            <div className="text-[10px] uppercase tracking-wider text-red-600/80 mb-1">Costs you games</div>
            {costly.map(r => (
              <div key={r.reason} className="text-xs text-[var(--ink-2)] leading-snug">
                <span className="font-semibold text-[var(--ink)]">{r.reason}</span> — {r.loss_multiplier}× more frequent in losses
                <span className="text-[var(--faint)]"> ({r.loss_per_match}/loss vs {r.win_per_match}/win)</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[10px] text-[var(--faint-2)] mb-2">No single cause skews your losses much — deaths spread evenly across wins and losses.</div>
        )
      ) : (
        <div className="text-[10px] text-[var(--faint-2)] mb-2">Need more wins and losses tagged to compare what costs you games.</div>
      )}

      {/* Deaths per game */}
      {data.has_outcome_split && data.deaths_per_win !== null && data.deaths_per_loss !== null && (
        <div data-inspect-id="deathInsights-deathsPerGameStatRow" className="flex items-center gap-2 text-xs">
          <span className="text-[var(--faint)]">Deaths / game:</span>
          <span className="text-emerald-600 font-medium">{data.deaths_per_win} win</span>
          <span className="text-[var(--faint-2)]">·</span>
          <span className="text-red-600 font-medium">{data.deaths_per_loss} loss</span>
          {data.deaths_per_loss > data.deaths_per_win && (
            <span className="text-[10px] text-[var(--faint-2)]">
              (+{Math.round(((data.deaths_per_loss - data.deaths_per_win) / data.deaths_per_win) * 100)}% in losses)
            </span>
          )}
        </div>
      )}
    </div>
  );
}

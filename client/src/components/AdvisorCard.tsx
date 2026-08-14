import { MAPS, Recommendation, AxisPayload, DEATH_AXES } from '../types';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';

interface Props {
  map: string;
  queueLabel: string;
  rec: Recommendation | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpenHero: (hero: string) => void;
  /** Render without the outer card chrome + own header — for nesting inside the
   *  consolidated advisor card, which supplies the heading and refresh control. */
  bare?: boolean;
}

// Human caption explaining which slice of the player's data the death
// axes are drawn from — keeps thin/fallback data honest. Prefers the
// coaching column's own recommended hero (rec.primary) when there's enough
// of that hero's own data; falls back to all-heroes slices otherwise.
function scopeCaption(rec: Recommendation, map: string, a: AxisPayload, mapCounts: Record<string, number>): string {
  const g = `${a.games} game${a.games !== 1 ? 's' : ''}`;
  const d = `${a.deaths} death${a.deaths !== 1 ? 's' : ''}`;
  const mapLabel = withMapCount(map, mapCounts);
  const hero = rec.primary;
  const type = MAPS[map] ?? 'these';
  switch (rec.death_scope) {
    case 'hero_map': return `Your ${hero} deaths on ${mapLabel} · ${g}, ${d}`;
    case 'hero_type': return `Too few ${hero} games on ${mapLabel} — your ${hero} on ${type} maps · ${g}, ${d}`;
    case 'hero': return `Too few ${hero} games here — your ${hero} overall · ${g}, ${d}`;
    case 'map': return `Too few ${hero} games logged — everyone's deaths on ${mapLabel} · ${g}, ${d}`;
    case 'map_type': return `Too few games here — everyone's deaths on ${type} maps · ${g}, ${d}`;
    case 'overall': return `Too few games here — your overall pattern (all heroes) · ${g}, ${d}`;
  }
}

// One death axis as a spectrum: a marker sits at the mean position (0–1)
// between the two poles. Faint "no data" until that axis has been sampled.
function SpectrumBar({ label, low, high, mean, n }: { label: string; low: string; high: string; mean: number; n: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] w-16 shrink-0 text-[var(--muted)]">{label}</span>
      {n === 0 ? (
        <span className="flex-1 text-[10px] text-[var(--faint-2)] italic">no data yet</span>
      ) : (
        <>
          <span className="text-[10px] text-[var(--muted)] w-14 shrink-0 text-right truncate" title={low}>{low}</span>
          <div className="relative flex-1 h-2.5 rounded-full bg-ow-darker" title={`mean ${mean.toFixed(2)} · ${n} logged`}>
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-ow-accent border-2 border-ow-card shadow"
              style={{ left: `${Math.round(mean * 100)}%` }}
            />
          </div>
          <span className="text-[10px] text-[var(--muted)] w-14 shrink-0 truncate" title={high}>{high}</span>
          <span className="text-[10px] text-[var(--faint-2)] w-5 shrink-0 text-right tabular-nums font-bold">{n}</span>
        </>
      )}
    </div>
  );
}

export default function AdvisorCard({ map, queueLabel, rec, loading, error, onRefresh, onOpenHero, bare = false }: Props) {
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();
  return (
    <div
      data-inspect-id="advisorCard-outerCard"
      className={bare ? '' : 'rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3'}
    >
      {!bare && (
        <div className="flex items-center justify-between mb-2">
          <div
            data-inspect-id="advisorCard-header"
            className="text-[10px] text-emerald-600 uppercase tracking-widest font-semibold"
          >
            {withMapCount(map, mapCounts)}
            <span className="text-[var(--faint-2)] mx-2">·</span>
            <span className="text-[var(--faint)]">{queueLabel}</span>
          </div>
          <button
            data-inspect-id="advisorCard-refreshButton"
            onClick={onRefresh}
            disabled={loading}
            className="text-[10px] text-[var(--faint)] hover:text-emerald-600 disabled:opacity-40 uppercase tracking-wider"
          >
            {loading ? '…' : '↻'}
          </button>
        </div>
      )}

      {loading && !rec && <div data-inspect-id="advisorCard-loadingIndicator" className="text-xs text-[var(--faint)]">Loading…</div>}
      {error && <div data-inspect-id="advisorCard-errorBanner" className="text-xs text-red-600">{error}</div>}

      {rec && (
        <>
          {/* Primary + stretch hero */}
          <div className="flex items-center gap-2 mb-2 text-sm flex-wrap">
            <button
              data-inspect-id="advisorCard-primaryHeroButton"
              onClick={() => onOpenHero(rec.primary)}
              className="hero-name text-[var(--ink)] hover:text-ow-accent transition-colors"
            >
              {withHeroCount(rec.primary, heroCounts)}
            </button>
            {rec.primary_stats && (
              <span data-inspect-id="advisorCard-primaryStatsBadge" className="text-[10px] text-[var(--faint)]">
                <b className="font-bold">{rec.primary_stats.win_rate}</b>% · <b className="font-bold">{rec.primary_stats.games}</b>g
              </span>
            )}
            {rec.stretch && (
              <>
                <span className="text-[var(--faint-2)]">→</span>
                <button
                  data-inspect-id="advisorCard-stretchHeroButton"
                  onClick={() => onOpenHero(rec.stretch!)}
                  className={`hero-name text-xs transition-colors ${
                    rec.stretch_untested
                      ? 'text-amber-700 hover:text-amber-200'
                      : 'text-emerald-700 hover:text-emerald-200'
                  }`}
                >
                  {withHeroCount(rec.stretch, heroCounts)}
                </button>
                <span
                  data-inspect-id="advisorCard-stretchBadge"
                  className="text-[10px] text-[var(--faint-2)] italic"
                  title={
                    rec.stretch_untested
                      ? "Meta pick you haven't played — not based on your own data"
                      : "A hero outside your mains you've had success with"
                  }
                >
                  {rec.stretch_untested ? 'untested · meta' : 'stretch'}
                </span>
              </>
            )}
          </div>

          {/* Death axes — factual stats from the player's own logs */}
          {rec.death_axes ? (
            <div className="mb-2.5">
              <div
                data-inspect-id="advisorCard-scopeCaption"
                className="text-[10px] text-[var(--faint)] uppercase tracking-wider mb-1.5"
              >
                {scopeCaption(rec, map, rec.death_axes, mapCounts)}
              </div>
              <div data-inspect-id="advisorCard-spectrumBars" className="space-y-1">
                {DEATH_AXES.map(a => {
                  const ax = rec.death_axes!.axes[a.key];
                  return (
                    <SpectrumBar key={a.key} label={a.label} low={a.lowShort} high={a.highShort}
                      mean={ax?.mean ?? 0} n={ax?.n ?? 0} />
                  );
                })}
              </div>
              {rec.death_axes.strongest_lean && (
                <div data-inspect-id="advisorCard-strongestLean" className="text-[10px] text-[var(--faint)] mt-1.5">
                  Strongest lean: <span className="text-[var(--ink-2)]">
                    {DEATH_AXES.find(a => a.key === rec.death_axes!.strongest_lean!.axis)?.label} — {rec.death_axes.strongest_lean.label}
                  </span> (<b className="font-bold">{rec.death_axes.strongest_lean.n}</b> logged)
                </div>
              )}
            </div>
          ) : (
            <div data-inspect-id="advisorCard-noDeathTagsMessage" className="text-[10px] text-[var(--faint-2)] mb-2.5">No death tags yet — log a few matches with the new death tagger to unlock patterns.</div>
          )}

          {/* One grounded coaching insight */}
          {rec.insight && (
            <div data-inspect-id="advisorCard-insightCallout" className="flex items-start gap-2 text-xs text-[var(--ink-2)] border-t border-emerald-500/15 pt-2">
              <span className="text-emerald-700 mt-0.5">▸</span>
              <span className="leading-snug">{rec.insight}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

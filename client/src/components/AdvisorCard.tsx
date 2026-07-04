import { MAPS, Recommendation, AxisPayload } from '../types';

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
// axes are drawn from — keeps thin/fallback data honest.
function scopeCaption(rec: Recommendation, map: string, a: AxisPayload): string {
  const g = `${a.games} game${a.games !== 1 ? 's' : ''}`;
  const d = `${a.deaths} death${a.deaths !== 1 ? 's' : ''}`;
  if (rec.death_scope === 'map') return `Your deaths on ${map} · ${g}, ${d}`;
  if (rec.death_scope === 'map_type') {
    const type = MAPS[map] ?? 'these';
    return `Too few ${map} games — your ${type} maps · ${g}, ${d}`;
  }
  return `Too few games here — your overall pattern · ${g}, ${d}`;
}

type Seg = { label: string; pct: number; cls: string };

// One death axis as a labeled segmented bar, with the dominant side called out.
function AxisBar({ name, segs }: { name: string; segs: Seg[] }) {
  const top = [...segs].sort((a, b) => b.pct - a.pct)[0];
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] w-16 shrink-0 text-[var(--muted)]">{name}</span>
      <div className="flex-1 h-2.5 rounded-full overflow-hidden flex bg-ow-darker">
        {segs.map(s => s.pct > 0 && (
          <div key={s.label} className={s.cls} style={{ width: `${s.pct}%` }} title={`${s.label} ${s.pct}%`} />
        ))}
      </div>
      <span className="text-[10px] text-[var(--muted)] w-24 text-right tabular-nums truncate">
        {top.label} {top.pct}%
      </span>
    </div>
  );
}

export default function AdvisorCard({ map, queueLabel, rec, loading, error, onRefresh, onOpenHero, bare = false }: Props) {
  return (
    <div className={bare ? '' : 'rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3'}>
      {!bare && (
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] text-emerald-600 uppercase tracking-widest font-semibold">
            {map}
            <span className="text-[var(--faint-2)] mx-2">·</span>
            <span className="text-[var(--faint)]">{queueLabel}</span>
          </div>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="text-[10px] text-[var(--faint)] hover:text-emerald-600 disabled:opacity-40 uppercase tracking-wider"
          >
            {loading ? '…' : '↻'}
          </button>
        </div>
      )}

      {loading && !rec && <div className="text-xs text-[var(--faint)]">Loading…</div>}
      {error && <div className="text-xs text-red-600">{error}</div>}

      {rec && (
        <>
          {/* Primary + stretch hero */}
          <div className="flex items-center gap-2 mb-2 text-sm flex-wrap">
            <button
              onClick={() => onOpenHero(rec.primary)}
              className="font-bold text-[var(--ink)] hover:text-ow-accent transition-colors"
            >
              {rec.primary}
            </button>
            {rec.primary_stats && (
              <span className="text-[10px] text-[var(--faint)]">
                {rec.primary_stats.win_rate}% · {rec.primary_stats.games}g
              </span>
            )}
            {rec.stretch && (
              <>
                <span className="text-[var(--faint-2)]">→</span>
                <button
                  onClick={() => onOpenHero(rec.stretch!)}
                  className={`font-semibold transition-colors ${
                    rec.stretch_untested
                      ? 'text-amber-700 hover:text-amber-200'
                      : 'text-emerald-700 hover:text-emerald-200'
                  }`}
                >
                  {rec.stretch}
                </button>
                <span
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
              <div className="text-[10px] text-[var(--faint)] uppercase tracking-wider mb-1.5">
                {scopeCaption(rec, map, rec.death_axes)}
              </div>
              <div className="space-y-1">
                <AxisBar name="Trade" segs={[
                  { label: 'Wasted', pct: rec.death_axes.trade.free, cls: 'bg-red-400' },
                  { label: 'Got value', pct: rec.death_axes.trade.traded, cls: 'bg-emerald-400/70' },
                ]} />
                <AxisBar name="Timing" segs={[
                  { label: 'First', pct: rec.death_axes.timing.first, cls: 'bg-ow-accent' },
                  { label: 'Mid', pct: rec.death_axes.timing.middle, cls: 'bg-ow-accent/50' },
                  { label: 'Last', pct: rec.death_axes.timing.last, cls: 'bg-amber-300/70' },
                ]} />
                <AxisBar name="Grouping" segs={[
                  { label: 'Alone', pct: rec.death_axes.grouping.alone, cls: 'bg-red-400' },
                  { label: 'Grouped', pct: rec.death_axes.grouping.grouped, cls: 'bg-emerald-400/70' },
                ]} />
                <AxisBar name="Awareness" segs={[
                  { label: 'Caught out', pct: rec.death_axes.awareness.caught, cls: 'bg-red-400' },
                  { label: 'Read it', pct: rec.death_axes.awareness.saw, cls: 'bg-emerald-400/70' },
                ]} />
              </div>
              {rec.death_axes.top_pattern && (
                <div className="text-[10px] text-[var(--faint)] mt-1.5">
                  Most common: <span className="text-[var(--ink-2)]">{rec.death_axes.top_pattern.label}</span> ({rec.death_axes.top_pattern.count}×)
                </div>
              )}
            </div>
          ) : (
            <div className="text-[10px] text-[var(--faint-2)] mb-2.5">No death tags yet — log a few matches with the new death tagger to unlock patterns.</div>
          )}

          {/* One grounded coaching insight */}
          {rec.insight && (
            <div className="flex items-start gap-2 text-xs text-[var(--ink-2)] border-t border-emerald-500/15 pt-2">
              <span className="text-emerald-700 mt-0.5">▸</span>
              <span className="leading-snug">{rec.insight}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

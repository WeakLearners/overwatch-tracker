import { Recommendation } from '../types';
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

export default function AdvisorCard({ map, queueLabel, rec, loading, error, onRefresh, onOpenHero, bare = false }: Props) {
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();
  return (
    <div
      data-inspect-id="advisorCard-outerCard"
      className={bare ? '' : 'rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3'}
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
          <div className="flex items-center gap-2 text-sm flex-wrap">
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
        </>
      )}
    </div>
  );
}

import { memo, useState, useEffect } from 'react';
import { ModeComparison, QueueMode, QUEUE_MODES, QUEUE_MODE_COLORS, QUEUE_MODE_SEL_RGB } from '../../types';
import { useTodayHeroCounts, withHeroCount } from '../../hooks/useHeroCounts';
import AnimatedNumber from '../AnimatedNumber';
import ModeWatermark from '../ModeWatermark';
import { useHeroDrawer } from '../../contexts/HeroDrawerContext';
import { useMatch } from '../../contexts/MatchContext';

type ModeMeta = typeof QUEUE_MODES[number];
type LastLog = { mode: QueueMode; win: boolean; seq: number } | null;

// A single mode tile. Doubles as the queue-mode selector and plays the win/loss
// flash overlay when a match is logged under its mode.
function ModeTile({ meta, m, selected, onSelect, openHero, lastLog }: {
  meta: ModeMeta;
  m: ModeComparison | undefined;
  selected: boolean;
  onSelect: () => void;
  openHero: (h: string) => void;
  lastLog: LastLog;
}) {
  const [flash, setFlash] = useState<null | 'win' | 'loss'>(null);
  const heroCounts = useTodayHeroCounts();
  const c = QUEUE_MODE_COLORS[meta.value];

  // Trigger the sweep when the latest log was under this mode (skip on reduced
  // motion). `seq` is the dep so a repeat result still re-fires.
  useEffect(() => {
    if (!lastLog || lastLog.mode !== meta.value) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setFlash(lastLog.win ? 'win' : 'loss');
    const t = setTimeout(() => setFlash(null), 1050);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLog?.seq]);

  return (
    <button
      type="button"
      onClick={onSelect}
      data-inspect-id="dash-mode-tiles"
      // Same arrangement as LogMatch's selector: the shared class draws the
      // bottom-lit selected state, --sel decides its hue. A border width is
      // added here because the tile had none and .is-selected sets a colour,
      // which paints nothing without one.
      style={selected ? ({ '--sel': QUEUE_MODE_SEL_RGB[meta.value] } as React.CSSProperties) : undefined}
      className={`relative overflow-hidden text-left chamfer p-4 border-2 transition-all duration-200 mode-tile hover:-translate-x-1 hover:-translate-y-1 ${selected ? `is-selected mode-fill` : `border-transparent ${c.tileDim}`}`}
    >
      {/* 10% larger than the other (selector) watermarks — these tiles are bigger.
          Opacity is left at the component default (15%) even when selected —
          a forced full-opacity override here used to wash out the stat text
          drawn on top of it. */}
      <ModeWatermark
        mode={meta.value}
        variant="tile"
        className="scale-[3] translate-x-[19.0%] translate-y-[-7%]"
        color={selected ? undefined : 'text-ow-card'}
        lit={selected}
      />
      {flash && (
        <div
          className={`absolute inset-0 z-20 flex items-center justify-center mode-flash ${flash === 'win' ? 'bg-emerald-500/55' : 'bg-rose-500/55'}`}
          aria-hidden="true"
        >
          <span className={`text-6xl font-black text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.35)] ${flash === 'win' ? 'mode-arrow-up' : 'mode-arrow-down'}`}>
            {flash === 'win' ? '▲' : '▼'}
          </span>
        </div>
      )}
      <div className="relative z-10">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className={`pill min-w-0 truncate ${c.selected}`}>{meta.short}</span>
        {selected && <span className="shrink-0 whitespace-nowrap text-[11px] uppercase tracking-widest font-bold lit-text lit-strong">Selected</span>}
      </div>
      {m && m.games > 0 ? (
        <>
          {(() => {
            // Headline = recent form (last N games) so a single match visibly
            // moves it; the all-time rate sits below, smaller.
            const big = m.recent_win_rate ?? m.win_rate;
            // Selected tile: lit from the bottom glow, but ramped in the
            // win/loss hue (emerald-500 / rose-500), not the mode colour.
            return (
              <div
                className={`text-4xl font-black tracking-tight num-display ${selected ? `lit-text lit-hue ${big >= 50 ? '' : 'lit-loss'}` : big >= 50 ? 'grad-win' : 'grad-loss'}`}
                style={selected ? ({ '--sel': big >= 50 ? '16 185 129' : '244 63 94' } as unknown as React.CSSProperties) : undefined}
              >
                <AnimatedNumber value={big} decimals={1} suffix="%" />
              </div>
            );
          })()}
          <div className="text-xs text-[var(--muted)] mt-0.5">
            last <b className="font-bold">{m.recent_window}</b>d · <span className="text-emerald-500 font-bold">{m.recent_wins}W</span> <span className="text-red-400 font-bold">{m.recent_games - m.recent_wins}L</span>
          </div>
          <div className="text-[11px] text-[var(--faint)] mt-0.5">
            <b className="font-bold">{m.win_rate.toFixed(1)}</b>% all-time · <b className="font-bold">{m.games}</b> games
          </div>
          <div className="mt-3">
            <div className="text-[10px] text-[var(--muted)] uppercase tracking-wider mb-1">Most played</div>
            {m.top_hero ? (
              <div className="flex items-center justify-between">
                <span
                  onClick={e => { e.stopPropagation(); openHero(m.top_hero!.hero); }}
                  title={m.top_hero.hero.toUpperCase()}
                  className="min-w-0 text-xs hero-name text-[var(--ink)] hover:text-ow-accent transition-colors truncate cursor-pointer"
                >
                  {withHeroCount(m.top_hero.hero, heroCounts)}
                </span>
                <span className="text-xs text-[var(--muted)] shrink-0 ml-2 font-bold">
                  {m.top_hero.win_rate.toFixed(1)}% · {m.top_hero.games} games
                </span>
              </div>
            ) : (
              <div className="text-sm text-[var(--faint)]">—</div>
            )}
          </div>
        </>
      ) : (
        <div className="text-sm text-[var(--faint)] mt-1">No games yet</div>
      )}
      </div>
    </button>
  );
}

// Per-mode summary that doubles as the queue-mode selector: tap a card to set
// the active mode that drives the advisor and the logged match.
//
// Optimization pass (2026-09-27): wrapped in memo. Dashboard re-renders on
// every scroll tick (activeSection state); this card's `data` prop is
// useApi state that's stable unless it actually refetches, so those
// scroll-driven re-renders were re-rendering all 3 ModeTiles for no
// reason. memo skips that — it still re-renders normally whenever `data`
// changes or the queueMode/lastLog context values it reads directly
// change. Left as-is: the inline onSelect closure and ModeTile itself
// aren't memoized, since useCallback-wrapping onSelect and memoizing
// ModeTile would be a bigger behavior-risk change than this pass's scope
// (per-tile flash/selection state) — a candidate for a future pass, not
// invented here.
const ModeComparisonCard = memo(function ModeComparisonCard({ data }: { data: ModeComparison[] }) {
  const { openHero } = useHeroDrawer();
  const { queueMode, setQueueMode, lastLog } = useMatch();
  const byMode = Object.fromEntries(data.map(m => [m.queue_mode, m]));

  return (
    <div className="card" data-inspect-id="dash-mode-card">
      <h2 className="text-sm card-title mb-4">Mode</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {QUEUE_MODES.map(meta => (
          <ModeTile
            key={meta.value}
            meta={meta}
            m={byMode[meta.value]}
            selected={meta.value === queueMode}
            onSelect={() => {
              setQueueMode(meta.value);
              // Hand focus straight to Map Voting so the next match's prep
              // continues without a manual scroll/click.
              const mapInput = document.getElementById('map-search') as HTMLInputElement | null;
              mapInput?.focus({ preventScroll: true });
            }}
            openHero={openHero}
            lastLog={lastLog}
          />
        ))}
      </div>
    </div>
  );
});

export default ModeComparisonCard;

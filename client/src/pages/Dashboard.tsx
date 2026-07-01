import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import { Overview, Streaks, TrendPoint, ModeComparison, QueueMode, QUEUE_MODES, QUEUE_MODE_COLORS } from '../types';
import StatCard from '../components/StatCard';
import AnimatedNumber from '../components/AnimatedNumber';
import EmptyState from '../components/EmptyState';
import ModeWatermark from '../components/ModeWatermark';
import PageHeader from '../components/PageHeader';
import { useHeroDrawer } from '../contexts/HeroDrawerContext';
import { useMatch } from '../contexts/MatchContext';
import { useMatchEditDrawer } from '../contexts/MatchEditDrawerContext';
import { format, parseISO } from 'date-fns';
import Prematch from './Prematch';
import LogMatch from './LogMatch';
import TrendsSummary from '../components/TrendsSummary';

// Recent-match tile letter by queue mode (colour still encodes win/loss).
const MODE_LETTER: Record<string, string> = { qp_role: 'Q', comp_role: '5', comp_open: '6' };

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
      className={`relative overflow-hidden text-left rounded-xl p-4 transition-all duration-200 mode-tile hover:-translate-x-1 hover:-translate-y-1 ${selected ? `${c.card} ${c.glow}` : c.tileDim}`}
    >
      {/* 10% larger than the other (selector) watermarks — these tiles are bigger. */}
      <ModeWatermark
        mode={meta.value}
        variant="tile"
        className="scale-[3] translate-x-[19.0%] translate-y-[-7%] !opacity-100"
        color={selected ? undefined : 'text-ow-card'}
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
      <div className="flex items-center justify-between mb-2">
        <span className={`pill ${c.selected}`}>{meta.short}</span>
        {selected && <span className="text-[11px] uppercase tracking-widest font-bold text-white/90">Selected</span>}
      </div>
      {m && m.games > 0 ? (
        <>
          {(() => {
            // Headline = recent form (last N games) so a single match visibly
            // moves it; the all-time rate sits below, smaller.
            const big = m.recent_win_rate ?? m.win_rate;
            return (
              <div className={`text-4xl font-black tracking-tight num-display ${big >= 50 ? 'grad-win' : 'grad-loss'}`}>
                <AnimatedNumber value={big} decimals={1} suffix="%" />
              </div>
            );
          })()}
          <div className="text-xs text-[var(--muted)] dark:text-white/80 mt-0.5">
            last {m.recent_window}d · <span className="text-emerald-500">{m.recent_wins}W</span> <span className="text-red-400">{m.recent_games - m.recent_wins}L</span>
          </div>
          <div className="text-[11px] text-[var(--faint)] dark:text-white/65 mt-0.5">
            {m.win_rate}% all-time · {m.games}g
          </div>
          <div className="mt-3">
            <div className="text-[10px] text-[var(--muted)] dark:text-white/70 uppercase tracking-wider mb-1">Most played</div>
            {m.top_hero ? (
              <div className="flex items-center justify-between">
                <span
                  onClick={e => { e.stopPropagation(); openHero(m.top_hero!.hero); }}
                  className="text-sm font-medium text-[var(--ink)] hover:text-ow-accent transition-colors truncate cursor-pointer"
                >
                  {m.top_hero.hero}
                </span>
                <span className="text-xs text-[var(--muted)] dark:text-white/70 shrink-0 ml-2">
                  {m.top_hero.win_rate}% · {m.top_hero.games}g
                </span>
              </div>
            ) : (
              <div className="text-sm text-[var(--faint)] dark:text-white/65">—</div>
            )}
          </div>
        </>
      ) : (
        <div className="text-sm text-[var(--faint)] dark:text-white/50 mt-1">No games yet</div>
      )}
      </div>
    </button>
  );
}

// Per-mode summary that doubles as the queue-mode selector: tap a card to set
// the active mode that drives the advisor and the logged match.
function ModeComparisonCard({ data }: { data: ModeComparison[] }) {
  const { openHero } = useHeroDrawer();
  const { queueMode, setQueueMode, lastLog } = useMatch();
  const byMode = Object.fromEntries(data.map(m => [m.queue_mode, m]));

  return (
    <div className="card mb-6">
      <h2 className="text-sm heading-display text-[var(--ink-2)] mb-4">Mode</h2>
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
}

export default function Dashboard() {
  const { data: overview } = useApi<Overview>('/api/stats/overview');
  const { data: streaks } = useApi<Streaks>('/api/stats/streaks');
  const { data: trends } = useApi<TrendPoint[]>('/api/stats/trends?window=20');
  const { data: modeComparison } = useApi<ModeComparison[]>('/api/stats/mode-comparison');
  const { openEdit } = useMatchEditDrawer();
  // Session tilt is map-independent, so a no-arg prematch fetch gives it to us.
  const { data: prematch } = useApi<{ session: { on_tilt: boolean; tilt_win_rate: number | null; tilt_games: number } | null }>('/api/stats/prematch');
  const tilt = prematch?.session;

  const last25 = trends?.slice(-25) ?? [];
  const last100 = trends?.slice(-100) ?? [];
  const winRate = (games: TrendPoint[]) =>
    games.length ? Math.round((games.filter(g => g.win).length / games.length) * 100) : null;
  const wr25 = winRate(last25);
  const wr100 = winRate(last100);
  const wrDelta = wr25 !== null && wr100 !== null ? wr25 - wr100 : null;
  // Display a long run of history (newest first) to fill the row; the headline
  // percentage still reads only from last25/last100 above.
  const recentGames = [...(trends ?? [])].slice(-60).reverse();

  return (
    <div>
      {modeComparison && <ModeComparisonCard data={modeComparison} />}

      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-sm heading-display text-[var(--ink-2)]">Recent Matches</h2>
            {recentGames.length > 0 && (
              <span className="text-xs text-[var(--faint)] bg-ow-border/50 px-2 py-0.5 rounded-full whitespace-nowrap">tap to edit</span>
            )}
          </div>
          {wr25 !== null && (
            <div className="flex items-baseline gap-2 text-xs">
              <span className="text-[var(--faint)]">last {last25.length}</span>
              <span className={`text-2xl font-black tracking-tight num-display ${wr25 >= 50 ? 'grad-win' : 'grad-loss'}`}><AnimatedNumber value={wr25} suffix="%" /></span>
              {wrDelta !== null && (
                <span className={wrDelta > 0 ? 'text-emerald-600' : wrDelta < 0 ? 'text-red-600' : 'text-[var(--faint)]'}>
                  {wrDelta > 0 ? '▲' : wrDelta < 0 ? '▼' : '±'} {wrDelta > 0 ? '+' : ''}{wrDelta} vs last {last100.length} ({wr100}%)
                </span>
              )}
            </div>
          )}
        </div>
        <div
          className="flex gap-1.5 flex-nowrap overflow-hidden py-1"
          style={{
            WebkitMaskImage: 'linear-gradient(to right, #000 72%, transparent)',
            maskImage: 'linear-gradient(to right, #000 72%, transparent)',
          }}
        >
          {recentGames.map(g => (
            <button
              key={g.id}
              type="button"
              onClick={() => openEdit(g)}
              title={`${g.win ? 'Win' : 'Loss'} · ${g.hero} on ${g.map} (${format(parseISO(g.date), 'MMM d')}) — tap to edit`}
              className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-xs font-black border transition-all duration-150 cursor-pointer hover:-translate-y-0.5 hover:ring-2 hover:ring-offset-1 hover:ring-offset-transparent ${
                g.win
                  ? 'bg-emerald-100 text-emerald-700 border-emerald-300 hover:ring-emerald-400/60 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/40'
                  : 'bg-rose-100 text-rose-700 border-rose-300 hover:ring-rose-400/60 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/40'
              }`}
            >
              {MODE_LETTER[g.queue_mode] ?? '·'}
            </button>
          ))}
          {recentGames.length === 0 && (
            <EmptyState
              icon="◴"
              title="No matches logged yet"
              hint="Log your first result below and your recent form will track here."
              className="w-full"
            />
          )}
        </div>

        {tilt?.on_tilt && (
          <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mt-4">
            <span className="text-amber-600 text-lg shrink-0">⚠</span>
            <div>
              <div className="text-sm font-semibold text-amber-700">You've lost 2 in a row today</div>
              {tilt.tilt_win_rate !== null && tilt.tilt_games >= 10 && (
                <div className="text-xs text-amber-600/80 mt-0.5">
                  Historically your win rate in this situation is {tilt.tilt_win_rate}% — a short break often helps.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mt-8 border-t border-ow-border pt-6">
        <PageHeader title="Match" sub="Prep with the advisor, then log the result." />
        <Prematch />
        <LogMatch />
      </div>

      <div className="mt-8 border-t border-ow-border pt-6">
        <PageHeader title="Trends" sub="Recent form and momentum." />
        <TrendsSummary />
      </div>

      <div className="mt-8 border-t border-ow-border pt-6">
        <PageHeader title="Career" sub="All-time totals across every mode." />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <StatCard label="Total Games" value={overview?.total ?? '—'} />
        <StatCard
          label="Win Rate"
          value={overview ? overview.win_rate : '—'}
          decimals={1}
          suffix="%"
          color={overview && overview.win_rate >= 50 ? 'win' : 'loss'}
        />
        <StatCard label="Wins" value={overview?.wins ?? '—'} color="win" />
        <StatCard label="Losses" value={overview ? overview.total - overview.wins : '—'} color="loss" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Heroes Played" value={overview?.heroes_played ?? '—'} />
        <StatCard label="Maps Played" value={overview?.maps_played ?? '—'} />
        <StatCard
          label="Current Streak"
          value={streaks ? `${streaks.currentStreak} ${streaks.currentStreakType === 1 ? 'W' : 'L'}` : '—'}
          color={streaks?.currentStreakType === 1 ? 'win' : 'loss'}
        />
        <StatCard label="Longest Win Streak" value={streaks?.longestWin ?? '—'} color="win" />
        </div>
      </div>
    </div>
  );
}

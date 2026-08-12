import { useState, useEffect, Fragment } from 'react';
import { useApi } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
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
      className={`relative overflow-hidden text-left rounded-xl p-4 transition-all duration-200 mode-tile hover:-translate-x-1 hover:-translate-y-1 ${selected ? `${c.card} ${c.glow}` : c.tileDim}`}
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
        {selected && <span className="shrink-0 whitespace-nowrap text-[11px] uppercase tracking-widest font-bold text-white/90">Selected</span>}
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
            last <b className="font-bold">{m.recent_window}</b>d · <span className="text-emerald-500 font-bold">{m.recent_wins}W</span> <span className="text-red-400 font-bold">{m.recent_games - m.recent_wins}L</span>
          </div>
          <div className="text-[11px] text-[var(--faint)] dark:text-white/65 mt-0.5">
            <b className="font-bold">{m.win_rate}</b>% all-time · <b className="font-bold">{m.games}</b>g
          </div>
          <div className="mt-3">
            <div className="text-[10px] text-[var(--muted)] dark:text-white/70 uppercase tracking-wider mb-1">Most played</div>
            {m.top_hero ? (
              <div className="flex items-center justify-between">
                <span
                  onClick={e => { e.stopPropagation(); openHero(m.top_hero!.hero); }}
                  title={m.top_hero.hero.toUpperCase()}
                  className="min-w-0 text-xs hero-name text-[var(--ink)] hover:text-ow-accent transition-colors truncate cursor-pointer"
                >
                  {withHeroCount(m.top_hero.hero, heroCounts)}
                </span>
                <span className="text-xs text-[var(--muted)] dark:text-white/70 shrink-0 ml-2 font-bold">
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
    <div className="card" data-inspect-id="dash-mode-card">
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
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();
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
  // Group consecutive tiles by calendar day (newest-first order preserved).
  const gamesByDay = recentGames.reduce<{ dateStr: string; games: TrendPoint[] }[]>((acc, g) => {
    const day = g.date.slice(0, 10);
    if (acc.length === 0 || acc[acc.length - 1].dateStr !== day) {
      acc.push({ dateStr: day, games: [g] });
    } else {
      acc[acc.length - 1].games.push(g);
    }
    return acc;
  }, []);

  const sections = [
    { id: 'sec-mode', label: 'Mode' },
    { id: 'sec-match', label: 'Match' },
    { id: 'sec-trends', label: 'Trends' },
    { id: 'sec-career', label: 'Career' },
  ];

  // Tracks which section is currently in view so the quick-nav pill can get
  // the same solid-fill active treatment SensNav already uses, instead of
  // every pill sitting at the same neutral gray forever. The negative
  // top margin clears both sticky bars (header + this nav) before a section
  // counts as "current".
  const [activeSection, setActiveSection] = useState(sections[0].id);
  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.find(e => e.isIntersecting);
        if (visible) setActiveSection(visible.target.id);
      },
      { rootMargin: '-140px 0px -70% 0px', threshold: 0 },
    );
    sections.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {/* Wayfinding rail: the page is one long scroll of readout panels, so a
          sticky jump-strip stands in for the section tabs a multi-page app
          would use. Sits flush under the sticky header. */}
      <nav
        data-inspect-id="dash-section-nav"
        aria-label="Jump to section"
        className="sticky top-16 z-20 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2 mb-6 flex items-center gap-1.5 overflow-x-auto backdrop-blur border-b border-ow-border"
        style={{ backgroundColor: 'color-mix(in srgb, var(--surface) 88%, transparent)' }}
      >
        {sections.map(s => (
          <a
            key={s.id}
            href={`#${s.id}`}
            aria-current={activeSection === s.id ? 'true' : undefined}
            className={`pill shrink-0 border transition-colors heading-display tracking-[0.08em] ${
              activeSection === s.id
                ? 'bg-ow-accent/15 text-ow-accent border-ow-accent'
                : 'border-ow-border text-[var(--muted)] hover:text-ow-accent hover:border-ow-accent/60'
            }`}
          >
            {s.label}
          </a>
        ))}
      </nav>

      <div id="sec-mode" className="scroll-mt-32">
        {modeComparison && (
          <div className="reveal mb-6" style={{ '--reveal-delay': '0ms' } as React.CSSProperties}>
            <ModeComparisonCard data={modeComparison} />
          </div>
        )}

        <div className="card reveal" style={{ '--reveal-delay': '60ms' } as React.CSSProperties} data-inspect-id="dash-recent-matches-card">
          <div className="flex items-center justify-between flex-wrap gap-y-1 mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm heading-display text-[var(--ink-2)]">Recent Matches</h2>
              {recentGames.length > 0 && (
                <span data-inspect-id="dash-tap-to-edit-badge" className="text-xs text-[var(--faint)] bg-ow-border/50 px-2 py-0.5 rounded-full whitespace-nowrap">tap to edit</span>
              )}
            </div>
            {wr25 !== null && (
              <div className="flex items-baseline gap-2 text-xs" data-inspect-id="dash-recent-form-stat">
                <span className="text-[var(--faint)]">last <b className="font-bold">{last25.length}</b></span>
                <span className={`text-4xl font-black tracking-tight num-display ${wr25 >= 50 ? 'grad-win' : 'grad-loss'}`}><AnimatedNumber value={wr25} suffix="%" /></span>
                {wrDelta !== null && (
                  <span className={`font-bold ${wrDelta > 0 ? 'text-emerald-600' : wrDelta < 0 ? 'text-red-600' : 'text-[var(--faint)]'}`}>
                    {wrDelta > 0 ? '▲' : wrDelta < 0 ? '▼' : '±'} {wrDelta > 0 ? '+' : ''}{wrDelta} vs last {last100.length} ({wr100}%)
                  </span>
                )}
              </div>
            )}
          </div>
          <div
            data-inspect-id="dash-recent-match-history-list"
            className="flex gap-1.5 flex-nowrap overflow-hidden py-1"
            style={{
              WebkitMaskImage: 'linear-gradient(to right, #000 72%, transparent)',
              maskImage: 'linear-gradient(to right, #000 72%, transparent)',
            }}
          >
            {gamesByDay.map((group, i) => (
              <Fragment key={group.dateStr}>
                {i > 0 && (
                  <div className="flex flex-col items-center shrink-0 gap-0.5 self-stretch justify-center mx-0.5">
                    <div className="w-px flex-1 bg-ow-border opacity-60" />
                    <span className="text-[8px] leading-none text-[var(--faint)]">
                      {format(parseISO(gamesByDay[i - 1].dateStr), 'M/d')}
                    </span>
                    <div className="w-px flex-1 bg-ow-border opacity-60" />
                  </div>
                )}
                {group.games.map(g => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => openEdit(g)}
                    title={`${g.win ? 'Win' : 'Loss'} · ${withHeroCount(g.hero, heroCounts).toUpperCase()} on ${withMapCount(g.map, mapCounts).toUpperCase()} (${format(parseISO(g.date), 'MMM d')}) — tap to edit`}
                    className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-sm italic font-display font-black transition-all duration-150 cursor-pointer hover:-translate-y-0.5 hover:ring-2 hover:ring-offset-1 hover:ring-offset-transparent ${
                      g.win
                        ? 'bg-emerald-100 text-emerald-700 hover:ring-emerald-400/60 dark:bg-emerald-500/15 dark:text-emerald-300'
                        : 'bg-rose-100 text-rose-700 hover:ring-rose-400/60 dark:bg-rose-500/15 dark:text-rose-300'
                    }`}
                  >
                    {MODE_LETTER[g.queue_mode] ?? '·'}
                  </button>
                ))}
              </Fragment>
            ))}
            {recentGames.length === 0 && (
              <EmptyState
                dataInspectId="dash-empty-state-banner"
                icon="◴"
                title="No matches logged yet"
                hint="Log your first result below and your recent form will track here."
                className="w-full"
              />
            )}
          </div>

          {tilt?.on_tilt && (
            <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mt-4" data-inspect-id="dash-tilt-warning-banner">
              <span className="text-amber-600 text-lg shrink-0">⚠</span>
              <div>
                <div className="text-sm font-semibold text-amber-700">You've lost <b className="font-bold">2</b> in a row today</div>
                {tilt.tilt_win_rate !== null && tilt.tilt_games >= 10 && (
                  <div className="text-xs text-amber-600/80 mt-0.5">
                    Historically your win rate in this situation is <b className="font-bold">{tilt.tilt_win_rate}</b>% — a short break often helps.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div id="sec-match" className="mt-8 border-t border-ow-border pt-6 reveal scroll-mt-32" style={{ '--reveal-delay': '120ms' } as React.CSSProperties}>
        <PageHeader dataInspectId="dash-match-section-header" title="Match" sub="Prep with the advisor, then log the result.">
          {/* Links to the (otherwise unlinked) sensitivity-study pages, on the
              right of the section header. Open in a new tab so the dashboard
              stays put while stats are logged. */}
          <a
            href="/sens" target="_blank" rel="noreferrer"
            data-inspect-id="dash-log-sens-stats-link"
            className="shrink-0 bg-ow-card border border-ow-border px-4 py-2 text-sm heading-display text-[var(--ink)] hover:text-ow-accent transition-colors shadow-[var(--card-shadow)]"
            style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}
          >
            Log sens stats
          </a>
        </PageHeader>
        <div className="contents" data-inspect-id="dash-prematch-section"><Prematch /></div>
        <div className="contents" data-inspect-id="dash-logmatch-section"><LogMatch /></div>
      </div>

      <div id="sec-trends" className="mt-8 border-t border-ow-border pt-6 reveal scroll-mt-32" style={{ '--reveal-delay': '180ms' } as React.CSSProperties}>
        <PageHeader dataInspectId="dash-trends-section-header" title="Trends" sub="Recent form and momentum." />
        <TrendsSummary />
      </div>

      <div id="sec-career" className="mt-8 border-t border-ow-border pt-6 reveal scroll-mt-32" style={{ '--reveal-delay': '240ms' } as React.CSSProperties}>
        <PageHeader dataInspectId="dash-career-section-header" title="Career" sub="All-time totals across every mode." />
        {/* One continuous readout strip rather than two stacked 4-tile grids —
            all eight career totals scan as a single row on wide screens. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          <StatCard compact dataInspectId="dash-stat-total-games" label="Total Games" value={overview?.total ?? '—'} />
          <StatCard
            compact
            dataInspectId="dash-stat-win-rate"
            label="Win Rate"
            value={overview ? overview.win_rate : '—'}
            decimals={1}
            suffix="%"
            color={overview && overview.win_rate >= 50 ? 'win' : 'loss'}
          />
          <StatCard compact dataInspectId="dash-stat-wins" label="Wins" value={overview?.wins ?? '—'} color="win" />
          <StatCard compact dataInspectId="dash-stat-losses" label="Losses" value={overview ? overview.total - overview.wins : '—'} color="loss" />
          <StatCard compact dataInspectId="dash-stat-heroes-played" label="Heroes Played" value={overview?.heroes_played ?? '—'} />
          <StatCard compact dataInspectId="dash-stat-maps-played" label="Maps Played" value={overview?.maps_played ?? '—'} />
          <StatCard
            compact
            dataInspectId="dash-stat-current-streak"
            label="Current Streak"
            value={streaks ? `${streaks.currentStreak} ${streaks.currentStreakType === 1 ? 'W' : 'L'}` : '—'}
            color={streaks?.currentStreakType === 1 ? 'win' : 'loss'}
          />
          <StatCard compact dataInspectId="dash-stat-longest-win-streak" label="Longest Win Streak" value={streaks?.longestWin ?? '—'} color="win" />
        </div>
      </div>
    </div>
  );
}

import { useState, useRef, useEffect } from 'react';
import { format } from 'date-fns';
import { useApi } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { MAPS, QUEUE_MODES, ROLE_COLORS, TYPE_COLORS, MapVotingRow, Streaks } from '../types';
import AdvisorCard from '../components/AdvisorCard';
import EmptyState from '../components/EmptyState';
import { useMapDrawer } from '../contexts/MapDrawerContext';
import { useHeroDrawer } from '../contexts/HeroDrawerContext';
import { useMatch } from '../contexts/MatchContext';
import { Link } from 'react-router-dom';
import Odometer from '../components/Odometer';

// DPI stage-test HUD state — the dashboard reads this live to show the
// current stage's DPI plainly (no hiding, no LED colors).
interface BlindHud {
  active: {
    set_id: number; cur_stage: number; n_stages: number; totalGames: number;
    batch_size: number; games_on_stage: number; dpi: number | null;
  } | null;
}

const ALL_MAPS = Object.keys(MAPS).sort();

interface HeroRow { hero: string; role: string; games: number; wins: number; win_rate: number }

interface PrematchData {
  byHero:         HeroRow[];
  bestHeroes:     HeroRow[];
  session: {
    games_today:    number;
    next_game_pos:  number;
    on_tilt:        boolean;
    last3:          boolean[];
    depth_win_rate: number | null;
    depth_games:    number;
    tilt_win_rate:  number | null;
    tilt_games:     number;
  } | null;
  bestByGameType: HeroRow | null;
}

export default function Prematch() {
  // Shared, single-instance match state (queue mode, map, advisor) lives here
  // and is consumed by the Log Match section too.
  const { queueMode, map, setMap, mapType, rec, recLoading, recError, refreshRec, setPendingHero, matchLoggedSignal } = useMatch();
  const { data: blindHud } = useApi<BlindHud>('/api/blind/state');
  const bt = blindHud?.active ?? null;
  const btGamesLeft = bt ? Math.max(0, bt.batch_size - bt.games_on_stage) : 0;
  // Matches left across the WHOLE test — every stage's sample combined, minus
  // what's already been logged. Starts at n_stages × batch_size (e.g. 36).
  const btTestLeft = bt ? Math.max(0, bt.n_stages * bt.batch_size - bt.totalGames) : 0;
  const { data: pendingData } = useApi<{ total: number }>('/api/aim/pending?limit=1');
  const backlogCount = pendingData?.total ?? 0;
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();

  const params = new URLSearchParams();
  if (map) params.set('map', map);
  if (mapType) params.set('game_type', mapType);

  const { data } = useApi<PrematchData>(`/api/stats/prematch?${params}`, [map]);

  const { openMap } = useMapDrawer();
  const { openHero } = useHeroDrawer();
  const { data: votingData } = useApi<MapVotingRow[]>('/api/stats/map-voting');

  // Idle-state filler data for the Map Voting / Hero Advisor cards.
  const today = format(new Date(), 'yyyy-MM-dd');
  const { data: todayMatches } = useApi<{ rows: { win: 0 | 1 }[] }>(`/api/matches?from=${today}&to=${today}&limit=100`);
  const { data: streaksData } = useApi<Streaks>('/api/stats/streaks');
  const { data: byHour } = useApi<{ hour: number; games: number; wins: number; win_rate: number }[]>('/api/stats/by-hour');
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery]       = useState('');
  const [open, setOpen]         = useState(false);
  const [expandedOther, setExpandedOther] = useState<string | null>(null);
  const inputRef                = useRef<HTMLInputElement>(null);

  // Reset the voting picks after a match is logged (skips the initial mount).
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    setSelected([]);
    setQuery('');
    setOpen(false);
  }, [matchLoggedSignal]);

  // Keep focus on the map search whenever the app is idle (no map selected).
  useEffect(() => {
    if (!map) inputRef.current?.focus();
  }, [map]);

  const scoreMap = Object.fromEntries((votingData ?? []).map(r => [r.map, r]));

  // Best & worst maps by win rate (min games), for the idle Map Voting card.
  const rankedMaps = (votingData ?? [])
    .filter(m => m.total_games >= 5)
    .sort((a, b) => b.historical_rate - a.historical_rate);
  const bestMaps = rankedMaps.slice(0, 3);
  const worstMaps = rankedMaps.slice(-3).reverse().filter(m => !bestMaps.includes(m));

  // Session & timing snapshot for the idle Hero Advisor card.
  const todayRows = todayMatches?.rows ?? [];
  const todayW = todayRows.filter(r => r.win === 1).length;
  const todayL = todayRows.length - todayW;
  const curHour = new Date().getHours();
  const hourRow = (byHour ?? []).find(h => h.hour === curHour);
  const hourLabel = format(new Date(), 'h a');

  const results = query.length > 0
    ? ALL_MAPS.filter(m => m.toLowerCase().includes(query.toLowerCase()) && !selected.includes(m))
    : [];

  function selectMap(m: string) {
    if (selected.length >= 3 || selected.includes(m)) return;
    setSelected(prev => [...prev, m]);
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  }

  function toggleMap(m: string) {
    setSelected(prev => {
      const next = prev.includes(m) ? prev.filter(x => x !== m) : prev.length < 3 ? [...prev, m] : prev;
      if (!next.includes(map)) setMap('');
      return next;
    });
  }

  const ranked  = [...selected].sort((a, b) => (scoreMap[b]?.blended_score ?? 0) - (scoreMap[a]?.blended_score ?? 0));
  const winner  = ranked[0];
  const topOnMap = data?.byHero ?? [];

  // For each role, show up to 5 qualified heroes (>=2 games), then roll the
  // remaining heroes on this map into a single combined "Other heroes" slot.
  const MIN_GAMES = 2;
  const TOP_N = 5;
  function buildRole(role: string) {
    const all = topOnMap.filter(h => h.role === role); // already win_rate desc
    const top = all.filter(h => h.games >= MIN_GAMES).slice(0, TOP_N);
    const topSet = new Set(top.map(h => h.hero));
    const rest = all.filter(h => !topSet.has(h.hero));
    let other: { games: number; wins: number; win_rate: number; count: number; tooltip: string } | null = null;
    if (top.length < TOP_N && rest.length > 0) {
      const games = rest.reduce((s, h) => s + h.games, 0);
      const wins  = rest.reduce((s, h) => s + (h.wins ?? 0), 0);
      const tooltip = rest.map(h => `${withHeroCount(h.hero, heroCounts)} ${h.win_rate}% (${h.games}g)`).join('\n');
      other = { games, wins, win_rate: games ? Math.round((wins / games) * 1000) / 10 : 0, count: rest.length, tooltip };
    }
    return { top, other };
  }
  const byRole = {
    DPS:     buildRole('DPS'),
    Tank:    buildRole('Tank'),
    Support: buildRole('Support'),
  };
  const recommendation = topOnMap.find(h => h.games >= MIN_GAMES) ?? data?.bestHeroes[0];

  const queueLabel = QUEUE_MODES.find(q => q.value === queueMode)?.label ?? '';

  return (
    <div>

      {/* Blind trial (square) + Map Voting + Hero Advisor row */}
      <div className="flex items-stretch gap-4 mb-4">

        {/* DPI stage-test HUD — shows the current stage's DPI plainly (no
            hiding), plus two live wheels: matches left in the whole test and
            games left before the next stage switch. Drives off the same
            state the Sens page loop does. Sits where the sens picker used to. */}
        <div className="card aspect-square shrink-0 flex flex-col self-stretch">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm heading-display text-[var(--ink)] whitespace-nowrap">DPI Test</h2>
            {bt && <span className="text-xs num-display text-[var(--ink)]">{bt.dpi} DPI</span>}
          </div>
          {bt ? (
            <div className="flex-1 grid grid-cols-[auto_auto] items-center gap-x-3 gap-y-1.5 place-content-center">
              <Odometer value={btTestLeft} />
              <div className="leading-tight">
                <div className="text-sm text-[var(--ink)]">matches left</div>
                <div className="text-[10px] text-[var(--faint-2)]">in this test</div>
              </div>
              <Odometer value={btGamesLeft} />
              <div className="leading-tight">
                <div className="text-sm text-[var(--ink)]">games left</div>
                <div className="text-[10px] text-[var(--faint-2)]">in stage {bt.cur_stage}</div>
              </div>
              {/* Backlog counter shares this grid's column tracks (rather than
                  being its own grid) so its drum is guaranteed to land in the
                  same x position as the two above — a separate grid re-centers
                  independently and drifts whenever the label text width differs. */}
              <Odometer value={backlogCount} />
              <div className="leading-tight">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--ink)]">in backlog</span>
                  <Link
                    to="/sens"
                    className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-gradient-to-r from-ow-accent to-ow-accentLight text-white shadow-md shadow-ow-accent/30 hover:brightness-110 active:brightness-95 transition-all whitespace-nowrap"
                  >
                    Go →
                  </Link>
                </div>
                <div className="text-[10px] text-[var(--faint-2)]">matches awaiting stats</div>
              </div>
            </div>
          ) : (
            <div className="flex-1 grid place-items-center text-center px-2">
              <div>
                <div className="text-xs text-[var(--faint)]">No DPI test running</div>
                <div className="text-[10px] text-[var(--faint-2)] mt-1">Start one on the Sens page →</div>
              </div>
            </div>
          )}

          {/* Idle state has no sibling drum row to align with, so the backlog
              counter gets its own simple centered row here instead. */}
          {!bt && (
            <div className="flex items-center justify-center gap-3 pt-3 mt-2">
              <Odometer value={backlogCount} />
              <div className="leading-tight">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--ink)]">in backlog</span>
                  <Link
                    to="/sens"
                    className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-gradient-to-r from-ow-accent to-ow-accentLight text-white shadow-md shadow-ow-accent/30 hover:brightness-110 active:brightness-95 transition-all whitespace-nowrap"
                  >
                    Go →
                  </Link>
                </div>
                <div className="text-[10px] text-[var(--faint-2)]">matches awaiting stats</div>
              </div>
            </div>
          )}
        </div>

        {/* Map Voting */}
        <div className="card flex-1 min-w-0 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm heading-display text-[var(--ink)] whitespace-nowrap">Map Voting</h2>
              <span className="text-xs text-[var(--faint)] bg-ow-border/50 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">tap up to 3</span>
            </div>
            {selected.length > 0 && (
              <button onClick={() => setSelected([])} className="text-xs text-[var(--faint)] hover:text-[var(--ink)] transition-colors">
                clear
              </button>
            )}
          </div>

          {/* Search input */}
          <div className="relative mb-3">
            <input
              ref={inputRef}
              id="map-search"
              type="text"
              value={query}
              onChange={e => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 100)}
              onKeyDown={e => {
                if (e.key === 'Escape') { setQuery(''); setOpen(false); }
                if (e.key === 'Enter' && results.length > 0) selectMap(results[0]);
              }}
              placeholder={selected.length >= 3 ? '3 maps selected' : 'Type a map name…'}
              disabled={selected.length >= 3}
              className="w-full field px-3 py-2 text-sm"
            />
            {open && results.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-ow-card rounded-lg shadow-xl z-30 overflow-hidden">
                {results.map(m => (
                  <button
                    key={m}
                    onMouseDown={() => selectMap(m)}
                    className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-white/5 transition-colors text-left"
                  >
                    <span className="text-[var(--ink)]">{withMapCount(m, mapCounts)}</span>
                    <span className={`pill ${TYPE_COLORS[MAPS[m]] ?? ''}`}>{MAPS[m]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Idle: best & worst maps by win rate — tap one to add it to your
              picks (which swaps this block for the chips + vote below). */}
          {selected.length === 0 && rankedMaps.length > 0 && (
            <div className="flex-1 grid grid-cols-2 gap-x-4 content-center">
              {([
                { label: 'Best maps', color: 'text-emerald-600', pct: 'text-emerald-500', list: bestMaps },
                { label: 'Worst maps', color: 'text-red-500', pct: 'text-red-500', list: worstMaps },
              ] as const).map(col => (
                <div key={col.label}>
                  <div className={`text-[10px] uppercase tracking-wider mb-1.5 ${col.color}`}>{col.label}</div>
                  {col.list.map(m => (
                    <button
                      key={m.map}
                      onClick={() => selectMap(m.map)}
                      className="flex items-center justify-between w-full text-left py-1 px-1 -mx-1 rounded hover:bg-white/5 transition-colors group"
                    >
                      <span className="text-sm text-[var(--ink)] truncate group-hover:text-ow-accent transition-colors">{withMapCount(m.map, mapCounts)}</span>
                      <span className={`text-xs font-semibold shrink-0 ml-2 ${col.pct}`}>{Math.round(m.historical_rate)}%</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Selected chips */}
          {selected.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {selected.map(m => (
                <button
                  key={m}
                  onClick={() => toggleMap(m)}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                    m === winner
                      ? 'bg-emerald-500/20 text-emerald-700'
                      : 'bg-ow-accent/15 text-ow-accent'
                  }`}
                >
                  {m === winner && <span className="text-xs">✓</span>}
                  {withMapCount(m, mapCounts)}
                  <span className="text-xs opacity-60">×</span>
                </button>
              ))}
            </div>
          )}

          {/* Vote recommendation */}
          {ranked.length > 0 && (
            <div className="pt-4 mt-4">
              {ranked.length === 1 ? (
                <div className="text-sm text-[var(--muted)]">Select more maps to compare.</div>
              ) : (
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <div className="text-xs text-[var(--faint)] mb-1 uppercase tracking-wider">Vote for</div>
                    <button onClick={() => openMap(winner)} className="text-xl font-bold text-emerald-600 hover:text-emerald-700 transition-colors text-left">
                      {withMapCount(winner, mapCounts)}
                    </button>
                    {scoreMap[winner] && (
                      <div className="text-xs text-[var(--faint)] mt-0.5">
                        {scoreMap[winner].blended_score}% blended · {scoreMap[winner].total_games}g played
                      </div>
                    )}
                  </div>
                  <div className="text-right space-y-1">
                    {ranked.slice(1).map(m => (
                      <div key={m} className="text-sm text-[var(--faint)]">
                        {withMapCount(m, mapCounts)}{scoreMap[m] ? ` · ${scoreMap[m].blended_score}%` : ' · no data'}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Hero Advisor — Map selector */}
        <div className="card flex-1 min-w-0 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm heading-display text-[var(--ink)] whitespace-nowrap">Hero Advisor</h2>
              <span className="text-xs text-[var(--faint)] bg-ow-border/50 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">pick a map</span>
            </div>
            {map && (
              <button onClick={() => setMap('')} className="text-xs text-[var(--faint)] hover:text-[var(--ink)] transition-colors">
                clear
              </button>
            )}
          </div>

          <div className="mb-3">
            <select
              value={map}
              onChange={e => setMap(e.target.value)}
              className="w-full field px-3 py-2 text-sm"
            >
              <option value="">— Select map —</option>
              {(selected.length > 0 ? selected : Object.keys(MAPS)).sort().map(m => (
                <option key={m} value={m}>{withMapCount(m, mapCounts)}</option>
              ))}
            </select>
          </div>
          {mapType && <span className={`pill ${TYPE_COLORS[mapType] ?? ''}`}>{mapType}</span>}

          {/* Idle: session & timing snapshot — how you're doing right now */}
          {!map && (
            <div className="flex-1 flex items-stretch content-center mt-1">
              <div className="flex-1 p-2.5 flex flex-col justify-center items-center text-center">
                <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-1">Today</div>
                {todayRows.length > 0 ? (
                  <div className="text-3xl num-display leading-none">
                    <span className="text-emerald-500">{todayW}W</span> <span className="text-red-500">{todayL}L</span>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--faint)]">No games</div>
                )}
              </div>
              <div className="w-px shrink-0 bg-gradient-to-b from-transparent via-ow-border to-transparent" />
              <div className="flex-1 p-2.5 flex flex-col justify-center items-center text-center">
                <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-1">Streak</div>
                {streaksData && streaksData.currentStreak > 0 ? (
                  <div className={`text-3xl num-display leading-none ${streaksData.currentStreakType === 1 ? 'text-emerald-500' : 'text-red-500'}`}>
                    {streaksData.currentStreak}{streaksData.currentStreakType === 1 ? 'W' : 'L'}
                  </div>
                ) : (
                  <div className="text-sm text-[var(--faint)]">—</div>
                )}
              </div>
              <div className="w-px shrink-0 bg-gradient-to-b from-transparent via-ow-border to-transparent" />
              <div className="flex-1 p-2.5 flex flex-col justify-center items-center text-center">
                <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-1">This hour</div>
                {hourRow ? (
                  // Subtext is absolutely positioned so it doesn't push the number
                  // off-center — keeps this stat aligned with Today/Streak.
                  <div className="relative">
                    <div className={`text-3xl num-display leading-none ${hourRow.win_rate >= 50 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {Math.round(hourRow.win_rate)}%
                    </div>
                    <div className="absolute top-full left-1/2 -translate-x-1/2 whitespace-nowrap text-[9px] text-[var(--faint-2)] mt-1">{hourLabel} · {hourRow.games}g</div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--faint)]">—</div>
                )}
              </div>
            </div>
          )}
        </div>

      </div>

      {/* Consolidated advisor — recommendation + coaching + your heroes in one
          card below the row. When a map is picked these three used to repeat the
          same "what to play" answer across separate cards; here they read as one
          flow: the pick, the coaching behind it, then the full breakdown. */}
      <div className="card">
        <div className="flex items-start justify-between gap-3 mb-1">
          <div>
            <h2 className="text-sm heading-display text-[var(--ink-2)]">
              {map ? (
                <>Your Heroes on <button onClick={() => openMap(map)} className="text-ow-accent hover:text-ow-accent/80 transition-colors">{withMapCount(map, mapCounts)}</button></>
              ) : 'Your Best Heroes Overall'}
            </h2>
            <p className="text-xs text-[var(--faint)] mt-0.5">By role · min 2 games · tap hero to pre-fill log</p>
          </div>
          {map && (
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest shrink-0 pt-0.5">
              <span className="text-[var(--faint)]">{queueLabel}</span>
              <button
                onClick={refreshRec}
                disabled={recLoading}
                className="text-[var(--faint)] hover:text-emerald-600 disabled:opacity-40"
                title="Refresh advisor"
              >
                {recLoading ? '…' : '↻'}
              </button>
            </div>
          )}
        </div>

        {/* Recommended pick — only with no map selected; once a map is chosen the
            coaching block's primary stands as the pick, so this would just repeat it. */}
        {recommendation && !map && (
          <div className="rounded-xl bg-gradient-to-br from-ow-accent/10 via-ow-accent/[0.04] to-transparent px-4 py-3 mt-3">
            <div className="text-[10px] grad-brand font-bold uppercase tracking-widest mb-1">Recommended pick</div>
            <div className="flex items-center gap-3">
              <div>
                <button onClick={() => openHero(recommendation.hero)} className="text-xl font-black tracking-tight text-[var(--ink)] hover:text-ow-accent transition-colors text-left">
                  {withHeroCount(recommendation.hero, heroCounts)}
                </button>
                <span className={`pill ml-2 ${ROLE_COLORS[recommendation.role]}`}>{recommendation.role}</span>
              </div>
              <div className="ml-auto text-right">
                <div className={`text-2xl font-black tracking-tight num-display ${recommendation.win_rate >= 50 ? 'grad-win' : 'grad-loss'}`}>
                  {recommendation.win_rate}%
                </div>
                <div className="text-[11px] text-[var(--muted)]">
                  {recommendation.games} games overall
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Coaching — LLM tactical read + death patterns, only once a map is set */}
        {map && (
          <div id="coaching" className="scroll-mt-24 rounded-xl bg-emerald-500/5 px-4 py-3 mt-3">
            <div className="text-[10px] text-emerald-600 uppercase tracking-widest font-semibold mb-2">Coaching</div>
            <AdvisorCard
              bare
              map={map}
              queueLabel={queueLabel}
              rec={rec}
              loading={recLoading}
              error={recError}
              onRefresh={refreshRec}
              onOpenHero={openHero}
            />
          </div>
        )}

        {/* Your heroes by role — the full breakdown, and the actual hero-select
            control (tapping a hero pre-fills the Match Log). Styled as its own
            selection panel — bordered, tinted, chip buttons — rather than a
            trailing stats list, so it doesn't get missed after Coaching above it. */}
        <div className="mt-4 pt-4 border-t border-ow-border/40">
        <div className="rounded-xl bg-violet-500/[0.06] px-4 py-3.5">
        <h3 className="text-sm grad-brand font-black uppercase tracking-widest mb-3">Select Your Hero</h3>
        {topOnMap.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {(['DPS', 'Tank', 'Support'] as const).map(role => {
              const { top, other } = byRole[role];
              return (
                <div key={role}>
                  <div className={`text-xs font-bold uppercase tracking-widest mb-2 ${ROLE_COLORS[role].split(' ')[1]}`}>{role}</div>
                  <div className="flex flex-col gap-1.5">
                    {top.map(h => (
                      <button
                        key={h.hero}
                        onClick={() => setPendingHero(h.hero)}
                        className="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-lg border border-ow-border bg-ow-darker hover:border-violet-500/70 hover:bg-violet-500/10 active:scale-[0.98] transition-all group"
                      >
                        <span className={`text-sm ${h.win_rate >= 50 ? 'text-emerald-700' : 'text-red-500'}`}>{h.win_rate >= 50 ? '↑' : '↓'}</span>
                        <span className="flex-1 text-sm font-semibold text-[var(--ink)] group-hover:text-violet-500 transition-colors">{withHeroCount(h.hero, heroCounts)}</span>
                        <span className={`text-sm font-semibold ${h.win_rate >= 60 ? 'text-emerald-600' : h.win_rate >= 50 ? 'text-ow-blue' : h.win_rate >= 40 ? 'text-yellow-400' : 'text-red-600'}`}>{h.win_rate}%</span>
                        <span className="text-xs text-[var(--faint-2)] w-7 text-right">{h.games}g</span>
                      </button>
                    ))}
                    {other && (() => {
                      const isOpen = expandedOther === role;
                      const rest = topOnMap.filter(h => h.role === role && !byRole[role].top.find(t => t.hero === h.hero));
                      return (
                        <>
                          <button
                            onClick={() => setExpandedOther(isOpen ? null : role)}
                            className="flex items-center gap-3 w-full text-left px-3 py-2 rounded-lg border border-dashed border-ow-border/70 hover:border-violet-500/50 hover:bg-white/5 transition-colors group"
                          >
                            <span className={`text-sm transition-transform ${isOpen ? 'rotate-90' : ''} text-[var(--faint-2)]`}>›</span>
                            <span className="flex-1 text-sm font-medium text-[var(--faint)] italic group-hover:text-[var(--ink)] transition-colors">
                              Other heroes <span className="not-italic text-[var(--faint-2)]">({other.count})</span>
                            </span>
                            <span className={`text-sm font-semibold ${other.win_rate >= 60 ? 'text-emerald-600' : other.win_rate >= 50 ? 'text-ow-blue' : other.win_rate >= 40 ? 'text-yellow-400' : 'text-red-600'}`}>{other.win_rate}%</span>
                            <span className="text-xs text-[var(--faint-2)] w-7 text-right">{other.games}g</span>
                          </button>
                          {isOpen && rest.map(h => (
                            <button
                              key={h.hero}
                              onClick={() => setPendingHero(h.hero)}
                              className="flex items-center gap-3 w-full text-left pl-6 pr-3 py-2 ml-2 rounded-lg border border-ow-border/60 bg-ow-darker/60 hover:border-violet-500/70 hover:bg-violet-500/10 active:scale-[0.98] transition-all group"
                            >
                              <span className={`text-sm ${h.win_rate >= 50 ? 'text-emerald-700' : 'text-red-500'}`}>{h.win_rate >= 50 ? '↑' : '↓'}</span>
                              <span className="flex-1 text-sm text-[var(--muted)] group-hover:text-violet-500 transition-colors">{withHeroCount(h.hero, heroCounts)}</span>
                              <span className={`text-sm font-semibold ${h.win_rate >= 60 ? 'text-emerald-600' : h.win_rate >= 50 ? 'text-ow-blue' : h.win_rate >= 40 ? 'text-yellow-400' : 'text-red-600'}`}>{h.win_rate}%</span>
                              <span className="text-xs text-[var(--faint-2)] w-7 text-right">{h.games}g</span>
                            </button>
                          ))}
                        </>
                      );
                    })()}
                    {top.length === 0 && !other && (
                      <div className="py-2 text-xs text-[var(--faint-2)]">No games yet</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={map ? '⌖' : '☷'}
            title={map ? `No games logged on ${withMapCount(map, mapCounts)} yet` : 'Pick a map to see your heroes'}
            hint={map
              ? 'Once you log a match here, your best heroes for this map appear by role.'
              : 'Select a map above and this fills with your strongest picks for it, broken out by role.'}
          />
        )}
        </div>
        </div>
      </div>
    </div>
  );
}

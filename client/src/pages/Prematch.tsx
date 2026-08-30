import { useState, useRef, useEffect } from 'react';
import { format } from 'date-fns';
import { useApi } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { MAPS, QUEUE_MODES, ROLE_COLORS, TYPE_COLORS, HEROES, MapVotingRow, Streaks } from '../types';
import AdvisorCard from '../components/AdvisorCard';
import EmptyState from '../components/EmptyState';
import { useMapDrawer } from '../contexts/MapDrawerContext';
import { useHeroDrawer } from '../contexts/HeroDrawerContext';
import { useMatch } from '../contexts/MatchContext';
import { Link } from 'react-router-dom';
import Odometer from '../components/Odometer';
import { MOUSE_DPI } from '../lib/aim';

// DPI stage-test HUD state — the dashboard reads this live to show the
// current stage's DPI plainly (no hiding, no LED colors). Several tests can
// be running at once (one per hero), so this is a list, not a single test.
interface DpiTestHud {
  actives: {
    set_id: number; hero: string | null; cur_stage: number; n_stages: number; totalGames: number;
    batch_size: number; games_on_stage: number; dpi: number | null; sens: number | null;
  }[];
}

const ALL_MAPS = Object.keys(MAPS).sort();
const DPI_TEST_HERO_KEY = 'ow-dpi-test-hero';
const AD_HOC_KEY = '__adhoc__';

interface HeroRow { hero: string; role: string; games: number; wins: number; win_rate: number }

interface AimAnalysisHero { hero: string; bestScaleEDPI: number; bestScaleN: number }

// Last-30-days vs. prior-90-days win rate per hero, sorted trending-first —
// see the /api/stats/momentum route for the exact windows and sort order.
interface MomentumHero {
  hero: string; role: string; recent_wr: number | null; prev_wr: number | null;
  recent_games: number; prev_games: number; is_new: 0 | 1;
}

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
  const { data: dpiHud } = useApi<DpiTestHud>('/api/blind/state');
  const btActives = dpiHud?.actives ?? [];
  // Several heroes can be "In Testing" at once, but the mouse can only be set
  // to one DPI at a time — so the HUD tracks whichever hero you're about to
  // play next, not an aggregate across all of them. Persisted so the choice
  // survives a reload; falls back to the first active test if the saved
  // hero's set finished/was cancelled since.
  const [btHeroPick, setBtHeroPick] = useState<string | null>(() => {
    try { return localStorage.getItem(DPI_TEST_HERO_KEY); } catch { return null; }
  });
  useEffect(() => {
    try {
      if (btHeroPick) localStorage.setItem(DPI_TEST_HERO_KEY, btHeroPick);
      else localStorage.removeItem(DPI_TEST_HERO_KEY);
    } catch { /* ignore */ }
  }, [btHeroPick]);
  const bt = btActives.find(a => (a.hero ?? AD_HOC_KEY) === btHeroPick) ?? btActives[0] ?? null;
  const btGamesLeft = bt ? Math.max(0, bt.batch_size - bt.games_on_stage) : 0;
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
  const { data: byHour } = useApi<{ hour: number; games: number; wins: number; win_rate: number; qp_games: number; qp_win_rate: number | null; comp_games: number; comp_win_rate: number | null }[]>('/api/stats/by-hour');
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery]       = useState('');
  const [open, setOpen]         = useState(false);
  // Which hero card in "Select Your Hero" is currently picked, kept
  // separately from the context's `pendingHero` — that one is a one-shot
  // signal LogMatch consumes and clears the instant it pre-fills the form,
  // so it can't double as "what should stay highlighted here."
  const [selectedHero, setSelectedHero] = useState<string | null>(null);
  const inputRef                = useRef<HTMLInputElement>(null);
  const advisorSelectRef        = useRef<HTMLSelectElement>(null);

  // Once a hero is picked in "Select Your Hero", snap the DPI/sens HUD to
  // that hero's active test (if it has one) instead of leaving it on
  // whatever hero was last picked in the HUD's own dropdown.
  useEffect(() => {
    if (!selectedHero) return;
    if (btActives.some(a => a.hero === selectedHero)) setBtHeroPick(selectedHero);
  }, [selectedHero, btActives]);

  // Reset the voting picks after a match is logged (skips the initial mount).
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    setSelected([]);
    setQuery('');
    setOpen(false);
    setSelectedHero(null);
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
  // "Select Your Hero" surfaces heroes with an active (in-testing) DPI test —
  // picking here is meant to feed a test, not just log any match. Heroes
  // whose set has already completed drop out entirely rather than lingering
  // with a Completed badge.
  const inTestingHeroes = new Set(btActives.map(a => a.hero).filter((h): h is string => !!h));
  const selectableHeroes = inTestingHeroes;
  // Every hero surfaced below is actively testing, so always has a sens/DPI
  // value here. Sens supersedes DPI post-lock; DPI is the fallback for any
  // pre-lock stage still running on the old axis.
  const testValueFor = (hero: string): string | null => {
    const a = btActives.find(a => a.hero === hero);
    if (!a) return null;
    const v = a.sens ?? a.dpi;
    return v != null ? v.toFixed(2) : null;
  };

  // Quantizes remaining-games-in-stage onto a 5-segment gauge (like a battery
  // meter) regardless of the set's actual batch_size, so every hero's gauge
  // reads on the same 5-bar scale.
  const GAUGE_SEGMENTS = 5;
  const testGaugeFor = (hero: string): number | null => {
    const a = btActives.find(a => a.hero === hero);
    if (!a || a.batch_size <= 0) return null;
    const remaining = Math.max(0, a.batch_size - a.games_on_stage);
    return Math.min(GAUGE_SEGMENTS, Math.round((remaining / a.batch_size) * GAUGE_SEGMENTS));
  };

  // For each role, list every hero with an active sens test — no top-N cap,
  // no collapsed overflow bucket. topOnMap only has rows for heroes with at
  // least one logged game on this exact map, so an active-test hero with zero
  // games here needs a synthetic zero-row or it'd silently vanish.
  function buildRole(role: string) {
    const onMap = topOnMap.filter(h => h.role === role && selectableHeroes.has(h.hero)); // already win_rate desc
    const onMapSet = new Set(onMap.map(h => h.hero));
    const zeroGame = [...selectableHeroes]
      .filter(h => HEROES[h] === role && !onMapSet.has(h))
      .map(hero => ({ hero, role, games: 0, wins: 0, win_rate: 0 }));
    return [...onMap, ...zeroGame];
  }
  const byRole = {
    DPS:     buildRole('DPS'),
    Support: buildRole('Support'),
  };
  // Recommended pick panel (no-map state): the hottest-trending DPS + Support
  // pick instead of the single overall-best-win-rate hero — "trending" means
  // biggest recent(30d)-vs-prior(90d) win-rate climb, per /api/stats/momentum,
  // which already sorts established heroes by that delta descending (heroes
  // without a prior-window baseline are current-form-only, no trend to show).
  // Each is still paired with the in-game sens its own best-tested scale
  // points to (bestScaleEDPI ÷ locked mouse DPI).
  const { data: momentum } = useApi<{ byHero: MomentumHero[] }>('/api/stats/momentum');
  const trendingDps     = momentum?.byHero.find(h => h.role === 'DPS') ?? null;
  const trendingSupport = momentum?.byHero.find(h => h.role === 'Support') ?? null;
  const { data: aimAnalysis } = useApi<{ heroes: AimAnalysisHero[] }>('/api/aim/analysis');
  const sensRecFor = (hero: string | undefined): number | null => {
    if (!hero) return null;
    const h = aimAnalysis?.heroes.find(a => a.hero === hero);
    return h && h.bestScaleN > 0 ? Math.round((h.bestScaleEDPI / MOUSE_DPI) * 100) / 100 : null;
  };

  const queueLabel = QUEUE_MODES.find(q => q.value === queueMode)?.label ?? '';

  return (
    <div>

      {/* DPI test HUD (square) + Map Voting + Hero Advisor row — stacks on
          phone widths; three-across only once there's room for each card's
          own header (title + badge) to fit without wrapping. */}
      <div className="flex flex-col sm:flex-row items-stretch gap-4 mb-4">

        {/* DPI stage-test HUD — a dropdown picks which "In Testing" hero you're
            about to play (several can be active at once, but the mouse can
            only sit on one DPI at a time), then shows that hero's current
            stage DPI plainly (no hiding) plus two live wheels: matches left
            in its whole test and games left before its next stage switch.
            Drives off the same state the Sens page loop does. Sits where the
            sens picker used to. */}
        <div className="card sm:aspect-square shrink-0 flex flex-col self-stretch" data-inspect-id="prematch-dpi-hud-card">
          <div className="flex items-center justify-between mb-2 gap-2">
            <h2 className="text-sm heading-display text-[var(--ink)] whitespace-nowrap">{bt?.sens != null ? 'Sens Test' : 'DPI Test'}</h2>
            {bt && (
              <span className="text-xs num-display text-[var(--ink)] shrink-0" data-inspect-id="prematch-dpi-value-badge">
                {bt.sens != null ? `${bt.sens.toFixed(2)} sens` : `${bt.dpi} DPI`}
              </span>
            )}
          </div>
          {btActives.length > 1 && (
            <select
              value={bt ? (bt.hero ?? AD_HOC_KEY) : ''}
              onChange={e => setBtHeroPick(e.target.value)}
              className="text-[11px] field px-1.5 py-1 mb-2 w-full"
              aria-label="Hero to show DPI-test progress for"
              data-inspect-id="prematch-dpi-hero-picker-select"
            >
              {btActives.map(a => (
                <option key={a.set_id} value={a.hero ?? AD_HOC_KEY}>
                  {(a.hero ?? 'Ad-hoc').toUpperCase()} — {a.sens != null ? `${a.sens.toFixed(2)} sens` : `${a.dpi} DPI`}
                </option>
              ))}
            </select>
          )}
          {btActives.length === 1 && (
            <div className="text-[10px] hero-name text-[var(--faint-2)] -mt-1 mb-2 truncate">{bt!.hero ?? 'ad-hoc'}</div>
          )}
          {bt ? (
            <div className="flex-1 grid grid-cols-[auto_auto] items-center gap-x-3 gap-y-1.5 place-content-center">
              <Odometer value={btTestLeft} dataInspectId="prematch-dpi-matches-left-odometer" />
              <div className="leading-tight">
                <div className="text-sm text-[var(--ink)]">matches left</div>
                <div className="text-[10px] text-[var(--faint-2)]">in this test</div>
              </div>
              <Odometer value={btGamesLeft} dataInspectId="prematch-dpi-games-left-odometer" />
              <div className="leading-tight">
                <div className="text-sm text-[var(--ink)]">games left</div>
                <div className="text-[10px] text-[var(--faint-2)]">in stage <b className="font-bold">{bt.cur_stage}</b></div>
              </div>
              {/* Backlog counter shares this grid's column tracks (rather than
                  being its own grid) so its drum is guaranteed to land in the
                  same x position as the two above — a separate grid re-centers
                  independently and drifts whenever the label text width differs. */}
              <Odometer value={backlogCount} dataInspectId="prematch-backlog-odometer" />
              <div className="leading-tight">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--ink)]">in backlog</span>
                  <Link
                    to="/sens"
                    className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-gradient-to-r from-ow-accent to-ow-accentLight text-white shadow-md shadow-ow-accent/30 hover:brightness-110 active:brightness-95 transition-all whitespace-nowrap"
                    data-inspect-id="prematch-backlog-go-link"
                  >
                    Go →
                  </Link>
                </div>
                <div className="text-[10px] text-[var(--faint-2)]">matches awaiting stats</div>
              </div>
            </div>
          ) : (
            <div className="flex-1 grid place-items-center text-center px-2" data-inspect-id="prematch-dpi-idle-banner">
              <div>
                <div className="text-xs text-[var(--faint)]">No DPI test running</div>
                <div className="text-[10px] text-[var(--faint-2)] mt-1">Start one on the Sens page →</div>
              </div>
            </div>
          )}

          {/* Idle state has no sibling drum row to align with, so the backlog
              counter gets its own simple centered row here instead. */}
          {btActives.length === 0 && (
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
        <div className="card flex-1 min-w-0 flex flex-col" data-inspect-id="prematch-map-voting-card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm heading-display text-[var(--ink)] whitespace-nowrap">Map Voting</h2>
              <span className="text-xs text-[var(--faint)] bg-ow-border/50 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">tap up to 3</span>
            </div>
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
              data-inspect-id="prematch-map-search-input"
              disabled={selected.length >= 3}
              className="w-full field px-3 py-2 text-sm"
            />
            {open && results.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-ow-card rounded-lg shadow-xl z-30 overflow-hidden" data-inspect-id="prematch-map-search-results-dropdown">
                {results.map(m => (
                  <button
                    key={m}
                    onMouseDown={() => selectMap(m)}
                    className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-white/5 transition-colors text-left"
                  >
                    <span className="map-name text-[var(--ink)]">{withMapCount(m, mapCounts)}</span>
                    <span className={`pill ${TYPE_COLORS[MAPS[m]] ?? ''}`}>{MAPS[m]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Idle: best & worst maps by win rate — tap one to add it to your
              picks (which swaps this block for the chips + vote below). */}
          {selected.length === 0 && rankedMaps.length > 0 && (
            <div className="flex-1 grid grid-cols-2 gap-x-4 content-center" data-inspect-id="prematch-best-worst-maps-list">
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
                      <span className="text-sm map-name text-[var(--ink)] truncate group-hover:text-ow-accent transition-colors">{withMapCount(m.map, mapCounts)}</span>
                      <span className={`text-xs font-bold shrink-0 ml-2 ${col.pct}`}>{Math.round(m.historical_rate)}%</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* Selected chips */}
          {selected.length > 0 && (
            <div className="flex gap-2 flex-wrap" data-inspect-id="prematch-selected-map-chips">
              {selected.map(m => (
                <span
                  key={m}
                  className={`flex items-center gap-1.5 pl-3 pr-1.5 py-1 rounded-full text-sm map-name transition-colors ${
                    m === winner
                      ? 'bg-emerald-500/20 text-emerald-700'
                      : 'bg-ow-accent/15 text-ow-accent'
                  }`}
                >
                  <button
                    onClick={() => setMap(m)}
                    className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
                    title={`Set ${m} as the match map`}
                  >
                    {m === winner && <span className="text-xs normal-case">✓</span>}
                    {withMapCount(m, mapCounts)}
                  </button>
                  <button
                    onClick={() => toggleMap(m)}
                    className="flex items-center justify-center w-5 h-5 rounded-full text-sm font-bold leading-none hover:bg-black/10 hover:text-red-600 transition-colors"
                    title={`Remove ${m}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                onClick={() => { setSelected([]); advisorSelectRef.current?.focus(); }}
                className="flex items-center px-3 py-1 rounded-full text-sm font-medium bg-ow-border/40 text-[var(--ink-2)] hover:bg-ow-border/70 hover:text-[var(--ink)] transition-colors"
                data-inspect-id="prematch-map-voting-clear-button"
              >
                Clear
              </button>
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
                    <button onClick={() => openMap(winner)} className="text-xl map-name text-emerald-600 hover:text-emerald-700 transition-colors text-left" data-inspect-id="prematch-vote-for-button">
                      {withMapCount(winner, mapCounts)}
                    </button>
                    {scoreMap[winner] && (
                      <div className="text-xs text-[var(--faint)] mt-0.5">
                        <b className="font-bold">{scoreMap[winner].blended_score}</b>% blended · <b className="font-bold">{scoreMap[winner].total_games}</b>g played
                      </div>
                    )}
                  </div>
                  <div className="text-right space-y-1">
                    {ranked.slice(1).map(m => (
                      <div key={m} className="text-sm text-[var(--faint)]">
                        <span className="map-name">{withMapCount(m, mapCounts)}</span>{scoreMap[m] ? <> · <b className="font-bold">{scoreMap[m].blended_score}</b>%</> : ' · no data'}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Hero Advisor — Map selector */}
        <div className="card flex-1 min-w-0 flex flex-col" data-inspect-id="prematch-hero-advisor-card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm heading-display text-[var(--ink)] whitespace-nowrap">Hero Advisor</h2>
              <span className="text-xs text-[var(--faint)] bg-ow-border/50 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">pick a map</span>
            </div>
            {map && (
              <button onClick={() => setMap('')} className="text-xs text-[var(--faint)] hover:text-[var(--ink)] transition-colors" data-inspect-id="prematch-hero-advisor-clear-button">
                clear
              </button>
            )}
          </div>

          <div className="mb-3">
            <select
              ref={advisorSelectRef}
              value={map}
              onChange={e => setMap(e.target.value)}
              className="w-full field px-3 py-2 text-sm"
              data-inspect-id="prematch-map-select-dropdown"
            >
              <option value="">— Select map —</option>
              {(selected.length > 0 ? [...selected] : Object.keys(MAPS)).sort().map(m => (
                <option key={m} value={m} className="uppercase">{withMapCount(m, mapCounts)}</option>
              ))}
            </select>
          </div>
          {mapType && <span className={`pill ${TYPE_COLORS[mapType] ?? ''}`} data-inspect-id="prematch-map-type-badge">{mapType}</span>}

          {/* Idle: session & timing snapshot — how you're doing right now.
              The panel is deliberately roomier than its content strictly
              needs: with no map picked yet this card would otherwise be
              mostly dead space next to Sens Test / Map Voting's packed
              lists, so the stat tiles get real card treatment (bordered
              panel, generous padding, bigger numerals) instead of just
              floating in the middle of the card. */}
          {!map && (
            <div className="flex-1 flex flex-col justify-center mt-1 gap-4">
              {/* True 2-row grid (labels row, values row) instead of three
                  independently-centered flex columns — that's what keeps all
                  three labels on one line and all three value blocks on the
                  next, regardless of the This Hour pills' extra padding
                  making that value taller than a plain number. Columns stay
                  content-sized (not stretched to equal width) with
                  justify-evenly, so spacing is even without forcing the three
                  categories to occupy equal space. */}
              <div className="rounded-xl border border-ow-border/40 bg-gradient-to-br from-ow-accent/[0.06] via-ow-accent/[0.02] to-transparent grid grid-cols-[repeat(3,max-content)] justify-evenly items-center gap-x-2 pt-4 pb-6">
                <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] col-start-1 row-start-1 justify-self-center" data-inspect-id="prematch-today-stat-tile">Today</div>
                <div className="col-start-1 row-start-2 justify-self-center">
                  {todayRows.length > 0 ? (
                    <div className="text-[27px] num-display leading-none">
                      <span className="text-emerald-500">{todayW}</span><span className="text-[var(--muted)]">-</span><span className="text-red-500">{todayL}</span>
                    </div>
                  ) : (
                    <div className="text-sm text-[var(--faint)]">No games</div>
                  )}
                </div>

                <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] col-start-2 row-start-1 justify-self-center" data-inspect-id="prematch-streak-stat-tile">Streak</div>
                <div className="col-start-2 row-start-2 justify-self-center">
                  {streaksData && streaksData.currentStreak > 0 ? (
                    <div className={`text-[27px] num-display leading-none ${streaksData.currentStreakType === 1 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {streaksData.currentStreak}{streaksData.currentStreakType === 1 ? 'W' : 'L'}
                    </div>
                  ) : (
                    <div className="text-sm text-[var(--faint)]">—</div>
                  )}
                </div>

                <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] col-start-3 row-start-1 justify-self-center" data-inspect-id="prematch-this-hour-stat-tile">This hour</div>
                <div className="col-start-3 row-start-2 justify-self-center">
                  {hourRow ? (
                    <div className="flex items-center justify-center w-full">
                      <div className="relative">
                        <span
                          className={`text-[27px] num-display leading-none rounded-md px-1 py-2 ${hourRow.qp_games > 0 ? 'text-blue-500' : 'text-[var(--faint)]'}`}
                        >
                          {hourRow.qp_games > 0 ? `${Math.round(hourRow.qp_win_rate!)}%` : '—'}
                        </span>
                        <span className="absolute top-full inset-x-0 -mt-0.5 text-center text-[7px] uppercase tracking-wider text-[var(--faint)] whitespace-nowrap">Quickplay</span>
                      </div>
                      <span className="text-[27px] num-display leading-none text-[var(--faint-2)] -mx-0.5">/</span>
                      <div className="relative">
                        <span
                          className={`text-[27px] num-display leading-none rounded-md px-1 py-2 ${hourRow.comp_games > 0 ? 'text-red-500' : 'text-[var(--faint)]'}`}
                        >
                          {hourRow.comp_games > 0 ? `${Math.round(hourRow.comp_win_rate!)}%` : '—'}
                        </span>
                        <span className="absolute top-full inset-x-0 -mt-0.5 text-center text-[7px] uppercase tracking-wider text-[var(--faint)] whitespace-nowrap">Competitive</span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-sm text-[var(--faint)]">—</div>
                  )}
                </div>
              </div>
              <div className="text-xs text-[var(--faint-2)] text-center">
                Select a map above for hero recommendations and coaching tailored to it.
              </div>
            </div>
          )}
        </div>

      </div>

      {/* Consolidated advisor — recommendation + coaching + your heroes in one
          card below the row. When a map is picked these three used to repeat the
          same "what to play" answer across separate cards; here they read as one
          flow: the pick, the coaching behind it, then the full breakdown. */}
      <div id="consolidated-advisor" className="card" data-inspect-id="prematch-consolidated-advisor-card">
        <div className="flex items-start justify-between gap-3 mb-1">
          <div>
            <h2 className="text-sm heading-display text-[var(--ink-2)]">
              {map ? (
                <>Your Heroes on <button onClick={() => openMap(map)} className="text-ow-accent hover:text-ow-accent/80 transition-colors" data-inspect-id="prematch-your-heroes-map-link">{withMapCount(map, mapCounts)}</button></>
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
                data-inspect-id="prematch-refresh-advisor-button"
              >
                {recLoading ? '…' : '↻'}
              </button>
            </div>
          )}
        </div>

        {/* Recommended pick — only with no map selected; once a map is chosen the
            coaching block's primary stands as the pick, so this would just repeat it.
            One column per role (DPS / Support), each the hottest-trending hero for
            that role rather than the single overall-best-win-rate hero, paired with
            the in-game sens its own best-tested scale points to. */}
        {(trendingDps || trendingSupport) && !map && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 items-start" data-inspect-id="prematch-recommended-pick-card">
            {([['DPS', trendingDps], ['Support', trendingSupport]] as const).map(([role, rec]) => {
              const delta = rec && !rec.is_new && rec.recent_wr != null && rec.prev_wr != null
                ? Math.round((rec.recent_wr - rec.prev_wr) * 10) / 10 : null;
              return (
                <div key={role} className="rounded-xl bg-gradient-to-br from-ow-accent/10 via-ow-accent/[0.04] to-transparent px-4 py-3">
                  <div className="text-[10px] grad-brand font-bold uppercase tracking-widest mb-1">Trending {role}</div>
                  {rec ? (
                    <>
                      <div className="flex items-center gap-3">
                        <div>
                          <button onClick={() => openHero(rec.hero)} className="text-lg hero-name text-[var(--ink)] hover:text-ow-accent transition-colors text-left" data-inspect-id="prematch-recommended-hero-button">
                            {withHeroCount(rec.hero, heroCounts)}
                          </button>
                          <span className={`pill ml-2 ${ROLE_COLORS[rec.role]}`}>{rec.role}</span>
                        </div>
                        <div className="ml-auto text-right">
                          <div className={`text-2xl font-black tracking-tight num-display ${(rec.recent_wr ?? 0) >= 50 ? 'grad-win' : 'grad-loss'}`}>
                            {rec.recent_wr ?? '—'}%
                          </div>
                          <div className="text-[11px] text-[var(--muted)]">
                            {delta != null ? (
                              <span className={`font-bold ${delta >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}pt</span>
                            ) : (
                              <span>new form</span>
                            )}
                            {' · '}<b className="font-bold">{rec.recent_games}</b> games (30d)
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 pt-2 border-t border-ow-border/40 flex items-center justify-between" data-inspect-id="prematch-recommended-sens">
                        <span className="text-[10px] text-[var(--muted)] uppercase tracking-wide">In-game sens</span>
                        <span className="text-sm num-display font-bold text-[var(--ink)]">
                          {sensRecFor(rec.hero) != null ? sensRecFor(rec.hero)!.toFixed(2) : 'No data yet'}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-[var(--faint)]">Not enough games yet</div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Coaching — LLM tactical read + death patterns, only once a map is set.
            Two columns, DPS and Support, each its own independent primary +
            stretch pick — a role with no in-testing hero just shows empty
            rather than an error, since the other column may still have one. */}
        {map && (
          <div id="coaching" className="scroll-mt-24 rounded-xl bg-emerald-500/5 px-4 py-3 mt-3" data-inspect-id="prematch-coaching-section">
            <div className="text-[10px] text-emerald-600 uppercase tracking-widest font-semibold mb-2">Coaching</div>
            {recLoading && !rec && <div className="text-xs text-[var(--faint)]">Loading…</div>}
            {recError && <div className="text-xs text-red-600">{recError}</div>}
            {rec && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start" data-inspect-id="prematch-coaching-columns">
                {(['DPS', 'Support'] as const).map(role => (
                  <div key={role}>
                    <div className="text-[10px] text-emerald-600/70 uppercase tracking-widest font-semibold mb-1.5">{role}</div>
                    {rec[role] ? (
                      <AdvisorCard
                        bare
                        map={map}
                        queueLabel={queueLabel}
                        rec={rec[role]}
                        loading={false}
                        error={null}
                        onRefresh={refreshRec}
                        onOpenHero={openHero}
                      />
                    ) : (
                      <div className="text-xs text-[var(--faint-2)] italic">No active {role} test</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Your heroes by role — the full breakdown, and the actual hero-select
            control (tapping a hero pre-fills the Match Log). Styled as its own
            selection panel — bordered, tinted, chip buttons — rather than a
            trailing stats list, so it doesn't get missed after Coaching above it. */}
        <div className="mt-4 pt-4 border-t border-ow-border/40">
        <h3 className="text-sm grad-brand font-black uppercase tracking-widest mb-3" data-inspect-id="prematch-select-your-hero-header">Select Your Hero</h3>
        {selectableHeroes.size > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" data-inspect-id="prematch-hero-picker-list">
            {(['DPS', 'Support'] as const).map(role => {
              const heroes = byRole[role];
              return (
                <div key={role}>
                  <div className={`text-xs font-bold uppercase tracking-widest mb-2 ${ROLE_COLORS[role].split(' ')[1]}`}>{role}</div>
                  <div className="flex flex-col gap-1.5">
                    {heroes.map(h => (
                      <button
                        key={h.hero}
                        onClick={() => { setSelectedHero(h.hero); setPendingHero(h.hero); }}
                        data-inspect-id="prematch-hero-picker-button"
                        aria-pressed={selectedHero === h.hero}
                        className={`relative flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-lg border active:scale-[0.98] transition-all group ${
                          selectedHero === h.hero
                            ? 'border-ow-accent bg-ow-accent/15'
                            : 'border-ow-border bg-ow-darker hover:border-ow-accent/70 hover:bg-ow-accent/10'
                        }`}
                      >
                        <span className={`text-sm ${h.win_rate >= 50 ? 'text-emerald-700' : 'text-red-500'}`}>{h.win_rate >= 50 ? '↑' : '↓'}</span>
                        <span className={`flex-1 text-xs hero-name transition-colors ${selectedHero === h.hero ? 'text-ow-accent' : 'text-[var(--ink)] group-hover:text-ow-accent'}`}>
                          {withHeroCount(h.hero, heroCounts)}{testValueFor(h.hero) && ` @ ${testValueFor(h.hero)}`}
                        </span>
                        {testGaugeFor(h.hero) != null && (
                          <span
                            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-0.5 pointer-events-none"
                            title={`${testGaugeFor(h.hero)}/${GAUGE_SEGMENTS} games left at current sens`}
                            data-inspect-id="prematch-hero-picker-gauge"
                          >
                            {Array.from({ length: GAUGE_SEGMENTS }).map((_, i) => (
                              <span
                                key={i}
                                className={`w-1.5 h-3 -skew-x-[20deg] ${
                                  i < testGaugeFor(h.hero)!
                                    ? 'bg-emerald-500'
                                    : 'bg-gray-400/50'
                                }`}
                              />
                            ))}
                          </span>
                        )}
                        <span className={`text-sm font-bold ${h.win_rate >= 60 ? 'text-emerald-600' : h.win_rate >= 50 ? 'text-ow-blue' : h.win_rate >= 40 ? 'text-yellow-400' : 'text-red-600'}`}>{h.win_rate}%</span>
                        <span className="text-xs text-[var(--faint-2)] w-7 text-right font-bold">{h.games}g</span>
                      </button>
                    ))}
                    {heroes.length === 0 && (
                      <div className="py-2 text-xs text-[var(--faint-2)]">No games yet</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            dataInspectId="prematch-empty-state-banner"
            icon={map ? '⌖' : '☷'}
            title={map ? `No games logged on ${withMapCount(map, mapCounts).toUpperCase()} yet` : 'Pick a map to see your heroes'}
            hint={map
              ? 'Once you log a match here, your best heroes for this map appear by role.'
              : 'Select a map above and this fills with your strongest picks for it, broken out by role.'}
          />
        )}
        </div>
      </div>
    </div>
  );
}

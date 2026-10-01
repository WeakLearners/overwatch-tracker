import LobbyRankSection from '../components/LobbyRankSection';
import SegmentedPills, { NOTCH, ACCENT_SEL } from '../components/SegmentedPills';
import { useState, useRef, useEffect } from 'react';
import { useApi, revalidateAll } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { format } from 'date-fns';
import { MAPS, mapShort, heroShort, QUEUE_MODES, ROLE_COLORS, ROLE_SEL_RGB, ROLE_TEXT, ROLE_PILL_CLASS, TYPE_COLORS, HEROES, MODE_COMPACT, OLDEST_DASH_FADE_STYLE, MapVotingRow, QueueMode, Streaks, RANK_TIER_RGB, ACCOUNTS, rankLabel, rankShort, rankTier, rankDivision } from '../types';
import AdvisorCard from '../components/AdvisorCard';
import EmptyState from '../components/EmptyState';
import { useMapDrawer } from '../contexts/MapDrawerContext';
import { useHeroDrawer } from '../contexts/HeroDrawerContext';
import { useMatch } from '../contexts/MatchContext';
import { useAdvisor, refreshRec } from '../contexts/AdvisorContext';
import { Link } from 'react-router-dom';
import Odometer from '../components/Odometer';
import { MOUSE_DPI } from '../lib/aim';
import { useFieldConfig } from '../contexts/FieldConfigContext';
import { useDfHeroes, dfHeroSet, withDfBadge } from '../hooks/useDfHeroes';

// GET /api/blind/next's shape — see server/src/lib/nextTest.ts for what each
// field means (role pick, block lock, cold flag). Fetched fresh whenever
// queueMode changes (Quickplay gets its own no-list response) and whenever
// any match is logged, via useApi's shared revalidateAll() subscription.
interface NextTestResponse {
  isQuickplay: boolean;
  allFinished?: boolean;
  finishedHeroes?: string[];
  phase?: string | null;
  block?: { hero: string; role: string; openMinutes: number } | null;
  // Distinguishes block===null's two causes, added 2026-09-27: a block just
  // closed (the most-recently-credited match's hero, now at 0/60 open
  // minutes) vs. nothing played yet this phase (no test-credited match at
  // all). Drives whether the full-recompute branch below can honestly say
  // "Block done" or has to stay neutral.
  justClosed?: { hero: string } | null;
  recommendedRole?: string | null;
  orderedHeroes?: { hero: string; role: string; credited: number; target: number; playedMinutes?: number; targetMinutes?: number; daysSinceLastPlayed: number | null; cold: boolean }[];
  // Every hero in the phase, all roles (Quickplay included). Drives the
  // card's always-on Support | DPS columns.
  heroes?: { hero: string; role: string; credited: number; target: number; playedMinutes?: number; targetMinutes?: number; daysSinceLastPlayed: number | null; completed: boolean }[];
}

// DPI stage-test HUD state — the dashboard reads this live to show the
// current stage's DPI plainly (no hiding, no LED colors). Several tests can
// be running at once (one per hero), so this is a list, not a single test.
interface DpiTestHud {
  actives: {
    set_id: number; hero: string | null; cur_stage: number; n_stages: number; totalGames: number;
    batch_size: number; games_on_stage: number; dpi: number | null; sens: number | null;
    // Present only for a chunked (ABBA) 2-stage set — see routes/blind.ts's
    // GET /state and lib/blind.ts's block model (chunkLabelFor/
    // deriveBlockState). `label` is the "A1".."B4" chunk badge.
    // `openMinutes` is this hero's currently open (unclosed) 60-minute
    // block, 0..<60 — what the continuous gauge fills (2026-09-27; it used
    // to be chunk_size segmented bars counting down games). stageBlocks/
    // stageBlocksTarget give the current physical stage's own progress in
    // closed blocks, replacing the games-based "left in this batch" figure
    // for a chunked set.
    chunk?: {
      label: string; openMinutes: number; stageBlocks: number; stageBlocksTarget: number;
      closedBlocks: number; totalBlocksTarget: number;
    } | null;
  }[];
}

const ALL_MAPS = Object.keys(MAPS).sort();
const DPI_TEST_HERO_KEY = 'ow-dpi-test-hero';
const AD_HOC_KEY = '__adhoc__';

interface HeroRow { hero: string; role: string; games: number; wins: number; win_rate: number }

// /api/blind/sets — every DPI/sens-test set ever created (active or not),
// tagged with its testing phase. Used to build the full "5 heroes per role"
// roster for whichever phase is current, including heroes that already
// finished this phase — /api/blind/state only returns currently-active sets,
// which is why "Select Your Hero" used to drop a hero the moment its test
// completed.
interface BlindSetSummary {
  set_id: number;
  hero: string | null;
  phase: string | null;
  active: boolean;
  completed: boolean;
}

// /api/advisor/test-pick response — top 3 (map, hero) combos ranked by win
// rate across (candidate maps) x (current phase roster for the selected
// role). See that route for the ranking/sparse-data rules.
interface TestPickCombo {
  map: string;
  hero: string;
  games: number;
  win_rate: number;
  sample_size: 'strong' | 'thin';
}
interface TestPick {
  role: 'DPS' | 'Support';
  available: boolean;
  reason?: 'no_phase_heroes' | 'no_data' | 'no_maps_selected';
  picks: TestPickCombo[];
}

interface AimAnalysisHero { hero: string; bestScaleEDPI: number | null; bestScaleN: number; bestScaleReliable: boolean }

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

// Time left as H:MM on narrow odometer drums: one hour drum (two past 9h), a colon,
// two minute drums. Under an hour the hour drum reads 0. Right-aligned in its
// column, so the minute drums of every clock line up.
function ClockOdometer({ minutes, size, dataInspectId }: { minutes: number; size: number; dataInspectId: string }) {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return (
    <div className="flex items-center justify-end" data-inspect-id={dataInspectId} aria-label={`${h}:${String(m % 60).padStart(2, '0')} left`}>
      <Odometer value={h} size={size} digits={h >= 10 ? 2 : 1} narrow />
      <span className="num-display text-[var(--faint-2)] leading-none px-0.5" style={{ fontSize: Math.round(size * 0.7) }} aria-hidden>:</span>
      <Odometer value={m % 60} size={size} digits={2} narrow />
    </div>
  );
}

interface RoleTimerData {
  role: string | null; matches: number; since: string | null;
  recordedMin: number; estimatedMin: number; totalMin: number;
  thresholdMin: number; reached: boolean; switchTo: string | null;
}
const fmtHM = (min: number) => { const t = Math.round(min); return `${Math.floor(t / 60)}h ${String(t % 60).padStart(2, '0')}m`; };

export default function Prematch() {
  // Shared, single-instance match state (queue mode, map, advisor) lives here
  // and is consumed by the Log Match section too.
  const { queueMode, map, setMap, mapType, testRole, setTestRole, setPendingHeroes, pickedHeroes, setMapCandidates, matchLoggedSignal, account, setAccount, playerRank, ladder } = useMatch();
  const { rec, recLoading, recError } = useAdvisor();

  const { data: dpiHud } = useApi<DpiTestHud>('/api/blind/state');
  // Role timer: competitive minutes in the current role run. matchLoggedSignal
  // is a dep as well as useApi's revalidateAll(), so a logged match always refetches.
  const { data: roleTimer } = useApi<RoleTimerData>('/api/role-timer', [matchLoggedSignal]);
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
  // A chunked set runs on 60-minute blocks (2026-09-27), so its HUD counts
  // minutes left, not games (2026-09-28). The open block's minutes count
  // toward both the whole test and the current stage. Rounded up so 0 only
  // shows when it's truly done. A legacy unchunked set still counts games.
  const btChunk = bt?.chunk ?? null;
  const btGamesLeft = btChunk
    ? Math.max(0, Math.ceil((btChunk.stageBlocksTarget - btChunk.stageBlocks) * 60 - btChunk.openMinutes))
    : bt ? Math.max(0, bt.batch_size - bt.games_on_stage) : 0;
  const btTestLeft = btChunk
    ? Math.max(0, Math.ceil((btChunk.totalBlocksTarget - btChunk.closedBlocks) * 60 - btChunk.openMinutes))
    : bt ? Math.max(0, bt.n_stages * bt.batch_size - bt.totalGames) : 0;
  // A 10+ hour clock needs a second hour drum and overflows its column at 1024px
  // (~13px at size 28). One smaller size for every clock keeps the minute drums aligned.
  const clockSize = btChunk && (btGamesLeft >= 600 || btTestLeft >= 600) ? 22 : 28;
  const { data: pendingData } = useApi<{ total: number }>('/api/aim/pending?limit=1');
  const backlogCount = pendingData?.total ?? 0;
  // One-digit backlog (max 9, 2026-09-28): gold from 7 up, a warning before it fills.
  const BACKLOG_WARN = 7;
  const { isCategoryEnabled } = useFieldConfig();
  const sensStudyOn = isCategoryEnabled('sens-study');
  // Fetched unconditionally — the category toggle is a display gate on the
  // card below, not a reason to skip a cheap, side-effect-free GET. Keeping
  // the fetch itself unconditional also means flipping the toggle on shows
  // fresh data immediately rather than a stale null from before it was on.
  const { data: nextTest } = useApi<NextTestResponse>(`/api/blind/next?queue_mode=${queueMode}`, [queueMode]);
  // The hero the Next test card is pointing at: the locked open-block hero,
  // else the top of the recommended list. Its picker row pulses
  // (.test-glow) so it can be found at a glance.
  const testHero = sensStudyOn && nextTest && !nextTest.isQuickplay && !nextTest.allFinished
    ? (nextTest.block?.hero ?? nextTest.orderedHeroes?.[0]?.hero ?? null)
    : null;
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();
  // GET /api/df — the Designated Fallback (a role's safe pick when nothing
  // else fits; never earns test credit, never opens a test set) for each
  // role. "Select Your Hero" always shows the current role's DF alongside
  // the phase roster, marked with the same "◆ DF" mark LogMatch and
  // MatchEditDrawer use (useDfHeroes.ts's withDfBadge) — but it must never
  // pick up any of the test-only trimmings (glow, stage/chunk badge, gauge)
  // those rows render, since a DF hero has no test set to show progress on.
  const dfMap = useDfHeroes();
  const dfHeroes = dfHeroSet(dfMap);

  // Full roster for the CURRENT testing phase, so "Select Your Hero" can show
  // every hero that belongs to this phase — not just the ones still actively
  // testing. "Current phase" = the most recent non-null `phase` tag among all
  // sets ever created (blind_stage_sets.phase, set once per phase via
  // SensLog's phase-builder); verified against the live DB rather than
  // assumed — every phase so far is exactly 5 DPS + 5 Support sets created
  // together, and only one phase is ever "live" at a time (a new phase's
  // roster carryover cancels the previous phase's sets). "Done this phase" =
  // that hero's set for the phase has completed (totalGames reached its
  // batch_size × n_stages target) — checked against `active` too, and in the
  // live data the two always agree (a done hero's set is also inactive), but
  // `completed` is the more direct signal for "finished testing" and is what
  // gets shown, independent of whether it also happens to be inactive.
  const { data: blindSets } = useApi<{ sets: BlindSetSummary[] }>('/api/blind/sets');
  const allSets = blindSets?.sets ?? [];
  const currentPhase = [...allSets].reverse().find(s => s.phase)?.phase ?? null;
  const phaseRoster = currentPhase ? allSets.filter(s => s.phase === currentPhase) : [];
  const phaseHeroes = new Set(phaseRoster.map(s => s.hero).filter((h): h is string => !!h));
  const doneThisPhase = new Set(phaseRoster.filter(s => s.completed && s.hero).map(s => s.hero!));


  const params = new URLSearchParams();
  if (map) params.set('map', map);
  if (mapType) params.set('game_type', mapType);

  const { data } = useApi<PrematchData>(`/api/stats/prematch?${params}`, [map]);

  const { openMap } = useMapDrawer();
  const { openHero } = useHeroDrawer();
  const { data: votingData } = useApi<MapVotingRow[]>('/api/stats/map-voting');

  // Data for the Today card.
  const today = format(new Date(), 'yyyy-MM-dd');
  const { data: todayMatches } = useApi<{ rows: { win: 0 | 1; map: string; hero: string; player_rank: number | null; player_rank_start: number | null; created_at: string; time: string }[] }>(`/api/matches?from=${today}&to=${today}&limit=100`);
  const { data: streaksData } = useApi<Streaks>('/api/stats/streaks');
  const [selected, setSelected] = useState<string[]>([]);
  // Hand the Map Voting picks to the Log Match map picker, which narrows its
  // list to them (empty = every map). Cleared if this page goes away.
  useEffect(() => { setMapCandidates(selected); return () => setMapCandidates([]); }, [selected, setMapCandidates]);

  // On a map pick, scroll so Select Your Hero sits 16px below the sticky bars
  // (header, plus the Jump-to strip on the Dashboard). Only a real change of map
  // scrolls: not page load (or dev's double effect run), not clearing. The short delay lets the map's
  // advice above the card finish loading so the card is measured at rest.
  const lastScrolledMap = useRef(map);
  useEffect(() => {
    if (map === lastScrolledMap.current) return;
    lastScrolledMap.current = map; if (!map) return;
    const t = setTimeout(() => {
      const el = document.querySelector('[data-inspect-id$="-hero-select-card"]');
      if (!el) return;
      const bar = document.querySelector('[data-inspect-id="dash-section-nav"]') ?? document.querySelector('header');
      const offset = (bar?.getBoundingClientRect().bottom ?? 0) + 16;
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - offset, behavior: 'smooth' });
    }, 350);
    return () => clearTimeout(t);
  }, [map]);

  // Last 5 results on each currently-selected voting map, for the win/loss
  // dash strip under each chip. Same treatment as Today's Matches' map
  // history, but keyed on map name — no match exists yet to hang it off. The
  // URL carries the picks, so useApi refetches whenever they change; an empty
  // selection returns an empty byMap rather than needing a conditional hook.
  const { data: mapHistory } = useApi<{ byMap: Record<string, { win: 0 | 1; queue_mode: QueueMode }[]> }>(
    `/api/matches/map-history?maps=${encodeURIComponent(selected.join(','))}`
  );

  // Test Pick — top 3 (map, hero) combos ranked by win rate, once maps are
  // entered. Reuses Map Voting's own `selected` picks — the same up-to-3
  // maps Sean already enters there, which is what the in-game vote screen
  // actually offered — as the candidate set, rather than a second map
  // picker. Ranked across (candidate maps) x (current phase roster for the
  // Role Pick role) — see /api/advisor/test-pick for the ranking/sparse-data
  // rules. Displayed attached to Map Voting further down, only once
  // `selected` is non-empty — a single "best map" pick wouldn't help vote
  // differently among 3 fixed candidates, so Role Pick itself shows no
  // recommendation. `testRole` lives in MatchContext (not local state) so Log
  // Match's hero dropdowns can read the same chosen role to filter by.
  const testPickMaps = selected.join(',');
  const { data: testPick } = useApi<TestPick>(
    `/api/advisor/test-pick?role=${testRole}&maps=${encodeURIComponent(testPickMaps)}`,
    [testRole, testPickMaps],
  );

  const [query, setQuery]       = useState('');
  // The ordered picks are NOT kept here. The Log Match form owns its hero
  // slots and publishes them as `pickedHeroes` (MatchContext); this picker
  // reads that list to highlight rows and writes a whole new list back through
  // `setPendingHeroes`, which the form applies. Index 0 is the starting hero,
  // 1/2 the two switch slots. Clicking a picked hero again toggles it off
  // (later ones reflow up); a 4th click while 3 are picked is a no-op — the
  // same "tap up to 3, blocked past that" convention Map Voting uses.
  const clickedHeroes = pickedHeroes;
  const inputRef                = useRef<HTMLInputElement>(null);

  function toggleHeroClick(hero: string) {
    const next = clickedHeroes.includes(hero)
      ? clickedHeroes.filter(h => h !== hero)
      : clickedHeroes.length < 3 ? [...clickedHeroes, hero] : clickedHeroes;
    if (next === clickedHeroes) return; // blocked (4th click) — no-op, nothing to sync
    setPendingHeroes(next);
  }

  // Once a hero is picked in "Select Your Hero", snap the DPI/sens HUD to
  // whichever one was clicked most recently (not the 1st click) — that's the
  // hero about to be played next when multiple are queued up.
  useEffect(() => {
    const last = clickedHeroes[clickedHeroes.length - 1];
    if (!last) return;
    if (btActives.some(a => a.hero === last)) setBtHeroPick(last);
  }, [clickedHeroes, btActives]);

  // Reset the voting picks after a match is logged (skips the initial mount).
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    setSelected([]);
    setQuery('');
  }, [matchLoggedSignal]);

  // Keep focus on the map search whenever the app is idle (no map selected).
  useEffect(() => {
    if (!map) inputRef.current?.focus();
  }, [map]);

  const scoreMap = Object.fromEntries((votingData ?? []).map(r => [r.map, r]));

  // Best & worst maps by win rate over the last 90 days (min games in that
  // window), for the idle Map Voting card. Ranks on current form, not
  // all-time rate — the min of 5 is applied to the 90-day window itself, so
  // a map needs to actually be in current rotation to appear here.
  const rankedMaps = (votingData ?? [])
    .filter(m => m.recent_games >= 5 && m.recent_rate !== null)
    .sort((a, b) => b.recent_rate! - a.recent_rate!);
  const bestMaps = rankedMaps.slice(0, 3);
  const worstMaps = rankedMaps.slice(-3).reverse().filter(m => !bestMaps.includes(m));

  // Session & timing snapshot for the Today card.
  const todayRows = todayMatches?.rows ?? [];
  const todayW = todayRows.filter(r => r.win === 1).length;
  const todayL = todayRows.length - todayW;
  // Net divisions gained today: the sum of each ranked game's own change.
  // Summing per game, rather than first rank minus last, stays right when
  // Sean switches accounts mid-day. Null when no game today carries a rank.
  const rankedToday = todayRows.filter(r => r.player_rank != null && r.player_rank_start != null);
  const rankDelta = rankedToday.length > 0
    ? rankedToday.reduce((sum, r) => sum + (r.player_rank! - r.player_rank_start!), 0)
    : null;
  // Minutes since the newest game today was logged. created_at is SQLite's
  // UTC timestamp with no zone marker, hence the 'Z'. A one-minute tick keeps
  // it current while the page sits open between games.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNowMs(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const lastLoggedMs = todayRows[0] ? Date.parse(todayRows[0].created_at.replace(' ', 'T') + 'Z') : NaN;
  const sinceLastMin = Number.isFinite(lastLoggedMs) ? Math.max(0, Math.floor((nowMs - lastLoggedMs) / 60_000)) : null;
  const sinceLast = sinceLastMin == null ? null
    : sinceLastMin < 60 ? `${sinceLastMin}m`
    : `${Math.floor(sinceLastMin / 60)}h ${sinceLastMin % 60}m`;
  // Session length: from the start of today's first game to now. Rows come
  // newest first, so the oldest is last. time is local, with no zone.
  const firstStartMs = todayRows.length ? Date.parse(todayRows[todayRows.length - 1].time) : NaN;
  const sessionMin = Number.isFinite(firstStartMs) ? Math.max(0, Math.floor((nowMs - firstStartMs) / 60_000)) : null;
  const sessionLen = sessionMin == null ? null
    : sessionMin < 60 ? `${sessionMin}m`
    : `${Math.floor(sessionMin / 60)}h ${String(sessionMin % 60).padStart(2, '0')}m`;
  // Most-played hero today, ties going to the most recent.
  const topHero = (() => {
    const tally = new Map<string, { games: number; wins: number }>();
    for (const r of todayRows) {
      const t = tally.get(r.hero) ?? { games: 0, wins: 0 };
      t.games++; t.wins += r.win; tally.set(r.hero, t);
    }
    let best: { hero: string; games: number; wins: number } | null = null;
    for (const [hero, t] of tally) if (!best || t.games > best.games) best = { hero, ...t };
    return best;
  })();

  // Inline completion, matched from the start of the name only: typing
  // "kin" shows "g's Row" greyed after the cursor, Enter or Tab takes it.
  // Start-only because grey text can only finish a name, not jump into its
  // middle. No results list, so nothing pops over the card below.
  const suggestion = query.length > 0
    ? ALL_MAPS.find(m => m.toLowerCase().startsWith(query.toLowerCase()) && !selected.includes(m))
    : undefined;

  function selectMap(m: string) {
    if (selected.length >= 3 || selected.includes(m)) return;
    setSelected(prev => [...prev, m]);
    setQuery('');
    inputRef.current?.focus();
  }

  const ranked  = [...selected].sort((a, b) => (scoreMap[b]?.blended_score ?? 0) - (scoreMap[a]?.blended_score ?? 0));
  const winner  = ranked[0];
  // The single source of truth for "which map are we telling him to vote for".
  // The headline below prefers the hero-informed pick and only falls back to
  // the map-only blended score; the selected-map chips must follow the same
  // branch or the green check lands on a different map than the headline.
  const recommended = testPick?.available && testPick.picks.length > 0
    ? testPick.picks[0].map
    : winner;
  const topOnMap = data?.byHero ?? [];
  // "Select Your Hero" surfaces every hero in the CURRENT testing phase's
  // full roster — both the ones still actively testing and the ones that
  // already finished this phase (see phaseHeroes/doneThisPhase above) — union
  // with inTestingHeroes so an active ad-hoc/legacy test outside the current
  // phase (if one is ever running) still shows up too, additive rather than
  // narrowing. Previously this dropped a hero the instant its test completed;
  // now it stays visible with a "Done" badge instead (see the button render
  // below) so Sean can see the whole phase roster at a glance.
  const inTestingHeroes = new Set(btActives.map(a => a.hero).filter((h): h is string => !!h));
  const selectableHeroes = new Set([...inTestingHeroes, ...phaseHeroes]);
  // Every hero surfaced below is actively testing, so always has a sens/DPI
  // value here. Sens supersedes DPI post-lock; DPI is the fallback for any
  // pre-lock stage still running on the old axis.
  const testValueFor = (hero: string): string | null => {
    const a = btActives.find(a => a.hero === hero);
    if (!a) return null;
    const v = a.sens ?? a.dpi;
    return v != null ? v.toFixed(2) : null;
  };

  // Which stage of the set this hero is currently on. Already in the DpiTestHud
  // payload (the DPI card reads the same two fields), so this is a read, not a
  // new fetch. The gauge beside it only says how far through the CURRENT stage
  // he is — it resets every stage and so cannot say where the set as a whole
  // stands. That is what this number adds.
  const testStageFor = (hero: string): { cur: number; total: number } | null => {
    const a = btActives.find(a => a.hero === hero);
    if (!a || a.n_stages <= 0) return null;
    return { cur: a.cur_stage, total: a.n_stages };
  };

  // Chunk badge/gauge for a chunked (ABBA) set — see the DpiTestHud.chunk
  // comment above. null for an unchunked/legacy set, which keeps the
  // encircled-stage-number badge and stage-wide gauge exactly as before.
  const chunkFor = (hero: string) => btActives.find(a => a.hero === hero)?.chunk ?? null;

  // How far the hero's gauge has filled, 0..1, or null for a hero with no
  // gauge. Shared by the gauge and by the lit letters above it, which only
  // glow as far as the gauge reaches (2026-09-28).
  const gaugeFillFor = (hero: string): number | null => {
    const c = chunkFor(hero);
    if (!c && testGaugeFor(hero) == null) return null;
    const r = testStageLeftFor(hero);
    return c ? Math.min(1, c.openMinutes / 60) : r && r.total > 0 ? 1 - r.left / r.total : 0;
  };

  // Quantizes remaining-games-in-stage onto a 5-segment gauge (like a battery
  // meter) regardless of the set's actual batch_size, so every hero's gauge
  // reads on the same 5-bar scale.
  //
  // ROUNDS UP, and that is the whole point. This used to Math.round, which was
  // exact while a stage was 5 games (one game per bar) and quietly wrong the
  // moment Phase 11 raised it to 40: the gauge went fully dark with up to four
  // games still to play. An empty fuel gauge has to mean empty. Rounding up
  // means any remaining game keeps at least one bar lit, so dark means done,
  // and every bar covers the same batch_size/5 games instead of the end bars
  // being half-width.
  const GAUGE_SEGMENTS = 5;
  const testStageLeftFor = (hero: string): { left: number; total: number } | null => {
    const a = btActives.find(a => a.hero === hero);
    if (!a || a.batch_size <= 0) return null;
    return { left: Math.max(0, a.batch_size - a.games_on_stage), total: a.batch_size };
  };
  const testGaugeFor = (hero: string): number | null => {
    const r = testStageLeftFor(hero);
    if (!r) return null;
    return Math.min(GAUGE_SEGMENTS, Math.ceil((r.left / r.total) * GAUGE_SEGMENTS));
  };

  // In Quickplay, "Select Your Hero" isn't feeding a DPI test, so the
  // in-testing filter doesn't apply — show the top 3 win-rate heroes per role
  // for this map instead, testing or not.
  const isQP = queueMode === 'qp_role';

  // For each role, list every hero with an active sens test — no top-N cap,
  // no collapsed overflow bucket. topOnMap only has rows for heroes with at
  // least one logged game on this exact map, so an active-test hero with zero
  // games here needs a synthetic zero-row or it'd silently vanish.
  // The role's DF (if any — Support has none), as a HeroRow: its real
  // stats-on-this-map if it has any, otherwise a synthetic zero row exactly
  // like the phase roster's own zero-game heroes above.
  function dfRow(role: string): HeroRow | null {
    const hero = dfMap[role]?.hero;
    if (!hero) return null;
    return topOnMap.find(h => h.role === role && h.hero === hero)
      ?? { hero, role, games: 0, wins: 0, win_rate: 0 };
  }
  function buildRole(role: string) {
    const df = dfRow(role);
    if (isQP) {
      const base = topOnMap.filter(h => h.role === role).slice(0, 3); // already win_rate desc
      if (df && !base.some(h => h.hero === df.hero)) base.push(df);
      return base;
    }
    const onMap = topOnMap.filter(h => h.role === role && selectableHeroes.has(h.hero)); // already win_rate desc
    const onMapSet = new Set(onMap.map(h => h.hero));
    const zeroGame = [...selectableHeroes]
      .filter(h => HEROES[h] === role && !onMapSet.has(h))
      .map(hero => ({ hero, role, games: 0, wins: 0, win_rate: 0 }));
    const result = [...onMap, ...zeroGame];
    if (df && !result.some(h => h.hero === df.hero)) result.push(df);
    return result;
  }
  const byRole = {
    DPS:     buildRole('DPS'),
    Support: buildRole('Support'),
  };
  // "Always included" (see dfRow above) has to hold even when nothing else
  // would otherwise put a row on screen — e.g. no phase currently active, so
  // selectableHeroes is empty — or the panel below stays empty-state-hidden
  // and the DF hero never actually renders despite being "in" byRole.
  const hasDf = Object.keys(dfMap).length > 0;
  const showHeroPicker = isQP ? (byRole.DPS.length > 0 || byRole.Support.length > 0) : (selectableHeroes.size > 0 || hasDf);
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
    // bestScaleReliable (server-side MIN_SCALE_N) rather than a local n > 0
    // test — this line recommends a sens right before a match, so a single
    // lucky game at an untested scale must never reach it.
    return h?.bestScaleReliable && h.bestScaleEDPI != null
      ? Math.round((h.bestScaleEDPI / MOUSE_DPI) * 100) / 100
      : null;
  };

  // What sens to show beside a hero in the picker.
  //
  // A hero mid-test shows the sens that test is running at. A hero that has
  // finished shows the best scale its own data points to. The row used to go
  // blank the moment a test ended, which read as "nothing known about this
  // hero" — when finishing the test is precisely when something IS known.
  //
  // `settled` separates the two, because they are different claims. One is
  // "play at this to keep the trial honest". The other is "this is the number
  // the trial arrived at".
  const pickerSensFor = (hero: string): { value: string; settled: boolean } | null => {
    const active = testValueFor(hero);
    if (active) return { value: active, settled: false };
    const rec = sensRecFor(hero);
    return rec != null ? { value: rec.toFixed(2), settled: true } : null;
  };

  const queueLabel = QUEUE_MODES.find(q => q.value === queueMode)?.label ?? '';

  // A segmented control: one row of equal-width choices with a single lit
  // block that SLIDES between them, rather than the lit state blinking off one
  // pill and on to another. The movement is the point — it shows the choice
  // travelling from where it was to where it went, so a mis-click is obvious
  // from the direction alone.
  //
  // One button width across BOTH groups (2026-09-24). auto-cols-fr only
  // equalises within a group, so the account pills came out narrower than
  // "Support". Every button stacks all six labels invisibly in one grid
  // cell, with its own label on top — each is exactly as wide as the widest
  // label anywhere on the strip, with nothing to measure.
  const ROLE_PICKS = ['DPS', 'Support'] as const;
  const IDENTITY_LABELS: readonly string[] = [...ACCOUNTS, ...ROLE_PICKS];

  const identityGroup = <T extends string>(
    options: readonly T[],
    value: T,
    onPick: (v: T) => void,
    sel: string | undefined,
    inspectId: string,
    idFor: (v: T) => string,
    titleFor: (v: T) => string,
  ) => (
    <SegmentedPills
      options={options} value={value} onPick={onPick} sel={sel}
      inspectId={inspectId} idFor={idFor} titleFor={titleFor}
      sizeLabels={IDENTITY_LABELS}
    />
  );

  return (
    <div>

      {/* Who is playing, right now. Account and role were separate controls in
          two different cards until 2026-09-19 — the account pills lived in the
          Lobby Rank header, the role pills in Map Voting's. Together they name
          one thing, and four separate things read them: the hero advisor's
          request, the Hero Advisor card's own role pill, Log Match's hero
          dropdown filter, and which of the eight rank slots the drum shows.
          A page-level setting with four readers does not belong inside one
          card's header.

          It sits ABOVE the cards rather than inside any of them, and that is
          load-bearing rather than cosmetic: the Lobby Rank card is hidden
          entirely on Quickplay, and the role pick still has work to do there.
          Folding role into that card would have made it vanish exactly when
          Quickplay needs it. */}
      {/* Deliberately thinner than a card. .card is p-5 — 20px top and bottom —
          which is right for a panel of content and far too much for one row of
          pills. The VERTICAL padding is overridden to zero: the pills span the
          strip edge to edge, so they define its height and there is no padding
          left to add on top. min-h keeps the bar from collapsing on itself if
          the pills ever shrink. The HORIZONTAL padding is left at
          the card's own px-5 on purpose: the Sens Test card sits directly below
          with the same 20px inset, so "Playing as" and that card's title start
          on the same vertical line. Trimming both sides knocked them 8px out
          of alignment. */}
      {/* Three columns on a 4-2-4 split (Sean, 2026-10-01): who is playing on
          the left, the role pick in the middle, the role timer on the right.
          A fixed grid rather than content-sized flex, so each column keeps
          its place whatever the text inside it says. */}
      <div
        className="card !py-0 mb-3 grid grid-cols-10 items-stretch gap-4 min-h-[34px]"
        data-inspect-id="prematch-identity-strip"
      >
        {/* Left (4): label, account pills, then the rank slot the account and
            role select. .card-title is the same as every card heading on the
            page; the class carries uppercase and tracking, so only size is set. */}
        <div className="col-span-4 min-w-0 flex items-stretch gap-2.5">
          <span className="text-xs card-title shrink-0 self-center">Playing as</span>
          <span className="text-[10px] uppercase tracking-wider text-[var(--faint-2)] self-center shrink-0" data-inspect-id="prematch-account-label">Account</span>
          {identityGroup(
            ACCOUNTS,
            account,
            setAccount,
            // The lit block wears the selected account's own rank tier hue, so
            // this strip and the rank badge further down agree without being
            // told twice. It transitions with the slide: moving from a Gold
            // account to a Platinum one shifts colour as it travels.
            playerRank != null ? RANK_TIER_RGB[rankTier(playerRank)] : undefined,
            'prematch-account-toggle',
            a => `prematch-account-${a.toLowerCase()}-button`,
            a => `Play as ${a}`,
          )}
          {/* Says out loud which of the eight rank slots the pair selects. The
              drum is far enough down the page that the strip is off screen by
              the time it is read. */}
          <span className="text-[11px] text-[var(--faint-2)] ml-auto min-w-0 truncate text-right self-center" data-inspect-id="prematch-identity-rank-readout">
            rank slot <b className="font-semibold text-[var(--muted)]">{account} · {ladder}</b>
            {playerRank != null && <> — <b className="font-semibold text-[var(--ink-2)]">{rankLabel(playerRank)}</b></>}
          </span>
        </div>

        {/* Middle (2): the role pick. Open Queue has one rank per account and
            no role queue, so the pick is hidden there, but the column keeps
            its space so the timer never shifts between queue modes. */}
        <div className="col-span-2 min-w-0 flex items-stretch justify-center gap-2.5">
          {queueMode !== 'comp_open' && (<>
          <span className="text-[10px] uppercase tracking-wider text-[var(--faint-2)] self-center shrink-0" data-inspect-id="prematch-role-label">Role</span>
          {identityGroup(
            ROLE_PICKS,
            testRole,
            setTestRole,
            ROLE_SEL_RGB[testRole],
            'prematch-role-pick-toggle',
            r => `prematch-role-pick-${r.toLowerCase()}-button`,
            r => `Queue as ${r}`,
          )}
          </>)}
        </div>

        {/* Right (4): role timer. Competitive minutes in the current role run,
            with a nudge to switch at 4 hours. Shown in every queue mode: Open
            Queue matches count too. Quick Play is ignored server-side.
            Recommendation only, never blocks logging. */}
        <div className="col-span-4 min-w-0 flex items-center">
          {roleTimer && roleTimer.role && (
            <div
              className="flex-1 min-w-0 flex items-center gap-2"
              title={`Competitive only · ${roleTimer.matches} matches since ${roleTimer.since}. Switch roles at ${fmtHM(roleTimer.thresholdMin)}.`}
              data-inspect-id="prematch-role-timer-card"
            >
              <span className="text-[10px] uppercase tracking-wider text-[var(--faint-2)] shrink-0">Role time</span>
              <div className="flex-1 min-w-[40px] h-1.5 rounded-full bg-ow-border/50 overflow-hidden" data-inspect-id="prematch-role-timer-bar">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, (roleTimer.totalMin / roleTimer.thresholdMin) * 100)}%`, background: `rgb(${ROLE_SEL_RGB[roleTimer.role] ?? '148 163 184'})` }}
                  data-inspect-id="prematch-role-timer-fill"
                />
              </div>
              <span className="text-[11px] whitespace-nowrap shrink-0 text-[var(--ink-2)]" data-inspect-id="prematch-role-timer-readout">
                {roleTimer.reached
                  ? <b className="font-semibold">{fmtHM(roleTimer.thresholdMin)} — switch to {roleTimer.switchTo}</b>
                  : <><b className="font-semibold">{roleTimer.role}</b> {fmtHM(roleTimer.totalMin)} / {fmtHM(roleTimer.thresholdMin)}</>}
                {roleTimer.estimatedMin > 0 && <span className="text-[var(--faint-2)]"> (+{Math.round(roleTimer.estimatedMin)}m est.)</span>}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Step 1 row (game sequence, design-language section 7), on the
          page's three-column grid: the Map card spans two columns (the
          tracker's map inputs, then the vote advice under a divider), Today
          takes the third. No fixed height and no clipping: cards size to their
          content, and nothing scrolls inside a card. The min height is the
          tallest state (three maps offered: search above a full 2x2 grid of
          maps and Clear, measured 191px). Every other state is shorter, so the row stays put
          as maps are typed and picked instead of jumping on each click. It is
          a minimum, not a height, so longer content grows the row rather than
          clipping. The sens-test HUD used to
          own this row's height; it now lives with the Experiment column at
          step 5. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 items-stretch gap-4 mb-4 lg:min-h-[191px]">

        {/* Map — game step 1. Tracker-owned inputs, moved out of the advice
            cards that used to host them: the offered-maps search and chips (up
            to 3, what the vote screen offered), then the match map itself.
            State is MatchContext's `map`; this is placement only. */}
        <div className="card lg:col-span-2 min-w-0 flex flex-col" data-inspect-id="prematch-map-card">

          {/* Header on the body's three-column grid. Title and search take
              column 1, and the search reaches across the 16px gap to end
              exactly on the first column divider. The rest sits past it. */}
          <div className="grid grid-cols-3 gap-4 items-center mb-2 min-h-8">
            <div className="flex items-center gap-2 min-w-0">
              <h2 className="text-sm card-title whitespace-nowrap">Map</h2>
              {/* Search input — in the header beside the title. Stays in
                  place once three maps are in (greyed out; Clear frees it). */}
              <div className="flex-1 min-w-0 -mr-4">
                <div className="relative">
                  <input
                    ref={inputRef}
                    id="map-search"
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Escape') setQuery('');
                      if ((e.key === 'Enter' || e.key === 'Tab') && suggestion) { e.preventDefault(); selectMap(suggestion); }
                    }}
                    placeholder={selected.length >= 3 ? '3 maps entered' : 'Type a map name…'}
                    disabled={selected.length >= 3}
                    autoComplete="off"
                    spellCheck={false}
                    data-inspect-id="prematch-map-search-input"
                    className="w-full field px-2.5 py-1 text-xs"
                  />
                  {/* The grey completion. Same padding, border and font as the
                      input, with the typed part invisible, so the rest of the
                      name lands right after the cursor. */}
                  {suggestion && (
                    <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center px-2.5 py-1 text-xs border border-transparent whitespace-pre overflow-hidden" data-inspect-id="prematch-map-search-completion">
                      <span className="invisible">{query}</span><span className="text-[var(--faint-2)]">{suggestion.slice(query.length)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="col-span-2 flex items-center justify-between gap-2 pl-4 min-w-0">
              <span className="text-xs text-[var(--faint)] bg-ow-border/50 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">tap up to 3</span>
              {mapType && <span className={`pill shrink-0 ${TYPE_COLORS[mapType] ?? ''}`} data-inspect-id="prematch-map-type-badge">{mapType}</span>}
            </div>
          </div>

          {/* Three columns. Left: the search and the offered maps. Middle:
              the vote advice. Right: best and worst maps, always shown. */}
          <div className="flex-1 grid grid-cols-3 gap-4">
          <div className="min-w-0 flex flex-col gap-1.5">

          {/* Selected chips — all four pills (up to 3 maps + Clear) share
              equal width via flex-1/min-w-0 so they always sum to exactly
              the row's width (one row, no wrap) regardless of card width;
              the map name itself is a separate truncating span at a small
              fixed font size so even the longest map names ("Shambali
              Monastery") stay inside the pill instead of forcing it wider.
              Shape matches Dashboard's "Log sens stats" link — same notched
              clip-path (scaled down to a 6px cut for this smaller pill)
              instead of rounded-full, so the two clipped-corner shapes in
              the app are consistent rather than mixing pill styles. */}
          {selected.length > 0 && (
            <div className="flex flex-col gap-1.5">
            {/* Three square tiles in one row, Clear as a full-width bar
                under them. The whole tile sets the match map. There is no
                per-map remove; Clear takes them all off. */}
            <div className="grid grid-cols-3 gap-1.5 items-start" data-inspect-id="prematch-selected-map-chips">
              {selected.map(m => (
                <div key={m} className="min-w-0 flex flex-col gap-0.5">
                <span
                  className={`relative w-full min-w-0 aspect-square flex flex-col items-center justify-center border-2 text-[11px] font-semibold transition-colors ${
                    m === map ? 'is-selected mode-fill fill-strong'
                      : m === recommended ? 'is-selected mode-fill'
                      : 'border-ow-border text-[var(--ink-2)]'
                  }`}
                  style={{ '--sel': m === map ? ACCENT_SEL : '16 185 129', clipPath: NOTCH } as React.CSSProperties}
                >
                  <button
                    onClick={() => setMap(m)}
                    className="absolute inset-0 flex flex-col items-center justify-center px-1 min-w-0 hover:opacity-80 transition-opacity"
                    title={`Set ${m} as the match map`}
                  >
                    {/* Rank-badge type (RankBadge.tsx): small caps label on top,
                        big heavy number under it. Lit tiles use .lit-text. */}
                    <span className={`w-full text-center truncate text-[9px] uppercase tracking-wide xl:tracking-widest font-bold leading-none ${m === map || m === recommended ? 'lit-text' : 'text-[var(--faint)]'} ${m === map ? 'lit-strong' : ''}`} data-inspect-id="prematch-selected-map-chip-name">{mapShort(m)}{mapCounts[m] ? ` (${mapCounts[m]})` : ''}</span>
                    {/* Overall win rate on this map: every logged game. The
                        last-5 strip sits under it, exactly as wide as the
                        number (the column stretches it), newest leftmost,
                        oldest faded.
                        Clicks pass through to the tile. */}
                    <span className="inline-flex flex-col items-stretch">
                        <span className={`text-lg xl:text-xl num-display font-black leading-none ${m === map || m === recommended ? 'lit-text' : 'text-[var(--ink)]'} ${m === map ? 'lit-strong' : ''}`} data-inspect-id="prematch-selected-map-chip-rate">{scoreMap[m] ? <>{Math.round(scoreMap[m].historical_rate)}<span className="text-[10px] font-bold ml-px">%</span></> : '—'}</span>
                      <span className="flex items-stretch h-[2px] -mt-[3px] pointer-events-none" data-inspect-id="prematch-selected-map-chip-history">
                        {(() => {
                          const hist = [...(mapHistory?.byMap?.[m] ?? [])].reverse();
                          return hist.map((h, i) => (
                            <span
                              key={i}
                              style={i === hist.length - 1 ? OLDEST_DASH_FADE_STYLE : undefined}
                              className={`flex-1 ${h.win ? 'bg-emerald-500' : 'bg-red-500'}`}
                              title={`${h.win ? 'Win' : 'Loss'} · ${MODE_COMPACT[h.queue_mode]?.top ?? h.queue_mode} ${MODE_COMPACT[h.queue_mode]?.bot ?? ''}`.trim()}
                            />
                          ));
                        })()}
                      </span>
                    </span>
                  </button>
                </span>
                </div>
              ))}
            </div>
              <button
                onClick={() => { setSelected([]); setMap(''); setTimeout(() => inputRef.current?.focus(), 0); }}
                className="w-full mt-[2px] flex items-center justify-center px-2 py-1 border-2 border-ow-border text-[11px] font-semibold text-[var(--faint)] hover:text-[var(--ink)] hover:border-[var(--faint-2)] transition-colors"
                style={{ clipPath: NOTCH }}
                data-inspect-id="prematch-map-voting-clear-button"
              >
                Clear
              </button>
            </div>
          )}
          </div>

        {/* Vote advice — the middle third of the Map card (merged
            2026-09-30; it was its own "Map Voting" card). Reads the offered
            maps and says which to vote for. */}
        <div className="min-w-0 flex flex-col pl-4 border-l border-ow-border/40" data-inspect-id="prematch-map-voting-card">

          <div className="flex-1 min-h-0 flex flex-col">

          {/* Nothing offered yet: say what goes here. */}
          {selected.length === 0 && (
            <div className="text-xs text-[var(--faint)]" data-inspect-id="prematch-map-voting-empty">Enter the offered maps for a vote.</div>
          )}

          {/* Vote recommendation — driven by testPick (the cross product of
              candidate maps x current-phase roster for the Role Pick role)
              when that data is available, since a hero-informed win rate is
              more useful than a map-only blended score for actually deciding
              which map to vote for. Falls back to the old map-only
              blended_score ranking when testPick has nothing (no phase
              heroes yet, or zero games logged for any of them) so the
              section still works before a testing phase exists. Replaces
              the former separate "Top Picks" list below this — folded in
              per "new feature does not equate to new elements" rather than
              keeping two side-by-side recommendations. */}
          {selected.length > 0 && (testPick?.available ? testPick.picks.length > 0 : ranked.length > 0) && (
            <div className="flex-1 flex flex-col">
              {testPick?.available && testPick.picks.length > 0 ? (
                <div className="flex-1 flex flex-col justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <button onClick={() => setMap(testPick.picks[0].map)} className="min-w-0 truncate text-2xl leading-tight map-name text-emerald-600 hover:text-emerald-700 transition-colors text-left" data-inspect-id="prematch-vote-for-button">
                        {withMapCount(testPick.picks[0].map, mapCounts)}
                      </button>
                      <span className={`pill shrink-0 ${ROLE_COLORS[testRole]}`}>{testRole}</span>
                    </div>
                    <div className="text-xs text-[var(--faint)] truncate">
                      <span className="hero-name">{testPick.picks[0].hero}</span> · <b className="font-bold text-emerald-500">{testPick.picks[0].win_rate}</b>%
                      {testPick.picks[0].sample_size === 'thin' && <span className="text-amber-500"> · thin</span>}
                      {' · '}<b className="font-bold">{testPick.picks[0].games}</b>g played
                    </div>
                  </div>
                  {testPick.picks.length > 1 && (
                    <div className="flex flex-col gap-1.5">
                      {testPick.picks.slice(1, 3).map(p => (
                        <div key={`${p.map}|${p.hero}`} className="min-w-0 flex items-baseline justify-between gap-2 text-xs text-[var(--faint)]">
                          <span className="map-name text-sm text-[var(--ink-2)] truncate">{withMapCount(p.map, mapCounts)}</span>
                          <span className="shrink-0"><span className="hero-name">{p.hero}</span> · <b className="font-bold">{p.win_rate}</b>%</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : ranked.length === 1 ? (
                <div className="text-sm text-[var(--muted)]">Select more maps to compare.</div>
              ) : (
                <div className="flex-1 flex flex-col justify-between gap-3">
                  <div className="min-w-0">
                    <button onClick={() => openMap(winner)} className="min-w-0 truncate text-2xl leading-tight map-name text-emerald-600 hover:text-emerald-700 transition-colors text-left" data-inspect-id="prematch-vote-for-button">
                      {withMapCount(winner, mapCounts)}
                    </button>
                    {scoreMap[winner] && (
                      <div className="text-xs text-[var(--faint)]">
                        <b className="font-bold">{scoreMap[winner].blended_score}</b>% blended · <b className="font-bold">{scoreMap[winner].total_games}</b>g played
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {ranked.slice(1, 3).map(m => (
                      <div key={m} className="min-w-0 flex items-baseline justify-between gap-2 text-xs text-[var(--faint)]">
                        <span className="map-name text-sm text-[var(--ink-2)] truncate">{withMapCount(m, mapCounts)}</span>
                        <span className="shrink-0">{scoreMap[m] ? <><b className="font-bold">{scoreMap[m].blended_score}</b>% blended</> : 'no data'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Maps offered but no games on any of them — neither state above
              renders, so say why the card is empty. */}
          {selected.length > 0 && !(testPick?.available ? testPick.picks.length > 0 : ranked.length > 0) && (
            <div className="text-xs text-[var(--muted)] mt-2" data-inspect-id="prematch-map-voting-no-games">No games on these maps yet — no vote to suggest.</div>
          )}
          </div>
        </div>

        {/* Best & worst maps by recent win rate: two rows of three pills,
            best on top, no labels. Styled as the Playing As lit pill
            (SegmentedPills.tsx): notched corner (its NOTCH), 2px border,
            bottom-lit fill, semibold lit text (11px, not 12, so every short
            name in MAP_SHORT fits a tile at 1024px wide). The hue says which
            row is which: emerald-500 for best, red-500 for worst, the same
            colours these rates already used.
            Always shown; tap one to add it as an offered map. */}
        <div className="min-w-0 flex flex-col gap-1.5 pl-4 border-l border-ow-border/40" data-inspect-id="prematch-best-worst-maps-list">
          {rankedMaps.length > 0 && ([
            { label: 'Best maps', sel: '16 185 129', list: bestMaps },
            { label: 'Worst maps', sel: '239 68 68', list: worstMaps },
          ] as const).map(row => (
            <div key={row.label} className="flex-1 min-w-0 grid grid-cols-3 gap-1.5">
                {row.list.map(m => (
                  <button
                    key={m.map}
                    onClick={() => selectMap(m.map)}
                    title={m.map}
                    className="min-w-0 border-2 is-selected mode-fill flex flex-col items-center justify-center px-0.5 select-none hover:brightness-110 transition"
                    style={{ '--sel': row.sel, clipPath: NOTCH } as React.CSSProperties}
                  >
                    <span className="w-full text-center text-[11px] font-semibold leading-none lit-text truncate">{mapShort(m.map)}</span>
                    <span className="text-[11px] font-semibold tracking-wide leading-none mt-1 lit-text">{Math.round(m.recent_rate!)}%</span>
                  </button>
                ))}
            </div>
          ))}
        </div>
          </div>
        </div>

        {/* Today — the third column of the step-1 grid. Kept by Sean
            2026-09-30 (overrides flow spec later item A). Its tiles show in
            every state; they used to vanish once a map was picked, leaving a
            blank card. */}
        <div className="card min-w-0 flex flex-col" data-inspect-id="prematch-hero-advisor-card">
          <div className="flex items-center justify-between mb-2 min-h-8">
            <h2 className="text-sm card-title whitespace-nowrap">Today</h2>
          </div>

          {/* Everything below the pinned map selector — same treatment as
              Map Voting: no scroll region, content must fit the row's
              fixed height through compression alone. */}
          <div className="flex-1 min-h-0 flex flex-col">

          {/* Idle: session & timing snapshot — how you're doing right now.
              The panel is deliberately roomier than its content strictly
              needs: with no map picked yet this card would otherwise be
              mostly dead space next to Sens Test / Map Voting's packed
              lists, so the stat tiles get real card treatment (bordered
              panel, generous padding, bigger numerals) instead of just
              floating in the middle of the card. */}
          {(
            <div className="flex-1 flex flex-col">
              {/* Six readout tiles in a 3x2, replacing the old This hour tile
                  (hour-of-day win rates were retired as noise). The box keeps
                  the step-1 row at its 191px height at every width. */}
              <div className="relative overflow-hidden rounded-lg border border-ow-border/40 bg-gradient-to-br from-ow-accent/[0.06] via-ow-accent/[0.02] to-transparent flex-1 grid grid-cols-3 grid-rows-2 pb-1">
                {/* Today's results as one continuous line along the bottom
                    of the stats box: most recent left, one segment per game,
                    same flat win/loss colours as the map tiles' last-5 line.
                    Moved out of the card header 2026-09-30. Fixed length: the
                    box's full inner width, split into equal parts, one per
                    game played. With no games it is an empty grey track. */}
                {(
                  <div className="absolute inset-x-0 bottom-0 h-[4px] flex bg-ow-border/40" data-inspect-id="prematch-today-dots-strip">
                    {todayRows.map((r, i) => (
                      <span
                        key={i}
                        data-inspect-id="prematch-today-dot"
                        title={`${r.win ? 'Win' : 'Loss'} — ${r.hero} on ${r.map}`}
                        aria-label={`${r.win ? 'Win' : 'Loss'}, ${r.hero} on ${r.map}`}
                        className={`flex-1 ${r.win ? 'bg-emerald-500' : 'bg-red-500'}`}
                      />
                    ))}
                  </div>
                )}
                {/* Six readout tiles in a 3x2. Each is two centred lines: the label,
                    then the value. Only Rank carries a small tag beside its
                    value; every other tile's value says it all. */}
                <div className="col-start-1 row-start-1 min-w-0 flex flex-col items-center justify-center gap-1.5 px-2 border-ow-border/40 border-r border-b" data-inspect-id="prematch-today-stat-tile">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] leading-none">Today</div>
                  <div className="flex items-baseline justify-center gap-1 min-w-0 max-w-full">
                    {todayRows.length > 0 ? (
                      <span className="text-xl num-display !leading-none whitespace-nowrap"><span className="text-emerald-500">{todayW}</span><span className="text-[var(--muted)]">-</span><span className="text-red-500">{todayL}</span></span>
                    ) : <span className="text-sm text-[var(--faint)] leading-none">No games</span>}
                  </div>
                </div>
                <div className="col-start-2 row-start-1 min-w-0 flex flex-col items-center justify-center gap-1.5 px-2 border-ow-border/40 border-r border-b" data-inspect-id="prematch-streak-stat-tile">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] leading-none">Streak</div>
                  <div className="flex items-baseline justify-center gap-1 min-w-0 max-w-full">
                    {streaksData && streaksData.currentStreak > 0 ? (
                      <span className={`text-xl num-display !leading-none whitespace-nowrap ${streaksData.currentStreakType === 1 ? 'text-emerald-500' : 'text-red-500'}`}>{streaksData.currentStreak}{streaksData.currentStreakType === 1 ? 'W' : 'L'}</span>
                    ) : <span className="text-base text-[var(--faint)] leading-none">—</span>}
                  </div>
                </div>
                <div className="col-start-3 row-start-1 min-w-0 flex flex-col items-center justify-center gap-1.5 px-2 border-ow-border/40 border-b" data-inspect-id="prematch-rank-today-stat-tile" title="Divisions gained or lost across today's ranked games, and your current rank">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] leading-none">Rank</div>
                  <div className="flex items-baseline justify-center gap-1 min-w-0 max-w-full">
                    {rankDelta != null ? (<>
                      <span className={`text-xl num-display !leading-none whitespace-nowrap ${rankDelta > 0 ? 'text-emerald-500' : rankDelta < 0 ? 'text-red-500' : 'text-[var(--ink)]'}`}>{rankDelta > 0 ? `+${rankDelta}` : rankDelta < 0 ? `\u2212${-rankDelta}` : '\u00b10'}</span>
                      <span className="text-[10px] text-[var(--faint)] leading-none whitespace-nowrap" title={rankLabel(rankedToday[0].player_rank)}>{rankShort(rankedToday[0].player_rank)}</span>
                    </>) : <span className="text-base text-[var(--faint)] leading-none">—</span>}
                  </div>
                </div>
                <div className="col-start-1 row-start-2 min-w-0 flex flex-col items-center justify-center gap-1.5 px-2 border-ow-border/40 border-r" data-inspect-id="prematch-session-stat-tile" title="Time since today's first game started">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] leading-none">Session</div>
                  <div className="flex items-baseline justify-center gap-1 min-w-0 max-w-full">
                    {sessionLen != null ? <span className="text-xl num-display !leading-none whitespace-nowrap text-[var(--ink)]">{sessionLen}</span> : <span className="text-base text-[var(--faint)] leading-none">—</span>}
                  </div>
                </div>
                <div className="col-start-2 row-start-2 min-w-0 flex flex-col items-center justify-center gap-1.5 px-2 border-ow-border/40 border-r" data-inspect-id="prematch-top-hero-stat-tile" title="Most-played hero today">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] leading-none">Top hero</div>
                  <div className="flex items-baseline justify-center gap-1 min-w-0 max-w-full">
                    {topHero ? (
                      <span className="min-w-0 text-sm font-semibold hero-name text-[var(--ink)] leading-6 truncate" title={`${topHero.hero}: ${topHero.wins}-${topHero.games - topHero.wins} today`}>{heroShort(topHero.hero)}</span>
                    ) : <span className="text-base text-[var(--faint)] leading-none">—</span>}
                  </div>
                </div>
                <div className="col-start-3 row-start-2 min-w-0 flex flex-col items-center justify-center gap-1.5 px-2 border-ow-border/40 " data-inspect-id="prematch-last-game-stat-tile" title="Time since your last game today was logged">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] leading-none">Since last</div>
                  <div className="flex items-baseline justify-center gap-1 min-w-0 max-w-full">
                    {sinceLast != null ? <span className="text-xl num-display !leading-none whitespace-nowrap text-[var(--ink)]">{sinceLast}</span> : <span className="text-base text-[var(--faint)] leading-none">—</span>}
                  </div>
                </div>
              </div>
            </div>
          )}
          </div>
        </div>
      </div>


      {/* Hero advice — the recommendation and the coaching behind it, in one
          card above Select Your Hero (the tracker's hero input). */}
      <div id="consolidated-advisor" className="card mb-4" data-inspect-id="prematch-consolidated-advisor-card">
        <div className="flex items-start justify-between gap-3 mb-1">
          <div>
            <h2 className="text-sm card-title">
              {map ? (
                <>Your Heroes on <button onClick={() => openMap(map)} className="text-ow-accent hover:text-ow-accent/80 transition-colors" data-inspect-id="prematch-your-heroes-map-link">{withMapCount(map, mapCounts)}</button></>
              ) : 'Your Best Heroes Overall'}
            </h2>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Advice</span>
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
        </div>

        {/* Recommended pick — only with no map selected; once a map is chosen the
            coaching block's primary stands as the pick, so this would just repeat it.
            One column per role (DPS / Support), each the hottest-trending hero for
            that role rather than the single overall-best-win-rate hero, paired with
            the in-game sens its own best-tested scale points to. */}
        {(trendingDps || trendingSupport) && !map && (
          <div className="grid gap-3 mt-3 items-stretch grid-cols-1 sm:grid-cols-2" data-inspect-id="prematch-recommended-pick-card">
            {([['DPS', trendingDps], ['Support', trendingSupport]] as const).map(([role, rec]) => {
              const delta = rec && !rec.is_new && rec.recent_wr != null && rec.prev_wr != null
                ? Math.round((rec.recent_wr - rec.prev_wr) * 10) / 10 : null;
              return (
                <div key={role} className="rounded-lg match-card-bg px-4 py-3">
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

        {/* Coaching — LLM tactical read (AdvisorCard), only once a map is set.
            Two columns, DPS and Support, each its own independent primary +
            stretch pick — a role with no in-testing hero just shows empty
            rather than an error, since the other column may still have one. */}
        {map && (
          <div id="coaching" className="scroll-mt-24 rounded-lg bg-emerald-500/5 px-4 py-3 mt-3" data-inspect-id="prematch-coaching-section">
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
      </div>

      {/* Step 5 row, on the same three-column grid as step 1 so the edges and
          gaps line up: Select Your Hero spans two columns, the Experiment
          column one. With the sens study off there is no Experiment column
          and Select Your Hero takes all three. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 items-stretch gap-4">
        {/* Select Your Hero — game step 5, the tracker's hero input. Advice sits
            above it (the card above) and the Experiment column beside it. Its
            picks feed the Match Log's hero slots through MatchContext. */}
        <div className={`card min-w-0 ${sensStudyOn ? 'lg:col-span-2' : 'lg:col-span-3'}`} data-inspect-id="prematch-hero-select-card">
        <div className="flex items-baseline gap-2 mb-3">
          <h3 className="text-sm card-title" data-inspect-id="prematch-select-your-hero-header">Select Your Hero</h3>
          <span className="text-xs text-[var(--faint-2)]">by role · min 2 games · tap hero to pre-fill log</span>
        </div>
        {showHeroPicker ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" data-inspect-id="prematch-hero-picker-list">
            {(['DPS', 'Support'] as const).map(role => {
              const heroes = byRole[role];
              return (
                <div key={role}>
                  <div className={`text-xs font-bold uppercase tracking-widest mb-2 ${ROLE_TEXT[role]}`}>{role}</div>
                  <div className="flex flex-col gap-1.5">
                    {heroes.map(h => {
                      const clickIndex = clickedHeroes.indexOf(h.hero);
                      const isClicked = clickIndex !== -1;
                      const sensTag = pickerSensFor(h.hero);
                      const isDfHero = dfHeroes.has(h.hero);
                      const isTestHero = h.hero === testHero && !isDfHero;
                      // Lit letters follow the gauge: glow where the bar is under
                      // them, plain past its end. Selected cards only, since
                      // resting names aren't lit.
                      const fill = isDfHero ? null : gaugeFillFor(h.hero);
                      const litFill = isClicked && fill != null;
                      // Every piece of text on the card follows the glow, not
                      // just the name. litAs() returns the props that do it:
                      // a measured left edge (--nl) and the gauge's end in the
                      // element's own coordinates (--lit-x). `hue` keeps a
                      // coloured number (win rate, arrow) in its own colour.
                      const litAs = (hue?: string) => litFill ? {
                        ref: (el: HTMLElement | null) => { if (el) el.style.setProperty('--nl', `${el.offsetLeft}px`); },
                        style: { '--lit-x': 'calc(var(--fill) * (100cqw + 24px) + 7px - var(--nl, 0px))', ...(hue ? { '--sel': hue } : {}) } as React.CSSProperties,
                        cls: `lit-text ${hue ? 'lit-hue' : 'lit-strong'} lit-fill`,
                      } : null;
                      const wrHue = h.win_rate >= 60 ? '5 150 105' : h.win_rate >= 50 ? '41 211 242' : h.win_rate >= 40 ? '250 204 21' : '220 38 38';
                      const litName = litAs();
                      const litArrow = litAs(h.win_rate >= 50 ? '16 185 129' : '239 68 68');
                      const litWr = litAs(wrHue);
                      const litGames = litAs();
                      const litSens = sensTag?.settled ? litAs('4 120 87') : null;
                      // Per-map numbers when a map is picked, all-maps numbers
                      // before (2026-09-28). A hero with no games at all still
                      // hides them rather than reading 0%.
                      const showNums = h.games > 0;
                      return (
                      // role="button" rather than a real <button> because the
                      // row now nests its own "start next phase" button, and a
                      // button inside a button is invalid HTML (browsers drop
                      // the inner one out of the outer, breaking both). Keeps
                      // the whole row clickable and keyboard-operable exactly
                      // as before.
                      <div
                        key={h.hero}
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleHeroClick(h.hero)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHeroClick(h.hero); }
                        }}
                        data-inspect-id="prematch-hero-picker-button"
                        aria-pressed={isClicked}
                        // --sel is set on every chip, not just the chosen ones,
                        // so the hover preview and the settled selection share
                        // one hue. The order badge below already colours by role
                        // for the same reason: the row should read as "this
                        // role's pick", not as a generic accent highlight.
                        // Styled like Log Match's mode tiles (2026-09-27):
                        // selected = .is-selected.mode-fill (border, bottom-lit
                        // tint, lit edge); resting = no box, faint text. On a
                        // test hero the card-wide bottom edge is turned off
                        // because the gauge below draws that edge instead,
                        // only as far as the block's minutes reach.
                        style={{
                          '--sel': ROLE_SEL_RGB[role],
                          ...(litFill ? { '--fill': fill } : {}),
                          ...(isClicked && !isDfHero && (testGaugeFor(h.hero) != null || chunkFor(h.hero)) ? { boxShadow: 'none' } : {}),
                        } as React.CSSProperties}
                        className={`relative isolate [container-type:inline-size] flex items-center gap-3 w-full text-left rounded cursor-pointer active:scale-[0.98] transition-all group ${isTestHero ? 'test-glow' : ''} ${
                          // Resting wears the lobby slider's unlit rank-pane border; the extra
                          // 1px padding makes up the width gap with the 2px
                          // selected border, so selecting doesn't shift the row.
                          isClicked
                            ? 'border-2 px-3 py-2.5 is-selected mode-fill'
                            : 'hero-pane px-[13px] py-[11px] hover-sel'
                        }`}
                      >
                        {isClicked && (
                          // Click order (1st/2nd/3rd) — feeds Log Match's
                          // form.hero + 2 switch-hero slots in this same order.
                          // Colored by the hero's own role (ROLE_PILL_CLASS —
                          // the same DPS/Tank/Support convention used for role
                          // badges/pills elsewhere) rather than a generic accent
                          // color, so the badge reads as "this role's Nth pick."
                          <span
                            className={`absolute -top-1.5 -left-1.5 w-4 h-4 rounded-full text-white text-[11px] font-bold flex items-center justify-center pointer-events-none z-10 ${ROLE_PILL_CLASS[role]}`}
                            title={`Pick #${clickIndex + 1} this match`}
                            data-inspect-id="prematch-hero-picker-order-badge"
                          >
                            {clickIndex + 1}
                          </span>
                        )}
                        <span ref={litArrow?.ref} style={litArrow?.style} className={`text-[15px] font-bold ${showNums ? '' : 'invisible'} ${litArrow ? litArrow.cls : h.win_rate >= 50 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>{h.win_rate >= 50 ? '↑' : '↓'}</span>
                        <span
                          ref={litName?.ref}
                          style={litName?.style}
                          className={`flex-1 min-w-0 truncate whitespace-nowrap translate-y-[2px] text-[13px] hero-name transition-colors ${litName ? litName.cls : isClicked ? 'lit-text lit-strong' : 'text-[var(--muted)]'}`}
                        >
                          {isDfHero ? withDfBadge(withHeroCount(h.hero, heroCounts), dfMap, h.hero) : withHeroCount(h.hero, heroCounts)}
                          {sensTag && (
                            <span
                              ref={litSens?.ref}
                              style={litSens?.style}
                              className={litSens ? litSens.cls : sensTag.settled ? 'text-emerald-700 dark:text-emerald-400' : undefined}
                              title={sensTag.settled
                                ? 'Best sens this hero’s own testing landed on'
                                : 'Sens this test is running at'}
                              data-inspect-id="prematch-hero-picker-sens-tag"
                            >
                              {` @ ${sensTag.value}`}
                            </span>
                          )}
                        </span>
                        {!isDfHero && (testGaugeFor(h.hero) != null || chunkFor(h.hero)) ? (() => {
                          // The gauge IS the lit bottom edge (2026-09-27): the
                          // mode tile's 3px edge + upward underglow, drawn only
                          // as far as the hero's open 60-min block has filled
                          // (legacy unchunked set: games played at this sens).
                          // Full strength on a selected card, half at rest.
                          // Behind it, the stage/chunk label ("A1".."B4") as an
                          // oversized watermark, sized and set like the mode
                          // tiles' QP/V5/V6 (ModeWatermark "selector" variant).
                          // -z-10 + the card's `isolate` puts this layer above
                          // the card's own fill but under its text.
                          const c = chunkFor(h.hero);
                          const r = testStageLeftFor(h.hero);
                          const done = fill ?? 0;
                          const hue = ROLE_SEL_RGB[role];
                          const a = isClicked ? 1 : 0.5;
                          const label = c ? c.label : String(testStageFor(h.hero)?.cur ?? '');
                          return (
                            <span
                              // Reach down over the card's bottom border (2px
                              // selected, 1px at rest) so the lit edge sits ON
                              // the border; otherwise the border's dimmer tint
                              // shows as a thin line under it. The watermark
                              // takes the same px back so it stays centred.
                              className={`absolute inset-x-0 top-0 -z-10 overflow-hidden pointer-events-none ${isClicked ? '-bottom-[2px] rounded-t-[2px] rounded-b-[4px]' : '-bottom-[1px] rounded-t-[3px] rounded-b-[4px]'}`}
                              title={c
                                ? `${c.label} · ${Math.floor(c.openMinutes)} minutes played`
                                : `${r?.left ?? 0} of ${r?.total ?? 0} games left at this sens`}
                              data-inspect-id="prematch-hero-picker-gauge"
                            >
                              <span
                                aria-hidden="true"
                                className={`absolute inset-x-0 top-0 ${isClicked ? 'bottom-[2px]' : 'bottom-[1px]'} flex items-center justify-center num-display italic font-black leading-none tracking-[-0.07em] text-[4.2rem] translate-x-[0.15em] translate-y-[0.007em] whitespace-nowrap ${isClicked ? 'opacity-[0.225]' : 'opacity-15'}`}
                                style={isClicked ? undefined : { color: `rgb(${hue})` }}
                                data-inspect-id="prematch-hero-picker-stage-badge"
                              >
                                {isClicked ? (
                                  // Centred (2026-09-30). The span is the card's
                                  // full width with the text centred in it, so
                                  // its left edge is the card's left edge, the
                                  // same origin as the fill. --lit-x is then the
                                  // fill's end, less the parent's 0.15em nudge.
                                  <span
                                    className="flex-1 text-center lit-text lit-strong lit-fill"
                                    style={{ '--lit-x': 'calc(var(--fill) * (100cqw + 24px) - 0.15em)' } as React.CSSProperties}
                                  >{label}</span>
                                ) : label}
                              </span>
                              <span
                                className={`absolute inset-y-0 left-0 transition-opacity ${isClicked ? '' : 'opacity-0 group-hover:opacity-100'}`}
                                style={{
                                  // Straight vertical end (2026-09-30; was a
                                  // 20deg slant).
                                  width: `${done * 100}%`,
                                  // A gradient, not the tiles' inset box-shadow:
                                  // a blurred shadow also bleeds up the left and
                                  // slanted edges; this only climbs from the bottom.
                                  // Eased falloff (2026-09-28): the old hard step from full to
                                  // 55% at 3px read as a sudden band. Now it tapers over ~24px.
                                  background: `linear-gradient(to top, rgb(${hue} / ${a}) 0 2px, rgb(${hue} / ${a * 0.6}) 4px, rgb(${hue} / ${a * 0.3}) 9px, rgb(${hue} / ${a * 0.12}) 16px, rgb(${hue} / 0) 24px)`,
                                }}
                              />
                            </span>
                          );
                        })() : !isDfHero && doneThisPhase.has(h.hero) && (
                          // No active test right now, but this hero belongs to the
                          // current phase's roster and has already finished it —
                          // shown so Sean can see the whole phase at a glance,
                          // not just whichever hero is still running.
                          <span
                            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[11px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-800 dark:text-emerald-600 pointer-events-none whitespace-nowrap"
                            title="Already tested this phase"
                            data-inspect-id="prematch-hero-picker-done-badge"
                          >
                            ✓ Done
                          </span>
                        )}
                        {/* This map's numbers once a map is picked, all maps'
                            before that. Hidden (space kept) for a hero with
                            no games, which would read 0%.
                            Fixed width + right-aligned so the win rate can't
                            change the column's width — "0%" and "100%" occupy
                            the same box, so the row's layout doesn't slide
                            from row to row. */}
                        <span ref={litWr?.ref} style={litWr?.style} className={`shrink-0 w-12 translate-y-[2px] text-right text-[13px] hero-name ${showNums ? '' : 'invisible'} ${litWr ? litWr.cls : h.win_rate >= 60 ? 'text-emerald-600' : h.win_rate >= 50 ? 'text-ow-blue' : h.win_rate >= 40 ? 'text-yellow-400' : 'text-red-600'}`}>{h.win_rate}%</span>
                        <span ref={litGames?.ref} style={litGames?.style} className={`shrink-0 translate-y-[2px] text-[13px] hero-name w-11 text-right ${showNums ? '' : 'invisible'} ${litGames ? litGames.cls : 'text-[var(--faint)]'}`}>{h.games}g</span>
                      </div>
                      );
                    })}
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
        {/* Experiment — the sens-study module (blind stages), step 5 beside hero
            select. Mounted only while the sens-study category is on; with it
            off there is nothing to run and nothing to show. */}
        {sensStudyOn && (
          <div className="min-w-0 flex flex-col gap-4" data-inspect-id="prematch-experiment-card">
        {/* DPI stage-test HUD — a dropdown picks which "In Testing" hero you're
            about to play (several can be active at once, but the mouse can
            only sit on one DPI at a time), then shows that hero's current
            stage DPI plainly (no hiding) plus two live wheels: minutes left
            in its whole test and in its current stage (games, for a legacy
            unchunked set).
            Drives off the same state the Sens page loop does. Sits where the
            sens picker used to. */}
        <div className="card flex flex-col" data-inspect-id="prematch-dpi-hud-card">
          {/* Header row uses the same mb-2 min-h-8 classes as the sibling
              cards' headers, so the titles line up. */}
          <div className="flex items-center justify-between mb-2 min-h-8 gap-2">
            <h2 className="text-sm card-title whitespace-nowrap">{bt?.sens != null ? 'Sens Test' : 'DPI Test'}</h2>
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
              className="text-[11px] field px-1.5 py-1 mb-1 w-full"
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
            // Fixed h-[23px] + mb-1 (27px) matches the <select> branch above
            // (~23px field + mb-1), so the odometer grid below starts at the
            // same offset whichever branch rendered.
            <div className="h-[23px] flex items-center mb-1">
              <span className="text-[10px] hero-name text-[var(--faint-2)] truncate">{bt!.hero ?? 'ad-hoc'}</span>
            </div>
          )}
          {/* Two columns (2026-09-30). Left: minutes left in the whole test,
              the current stage and the open 60-minute block. Right: the aim
              backlog and a full-width button to it. */}
          <div className="flex-1 grid grid-cols-2 gap-4 mt-2.5">
          {bt ? (
            // Compact (2026-09-30): one row per counter, its two-line label
            // beside it. Narrow drums at size 28 (17px
            // wide, 22px digit); an H:MM clock is ~63px. Right-aligned, so the
            // minute drums line up down the column.
            <div className="grid grid-cols-[auto_auto] justify-end items-center gap-x-3 gap-y-1.5 content-start">
              {btChunk
                ? <ClockOdometer minutes={btTestLeft} size={clockSize} dataInspectId="prematch-dpi-matches-left-odometer" />
                : <Odometer value={btTestLeft} size={28} digits={3} narrow dataInspectId="prematch-dpi-matches-left-odometer" />}
              <div className="min-w-0 whitespace-nowrap translate-y-[3px]">
                <div className="text-[10px] leading-[9px] uppercase tracking-wider text-[var(--muted)]">{btChunk ? 'left' : 'matches left'}</div>
                <div className="text-[10px] leading-[9px] text-[var(--faint-2)]">in this test</div>
              </div>
              {btChunk
                ? <ClockOdometer minutes={btGamesLeft} size={clockSize} dataInspectId="prematch-dpi-games-left-odometer" />
                : <Odometer value={btGamesLeft} size={28} digits={3} narrow dataInspectId="prematch-dpi-games-left-odometer" />}
              <div className="min-w-0 whitespace-nowrap translate-y-[3px]">
                <div className="text-[10px] leading-[9px] uppercase tracking-wider text-[var(--muted)]">{btChunk ? 'left' : 'games left'}</div>
                <div className="text-[10px] leading-[9px] text-[var(--faint-2)]">in stage <b className="font-bold">{bt.cur_stage}</b></div>
              </div>
              {/* The open 60-minute block. Chunked sets only; a legacy set
                  counts games and has no blocks. */}
              {btChunk && (
                <>
                  <ClockOdometer minutes={Math.max(0, Math.ceil(60 - btChunk.openMinutes))} size={clockSize} dataInspectId="prematch-dpi-block-left-odometer" />
                  <div className="min-w-0 whitespace-nowrap translate-y-[3px]">
                    <div className="text-[10px] leading-[9px] uppercase tracking-wider text-[var(--muted)]">left</div>
                    <div className="text-[10px] leading-[9px] text-[var(--faint-2)]">in this block</div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="grid justify-items-center content-start text-center px-2" data-inspect-id="prematch-dpi-idle-banner">
              <div>
                <div className="text-xs text-[var(--faint)]">No DPI test running</div>
                <div className="text-[10px] text-[var(--faint-2)] mt-1">Start one on the Sens page →</div>
              </div>
            </div>
          )}

            {/* Aim backlog: the count, then a full-width button to the Sens
                page, which opens at the top like any other arrival. */}
            {/* The backlog count (label under it), centred, then the button pinned to the
                bottom so its edge lines up with the left column's last clock. */}
            <div className="flex flex-col justify-between gap-2 min-w-0 pl-4 border-l border-ow-border/40">
              <div className="flex flex-col items-center gap-0.5">
                <Odometer value={backlogCount} size={40} digits={1} narrow warn={backlogCount >= BACKLOG_WARN} dataInspectId="prematch-backlog-odometer" />
                <span className="text-[10px] leading-none uppercase tracking-wider text-[var(--muted)] whitespace-nowrap">in backlog</span>
              </div>
              <Link
                to="/sens"
                // The accent's lit fill (.is-selected.mode-fill) with a thin
                // 1px border instead of the mode tile's 2px one. The extra 1px
                // padding keeps the button's size. The lit bottom edge and
                // underglow stay: they are the theme.
                className="relative block w-full text-center rounded border is-selected mode-fill px-[9px] py-[7px] text-sm font-bold whitespace-nowrap cursor-pointer active:scale-[0.98] hover:brightness-110 transition-all"
                style={{ '--sel': ACCENT_SEL } as React.CSSProperties}
                data-inspect-id="prematch-backlog-go-link"
              >
                <span className="lit-text">Go to backlog →</span>
              </Link>
            </div>
          </div>
          {/* One line (2026-09-30). The full rule: every other game logs at
              the frozen fallback sens, not the active test value. */}
          <p className="mt-3 text-[11px] text-[var(--faint)] leading-snug" title="Everything else logs at the frozen fallback sens instead of the active test value.">
            Counts Comp (any role) and QP Support only.
          </p>
        </div>

            {/* Next test — the sens-study round-robin recommender (GET
                /api/blind/next, lib/nextTest.ts). The whole column is gated on
                the sens-study category, since it has nothing to say when that
                data isn't being collected. Sits under the HUD in the Experiment column. */}
            {nextTest && (
              <div className="card text-left" data-inspect-id="prematch-next-test-card">
                <h3 className="text-sm card-title mb-1">Next test</h3>
                {nextTest.isQuickplay ? (
                  <p className="text-xs text-[var(--faint)]" data-inspect-id="prematch-next-test-qp">
                    Quickplay doesn't count toward testing — queue Competitive
                  </p>
                ) : nextTest.allFinished ? (
                  <p className="text-xs text-[var(--faint)]" data-inspect-id="prematch-next-test-finished">
                    Every hero in this phase is done — next phase needs creating on the Sens page.
                  </p>
                ) : nextTest.block ? (
                  <p className="text-xs text-[var(--ink)]" data-inspect-id="prematch-next-test-block">
                    Stay on <b className="hero-name">{nextTest.block.hero}</b> — {Math.floor(nextTest.block.openMinutes)} minutes played
                    <span className="text-[var(--faint-2)]"> · queue {nextTest.block.role}</span>
                  </p>
                ) : nextTest.justClosed ? (
                  <p className="text-xs text-[var(--ink)]" data-inspect-id="prematch-next-test-just-closed">
                    Block done on <b className="hero-name">{nextTest.justClosed.hero}</b> — switch to <b className="hero-name">{nextTest.orderedHeroes?.[0]?.hero}</b>
                  </p>
                ) : (
                  <p className="text-xs text-[var(--ink)]" data-inspect-id="prematch-next-test-just-closed">
                    Queue <b>{nextTest.recommendedRole}</b> → <b className="hero-name">{nextTest.orderedHeroes?.[0]?.hero}</b>
                  </p>
                )}
                {/* Always on (2026-09-30): DPS left, Support right, whatever
                    the line above says. Same order as lib/nextTest.ts —
                    cold first, then least-progressed, then longest unplayed. */}
                {!!nextTest.heroes?.some(h => !h.completed) && (
                  <div className="grid grid-cols-2 gap-x-4 mt-1.5" data-inspect-id="prematch-next-test-list">
                    {(['DPS', 'Support'] as const).map(role => (
                      <div key={role} className="flex flex-col gap-0.5 min-w-0">
                        <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">{role}</div>
                        {nextTest.heroes!
                          .filter(h => h.role === role && !h.completed)
                          .map(h => ({ ...h, cold: h.daysSinceLastPlayed != null && h.daysSinceLastPlayed >= 7 }))
                          .sort((a, b) => Number(b.cold) - Number(a.cold) || a.credited - b.credited
                            || (b.daysSinceLastPlayed ?? Infinity) - (a.daysSinceLastPlayed ?? Infinity))
                          .map(h => (
                            <div key={h.hero} className="flex items-center justify-start gap-1.5 text-[11px] text-[var(--faint-2)]" data-inspect-id="prematch-next-test-hero-row">
                              <span className="hero-name truncate">{h.hero}</span>
                              {h.cold && (
                                <span className="text-[9px] font-bold uppercase tracking-wide text-blue-500" title={`${h.daysSinceLastPlayed} days since last played`}>
                                  cold
                                </span>
                              )}
                              {/* Minutes played / planned for a block-based set
                                  (2026-09-28); games for a legacy one. */}
                              <span className="num-display ml-auto whitespace-nowrap">
                                {h.targetMinutes != null ? `${h.playedMinutes ?? 0}/${h.targetMinutes} min` : `${h.credited}/${h.target}`}
                              </span>
                            </div>
                          ))}
                      </div>
                    ))}
                  </div>
                )}
                {!!nextTest.finishedHeroes?.length && !nextTest.allFinished && (
                  <p className="text-[10px] text-[var(--faint-2)] mt-1.5" data-inspect-id="prematch-next-test-done-heroes">
                    Done this phase: {nextTest.finishedHeroes.join(', ')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Lobby Rank — the tracker's centrepiece, in its own full-width card.
          Game step 4, but it sits after hero select, right above the Deaths
          card (Sean, 2026-09-30). Placed before hero select, it was off screen
          while he got ready to log deaths, so he kept forgetting it. The
          component and its state are tracker-owned (MatchContext). On
          Quickplay the component renders nothing, so no empty card appears. */}
      <div id="lobby-step" className="scroll-mt-24 mt-4">
        <LobbyRankSection className="card" />
      </div>
    </div>
  );
}

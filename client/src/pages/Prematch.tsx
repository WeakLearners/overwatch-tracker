import { useState, useRef, useEffect } from 'react';
import { format } from 'date-fns';
import { useApi, revalidateAll } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import LobbyRangeSlider from '../components/LobbyRangeSlider';
import { MAPS, QUEUE_MODES, ROLE_COLORS, ROLE_SEL_RGB, ROLE_TEXT, ROLE_PILL_CLASS, TYPE_COLORS, HEROES, MODE_COMPACT, OLDEST_DASH_FADE_STYLE, MapVotingRow, QueueMode, Streaks, RANK_TIER_RGB, DEFAULT_LOBBY_SPREAD, ACCOUNTS, rankLabel, rankTier, rankDivision, rankFromParts, clampRank } from '../types';
import AdvisorCard from '../components/AdvisorCard';
import EmptyState from '../components/EmptyState';
import { useMapDrawer } from '../contexts/MapDrawerContext';
import { useHeroDrawer } from '../contexts/HeroDrawerContext';
import { useMatch } from '../contexts/MatchContext';
import { Link } from 'react-router-dom';
import Odometer from '../components/Odometer';
import { MOUSE_DPI } from '../lib/aim';
import RankBadge from '../components/RankBadge';
import { useFieldConfig } from '../contexts/FieldConfigContext';
import { useDfHeroes, dfHeroSet, withDfBadge } from '../hooks/useDfHeroes';

// GET /api/blind/next's shape — see server/src/lib/nextTest.ts for what each
// field means (role pick, stint lock, cold flag). Fetched fresh whenever
// queueMode changes (Quickplay gets its own no-list response) and whenever
// any match is logged, via useApi's shared revalidateAll() subscription.
interface NextTestResponse {
  isQuickplay: boolean;
  allFinished?: boolean;
  finishedHeroes?: string[];
  phase?: string | null;
  stint?: { hero: string; role: string; position: number; length: number } | null;
  recommendedRole?: string | null;
  orderedHeroes?: { hero: string; role: string; credited: number; target: number; daysSinceLastPlayed: number | null; cold: boolean }[];
}

// DPI stage-test HUD state — the dashboard reads this live to show the
// current stage's DPI plainly (no hiding, no LED colors). Several tests can
// be running at once (one per hero), so this is a list, not a single test.
interface DpiTestHud {
  actives: {
    set_id: number; hero: string | null; cur_stage: number; n_stages: number; totalGames: number;
    batch_size: number; games_on_stage: number; dpi: number | null; sens: number | null;
    // Present only for a chunked (ABBA) 2-stage set — see routes/blind.ts's
    // GET /state and lib/blind.ts's chunkLabelFor/leftInCurrentChunk/
    // label is the "A1".."B4" chunk badge; left counts down the CURRENT
    // chunk, not the whole stage. The gauge draws chunk_size bars, one per
    // match.
    chunk?: {
      chunk_size: number; n_chunks_per_stage: number; chunk_number: number; chunk_position: number;
      label: string; left: number;
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

// The band's remembered width. Its position persists too, in MatchContext.
const TRAY_WIDTH_KEY = 'ow-lobby-tray-width';

export default function Prematch() {
  // Shared, single-instance match state (queue mode, map, advisor) lives here
  // and is consumed by the Log Match section too.
  const { queueMode, map, setMap, mapType, rec, recLoading, recError, refreshRec, revalidateRec, testRole, setTestRole, setPendingHeroes, matchLoggedSignal, account, setAccount, playerRank, setPlayerRank, lobbyLow, lobbyHigh, setLobbyRange, clearLobbyRange } = useMatch();

  // The lobby band's width in divisions, remembered across matches. Eleven is
  // +/-5 around Sean's rank, the spread ~99% of lobbies fall inside — so the
  // usual match is one drag, not a resize and a drag. The POSITION is never
  // remembered; that is the per-match observation.
  const [trayWidth, setTrayWidthState] = useState(() => {
    const v = Number(localStorage.getItem(TRAY_WIDTH_KEY));
    return v >= 1 && v <= 2 * 10 + 1 ? v : DEFAULT_LOBBY_SPREAD * 2 + 1;
  });
  // Two separate jobs, deliberately separate functions.
  //
  // rememberTrayWidth only stores the number. It is what a finished handle
  // drag reports. Folding these two together is what made the slider fight
  // itself: dragging an end changed the width, the width setter re-centred the
  // bar around its old middle, and the bar snapped back under the cursor.
  const rememberTrayWidth = (w: number) => {
    setTrayWidthState(w);
    try { localStorage.setItem(TRAY_WIDTH_KEY, String(w)); } catch { /* ignore */ }
  };
  // resizeTray changes the bar's width in place, keeping it centred where it
  // already sits. Only the header's -/+ buttons do this.
  const resizeTray = (w: number) => {
    rememberTrayWidth(w);
    if (lobbyLow != null && lobbyHigh != null) {
      const centre = Math.round((lobbyLow + lobbyHigh) / 2);
      const half = Math.floor((w - 1) / 2);
      setLobbyRange(centre - half, centre - half + w - 1);
    }
  };

  // The rank drum. Quickplay has no rank, so it isn't shown there.
  // First press seeds at Gold 5 — a visible starting point on the badge, a few
  // presses from any real rank, and it sticks from then on. Moving the rank
  // clears any lobby range, because that range was built from the OLD rank and
  // would otherwise attach itself silently to the new one.
  const stepRank = (d: number) => {
    if (playerRank == null) { setPlayerRank(rankFromParts('Gold', 5)); return; }
    const next = clampRank(playerRank + d);
    if (next === playerRank) return;
    setPlayerRank(next);
    clearLobbyRange();
  };
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
  const { isCategoryEnabled } = useFieldConfig();
  const sensStudyOn = isCategoryEnabled('sens-study');
  // Fetched unconditionally — the category toggle is a display gate on the
  // card below, not a reason to skip a cheap, side-effect-free GET. Keeping
  // the fetch itself unconditional also means flipping the toggle on shows
  // fresh data immediately rather than a stale null from before it was on.
  const { data: nextTest } = useApi<NextTestResponse>(`/api/blind/next?queue_mode=${queueMode}`, [queueMode]);
  // The hero the Next test card is pointing at: the locked stint hero, else
  // the top of the recommended list. Its picker row pulses (.test-glow) so
  // it can be found at a glance.
  const testHero = sensStudyOn && nextTest && !nextTest.isQuickplay && !nextTest.allFinished
    ? (nextTest.stint?.hero ?? nextTest.orderedHeroes?.[0]?.hero ?? null)
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

  // Idle-state filler data for the Map Voting / Hero Advisor cards.
  const today = format(new Date(), 'yyyy-MM-dd');
  const { data: todayMatches } = useApi<{ rows: { win: 0 | 1; map: string; hero: string }[] }>(`/api/matches?from=${today}&to=${today}&limit=100`);
  const { data: streaksData } = useApi<Streaks>('/api/stats/streaks');
  const { data: byHour } = useApi<{ hour: number; games: number; wins: number; win_rate: number; qp_games: number; qp_win_rate: number | null; comp_games: number; comp_win_rate: number | null }[]>('/api/stats/by-hour');
  const [selected, setSelected] = useState<string[]>([]);

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
  const [open, setOpen]         = useState(false);
  // Ordered heroes clicked in "Select Your Hero" this match, kept separately
  // from the context's `pendingHeroes` — that one is a one-shot signal Log
  // Match consumes and clears the instant it pre-fills the form, so it can't
  // double as "what should stay highlighted here." Order matters: index 0 is
  // the 1st click (Log Match's form.hero/starting hero), 1/2 are the 2nd/3rd
  // clicks (Log Match's two switch-hero slots) — clicking an already-clicked
  // hero again toggles it off (and reflows the ones after it up), and a 4th
  // click while 3 are already picked is a no-op, same "tap up to 3, blocked
  // past that" convention Map Voting's own toggleMap already uses above.
  const [clickedHeroes, setClickedHeroes] = useState<string[]>([]);
  const inputRef                = useRef<HTMLInputElement>(null);
  const advisorSelectRef        = useRef<HTMLSelectElement>(null);

  function toggleHeroClick(hero: string) {
    const next = clickedHeroes.includes(hero)
      ? clickedHeroes.filter(h => h !== hero)
      : clickedHeroes.length < 3 ? [...clickedHeroes, hero] : clickedHeroes;
    if (next === clickedHeroes) return; // blocked (4th click) — no-op, nothing to sync
    setClickedHeroes(next);
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
    setOpen(false);
    setClickedHeroes([]);
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
  // Battery colour for a gauge's lit bars, from the fraction still left. It
  // slides along the card-title gradient: cyan when full, gold when nearly
  // empty (--gauge-full/--gauge-empty in index.css, per theme). One colour
  // for every lit bar, like a phone battery, not a per-bar rainbow.
  const batteryColor = (fractionLeft: number) =>
    `color-mix(in oklab, var(--gauge-full) ${Math.round(100 * Math.max(0, Math.min(1, fractionLeft)))}%, var(--gauge-empty))`;
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
  // Three things make the slide exact rather than approximate:
  //   - auto-cols-fr gives every option the same width, so step N is always
  //     N x 100% of the indicator's own width. No measuring, no refs, nothing
  //     to re-read on resize.
  //   - no gap between options. A gap is not part of that 100%, so the
  //     indicator would drift further out of register with each step.
  //   - the indicator carries the border and .is-selected; the buttons carry
  //     only text. Two elements painting a border would double it mid-slide.
  const NOTCH = 'polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px)';
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
  ) => {
    const i = Math.max(0, options.indexOf(value));
    return (
      // The group sits 3px inboard of the strip, and the lit block reaches back
      // out to the strip's own edge. Net effect: the selected option stands 6px
      // taller than its neighbours and meets the card border, which is what
      // reads as raised. It CANNOT overhang the border: .card carries a
      // clip-path for its notched corner, and a clip-path cuts its descendants,
      // so anything past the edge is silently sliced off. Growing outward looks
      // like nothing happened. Insetting the resting state is the same illusion
      // without fighting the card's own shape.
      <div className="relative grid grid-flow-col auto-cols-fr my-[3px]" data-inspect-id={inspectId}>
        <span
          aria-hidden="true"
          className="is-selected mode-fill absolute -inset-y-[3px] left-0 border-2 pointer-events-none transition-[transform,background-color,border-color,box-shadow] duration-200 ease-out motion-reduce:transition-none"
          style={{
            width: `${100 / options.length}%`,
            transform: `translateX(${i * 100}%)`,
            clipPath: NOTCH,
            ...(sel ? ({ '--sel': sel } as React.CSSProperties) : {}),
          }}
        />
        {options.map(o => (
          <button
            key={o}
            type="button"
            onClick={() => onPick(o)}
            aria-pressed={value === o}
            title={titleFor(o)}
            data-inspect-id={idFor(o)}
            style={value === o && sel ? ({ '--sel': sel } as React.CSSProperties) : undefined}
            className={`relative z-10 px-3 flex items-center justify-center text-xs leading-none font-semibold tracking-wide transition-colors ${
              value === o ? 'text-[var(--ink)]' : 'text-[var(--faint)] hover:text-[var(--ink)]'
            }`}
          >
            <span className="grid justify-items-center">
              {IDENTITY_LABELS.map(l => (
                <span key={l} aria-hidden="true" className="invisible col-start-1 row-start-1">{l}</span>
              ))}
              <span className="col-start-1 row-start-1">
                {value === o && sel ? <span className="lit-text">{o}</span> : o}
              </span>
            </span>
          </button>
        ))}
      </div>
    );
  };

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
      <div
        className="card !py-0 mb-3 flex items-stretch gap-2.5 flex-wrap min-h-[34px]"
        data-inspect-id="prematch-identity-strip"
      >
        {/* .card-title, the same as every card heading on the page — this
            strip is a section of the page and its label should read as one.
            The class already carries uppercase and the widest tracking, so
            only the size is set here. */}
        <span className="text-xs card-title shrink-0 flex-1 basis-0 min-w-0 self-center">Playing as</span>

        {/* The two pill groups sit dead centre of the strip. Centring is done
            by giving the label and the readout `flex-1 basis-0` rather than by
            margins: equal basis makes the two side items claim equal width
            whatever they contain, so the middle block lands on the strip's
            true centre. Sizing them to their own content would drift the
            centre every time the readout's rank text changed length. */}
        <div className="flex items-stretch gap-2.5 shrink-0">
          {/* Small group labels, same style as the "Today" label on the
              Hero Advisor dots. */}
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
          <span className="w-px self-stretch my-1.5 bg-ow-border/70 shrink-0" aria-hidden="true" />
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
        </div>

        {/* Says out loud which of the eight rank slots the pair selects. The
            drum is far enough down the page that the strip is off screen by
            the time it is read. */}
        <span className="text-[11px] text-[var(--faint-2)] flex-1 basis-0 min-w-0 text-right self-center" data-inspect-id="prematch-identity-rank-readout">
          rank slot <b className="font-semibold text-[var(--muted)]">{account} · {testRole}</b>
          {playerRank != null && <> — <b className="font-semibold text-[var(--ink-2)]">{rankLabel(playerRank)}</b></>}
        </span>
      </div>

      {/* DPI test HUD (square) + Map Voting + Hero Advisor row — stacks on
          phone widths; three-across only once there's room for each card's
          own header (title + badge) to fit without wrapping. */}
      {/* Fixed height at sm+ (sm:h-[13.68rem], 15.2rem - another 10%) so this row holds steady regardless of
          card content, with Map Voting and Hero Advisor matching DPI-HUD's
          card size instead of growing past it — their variable content
          (vote recommendation, hero coaching, etc.) scrolls internally past
          this fixed height rather than pushing it. DPI-HUD stays
          self-stretch + aspect-square so its width is always derived from
          this SAME shared height (square, deterministic) rather than a
          separate guessed width — all three cards size off one number. */}
      <div className="flex flex-col sm:flex-row items-stretch gap-4 mb-4 sm:h-[13.68rem]">

        {/* DPI stage-test HUD — a dropdown picks which "In Testing" hero you're
            about to play (several can be active at once, but the mouse can
            only sit on one DPI at a time), then shows that hero's current
            stage DPI plainly (no hiding) plus two live wheels: matches left
            in its whole test and games left before its next stage switch.
            Drives off the same state the Sens page loop does. Sits where the
            sens picker used to. */}
        <div className="card sm:aspect-square shrink-0 flex flex-col self-stretch" data-inspect-id="prematch-dpi-hud-card">
          {/* mb-2 min-h-8 matches Map Voting's/Hero Advisor's header row
              exactly (both use the same two classes) so this card's title
              sits at the same vertical position and the row below it starts
              from the same 40px offset their search-input/select rows do —
              see the mt-2.5 comment below for how that offset is spent. */}
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
            // Fixed h-[23px] + mb-1 makes this row's total height/margin
            // (27px) match the <select> branch above pixel-for-pixel (its
            // ~23px field height + mb-1), so the odometer grid below starts
            // from the same offset regardless of which of the two branches
            // rendered — needed so the grid's bottom edge (aligned to Map
            // Voting's best-maps list, see mt-2.5 comment below) doesn't
            // shift depending on how many DPI tests are active.
            <div className="h-[23px] flex items-center mb-1">
              <span className="text-[10px] hero-name text-[var(--faint-2)] truncate">{bt!.hero ?? 'ad-hoc'}</span>
            </div>
          )}
          {bt ? (
            // Two-point alignment with the Map Voting card's idle best-maps
            // list (both cards share the same ~178.88px content budget):
            // top of the hero-picker select == top of Map Voting's search
            // box (both at 40px from content top: a 32px min-h-8 header row
            // + 8px margin, identical classes on both cards' header rows),
            // and bottom of this odometer group == bottom of Map Voting's
            // 3-row best-maps list (both land at ~177px). Header(40) +
            // select-or-name-line block(27, see branch above) = 67px used
            // before this grid; mt-2.5 (10px) + the grid's own 3-row content
            // (~100px at size=32/gap-y-0.5) lands its bottom at ~177px,
            // matching Map Voting's list bottom. Odometers stay at 32 (down
            // from the original 46 default) — shrinking further to buy more
            // offset would make them hard to read, so this is as close as
            // the two cards' differing internal content gets without that
            // tradeoff.
            <div className="flex-1 grid grid-cols-[auto_auto] items-center gap-x-3 gap-y-0.5 content-start mt-2.5">
              <Odometer value={btTestLeft} size={32} dataInspectId="prematch-dpi-matches-left-odometer" />
              <div className="leading-tight">
                {/* text-[10px] uppercase tracking-wider text-[var(--muted)]
                    matches Hero Advisor's stat-tile labels (Today/Streak/
                    This hour, prematch-today-stat-tile etc.) exactly, so
                    this card's counter names read with the same caps
                    treatment as the app's other small stat labels. */}
                <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">matches left</div>
                <div className="text-[10px] text-[var(--faint-2)]">in this test</div>
              </div>
              <Odometer value={btGamesLeft} size={32} dataInspectId="prematch-dpi-games-left-odometer" />
              <div className="leading-tight">
                <div className="text-[10px] uppercase tracking-wider text-[var(--muted)]">games left</div>
                <div className="text-[10px] text-[var(--faint-2)]">in stage <b className="font-bold">{bt.cur_stage}</b></div>
              </div>
              {/* Backlog counter shares this grid's column tracks (rather than
                  being its own grid) so its drum is guaranteed to land in the
                  same x position as the two above — a separate grid re-centers
                  independently and drifts whenever the label text width differs. */}
              <Odometer value={backlogCount} size={32} dataInspectId="prematch-backlog-odometer" />
              <div className="leading-tight">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">backlog</span>
                  {/* Opens the Sens page at the top, like any other arrival. */}
                  <Link
                    to="/sens"
                    className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-lg bg-gradient-to-r from-ow-accent to-ow-accentLight text-white shadow-md shadow-ow-accent/30 hover:brightness-110 active:brightness-95 transition-all whitespace-nowrap"
                    data-inspect-id="prematch-backlog-go-link"
                  >
                    Go →
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 grid justify-items-center content-start text-center px-2" data-inspect-id="prematch-dpi-idle-banner">
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
                  <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">backlog</span>
                  <Link
                    to="/sens"
                    className="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-lg bg-gradient-to-r from-ow-accent to-ow-accentLight text-white shadow-md shadow-ow-accent/30 hover:brightness-110 active:brightness-95 transition-all whitespace-nowrap"
                    data-inspect-id="prematch-backlog-go-link"
                  >
                    Go →
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Map Voting */}
        <div className="card flex-1 min-w-0 flex flex-col overflow-hidden" data-inspect-id="prematch-map-voting-card">
          {/* Role Pick used to sit on the right of this row. It moved to the
              page-level identity strip on 2026-09-19 — four things read it,
              not just this card's recommendation, and it has to stay on
              screen in Quickplay. */}
          <div className="flex items-center justify-between mb-2 min-h-8">
            <div className="flex items-center gap-2">
              <h2 className="text-sm card-title whitespace-nowrap">Map Voting</h2>
              <span className="text-xs text-[var(--faint)] bg-ow-border/50 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">tap up to 3</span>
            </div>
          </div>

          {/* Search input */}
          <div className="relative mb-2">
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
                    className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-white/5 transition-colors text-left"
                  >
                    <span className="map-name text-[var(--ink)]">{withMapCount(m, mapCounts)}</span>
                    <span className={`pill ${TYPE_COLORS[MAPS[m]] ?? ''}`}>{MAPS[m]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Everything below the pinned search input — content here must
              stay compact enough to fit the row's fixed height on its own;
              cards never scroll internally, so overflow is fixed by
              shrinking content, not by adding a scroll region. flex-col so
              the Vote-for block below can pin itself to the bottom edge
              with mt-auto instead of sitting right under the chips. */}
          <div className="flex-1 min-h-0 flex flex-col">

          {/* Idle: best & worst maps by win rate — tap one to add it to your
              picks (which swaps this block for the chips + vote below). */}
          {selected.length === 0 && rankedMaps.length > 0 && (
            <div className="flex-1 grid grid-cols-2 gap-x-4 content-start mt-4" data-inspect-id="prematch-best-worst-maps-list">
              {([
                { label: 'Best maps', color: 'text-emerald-600', pct: 'text-emerald-500', list: bestMaps },
                { label: 'Worst maps', color: 'text-red-500', pct: 'text-red-500', list: worstMaps },
              ] as const).map(col => (
                <div key={col.label}>
                  <div className={`text-[9px] uppercase tracking-wider mb-1 ${col.color}`}>{col.label}</div>
                  {col.list.map(m => (
                    <button
                      key={m.map}
                      onClick={() => selectMap(m.map)}
                      className="flex items-center justify-between w-full text-left py-0.5 px-1 -mx-1 rounded hover:bg-white/5 transition-colors group"
                    >
                      <span className="text-xs map-name text-[var(--ink)] truncate group-hover:text-ow-accent transition-colors">{withMapCount(m.map, mapCounts)}</span>
                      <span className={`text-[10px] font-bold shrink-0 ml-2 ${col.pct}`}>{Math.round(m.recent_rate!)}%</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}

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
            <div className="flex items-start gap-2" data-inspect-id="prematch-selected-map-chips">
              {selected.map(m => (
                <div key={m} className="flex-1 min-w-0 flex flex-col gap-1">
                <span
                  className={`w-full min-w-0 flex items-center justify-center gap-1 pl-2 pr-1 py-1 text-[10px] map-name transition-colors ${
                    m === recommended
                      ? 'bg-emerald-500/20 text-emerald-700'
                      : 'bg-ow-accent/15 text-ow-accent'
                  }`}
                  style={{ clipPath: 'polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)' }}
                >
                  <button
                    onClick={() => setMap(m)}
                    className="flex items-center gap-1 min-w-0 hover:opacity-80 transition-opacity"
                    title={`Set ${m} as the match map`}
                  >
                    {m === recommended && <span className="shrink-0 normal-case">✓</span>}
                    <span className="truncate">{withMapCount(m, mapCounts)}</span>
                  </button>
                  <button
                    onClick={() => toggleMap(m)}
                    className="flex items-center justify-center w-4 h-4 shrink-0 rounded-full text-xs font-bold leading-none hover:bg-black/10 hover:text-red-600 transition-colors"
                    title={`Remove ${m}`}
                  >
                    ×
                  </button>
                </span>
                {/* Last 5 matches on this map (byMap from
                    /api/matches/map-history?maps=) — same win/loss-colored dash
                    treatment as the map history strip on Today's Matches rows,
                    newest leftmost with the oldest dash faded. Sized to the
                    chip's own column so it tracks the pill above it. */}
                <div className="flex items-center gap-1 px-0.5" data-inspect-id="prematch-selected-map-chip-history">
                  {(() => {
                    const hist = [...(mapHistory?.byMap?.[m] ?? [])].reverse();
                    return hist.map((h, i) => (
                      <span
                        key={i}
                        style={i === hist.length - 1 ? OLDEST_DASH_FADE_STYLE : undefined}
                        className={`flex-1 h-[3px] rounded-full ${h.win ? 'bg-emerald-500' : 'bg-red-500'}`}
                        title={`${h.win ? 'Win' : 'Loss'} · ${MODE_COMPACT[h.queue_mode]?.top ?? h.queue_mode} ${MODE_COMPACT[h.queue_mode]?.bot ?? ''}`.trim()}
                      />
                    ));
                  })()}
                </div>
                </div>
              ))}
              <button
                onClick={() => { setSelected([]); advisorSelectRef.current?.focus(); }}
                className="flex-1 min-w-0 flex items-center justify-center px-2 py-1 text-[10px] font-medium bg-ow-border/40 text-[var(--ink-2)] hover:bg-ow-border/70 hover:text-[var(--ink)] transition-colors"
                style={{ clipPath: 'polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)' }}
                data-inspect-id="prematch-map-voting-clear-button"
              >
                Clear
              </button>
            </div>
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
            <div className="mt-auto pt-1">
              {testPick?.available && testPick.picks.length > 0 ? (
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <button onClick={() => setMap(testPick.picks[0].map)} className="text-lg map-name text-emerald-600 hover:text-emerald-700 transition-colors text-left" data-inspect-id="prematch-vote-for-button">
                        {withMapCount(testPick.picks[0].map, mapCounts)}
                      </button>
                      <span className={`pill ${ROLE_COLORS[testRole]}`}>{testRole}</span>
                    </div>
                    <div className="text-xs text-[var(--faint)]">
                      <span className="hero-name">{testPick.picks[0].hero}</span> · <b className="font-bold text-emerald-500">{testPick.picks[0].win_rate}</b>%
                      {testPick.picks[0].sample_size === 'thin' && <span className="text-amber-500"> · thin</span>}
                      {' · '}<b className="font-bold">{testPick.picks[0].games}</b>g played
                    </div>
                  </div>
                  <div className="text-right space-y-0.5 pt-0.5">
                    {testPick.picks.slice(1).map(p => (
                      <div key={`${p.map}|${p.hero}`} className="text-[10px] text-[var(--faint)]">
                        <span className="map-name">{withMapCount(p.map, mapCounts)}</span> · <span className="hero-name">{p.hero}</span> · <b className="font-bold">{p.win_rate}</b>%
                      </div>
                    ))}
                  </div>
                </div>
              ) : ranked.length === 1 ? (
                <div className="text-sm text-[var(--muted)]">Select more maps to compare.</div>
              ) : (
                <div className="flex items-start gap-4">
                  <div className="flex-1">
                    <button onClick={() => openMap(winner)} className="text-lg map-name text-emerald-600 hover:text-emerald-700 transition-colors text-left" data-inspect-id="prematch-vote-for-button">
                      {withMapCount(winner, mapCounts)}
                    </button>
                    {scoreMap[winner] && (
                      <div className="text-xs text-[var(--faint)]">
                        <b className="font-bold">{scoreMap[winner].blended_score}</b>% blended · <b className="font-bold">{scoreMap[winner].total_games}</b>g played
                      </div>
                    )}
                  </div>
                  <div className="text-right space-y-0.5 pt-0.5">
                    {ranked.slice(1).map(m => (
                      <div key={m} className="text-[10px] text-[var(--faint)]">
                        <span className="map-name">{withMapCount(m, mapCounts)}</span>{scoreMap[m] ? <> · <b className="font-bold">{scoreMap[m].blended_score}</b>%</> : ' · no data'}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          </div>
        </div>

        {/* Hero Advisor — Map selector */}
        <div className="card flex-1 min-w-0 flex flex-col overflow-hidden" data-inspect-id="prematch-hero-advisor-card">
          <div className="flex items-center justify-between mb-2 min-h-8">
            <div className="flex items-center gap-2">
              <h2 className="text-sm card-title whitespace-nowrap">Hero Advisor</h2>
              <span className="text-xs text-[var(--faint)] bg-ow-border/50 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">pick a map</span>
            </div>
            {/* Today's matches as win/loss dots, most recent left, oldest
                right. Moved here 2026-09-24 — first tried on the "Playing
                as" strip, then Lobby Rank, which is Competitive-only. This
                card shows in every mode. Same `today` query as the session
                snapshot, so "today" means one thing on this page. No
                scrolling: rows hold 10 dots each, so game 11 starts a
                second row, and past 20 the dots shrink (no-scroll-in-cards
                rule). */}
            <div className="min-w-0 flex items-center gap-2" data-inspect-id="prematch-today-dots-strip">
              <span className="text-[10px] uppercase tracking-wider text-[var(--faint-2)] shrink-0">Today</span>
              {todayRows.length === 0 ? (
                <span className="text-[10px] text-[var(--faint-2)] whitespace-nowrap">no games yet</span>
              ) : (
                <div
                  className="grid items-center gap-1 min-w-0"
                  style={{ gridTemplateColumns: `repeat(${Math.min(todayRows.length, 10)}, auto)` }}
                >
                  {todayRows.map((r, i) => (
                    <span
                      key={i}
                      data-inspect-id="prematch-today-dot"
                      title={`${r.win ? 'Win' : 'Loss'} — ${r.hero} on ${r.map}`}
                      aria-label={`${r.win ? 'Win' : 'Loss'}, ${r.hero} on ${r.map}`}
                      className={`inline-block rounded-full shrink-0 ${
                        todayRows.length > 40 ? 'w-1 h-1' : todayRows.length > 20 ? 'w-1.5 h-1.5' : 'w-2 h-2'
                      } ${r.win ? 'bg-emerald-500' : 'bg-rose-500'}`}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="mb-2">
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

          {/* Everything below the pinned map selector — same treatment as
              Map Voting: no scroll region, content must fit the row's
              fixed height through compression alone. */}
          <div className="flex-1 min-h-0">

          {/* Idle: session & timing snapshot — how you're doing right now.
              The panel is deliberately roomier than its content strictly
              needs: with no map picked yet this card would otherwise be
              mostly dead space next to Sens Test / Map Voting's packed
              lists, so the stat tiles get real card treatment (bordered
              panel, generous padding, bigger numerals) instead of just
              floating in the middle of the card. */}
          {!map && (
            <div className="flex-1 flex flex-col justify-center mt-[0.6604rem] gap-4">
              {/* True 2-row grid (labels row, values row) instead of three
                  independently-centered flex columns — that's what keeps all
                  three labels on one line and all three value blocks on the
                  next, regardless of the This Hour pills' extra padding
                  making that value taller than a plain number. Columns stay
                  content-sized (not stretched to equal width) with
                  justify-evenly, so spacing is even without forcing the three
                  categories to occupy equal space. */}
              <div className="rounded-lg border border-ow-border/40 bg-gradient-to-br from-ow-accent/[0.06] via-ow-accent/[0.02] to-transparent grid grid-cols-[repeat(3,max-content)] justify-evenly items-center gap-x-2 pt-4 pb-6">
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
                          className={`text-[27px] num-display leading-none rounded-lg px-1 py-2 ${hourRow.qp_games > 0 ? 'text-blue-500' : 'text-[var(--faint)]'}`}
                        >
                          {hourRow.qp_games > 0 ? `${Math.round(hourRow.qp_win_rate!)}%` : '—'}
                        </span>
                        <span className="absolute top-full inset-x-0 -mt-0.5 text-center text-[7px] uppercase tracking-wider text-[var(--faint)] whitespace-nowrap">Quickplay</span>
                      </div>
                      <span className="text-[27px] num-display leading-none text-[var(--faint-2)] -mx-0.5">/</span>
                      <div className="relative">
                        <span
                          className={`text-[27px] num-display leading-none rounded-lg px-1 py-2 ${hourRow.comp_games > 0 ? 'text-red-500' : 'text-[var(--faint)]'}`}
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
            </div>
          )}
          </div>
        </div>

      </div>

      {/* Consolidated advisor — recommendation + coaching + your heroes in one
          card below the row. When a map is picked these three used to repeat the
          same "what to play" answer across separate cards; here they read as one
          flow: the pick, the coaching behind it, then the full breakdown. */}
      <div id="consolidated-advisor" className="card" data-inspect-id="prematch-consolidated-advisor-card">
        <div className="flex items-start justify-between gap-3 mb-1">
          <div>
            <h2 className="text-sm card-title">
              {map ? (
                <>Your Heroes on <button onClick={() => openMap(map)} className="text-ow-accent hover:text-ow-accent/80 transition-colors" data-inspect-id="prematch-your-heroes-map-link">{withMapCount(map, mapCounts)}</button></>
              ) : 'Your Best Heroes Overall'}
            </h2>
            <p className="text-xs text-[var(--faint)] mt-0.5">By role · min 2 games · tap hero to pre-fill log</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {/* Next test — the sens-study round-robin recommender (GET
                /api/blind/next, lib/nextTest.ts). Gated on the sens-study
                category since it has nothing to say when that data isn't being
                collected. Sits top-right of the advisor header, opposite
                "Your Best Heroes". */}
            {sensStudyOn && nextTest && (
              <div className="shrink-0 max-w-[16rem] text-right" data-inspect-id="prematch-next-test-card">
                <h3 className="text-sm card-title mb-1">Next test</h3>
                {nextTest.isQuickplay ? (
                  <p className="text-xs text-[var(--faint)]" data-inspect-id="prematch-next-test-qp">
                    Quickplay doesn't count toward testing — queue Competitive
                  </p>
                ) : nextTest.allFinished ? (
                  <p className="text-xs text-[var(--faint)]" data-inspect-id="prematch-next-test-finished">
                    Every hero in this phase is done — next phase needs creating on the Sens page.
                  </p>
                ) : nextTest.stint ? (
                  <p className="text-xs text-[var(--ink)]" data-inspect-id="prematch-next-test-stint">
                    Stay on <b className="hero-name">{nextTest.stint.hero}</b> — {nextTest.stint.position} of {nextTest.stint.length} this stint
                    <span className="text-[var(--faint-2)]"> · queue {nextTest.stint.role}</span>
                  </p>
                ) : (
                  <div data-inspect-id="prematch-next-test-list">
                    <p className="text-xs text-[var(--ink)] mb-1.5">
                      Queue <b>{nextTest.recommendedRole}</b> → {nextTest.orderedHeroes?.map(h => h.hero).join(', ')}
                    </p>
                    <div className="flex flex-col gap-0.5">
                      {nextTest.orderedHeroes?.map(h => (
                        <div key={h.hero} className="flex items-center justify-end gap-1.5 text-[11px] text-[var(--faint-2)]" data-inspect-id="prematch-next-test-hero-row">
                          <span className="hero-name truncate">{h.hero}</span>
                          <span className="num-display">{h.credited}/{h.target}</span>
                          {h.cold && (
                            <span className="text-[9px] font-bold uppercase tracking-wide text-blue-500" title={`${h.daysSinceLastPlayed} days since last played`}>
                              cold
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {!!nextTest.finishedHeroes?.length && !nextTest.allFinished && (
                  <p className="text-[10px] text-[var(--faint-2)] mt-1.5" data-inspect-id="prematch-next-test-done-heroes">
                    Done this phase: {nextTest.finishedHeroes.join(', ')}
                  </p>
                )}
              </div>
            )}
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

        {/* Lobby Rank — captured HERE, at hero select, and not in the Match Log.
            The lobby's rank spread is only readable on the opening scoreboard.
            By the time the match ends and gets logged it is gone, and a guess
            recalled ten minutes later is not an observation. So the reading is
            taken at the start and carried through the match in MatchContext,
            surviving a mid-match reload — and surviving the log as well, since
            the next match is nearly always the same lobby. Adjust it when the
            lobby changes; "clear" empties it.

            Competitive only — quickplay has no rank, so the section is hidden
            rather than sitting empty and inviting a guess. */}
        {queueMode !== 'qp_role' && (
          <div className="mt-4 pt-4 border-t border-ow-border/40" data-inspect-id="prematch-lobby-rank-section">
            <div className="flex items-baseline gap-2 mb-3">
              <h3 className="text-sm card-title" data-inspect-id="prematch-lobby-rank-header">Lobby Rank</h3>
              <span className="text-xs text-[var(--faint-2)]">read it off the scoreboard now</span>
            </div>

            {/* The drum sits in this row, beside the track it defines. Your
                own rank is the origin the lobby range is measured from, so
                the two belong in one place rather than a screen apart. The
                drum keeps its own square width; the track takes the rest and
                is allowed to shrink (min-w-0), so a 21-box row never pushes
                the drum off the card. */}
            <div className="flex items-center gap-4" data-inspect-id="prematch-lobby-rank-row">
              <div className="flex flex-col items-center justify-center gap-1.5 shrink-0" data-inspect-id="prematch-rank-drum">
                <button
                  type="button"
                  onClick={() => stepRank(1)}
                  data-inspect-id="prematch-rank-drum-up"
                  aria-label="Rank up one division"
                  className="w-20 h-6 rounded-md border border-ow-border text-[var(--faint)] hover:text-ow-accent hover:border-ow-accent/60 transition-colors leading-none text-xs"
                >
                  ▲
                </button>
                <RankBadge rank={playerRank} size="lg" dataInspectId="prematch-rank-drum-badge" />
                <button
                  type="button"
                  onClick={() => stepRank(-1)}
                  data-inspect-id="prematch-rank-drum-down"
                  aria-label="Rank down one division"
                  className="w-20 h-6 rounded-md border border-ow-border text-[var(--faint)] hover:text-ow-accent hover:border-ow-accent/60 transition-colors leading-none text-xs"
                >
                  ▼
                </button>
              </div>
              <div className="flex-1 min-w-0">
                {playerRank == null ? (
                  <p className="text-xs text-[var(--faint-2)]" data-inspect-id="prematch-lobby-rank-needs-rank">
                    Set your rank on the drum first — the track is built around it.
                  </p>
                ) : (
                  <LobbyRangeSlider
                    playerRank={playerRank}
                    low={lobbyLow}
                    high={lobbyHigh}
                    width={trayWidth}
                    onChange={setLobbyRange}
                    onRememberWidth={rememberTrayWidth}
                    onResize={resizeTray}
                    onClear={clearLobbyRange}
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {/* Your heroes by role — the full breakdown, and the actual hero-select
            control (tapping a hero pre-fills the Match Log). Styled as its own
            selection panel — bordered, tinted, chip buttons — rather than a
            trailing stats list, so it doesn't get missed after Coaching above it. */}
        <div className="mt-4 pt-4 border-t border-ow-border/40">
        <h3 className="text-sm card-title mb-3" data-inspect-id="prematch-select-your-hero-header">Select Your Hero</h3>
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
                        style={{ '--sel': ROLE_SEL_RGB[role] } as React.CSSProperties}
                        className={`relative flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-lg border cursor-pointer active:scale-[0.98] transition-all group ${isTestHero ? 'test-glow' : ''} ${
                          isClicked
                            ? 'is-selected'
                            : 'border-ow-border bg-ow-darker hover-sel'
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
                            className={`absolute -top-1.5 -left-1.5 w-4 h-4 rounded-full text-white text-[9px] font-bold flex items-center justify-center pointer-events-none z-10 ${ROLE_PILL_CLASS[role]}`}
                            title={`Pick #${clickIndex + 1} this match`}
                            data-inspect-id="prematch-hero-picker-order-badge"
                          >
                            {clickIndex + 1}
                          </span>
                        )}
                        <span className={`text-sm ${h.win_rate >= 50 ? 'text-emerald-700' : 'text-red-500'}`}>{h.win_rate >= 50 ? '↑' : '↓'}</span>
                        <span className={`flex-1 text-xs hero-name transition-colors ${isClicked ? 'lit-text' : 'text-[var(--ink)] group-hover:text-ow-accent'}`}>
                          {isDfHero ? withDfBadge(withHeroCount(h.hero, heroCounts), dfMap, h.hero) : withHeroCount(h.hero, heroCounts)}
                          {sensTag && (
                            <span
                              className={sensTag.settled ? 'text-emerald-700 dark:text-emerald-400' : undefined}
                              title={sensTag.settled
                                ? 'Best sens this hero’s own testing landed on'
                                : 'Sens this test is running at'}
                              data-inspect-id="prematch-hero-picker-sens-tag"
                            >
                              {` @ ${sensTag.value}`}
                            </span>
                          )}
                        </span>
                        {!isDfHero && testGaugeFor(h.hero) != null ? (
                          <span
                            // Chunked gauge bars are 1px wider than w-1 and 1px
                            // further apart than gap-0.5, so the gauge is about
                            // 20px wider overall. ml-[10px] shifts the centered
                            // container right by half of that, so the left edge
                            // stays put and it grows rightward only.
                            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center pointer-events-none ${chunkFor(h.hero) ? 'gap-[3px] ml-[10px]' : 'gap-0.5'}`}
                            // Says games, not bars. It used to print the bar
                            // count with the word "games" beside it — identical
                            // numbers while a stage was 5 games, and off by a
                            // factor of eight once stages became 40.
                            title={chunkFor(h.hero)
                              ? `${chunkFor(h.hero)!.label} · ${chunkFor(h.hero)!.left} left in this chunk`
                              : `${testStageLeftFor(h.hero)?.left ?? 0} of ${testStageLeftFor(h.hero)?.total ?? 0} games left at this sens`}
                            data-inspect-id="prematch-hero-picker-gauge"
                          >
                            {/* Which stage of the set (or, for a chunked ABBA
                                set, which lettered/ordinal CHUNK — "A1".."B4",
                                lib/blind.ts's chunkLabelFor), encircled,
                                immediately left of the gauge. Outlined rather
                                than filled so it cannot be mistaken for the
                                solid pick-order badge at the row's top-left
                                corner — that one is a click position, this one
                                is test progress. Lives inside the gauge's own
                                absolutely-positioned container so the pair
                                stays together at any row width instead of
                                drifting apart. */}
                            {chunkFor(h.hero) ? (
                              <span
                                className="h-4 min-w-[1rem] px-0.5 mr-1 shrink-0 relative right-[1%] rounded-full border border-ow-accent/70 text-[#9A3412] dark:text-ow-accent text-[9px] font-bold flex items-center justify-center leading-none tabular-nums"
                                title={`Chunk ${chunkFor(h.hero)!.label} — ${chunkFor(h.hero)!.left} left`}
                                data-inspect-id="prematch-hero-picker-stage-badge"
                              >
                                {chunkFor(h.hero)!.label}
                              </span>
                            ) : testStageFor(h.hero) && (
                              <span
                                className="w-4 h-4 mr-1 shrink-0 relative right-[1%] rounded-full border border-ow-accent/70 text-[#9A3412] dark:text-ow-accent text-[9px] font-bold flex items-center justify-center leading-none tabular-nums"
                                title={`Stage ${testStageFor(h.hero)!.cur} of ${testStageFor(h.hero)!.total}`}
                                data-inspect-id="prematch-hero-picker-stage-badge"
                              >
                                {testStageFor(h.hero)!.cur}
                              </span>
                            )}
                            {chunkFor(h.hero) ? (
                              // Gauge counts down the CURRENT chunk, not the
                              // whole 40-match stage: one bar per match
                              // (chunk_size bars), lit bars = matches left.
                              // Narrower bars than the stage gauge so ten
                              // still fit the row. A subtle tick (a left
                              // border on the bar past the midpoint) marks
                              // the halfway point of every chunk.
                              Array.from({ length: chunkFor(h.hero)!.chunk_size }).map((_, i) => {
                                const c = chunkFor(h.hero)!;
                                return (
                                  <span
                                    key={i}
                                    style={i < c.left ? { backgroundColor: batteryColor(c.left / c.chunk_size) } : undefined}
                                    className={`w-[5px] h-3 -skew-x-[20deg] ${i < c.left ? '' : 'bg-gray-400/50'} ${i === c.chunk_size / 2 ? 'border-l border-dashed border-gray-600/50 dark:border-gray-300/40' : ''}`}
                                  />
                                );
                              })
                            ) : (
                              Array.from({ length: GAUGE_SEGMENTS }).map((_, i) => (
                                <span
                                  key={i}
                                  style={i < testGaugeFor(h.hero)! ? { backgroundColor: batteryColor(testGaugeFor(h.hero)! / GAUGE_SEGMENTS) } : undefined}
                                  className={`w-1.5 h-3 -skew-x-[20deg] ${i < testGaugeFor(h.hero)! ? '' : 'bg-gray-400/50'}`}
                                />
                              ))
                            )}
                          </span>
                        ) : !isDfHero && doneThisPhase.has(h.hero) && (
                          // No active test right now, but this hero belongs to the
                          // current phase's roster and has already finished it —
                          // shown so Sean can see the whole phase at a glance,
                          // not just whichever hero is still running.
                          <span
                            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-800 dark:text-emerald-600 pointer-events-none whitespace-nowrap"
                            title="Already tested this phase"
                            data-inspect-id="prematch-hero-picker-done-badge"
                          >
                            ✓ Done
                          </span>
                        )}
                        {/* Fixed width + right-aligned so the win rate can't
                            change the column's width — "0%" and "100%" occupy
                            the same box, so the row's layout doesn't slide
                            from row to row. */}
                        <span className={`shrink-0 w-11 text-right text-sm font-bold ${h.win_rate >= 60 ? 'text-emerald-600' : h.win_rate >= 50 ? 'text-ow-blue' : h.win_rate >= 40 ? 'text-yellow-400' : 'text-red-600'}`}>{h.win_rate}%</span>
                        <span className="text-xs text-[var(--faint-2)] w-7 text-right font-bold">{h.games}g</span>
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
      </div>
    </div>
  );
}

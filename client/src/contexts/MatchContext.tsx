import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { MAPS, QUEUE_MODES, QueueMode, Recommendation, MatchDeathEntry, RANK_MIN, RANK_MAX, clampRank } from '../types';

// Coaching always shows a DPS and a Support column side by side — the advisor
// endpoint returns one recommendation per role (either can be null if that
// role has no in-testing hero with enough games).
export type AdvisorByRole = Record<'DPS' | 'Support', Recommendation | null>;

const QUEUE_MODE_KEY = 'ow-last-queue-mode';
// Role Pick's chosen role — lifted here (from a Prematch-local state) so both
// Prematch (the toggle + recommendation) and Log Match (the hero-dropdown
// role filter) read the same value instead of drifting independently.
const TEST_ROLE_KEY = 'ow-test-role';
// Last sensitivity used, carried across matches so it only changes when Sean
// deliberately changes it (the crux of the sens study). Shared here because the
// input lives in the Pre-Match row while the log form reads it on submit.
const SENS_KEY = 'ow-last-sens';
// Bumped to v4 (2026-09-09) when the buffer entry shape changed from the old
// axis-judgment {axis, value} to the new fact-only {killer, killer_role,
// ult} — a stale v-axis buffer sitting in localStorage from before this
// change would otherwise load malformed entries into the new capture UI.
const DEATH_BUFFER_KEY = 'ow-death-buffer-v4';

// Competitive rank. Sean's own rank changes only when he ranks up, so it
// persists like sens does. The LOBBY range is different: it is a reading taken
// off the scoreboard at the start of one specific match, and it is only
// visible there — by the time the match ends and gets logged, the scoreboard
// is gone. So it is captured in Pre-Match and has to survive the match itself,
// including a page reload mid-game, which is why it lives in localStorage and
// not in component state. It clears the moment the match is logged.
const RANK_KEY = 'ow-player-rank';
const LOBBY_KEY = 'ow-lobby-range';

// The shared "current match" intent for the single-page Dashboard: one queue
// mode, one selected map, one advisor recommendation, consumed by both the
// Pre-Match and Log Match sections. `pendingHeroes` lets the Pre-Match hero
// picker pre-fill the Log Match form's hero slots (in click order) without a
// page navigation — index 0 is the starting hero, 1/2 are mid-match switches,
// mirroring Log Match's own form.hero + switchHeroes[2] shape exactly (was a
// single `pendingHero: string | null` before Select Your Hero supported
// ordered multi-hero picks).
interface MatchContextValue {
  queueMode: QueueMode;
  setQueueMode: (q: QueueMode) => void;
  map: string;
  setMap: (m: string) => void;
  mapType: string;
  // In-game sensitivity for the next logged match (kept as the raw input string).
  sens: string;
  setSens: (s: string) => void;
  // Role Pick's chosen role (DPS/Support) — set in Prematch's Role Pick
  // toggle, read there for the map+hero recommendation and in Log Match to
  // scope the hero dropdowns to heroes being tested in that role.
  testRole: 'DPS' | 'Support';
  setTestRole: (r: 'DPS' | 'Support') => void;
  // Competitive rank, on the 1-45 division ladder (see RANK_TIERS in types).
  // Entered in Pre-Match before the match starts, read by Log Match on submit.
  // Same shape as sens: the input and the consumer are in different sections.
  playerRank: number | null;
  setPlayerRank: (r: number | null) => void;
  lobbyLow: number | null;
  lobbyHigh: number | null;
  /** Set both ends at once — what the lobby range slider writes. */
  setLobbyRange: (low: number, high: number) => void;
  /** Fill both ends at +/-n around Sean's own rank. */
  applyLobbySpread: (n: number) => void;
  /** Move one end by d divisions, never past the other end. */
  nudgeLobby: (end: 'low' | 'high', d: number) => void;
  clearLobbyRange: () => void;
  rec: AdvisorByRole | null;
  recLoading: boolean;
  recError: string | null;
  refreshRec: () => void;
  // Re-fetch the advisor without forcing an LLM regen (cheap) — used after a
  // match is logged so the death-axis breakdown reflects the new data.
  revalidateRec: () => void;
  pendingHeroes: string[] | null;
  setPendingHeroes: (h: string[] | null) => void;
  // Bumped each time a match is logged, so sections can reset (e.g. Map Voting).
  matchLoggedSignal: number;
  // The most recent logged result, used to play the win/loss flash on the
  // matching mode tile. `seq` rises each log so a repeat result re-triggers.
  lastLog: { mode: QueueMode; win: boolean; seq: number } | null;
  notifyMatchLogged: (info?: { mode: QueueMode; win: boolean }) => void;
  // In-match death buffer: accumulated via the DeathLogger inside LogMatch's
  // Deaths card during a match (one tap = one death, fact-only), then flushed
  // to the match record on submit.
  deathBuffer: MatchDeathEntry[];
  addDeathToBuffer: (r: MatchDeathEntry) => void;
  removeDeathFromBuffer: (i: number) => void;
  // Flips a buffered death's ult flag after the fact — the ⚡ toggle is
  // deliberately not part of the tap-to-log path (see DeathLogger.tsx).
  toggleDeathUlt: (i: number) => void;
  clearDeathBuffer: () => void;
}

const MatchContext = createContext<MatchContextValue | null>(null);

export function MatchProvider({ children }: { children: ReactNode }) {
  const [queueMode, setQueueMode] = useState<QueueMode>(() => {
    const saved = localStorage.getItem(QUEUE_MODE_KEY) as QueueMode | null;
    return saved && QUEUE_MODES.some(q => q.value === saved) ? saved : 'comp_role';
  });
  useEffect(() => {
    localStorage.setItem(QUEUE_MODE_KEY, queueMode);
  }, [queueMode]);

  const [map, setMap] = useState('');
  const [sens, setSens] = useState<string>(() => {
    try { return localStorage.getItem(SENS_KEY) ?? '2.5'; } catch { return '2.5'; }
  });
  useEffect(() => { if (sens) localStorage.setItem(SENS_KEY, sens); }, [sens]);
  const [testRole, setTestRole] = useState<'DPS' | 'Support'>(() => {
    try { return localStorage.getItem(TEST_ROLE_KEY) === 'Support' ? 'Support' : 'DPS'; } catch { return 'DPS'; }
  });
  useEffect(() => {
    try { localStorage.setItem(TEST_ROLE_KEY, testRole); } catch { /* ignore */ }
  }, [testRole]);
  const [playerRank, setPlayerRankState] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(RANK_KEY));
      return v >= RANK_MIN && v <= RANK_MAX ? v : null;
    } catch { return null; }
  });
  const setPlayerRank = useCallback((r: number | null) => {
    setPlayerRankState(r);
    try {
      if (r == null) localStorage.removeItem(RANK_KEY);
      else localStorage.setItem(RANK_KEY, String(r));
    } catch { /* ignore */ }
  }, []);

  const [lobbyRange, setLobbyRange] = useState<{ low: number; high: number } | null>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(LOBBY_KEY) ?? 'null');
      if (raw && typeof raw.low === 'number' && typeof raw.high === 'number') return raw;
      return null;
    } catch { return null; }
  });
  // Persisted the same way sens is — an effect on the value, not a write
  // buried inside a setState updater. React calls updaters twice in dev, so a
  // write in there runs twice for every one real change.
  useEffect(() => {
    try {
      if (lobbyRange == null) localStorage.removeItem(LOBBY_KEY);
      else localStorage.setItem(LOBBY_KEY, JSON.stringify(lobbyRange));
    } catch { /* ignore */ }
  }, [lobbyRange]);

  const applyLobbySpread = useCallback((n: number) => {
    if (playerRank == null) return;
    setLobbyRange({ low: clampRank(playerRank - n), high: clampRank(playerRank + n) });
  }, [playerRank]);

  // An end never crosses the other end: the floor can rise only to the
  // ceiling, and the ceiling can fall only to the floor.
  const nudgeLobby = useCallback((end: 'low' | 'high', d: number) => {
    setLobbyRange(cur => {
      if (!cur) return cur;
      return end === 'low'
        ? { ...cur, low: Math.min(clampRank(cur.low + d), cur.high) }
        : { ...cur, high: Math.max(clampRank(cur.high + d), cur.low) };
    });
  }, []);

  const clearLobbyRange = useCallback(() => setLobbyRange(null), []);

  const setLobbyRangeValues = useCallback((low: number, high: number) => {
    setLobbyRange({ low: clampRank(Math.min(low, high)), high: clampRank(Math.max(low, high)) });
  }, []);

  const [pendingHeroes, setPendingHeroes] = useState<string[] | null>(null);
  const [matchLoggedSignal, setMatchLoggedSignal] = useState(0);
  const [lastLog, setLastLog] = useState<{ mode: QueueMode; win: boolean; seq: number } | null>(null);

  const [deathBuffer, setDeathBuffer] = useState<MatchDeathEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem(DEATH_BUFFER_KEY) ?? '[]'); } catch { return []; }
  });

  const addDeathToBuffer = useCallback((r: MatchDeathEntry) => {
    setDeathBuffer(prev => {
      const updated = [...prev, r];
      localStorage.setItem(DEATH_BUFFER_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const removeDeathFromBuffer = useCallback((i: number) => {
    setDeathBuffer(prev => {
      const updated = prev.filter((_, j) => j !== i);
      localStorage.setItem(DEATH_BUFFER_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const toggleDeathUlt = useCallback((i: number) => {
    setDeathBuffer(prev => {
      const updated = prev.map((d, j) => (j === i ? { ...d, ult: !d.ult } : d));
      localStorage.setItem(DEATH_BUFFER_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const clearDeathBuffer = useCallback(() => {
    setDeathBuffer([]);
    localStorage.removeItem(DEATH_BUFFER_KEY);
  }, []);

  const [rec, setRec] = useState<AdvisorByRole | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);

  const fetchRec = useCallback(async (refresh: boolean) => {
    if (!map) { setRec(null); setRecError(null); return; }
    setRecLoading(true);
    setRecError(null);
    try {
      const url = `/api/advisor/recommend?map=${encodeURIComponent(map)}&queue_mode=${queueMode}${refresh ? '&refresh=1' : ''}`;
      const res = await fetch(url);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setRec(body);
    } catch (e: any) {
      setRecError(e.message ?? 'Failed to fetch');
      setRec(null);
    } finally {
      setRecLoading(false);
    }
  }, [map, queueMode]);

  // Refetch whenever the map or queue mode changes.
  useEffect(() => { fetchRec(false); }, [fetchRec]);

  return (
    <MatchContext.Provider value={{
      queueMode, setQueueMode,
      map, setMap,
      sens, setSens,
      testRole, setTestRole,
      mapType: map ? MAPS[map] : '',
      rec, recLoading, recError,
      refreshRec: () => fetchRec(true),
      revalidateRec: () => fetchRec(false),
      playerRank, setPlayerRank,
      lobbyLow: lobbyRange?.low ?? null,
      lobbyHigh: lobbyRange?.high ?? null,
      setLobbyRange: setLobbyRangeValues, applyLobbySpread, nudgeLobby, clearLobbyRange,
      pendingHeroes, setPendingHeroes,
      matchLoggedSignal,
      lastLog,
      deathBuffer, addDeathToBuffer, removeDeathFromBuffer, toggleDeathUlt, clearDeathBuffer,
      notifyMatchLogged: (info) => {
        setMatchLoggedSignal(s => s + 1);
        if (info) setLastLog(prev => ({ mode: info.mode, win: info.win, seq: (prev?.seq ?? 0) + 1 }));
      },
    }}>
      {children}
    </MatchContext.Provider>
  );
}

export function useMatch() {
  const ctx = useContext(MatchContext);
  if (!ctx) throw new Error('useMatch must be used within MatchProvider');
  return ctx;
}

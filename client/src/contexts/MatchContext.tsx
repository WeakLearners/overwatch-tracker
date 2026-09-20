import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { MAPS, QUEUE_MODES, QueueMode, Recommendation, MatchDeathEntry, RANK_MIN, RANK_MAX, clampRank, Account, ACCOUNTS, DEFAULT_ACCOUNT, isAccount } from '../types';

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
// not in component state.
//
// It also survives the log. The bar used to be wiped on submit, on Reset and
// on Match Cancelled, which meant re-placing it from scratch before every
// game. Consecutive matches are nearly always the same lobby, so that was
// re-entering an unchanged reading. It now holds until Sean moves it or
// presses the slider's own "clear".
//
// Both are stored PER ACCOUNT. Sean plays four, each sitting at its own rank,
// so one shared value would follow him onto an account it does not describe —
// and the lobby track is drawn around whatever rank is current, so a wrong
// rank quietly produces a wrong track. The legacy single-key values are
// adopted once, by the default account, so nothing is lost on first load.
const RANK_KEY = 'ow-player-rank';
const LOBBY_KEY = 'ow-lobby-range';
const ACCOUNT_KEY = 'ow-account';

// Rank is keyed by account AND role — eight slots, not four. Overwatch ranks
// each role separately, so "Sean's rank" is not a thing that exists; only
// "Linx's support rank" is. The lobby range follows the same key because a
// lobby is something you are in on one account in one role, and the track it
// sits on is drawn around that pairing's rank.
type RankRole = 'DPS' | 'Support';
// The two ladders Sean actually plays. Listed so the one-time seed below can
// walk every account/role slot the browser might still be holding a rank for.
const RANK_ROLES: readonly RankRole[] = ['DPS', 'Support'];
const rankKeyFor = (a: Account, r: RankRole) => `${RANK_KEY}:${a}:${r}`;
const lobbyKeyFor = (a: Account, r: RankRole) => `${LOBBY_KEY}:${a}:${r}`;

// The rank the LAST logged match on this ladder ended at. It becomes the next
// match's player_rank_start, so a row can say "went in at Gold 1, came out at
// Gold 2" on its own instead of the chart inferring it by comparing two rows.
// Per account+role, same as the rank drum, because each ladder moves alone.
const RANK_AT_LAST_LOG_KEY = 'ow-rank-at-last-log';
const rankAtLastLogKeyFor = (a: Account, r: RankRole) => `${RANK_AT_LAST_LOG_KEY}:${a}:${r}`;

// One-time move of everything that came before the per-role split. The value
// stored back when there was a single rank is Linx's support rank — Sean said
// so directly on 2026-09-19 — so it is written there rather than to whichever
// slot happens to be selected first. Runs once and leaves a marker; without
// the marker it would re-run after Sean legitimately cleared that slot and
// silently put the old rank back.
const MIGRATED_KEY = 'ow-rank-migrated-to-role-slots';
function migrateLegacyRank() {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    const legacyRank =
      localStorage.getItem(`${RANK_KEY}:Linx`) ?? localStorage.getItem(RANK_KEY);
    const legacyLobby =
      localStorage.getItem(`${LOBBY_KEY}:Linx`) ?? localStorage.getItem(LOBBY_KEY);
    if (legacyRank && !localStorage.getItem(rankKeyFor('Linx', 'Support'))) {
      localStorage.setItem(rankKeyFor('Linx', 'Support'), legacyRank);
    }
    if (legacyLobby && !localStorage.getItem(lobbyKeyFor('Linx', 'Support'))) {
      localStorage.setItem(lobbyKeyFor('Linx', 'Support'), legacyLobby);
    }
    localStorage.setItem(MIGRATED_KEY, '1');
  } catch { /* ignore */ }
}
migrateLegacyRank();

function readRankAtLastLog(a: Account, r: RankRole): number | null {
  try {
    const v = Number(localStorage.getItem(rankAtLastLogKeyFor(a, r)));
    if (v >= RANK_MIN && v <= RANK_MAX) return v;
    // No entry yet. This key is newer than the rank drum, so on every ladder
    // Sean has already been playing it is simply missing, and reading null
    // would make the next match record no starting rank — the one match he
    // wants marked. The drum is where the ladder stands right now, which is
    // exactly where the next match starts, so fall back to it. Only ever a
    // read: the key gets written for real when a match is logged.
    return readRank(a, r);
  } catch { return null; }
}

function readRank(a: Account, r: RankRole): number | null {
  try {
    const v = Number(localStorage.getItem(rankKeyFor(a, r)));
    return v >= RANK_MIN && v <= RANK_MAX ? v : null;
  } catch { return null; }
}
function readLobby(a: Account, r: RankRole): { low: number; high: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(lobbyKeyFor(a, r)) ?? 'null');
    if (v && typeof v.low === 'number' && typeof v.high === 'number') return v;
    return null;
  } catch { return null; }
}

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
  /**
   * Which of Sean's four accounts is in play. Rank and lobby range are stored
   * per account AND per role — eight slots — because Overwatch ranks each role
   * separately. Changing either one reloads the drum and the lobby track.
   */
  account: Account;
  setAccount: (a: Account) => void;
  playerRank: number | null;
  /** Rank the last logged match on this ladder ended at — the next match's start rank. */
  rankAtLastLog: number | null;
  commitRankAtLastLog: (r: number | null) => void;
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
  const [testRole, setTestRoleState] = useState<'DPS' | 'Support'>(() => {
    try { return localStorage.getItem(TEST_ROLE_KEY) === 'Support' ? 'Support' : 'DPS'; } catch { return 'DPS'; }
  });
  useEffect(() => {
    try { localStorage.setItem(TEST_ROLE_KEY, testRole); } catch { /* ignore */ }
  }, [testRole]);
  const [account, setAccountState] = useState<Account>(() => {
    try {
      const v = localStorage.getItem(ACCOUNT_KEY);
      return isAccount(v) ? v : DEFAULT_ACCOUNT;
    } catch { return DEFAULT_ACCOUNT; }
  });

  // Rank is server-backed as of 2026-09-20. Two surfaces now change it — the
  // Pre-Match drum and the log page's promote/demote row — and a value living
  // in one browser's localStorage would give each of them a private copy. The
  // badge would then disagree with the rank being written onto a match.
  //
  // localStorage is still read, but only as a seed: on first load, any slot
  // the server does not know about is pushed up from whatever the browser was
  // holding. It is still written too, so the drum renders instantly on reload
  // instead of flashing empty while the fetch lands.
  const [rankMap, setRankMap] = useState<Record<string, number> | null>(null);
  const rankSlotKey = useCallback((a: Account, r: RankRole) => `${a}|${r}`, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ranks');
        if (!res.ok) return;
        const server: Record<string, number> = await res.json();
        // Seed anything the server has never been told about.
        for (const a of ACCOUNTS) {
          for (const r of RANK_ROLES) {
            const key = `${a}|${r}`;
            if (server[key] != null) continue;
            const local = readRank(a, r);
            if (local == null) continue;
            await fetch('/api/ranks', {
              method: 'PUT', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ account: a, role: r, rank: local }),
            });
            server[key] = local;
          }
        }
        if (!cancelled) setRankMap(server);
      } catch { /* offline: the localStorage mirror below still renders */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const [playerRank, setPlayerRankState] = useState<number | null>(() => readRank(account, testRole));
  // Once the server's map arrives it wins, for the slot currently selected.
  useEffect(() => {
    if (!rankMap) return;
    const v = rankMap[rankSlotKey(account, testRole)];
    setPlayerRankState(v ?? null);
  }, [rankMap, account, testRole, rankSlotKey]);

  const setPlayerRank = useCallback((r: number | null) => {
    setPlayerRankState(r);
    const key = rankSlotKey(account, testRole);
    setRankMap(prev => {
      const next = { ...(prev ?? {}) };
      if (r == null) delete next[key]; else next[key] = r;
      return next;
    });
    // Mirror locally so a reload paints before the fetch returns.
    try {
      if (r == null) localStorage.removeItem(rankKeyFor(account, testRole));
      else localStorage.setItem(rankKeyFor(account, testRole), String(r));
    } catch { /* ignore */ }
    fetch('/api/ranks', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, role: testRole, rank: r }),
    }).catch(() => { /* the local mirror keeps the UI honest until next load */ });
  }, [account, testRole, rankSlotKey]);

  // Where this ladder stood when its last match was logged. Read on mount and
  // on every account/role swap, the same as the drum itself.
  const [rankAtLastLog, setRankAtLastLogState] = useState<number | null>(() => readRankAtLastLog(account, testRole));
  // Called by LogMatch after a match saves, with the rank that match ended at.
  // That rank is the next one's starting point.
  const commitRankAtLastLog = useCallback((r: number | null) => {
    setRankAtLastLogState(r);
    try {
      if (r == null) localStorage.removeItem(rankAtLastLogKeyFor(account, testRole));
      else localStorage.setItem(rankAtLastLogKeyFor(account, testRole), String(r));
    } catch { /* ignore */ }
  }, [account, testRole]);

  const [lobbyRange, setLobbyRange] = useState<{ low: number; high: number } | null>(() => readLobby(account, testRole));

  // Account and role each swap the whole rank context in one move: the drum's
  // rank and the lobby track both reload from the new slot's storage. Read,
  // never cleared — every slot keeps what it was last left at, so moving
  // between them is free.
  //
  // Both swaps happen inside the setter rather than in an effect on the
  // changed value. An effect would run AFTER the lobby-persist effect below,
  // which would have already written the outgoing slot's range under the
  // incoming slot's key — quietly copying one role's reading onto another.
  const setAccount = useCallback((a: Account) => {
    setAccountState(prev => {
      if (prev === a) return prev;
      try { localStorage.setItem(ACCOUNT_KEY, a); } catch { /* ignore */ }
      setPlayerRankState(readRank(a, testRole));
      setRankAtLastLogState(readRankAtLastLog(a, testRole));
      setLobbyRange(readLobby(a, testRole));
      return a;
    });
  }, [testRole]);

  const setTestRole = useCallback((r: 'DPS' | 'Support') => {
    setTestRoleState(prev => {
      if (prev === r) return prev;
      setPlayerRankState(readRank(account, r));
      setRankAtLastLogState(readRankAtLastLog(account, r));
      setLobbyRange(readLobby(account, r));
      return r;
    });
  }, [account]);
  // Persisted the same way sens is — an effect on the value, not a write
  // buried inside a setState updater. React calls updaters twice in dev, so a
  // write in there runs twice for every one real change.
  useEffect(() => {
    try {
      if (lobbyRange == null) localStorage.removeItem(lobbyKeyFor(account, testRole));
      else localStorage.setItem(lobbyKeyFor(account, testRole), JSON.stringify(lobbyRange));
    } catch { /* ignore */ }
  }, [lobbyRange, account, testRole]);

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
      account, setAccount,
      playerRank, setPlayerRank, rankAtLastLog, commitRankAtLastLog,
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

import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { MAPS, QUEUE_MODES, QueueMode, Recommendation, DeathRecord, DeathAxisKey, DEATH_AXES } from '../types';

// Coaching always shows a DPS and a Support column side by side — the advisor
// endpoint returns one recommendation per role (either can be null if that
// role has no in-testing hero with enough games).
export type AdvisorByRole = Record<'DPS' | 'Support', Recommendation | null>;

const QUEUE_MODE_KEY = 'ow-last-queue-mode';
// Last sensitivity used, carried across matches so it only changes when Sean
// deliberately changes it (the crux of the sens study). Shared here because the
// input lives in the Pre-Match row while the log form reads it on submit.
const SENS_KEY = 'ow-last-sens';
const DEATH_BUFFER_KEY = 'ow-death-buffer';
// Persistent per-axis sample tally used to keep the four death axes evenly
// sampled across matches and sessions (least-sampled-first). Survives buffer
// flushes on purpose — balance can only be maintained across matches, since a
// short match physically can't touch all four axes.
const DEATH_AXIS_TALLY_KEY = 'ow-death-axis-tally';

type AxisTally = Record<DeathAxisKey, number>;

function loadAxisTally(): AxisTally {
  const base: AxisTally = { trade: 0, timing: 0, grouping: 0, awareness: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(DEATH_AXIS_TALLY_KEY) ?? '{}');
    for (const a of DEATH_AXES) if (typeof saved[a.key] === 'number') base[a.key] = saved[a.key];
  } catch { /* keep zeros */ }
  return base;
}

function saveAxisTally(t: AxisTally) {
  localStorage.setItem(DEATH_AXIS_TALLY_KEY, JSON.stringify(t));
}

// Next axis to ask about = whichever has the fewest samples so far, ties broken
// randomly so a fresh (all-zero) tally doesn't always start on 'trade'.
function pickLeastSampledAxis(t: AxisTally): DeathAxisKey {
  const min = Math.min(...DEATH_AXES.map(a => t[a.key]));
  const candidates = DEATH_AXES.filter(a => t[a.key] === min);
  return candidates[Math.floor(Math.random() * candidates.length)].key;
}

// The shared "current match" intent for the single-page Dashboard: one queue
// mode, one selected map, one advisor recommendation, consumed by both the
// Pre-Match and Log Match sections. `pendingHero` lets the Pre-Match hero list
// pre-fill the Log Match form without a page navigation.
interface MatchContextValue {
  queueMode: QueueMode;
  setQueueMode: (q: QueueMode) => void;
  map: string;
  setMap: (m: string) => void;
  mapType: string;
  // In-game sensitivity for the next logged match (kept as the raw input string).
  sens: string;
  setSens: (s: string) => void;
  rec: AdvisorByRole | null;
  recLoading: boolean;
  recError: string | null;
  refreshRec: () => void;
  // Re-fetch the advisor without forcing an LLM regen (cheap) — used after a
  // match is logged so the death-axis breakdown reflects the new data.
  revalidateRec: () => void;
  pendingHero: string | null;
  setPendingHero: (h: string | null) => void;
  // Bumped each time a match is logged, so sections can reset (e.g. Map Voting).
  matchLoggedSignal: number;
  // The most recent logged result, used to play the win/loss flash on the
  // matching mode tile. `seq` rises each log so a repeat result re-triggers.
  lastLog: { mode: QueueMode; win: boolean; seq: number } | null;
  notifyMatchLogged: (info?: { mode: QueueMode; win: boolean }) => void;
  // In-match death buffer: accumulated via the floating DeathLogger during a
  // match, then flushed to the match record on submit.
  deathBuffer: DeathRecord[];
  addDeathToBuffer: (r: DeathRecord) => void;
  removeDeathFromBuffer: (i: number) => void;
  clearDeathBuffer: () => void;
  // Which single axis to ask about on the next death (least-sampled-first).
  nextDeathAxis: () => DeathAxisKey;
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
  const [pendingHero, setPendingHero] = useState<string | null>(null);
  const [matchLoggedSignal, setMatchLoggedSignal] = useState(0);
  const [lastLog, setLastLog] = useState<{ mode: QueueMode; win: boolean; seq: number } | null>(null);

  const [deathBuffer, setDeathBuffer] = useState<DeathRecord[]>(() => {
    try { return JSON.parse(localStorage.getItem(DEATH_BUFFER_KEY) ?? '[]'); } catch { return []; }
  });

  const addDeathToBuffer = useCallback((r: DeathRecord) => {
    // Count the asked axis toward the persistent balance tally.
    const tally = loadAxisTally();
    tally[r.axis] += 1;
    saveAxisTally(tally);
    setDeathBuffer(prev => {
      const updated = [...prev, r];
      localStorage.setItem(DEATH_BUFFER_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const removeDeathFromBuffer = useCallback((i: number) => {
    setDeathBuffer(prev => {
      const removed = prev[i];
      // Un-count a removed death so the tally reflects only what's kept.
      if (removed) {
        const tally = loadAxisTally();
        tally[removed.axis] = Math.max(0, tally[removed.axis] - 1);
        saveAxisTally(tally);
      }
      const updated = prev.filter((_, j) => j !== i);
      localStorage.setItem(DEATH_BUFFER_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const nextDeathAxis = useCallback(() => pickLeastSampledAxis(loadAxisTally()), []);

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
      mapType: map ? MAPS[map] : '',
      rec, recLoading, recError,
      refreshRec: () => fetchRec(true),
      revalidateRec: () => fetchRec(false),
      pendingHero, setPendingHero,
      matchLoggedSignal,
      lastLog,
      deathBuffer, addDeathToBuffer, removeDeathFromBuffer, clearDeathBuffer, nextDeathAxis,
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

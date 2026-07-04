import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { MAPS, QUEUE_MODES, QueueMode, Recommendation, DeathRecord } from '../types';

const QUEUE_MODE_KEY = 'ow-last-queue-mode';
const DEATH_BUFFER_KEY = 'ow-death-buffer';

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
  rec: Recommendation | null;
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
  const [pendingHero, setPendingHero] = useState<string | null>(null);
  const [matchLoggedSignal, setMatchLoggedSignal] = useState(0);
  const [lastLog, setLastLog] = useState<{ mode: QueueMode; win: boolean; seq: number } | null>(null);

  const [deathBuffer, setDeathBuffer] = useState<DeathRecord[]>(() => {
    try { return JSON.parse(localStorage.getItem(DEATH_BUFFER_KEY) ?? '[]'); } catch { return []; }
  });

  const addDeathToBuffer = useCallback((r: DeathRecord) => {
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

  const clearDeathBuffer = useCallback(() => {
    setDeathBuffer([]);
    localStorage.removeItem(DEATH_BUFFER_KEY);
  }, []);

  const [rec, setRec] = useState<Recommendation | null>(null);
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
      mapType: map ? MAPS[map] : '',
      rec, recLoading, recError,
      refreshRec: () => fetchRec(true),
      revalidateRec: () => fetchRec(false),
      pendingHero, setPendingHero,
      matchLoggedSignal,
      lastLog,
      deathBuffer, addDeathToBuffer, removeDeathFromBuffer, clearDeathBuffer,
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

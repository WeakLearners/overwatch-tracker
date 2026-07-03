import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { MAPS, QUEUE_MODES, QueueMode, Recommendation } from '../types';

const QUEUE_MODE_KEY = 'ow-last-queue-mode';

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
  alliedTank: string;
  setAlliedTank: (t: string) => void;
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
  const [alliedTank, setAlliedTank] = useState('');
  const [pendingHero, setPendingHero] = useState<string | null>(null);
  const [matchLoggedSignal, setMatchLoggedSignal] = useState(0);
  const [lastLog, setLastLog] = useState<{ mode: QueueMode; win: boolean; seq: number } | null>(null);

  const [rec, setRec] = useState<Recommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);

  const fetchRec = useCallback(async (refresh: boolean) => {
    if (!map) { setRec(null); setRecError(null); return; }
    setRecLoading(true);
    setRecError(null);
    try {
      const tankParam = alliedTank ? `&allied_tank=${encodeURIComponent(alliedTank)}` : '';
      const url = `/api/advisor/recommend?map=${encodeURIComponent(map)}&queue_mode=${queueMode}${tankParam}${refresh ? '&refresh=1' : ''}`;
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
  }, [map, queueMode, alliedTank]);

  // Refetch whenever the map or queue mode changes.
  useEffect(() => { fetchRec(false); }, [fetchRec]);

  return (
    <MatchContext.Provider value={{
      queueMode, setQueueMode,
      map, setMap,
      mapType: map ? MAPS[map] : '',
      alliedTank, setAlliedTank,
      rec, recLoading, recError,
      refreshRec: () => fetchRec(true),
      revalidateRec: () => fetchRec(false),
      pendingHero, setPendingHero,
      matchLoggedSignal,
      lastLog,
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

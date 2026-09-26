import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { Recommendation } from '../types';
import { useMatch } from './MatchContext';

// Coaching always shows a DPS and a Support column side by side — the advisor
// endpoint returns one recommendation per role (either can be null if that
// role has no in-testing hero with enough games).
export type AdvisorByRole = Record<'DPS' | 'Support', Recommendation | null>;

// Split out of MatchContext 2026-09-26 (perf pass, round 2). rec/recLoading/
// recError are read by Prematch alone — LogMatch and Dashboard never touch
// them — but as long as they lived in the same context object as everything
// else, being a MatchContext consumer AT ALL (which LogMatch and Dashboard's
// ModeComparisonCard both are, for unrelated fields) meant every advisor
// fetch cycle forced LogMatch's entire ~1490-line body to re-render too:
// React's context subscription is all-or-nothing per component, not
// per-field. A map pick or a queue-mode toggle in Pre-Match refetches the
// advisor (recLoading true -> false), and that used to be enough on its own
// to re-run the whole Log Match form.
interface AdvisorContextValue {
  rec: AdvisorByRole | null;
  recLoading: boolean;
  recError: string | null;
}

const AdvisorContext = createContext<AdvisorContextValue | null>(null);

// Mirrors useApi.ts's revalidateAll() pattern on purpose: a plain module-level
// trigger, not a context value, so a caller that only needs to KICK OFF a
// re-fetch (LogMatch, once a match finishes saving) can do so without
// becoming an AdvisorContext subscriber. Subscribing would put LogMatch right
// back to re-rendering on every recLoading flip, which is the exact thing
// this split exists to avoid — it never reads rec/recLoading/recError itself.
let currentFetch: ((refresh: boolean) => void) | null = null;
export function refreshRec() { currentFetch?.(true); }
export function revalidateRec() { currentFetch?.(false); }

export function AdvisorProvider({ children }: { children: ReactNode }) {
  // map/queueMode still live on MatchContext — this Provider reads them the
  // same way it always has, it just no longer hands its OWN state (rec/
  // recLoading/recError) back through that same shared object.
  const { map, queueMode } = useMatch();
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

  // Keep the module-level trigger pointed at the current fetchRec closure
  // (it captures this render's map/queueMode) so refreshRec()/revalidateRec()
  // called from anywhere always kick off a fetch for the CURRENT map, not a
  // stale one from whenever the caller last saw this provider.
  useEffect(() => {
    currentFetch = fetchRec;
    return () => { if (currentFetch === fetchRec) currentFetch = null; };
  }, [fetchRec]);

  // Refetch whenever the map or queue mode changes.
  useEffect(() => { fetchRec(false); }, [fetchRec]);

  const value = useMemo<AdvisorContextValue>(() => ({ rec, recLoading, recError }), [rec, recLoading, recError]);

  return (
    <AdvisorContext.Provider value={value}>
      {children}
    </AdvisorContext.Provider>
  );
}

export function useAdvisor() {
  const ctx = useContext(AdvisorContext);
  if (!ctx) throw new Error('useAdvisor must be used within AdvisorProvider');
  return ctx;
}

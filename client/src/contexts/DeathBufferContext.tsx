import { createContext, useCallback, useContext, useState, ReactNode } from 'react';
import { MatchDeathEntry } from '../types';

// Split out of MatchContext 2026-09-26 (perf pass). Every death tap during a
// match calls addDeathToBuffer, and that used to live on MatchContext — whose
// context VALUE is one object shared by Dashboard, Prematch, and LogMatch all
// at once (all three are mounted together; see App.tsx/Dashboard.tsx). A new
// object identity on ANY field forces EVERY consumer to re-render, so one tap
// per death (the app's own designed rhythm — see DeathLogger.tsx) was
// re-rendering the trends chart and the whole Pre-Match page on every single
// tap, neither of which reads deathBuffer at all. Moving it to its own
// context means a death tap now only re-renders the two components that
// actually consume this one (DeathLogger and LogMatch).
const DEATH_BUFFER_KEY = 'ow-death-buffer-v4';

interface DeathBufferContextValue {
  deathBuffer: MatchDeathEntry[];
  addDeathToBuffer: (r: MatchDeathEntry) => void;
  removeDeathFromBuffer: (i: number) => void;
  toggleDeathUlt: (i: number) => void;
  clearDeathBuffer: () => void;
}

const DeathBufferContext = createContext<DeathBufferContextValue | null>(null);

export function DeathBufferProvider({ children }: { children: ReactNode }) {
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

  return (
    <DeathBufferContext.Provider value={{ deathBuffer, addDeathToBuffer, removeDeathFromBuffer, toggleDeathUlt, clearDeathBuffer }}>
      {children}
    </DeathBufferContext.Provider>
  );
}

export function useDeathBuffer() {
  const ctx = useContext(DeathBufferContext);
  if (!ctx) throw new Error('useDeathBuffer must be used within DeathBufferProvider');
  return ctx;
}

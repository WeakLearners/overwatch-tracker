import { createContext, useContext, useState, ReactNode } from 'react';
import { TrendPoint } from '../types';

interface MatchEditDrawerCtx {
  editMatch: TrendPoint | null;
  openEdit: (match: TrendPoint) => void;
  closeEdit: () => void;
}

const MatchEditDrawerContext = createContext<MatchEditDrawerCtx>({
  editMatch: null,
  openEdit: () => {},
  closeEdit: () => {},
});

export function MatchEditDrawerProvider({ children }: { children: ReactNode }) {
  const [editMatch, setEditMatch] = useState<TrendPoint | null>(null);
  return (
    <MatchEditDrawerContext.Provider value={{
      editMatch,
      openEdit: setEditMatch,
      closeEdit: () => setEditMatch(null),
    }}>
      {children}
    </MatchEditDrawerContext.Provider>
  );
}

export const useMatchEditDrawer = () => useContext(MatchEditDrawerContext);

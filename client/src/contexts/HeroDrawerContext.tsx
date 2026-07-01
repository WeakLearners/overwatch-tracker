import { createContext, useContext, useState, ReactNode } from 'react';

interface HeroDrawerCtx {
  activeHero: string | null;
  openHero: (hero: string) => void;
  closeHero: () => void;
}

const HeroDrawerContext = createContext<HeroDrawerCtx>({
  activeHero: null,
  openHero: () => {},
  closeHero: () => {},
});

export function HeroDrawerProvider({ children }: { children: ReactNode }) {
  const [activeHero, setActiveHero] = useState<string | null>(null);
  return (
    <HeroDrawerContext.Provider value={{
      activeHero,
      openHero: setActiveHero,
      closeHero: () => setActiveHero(null),
    }}>
      {children}
    </HeroDrawerContext.Provider>
  );
}

export const useHeroDrawer = () => useContext(HeroDrawerContext);

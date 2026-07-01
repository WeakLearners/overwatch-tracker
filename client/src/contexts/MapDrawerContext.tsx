import { createContext, useContext, useState, ReactNode } from 'react';

interface MapDrawerCtx {
  activeMap: string | null;
  openMap: (map: string) => void;
  closeMap: () => void;
}

const MapDrawerContext = createContext<MapDrawerCtx>({
  activeMap: null,
  openMap: () => {},
  closeMap: () => {},
});

export function MapDrawerProvider({ children }: { children: ReactNode }) {
  const [activeMap, setActiveMap] = useState<string | null>(null);
  return (
    <MapDrawerContext.Provider value={{
      activeMap,
      openMap: setActiveMap,
      closeMap: () => setActiveMap(null),
    }}>
      {children}
    </MapDrawerContext.Provider>
  );
}

export const useMapDrawer = () => useContext(MapDrawerContext);

import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import SensLog from './pages/SensLog';
import SensAnalysis from './pages/SensAnalysis';
import { MapDrawerProvider } from './contexts/MapDrawerContext';
import MapDrawer from './components/MapDrawer';
import { HeroDrawerProvider } from './contexts/HeroDrawerContext';
import HeroDrawer from './components/HeroDrawer';
import { MatchProvider } from './contexts/MatchContext';
import { MatchEditDrawerProvider } from './contexts/MatchEditDrawerContext';
import MatchEditDrawer from './components/MatchEditDrawer';
import InspectorOverlay from './debug/InspectorOverlay';

/**
 * Root application component. Sets up context providers (hero/map drawers),
 * client-side routing, and renders the single-page Dashboard.
 */
export default function App() {
  const [dark, setDark] = useState(() => localStorage.getItem('ow-theme') === 'dark');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('ow-theme', dark ? 'dark' : 'light');
  }, [dark]);
  return (
    <HeroDrawerProvider>
    <MapDrawerProvider>
    <MatchProvider>
    <MatchEditDrawerProvider>
    <BrowserRouter>
      <div className="min-h-screen">
        {/* HUD top bar: sticky, chamfered wordmark tile with the orange/cyan
            split-tone underglow — the header's own signature slash instead of
            a full-bleed hero graphic. */}
        <header className="sticky top-0 z-30 border-b border-ow-border" style={{ backgroundColor: 'var(--surface)' }}>
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ background: 'linear-gradient(90deg, var(--hud-glow-1), transparent 40%, transparent 60%, var(--hud-glow-2))' }}
            aria-hidden="true"
          />
          <div className="relative max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              {/* Diagonal slash: the orange/cyan split repeated in miniature as
                  a mark, echoing the game's own team-color divide. */}
              <span
                aria-hidden="true"
                className="inline-block w-2.5 h-8 shrink-0 bg-gradient-to-br from-ow-accent from-48% to-ow-blue to-52%"
                style={{ clipPath: 'polygon(35% 0, 100% 0, 65% 100%, 0 100%)' }}
              />
              <div className="leading-none min-w-0">
                {/* Sized down before sm — "Overwatch" is one unbreakable word,
                    so on phone widths it must shrink rather than wrap, or it
                    pushes the theme toggle off the edge of the viewport. */}
                <div className="font-display font-black uppercase text-lg sm:text-2xl md:text-3xl tracking-[0.02em] text-[var(--ink)] whitespace-nowrap">
                  Overwatch
                </div>
                <div className="text-[10px] uppercase tracking-[0.2em] sm:tracking-[0.4em] text-[var(--muted)] mt-0.5 whitespace-nowrap">
                  Match Tracker
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDark(d => !d)}
              aria-label="Toggle theme"
              data-inspect-id="app-theme-toggle"
              className="w-9 h-9 shrink-0 grid place-items-center bg-ow-card border border-ow-border text-[var(--ink-2)] hover:text-ow-accent transition-all"
              style={{ clipPath: 'polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)' }}
            >
              {dark ? '☀' : '☾'}
            </button>
          </div>
        </header>
        <main className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 pt-6 pb-10">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            {/* Aliases: Pre-Match, Log Match and Trends now live as sections on
                the Dashboard. These keep any internal links resolving to the
                same single page. */}
            <Route path="/prematch" element={<Dashboard />} />
            <Route path="/log" element={<Dashboard />} />
            <Route path="/trends" element={<Dashboard />} />
            {/* Sensitivity study — a separate, intentionally unlinked page that
                shares the same backend/DB. Not woven into the Dashboard. */}
            <Route path="/sens" element={<SensLog />} />
            <Route path="/sens/analysis" element={<SensAnalysis />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
    <MapDrawer />
    <HeroDrawer />
    <MatchEditDrawer />
    {import.meta.env.DEV && <InspectorOverlay />}
    </MatchEditDrawerProvider>
    </MatchProvider>
    </MapDrawerProvider>
    </HeroDrawerProvider>
  );
}

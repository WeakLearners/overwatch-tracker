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
import DeathLogger from './components/DeathLogger';
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
        <button
          type="button"
          onClick={() => setDark(d => !d)}
          aria-label="Toggle theme"
          data-inspect-id="app-theme-toggle"
          className="fixed top-3 right-3 z-30 w-9 h-9 rounded-full grid place-items-center bg-ow-card border border-ow-border shadow-sm text-[var(--ink-2)] hover:text-ow-accent hover:-translate-y-0.5 transition-all"
        >
          {dark ? '☀' : '☾'}
        </button>
        {/* Bold header graphic, FIXED behind the content: the page scrolls up
            over it. Fades out at the bottom so it melts into the lit background
            with no seam or border. */}
        <header className="fixed top-0 inset-x-0 z-0 h-[380px] overflow-hidden pointer-events-none">
          {/* Brand: "OVERWATCH" embossed full-bleed into the solid surface, like
              the Apple TV crest — same colour as the page, raised by light alone. */}
          <div className="relative w-full px-4 sm:px-6 pt-10">
            <div className="flex justify-center items-end w-full gap-0 sm:gap-0.5 lg:gap-1">
              {'OVERWATCH'.split('').map((c, i) => (
                <span
                  key={i}
                  className="font-display font-black leading-[0.9] text-7xl sm:text-8xl lg:text-[9.5rem] select-none"
                  style={{
                    // Same cream material as the page, embossed UP out of the surface
                    // and lit from straight above (like the Apple TV crest, but deeper):
                    // a bright highlight hugging the top edges, a soft shadow hugging the
                    // bottom, then a deep diffuse drape so the cloth folds away beneath it.
                    color: 'var(--hdr-ink)',
                    // Crisp vector outline defines every edge (incl. the vertical
                    // sides) with zero blur — the sharpness.
                    // Stroke + shadow colours are theme variables (dark theme uses
                    // the inverse of the light values), so the relief holds in both.
                    WebkitTextStroke: '0.5px var(--hdr-stroke)',
                    filter: [
                        'drop-shadow(-1px -1px 0px var(--hdr-hi))',
                        'drop-shadow(3px 3px 1px var(--hdr-sh1))',
                        'drop-shadow(4px 4px 1px var(--hdr-sh2))',
                    ].join(' '),
                  }}
                >
                  {c}
                </span>
              ))}
            </div>
            <div className="flex items-center gap-3 mt-1 px-0.5">
              <span className="h-px flex-1 bg-gradient-to-r from-transparent via-violet-700/40 to-violet-700/60" />
              <span className="text-amber-900/70 dark:text-amber-200/70 text-xs font-bold uppercase tracking-[0.55em] whitespace-nowrap">Match Tracker</span>
              <span className="h-px flex-1 bg-gradient-to-l from-transparent via-fuchsia-700/40 to-fuchsia-700/60" />
            </div>
          </div>
        </header>
        {/* Embossed Overwatch crest, fixed and centred behind the content so the
            page surface has a subject. Pure decoration — masked + lit by CSS. */}
        <div className="crest-bg" aria-hidden="true" />
        <main className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 pt-[230px] pb-10">
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
    <DeathLogger />
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

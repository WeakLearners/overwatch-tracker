import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { NOTCH, ACCENT_SEL } from './SegmentedPills';

// Inspector / settings / theme — the three app tools. On the Dashboard they
// sit in the section nav strip (Sean, 2026-09-26); on every other page they
// stay in the header, since those pages have no nav strip to hold them.

const ThemeContext = createContext<{ dark: boolean; toggle: () => void }>({ dark: false, toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(() => localStorage.getItem('ow-theme') === 'dark');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('ow-theme', dark ? 'dark' : 'light');
  }, [dark]);
  return <ThemeContext.Provider value={{ dark, toggle: () => setDark(d => !d) }}>{children}</ThemeContext.Provider>;
}

// The inspector button (debug/InspectorToggleButton.tsx) portals into
// #header-inspector-slot. That slot now moves between the header and the
// Dashboard nav as routes change, so announce each mount/unmount and the
// button re-finds it.
export const INSPECTOR_SLOT_EVENT = 'inspector-slot-changed';

export const TOOL = 'relative z-10 px-4 flex items-center justify-center text-base leading-none text-[var(--faint)] hover:text-[var(--ink)] transition-colors';

// Same shell as SegmentedPills (the "Playing as" strip): a gapless row of
// equal-width cells inset 3px from the strip. Nothing is ever "selected"
// here except the inspector while it is on, which lights itself.
// home: a ⌂ link back to the Dashboard, for pages that aren't it (the
// header wordmark also goes home, but reads as a logo, not a button).
export default function AppTools({ home = false }: { home?: boolean }) {
  const { dark, toggle } = useContext(ThemeContext);
  useEffect(() => {
    window.dispatchEvent(new Event(INSPECTOR_SLOT_EVENT));
    return () => { window.dispatchEvent(new Event(INSPECTOR_SLOT_EVENT)); };
  }, []);
  return (
    // Deliberately NO data-inspect-id on this wrapper: the dev inspector
    // button portals in here, and a labelled ancestor makes inspect mode
    // swallow clicks on that button, so it can't be switched off (hit
    // 2026-09-26 when this wrapper briefly carried "app-tools").
    <div className="relative grid grid-flow-col auto-cols-fr my-[3px] shrink-0">
      {home && <Link to="/" aria-label="Home" title="Back to the Dashboard" data-inspect-id="app-home-link" className={TOOL}>⌂</Link>}
      <span id="header-inspector-slot" className="contents" />
      <Link to="/settings" aria-label="Settings" title="Settings" data-inspect-id="app-settings-link" className={TOOL}>⚙</Link>
      <button type="button" onClick={toggle} aria-label="Toggle theme" title="Toggle theme" data-inspect-id="app-theme-toggle" className={TOOL}>
        {dark ? '☀' : '☾'}
      </button>
    </div>
  );
}

// Lit block for a tool that is "on" — the same indicator SegmentedPills
// slides, pinned to one cell.
export function ToolLit() {
  return (
    <span
      aria-hidden="true"
      className="is-selected mode-fill absolute -inset-y-[3px] inset-x-0 border-2 pointer-events-none"
      style={{ clipPath: NOTCH, '--sel': ACCENT_SEL } as React.CSSProperties}
    />
  );
}

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { NOTCH } from './SegmentedPills';

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

const TOOL = 'relative z-10 px-3 flex items-center justify-center text-sm leading-none text-[var(--faint)] hover:text-[var(--ink)] transition-colors';

// Same shell as SegmentedPills (the "Playing as" strip): a gapless row of
// equal-width cells inset 3px from the strip. Nothing is ever "selected"
// here except the inspector while it is on, which lights itself.
export default function AppTools() {
  const { dark, toggle } = useContext(ThemeContext);
  useEffect(() => {
    window.dispatchEvent(new Event(INSPECTOR_SLOT_EVENT));
    return () => { window.dispatchEvent(new Event(INSPECTOR_SLOT_EVENT)); };
  }, []);
  return (
    <div className="relative grid grid-flow-col auto-cols-fr my-[3px] shrink-0" data-inspect-id="app-tools">
      {/* Dev-only inspector toggle portals in here. Deliberately no
          data-inspect-id on this wrapper, or the inspector would swallow
          clicks on its own button. */}
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
      style={{ clipPath: NOTCH }}
    />
  );
}

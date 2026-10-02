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

const TOOLS_OPEN_KEY = 'ow-app-tools-open';

export const TOOL = 'relative z-10 px-4 flex items-center justify-center text-base leading-none text-[var(--faint)] hover:text-[var(--ink)] transition-colors';

// Same shell as SegmentedPills (the "Playing as" strip): a gapless row of
// equal-width cells inset 3px from the strip. Nothing is ever "selected"
// here except the inspector while it is on, which lights itself.
// home: a ⌂ link back to the Dashboard, for pages that aren't it (the
// header wordmark also goes home, but reads as a logo, not a button).
export default function AppTools({ home = false }: { home?: boolean }) {
  const { dark, toggle } = useContext(ThemeContext);
  // The three tools tuck behind one trigger at the right edge (Sean,
  // 2026-10-02). Remembered per browser; closed unless it was left open.
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(TOOLS_OPEN_KEY) === '1'; } catch { return false; }
  });
  const flip = () => setOpen(o => {
    try { localStorage.setItem(TOOLS_OPEN_KEY, o ? '0' : '1'); } catch { /* storage blocked: still works this visit */ }
    return !o;
  });
  useEffect(() => {
    window.dispatchEvent(new Event(INSPECTOR_SLOT_EVENT));
    return () => { window.dispatchEvent(new Event(INSPECTOR_SLOT_EVENT)); };
  }, []);
  return (
    // Deliberately NO data-inspect-id on this wrapper: the dev inspector
    // button portals in here, and a labelled ancestor makes inspect mode
    // swallow clicks on that button, so it can't be switched off (hit
    // 2026-09-26 when this wrapper briefly carried "app-tools").
    <div className="relative flex my-[3px] shrink-0">
      {home && <Link to="/" aria-label="Home" title="Back to the Dashboard" data-inspect-id="app-home-link" className={TOOL}>⌂</Link>}
      {/* Slides open by animating the column from 0fr to 1fr. Closed, the
          tools are invisible (so Tab skips them) but stay mounted, because
          the inspector button portals into the slot below. */}
      <div
        id="app-tools-tray"
        className={`grid transition-[grid-template-columns,opacity,visibility] duration-200 ease-out ${
          open ? 'grid-cols-[1fr] opacity-100 visible' : 'grid-cols-[0fr] opacity-0 invisible'
        }`}
      >
        <div className="grid grid-flow-col auto-cols-fr min-w-0 overflow-hidden">
          <span id="header-inspector-slot" className="contents" />
          <Link to="/settings" aria-label="Settings" title="Settings" data-inspect-id="app-settings-link" className={`${TOOL} !text-xs`}>Settings</Link>
          <button type="button" onClick={toggle} aria-label="Toggle theme" title="Toggle theme" data-inspect-id="app-theme-toggle" className={TOOL}>
            {dark ? '☀' : '☾'}
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={flip}
        aria-expanded={open}
        aria-controls="app-tools-tray"
        aria-label={open ? 'Hide tools' : 'Show tools'}
        title="Tools"
        data-inspect-id="app-tools-toggle"
        className={`${TOOL}${open ? ' !text-[var(--ink)]' : ''}`}
      >
        {/* Drawn, not the ⚙ character: no app font has that glyph, so it fell
            back to a small symbol font. 16px box ≈ the nav labels' height. */}
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
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

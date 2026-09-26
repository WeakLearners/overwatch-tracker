import { useState } from 'react';
import { HEROES } from '../types';
import { useDeathBuffer } from '../contexts/DeathBufferContext';

type Role = 'Tank' | 'DPS' | 'Support';
const ROLES: Role[] = ['Tank', 'DPS', 'Support'];

const HEROES_BY_ROLE: Record<Role, string[]> = { Tank: [], DPS: [], Support: [] };
Object.entries(HEROES).forEach(([hero, role]) => {
  HEROES_BY_ROLE[role as Role]?.push(hero);
});
(Object.keys(HEROES_BY_ROLE) as Role[]).forEach(r => HEROES_BY_ROLE[r].sort());

// Fact-only death capture, built for a ~10-second respawn window — one tap
// in the common case. Two paths to the same log call:
//   1. "This match" MRU row — every distinct killer already logged this
//      match, most-recent-first. Covers most deaths after the first 2-3.
//   2. Role tab (sticky — stays on the last role used) -> hero grid, for a
//      killer not seen yet this match.
// Either path appends immediately with ult: false — no confirm step. The
// ult flag is only ever set after the fact, via the ⚡ toggle on a buffered
// row in LogMatch's Deaths card.
//
// Lives inline in that same Deaths card (2026-09-10 on) — it was a fixed
// bottom-right FAB with a floating popover until then. The card is two
// columns from lg up: logged history left, this picker right (stacked
// history-then-picker below lg), so a growing buffer never pushes the
// capture control down the screen mid-match. The expanded panel stays
// deliberately compact (dense grid, small type) since it now lives in a
// half-width column — hence the grid stepping back to 3-4 columns at lg. Capture and the list
// of what's been captured are one thing, so they read as one thing; the
// popover's cramped 288px width was also what forced the tiny type the
// respawn window can't afford. Consequences of the move: the picker stays
// open after a log (an inline panel costs nothing to leave open, and back-
// to-back deaths are the common case) and the buffer review panel + count
// pill are gone, since the card already lists the buffer right below.
export default function DeathLogger() {
  const { deathBuffer, addDeathToBuffer } = useDeathBuffer();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>('DPS');

  function logKill(hero: string) {
    addDeathToBuffer({ killer: hero, killer_role: HEROES[hero] ?? role, ult: false });
  }

  const count = deathBuffer.length;
  // Most-recent-first distinct killers already logged this match.
  const mru = [...new Set([...deathBuffer].reverse().map(d => d.killer))];

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Log a death"
        data-inspect-id="deathLogger-logDeathButton"
        className="w-full py-2 px-3 rounded-lg bg-ow-darker border border-ow-border flex items-center justify-center hover:border-ow-accent/50 active:scale-[0.99] transition-all"
      >
        <span className="flex items-center gap-2">
          <span className="text-base leading-5 select-none" role="img" aria-hidden>💀</span>
          <span className="text-sm leading-5 font-semibold text-[var(--ink-2)]">Log a death</span>
        </span>
      </button>
    );
  }

  return (
    <div data-inspect-id="deathLogger-loggingPopover" className="rounded-xl bg-ow-darker border border-ow-accent/40 overflow-hidden">
      <div className="flex items-center justify-between px-2 pt-2 pb-1">
        <span data-inspect-id="deathLogger-popoverTitle" className="text-xs font-semibold text-[var(--ink-2)] uppercase tracking-wide">
          Death <b className="font-bold text-[var(--ink)]">{count + 1}</b> — who got you?
        </span>
        <button
          data-inspect-id="deathLogger-popoverCancelButton"
          type="button"
          onClick={() => setOpen(false)}
          className="text-[var(--faint)] hover:text-[var(--ink)] text-lg leading-none px-1 transition-colors"
          aria-label="Cancel"
        >
          ×
        </button>
      </div>

      <div className="px-2 pb-2">
        {mru.length > 0 && (
          <div className="mb-1.5">
            <p className="text-[10px] text-[var(--faint-2)] uppercase tracking-wide mb-1">This match</p>
            <div data-inspect-id="deathLogger-mruRow" className="flex flex-wrap gap-1">
              {mru.map(hero => (
                <button
                  key={hero}
                  type="button"
                  data-inspect-id="deathLogger-mruChip"
                  onClick={() => logKill(hero)}
                  className="px-2.5 py-1 rounded-full bg-ow-accent/15 border border-ow-accent/50 text-xs font-semibold text-[var(--ink)] hover:bg-ow-accent/25 active:scale-95 transition-all"
                >
                  {hero}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Sticky role tab — stays on the last role used across deaths. */}
        <div className="flex gap-1 mb-1.5" data-inspect-id="deathLogger-roleTabs">
          {ROLES.map(r => (
            <button
              key={r}
              type="button"
              data-inspect-id="deathLogger-roleTab"
              onClick={() => setRole(r)}
              aria-pressed={role === r}
              className={`flex-1 text-xs font-semibold py-1 rounded-md border transition-colors ${
                role === r
                  ? 'is-selected text-[var(--ink)]'
                  : 'bg-transparent border-ow-border text-[var(--faint)] hover:text-[var(--ink)]'
              }`}
            >
              {role === r ? <span className="lit-text">{r}</span> : r}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-3 xl:grid-cols-4 gap-1">
          {HEROES_BY_ROLE[role].map(hero => (
            <button
              key={hero}
              type="button"
              data-inspect-id="deathLogger-heroGridButton"
              onClick={() => logKill(hero)}
              className="px-1 py-1.5 rounded-md bg-ow-card border border-ow-border text-[11px] leading-tight font-medium text-[var(--ink-2)] hover:text-[var(--ink)] hover:border-ow-accent/50 active:scale-95 transition-all truncate"
            >
              {hero}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

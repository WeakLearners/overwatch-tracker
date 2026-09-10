import { useState } from 'react';
import { HEROES } from '../types';
import { useMatch } from '../contexts/MatchContext';

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
// Lives inline inside that same Deaths card (2026-09-10 on) — it was a fixed
// bottom-right FAB with a floating popover until then. Capture and the list
// of what's been captured are one thing, so they read as one thing; the
// popover's cramped 288px width was also what forced the tiny type the
// respawn window can't afford. Consequences of the move: the picker stays
// open after a log (an inline panel costs nothing to leave open, and back-
// to-back deaths are the common case) and the buffer review panel + count
// pill are gone, since the card already lists the buffer right below.
export default function DeathLogger() {
  const { deathBuffer, addDeathToBuffer } = useMatch();
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
        className="w-full h-14 rounded-xl bg-ow-darker border border-ow-border grid place-items-center hover:border-ow-accent/50 active:scale-[0.99] transition-all"
      >
        <span className="flex items-center gap-2.5">
          <span className="text-2xl select-none" role="img" aria-hidden>💀</span>
          <span className="text-sm font-semibold text-[var(--ink-2)]">Log a death</span>
        </span>
      </button>
    );
  }

  return (
    <div data-inspect-id="deathLogger-loggingPopover" className="rounded-xl bg-ow-darker border border-ow-accent/40 overflow-hidden">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span data-inspect-id="deathLogger-popoverTitle" className="text-sm font-semibold text-[var(--ink-2)] uppercase tracking-wide">
          Death <b className="font-bold text-[var(--ink)]">{count + 1}</b> — who got you?
        </span>
        <button
          data-inspect-id="deathLogger-popoverCancelButton"
          type="button"
          onClick={() => setOpen(false)}
          className="text-[var(--faint)] hover:text-[var(--ink)] text-2xl leading-none px-1 transition-colors"
          aria-label="Cancel"
        >
          ×
        </button>
      </div>

      <div className="px-3 pb-3">
        {mru.length > 0 && (
          <div className="mb-3">
            <p className="text-xs text-[var(--faint-2)] uppercase tracking-wide mb-1.5">This match</p>
            <div data-inspect-id="deathLogger-mruRow" className="flex flex-wrap gap-2">
              {mru.map(hero => (
                <button
                  key={hero}
                  type="button"
                  data-inspect-id="deathLogger-mruChip"
                  onClick={() => logKill(hero)}
                  className="px-4 py-2 rounded-full bg-ow-accent/15 border border-ow-accent/50 text-sm font-semibold text-[var(--ink)] hover:bg-ow-accent/25 active:scale-95 transition-all"
                >
                  {hero}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Sticky role tab — stays on the last role used across deaths. */}
        <div className="flex gap-1.5 mb-2" data-inspect-id="deathLogger-roleTabs">
          {ROLES.map(r => (
            <button
              key={r}
              type="button"
              data-inspect-id="deathLogger-roleTab"
              onClick={() => setRole(r)}
              aria-pressed={role === r}
              className={`flex-1 text-sm font-semibold py-2 rounded-lg border transition-colors ${
                role === r
                  ? 'bg-ow-accent/20 border-ow-accent/60 text-[var(--ink)]'
                  : 'bg-transparent border-ow-border text-[var(--faint)] hover:text-[var(--ink)]'
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
          {HEROES_BY_ROLE[role].map(hero => (
            <button
              key={hero}
              type="button"
              data-inspect-id="deathLogger-heroGridButton"
              onClick={() => logKill(hero)}
              className="px-1.5 py-2.5 rounded-lg bg-ow-card border border-ow-border text-sm leading-tight font-medium text-[var(--ink-2)] hover:text-[var(--ink)] hover:border-ow-accent/50 active:scale-95 transition-all truncate"
            >
              {hero}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

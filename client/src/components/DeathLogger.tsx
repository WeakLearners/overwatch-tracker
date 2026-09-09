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
// row below (here, or in LogMatch's own Deaths card).
export default function DeathLogger() {
  const { deathBuffer, addDeathToBuffer, removeDeathFromBuffer, toggleDeathUlt } = useMatch();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>('DPS');
  const [showBuffer, setShowBuffer] = useState(false);

  function openLogger() {
    setShowBuffer(false);
    setOpen(true);
  }

  function logKill(hero: string) {
    addDeathToBuffer({ killer: hero, killer_role: HEROES[hero] ?? role, ult: false });
    setOpen(false);
  }

  const count = deathBuffer.length;
  // Most-recent-first distinct killers already logged this match.
  const mru = [...new Set([...deathBuffer].reverse().map(d => d.killer))];

  return (
    // Anchor point — everything positions relative to this fixed corner
    <div className="fixed bottom-6 right-4 z-40 flex flex-col items-end gap-2">

      {/* Popover — grows upward from the button, aligned to the right edge */}
      {open && (
        <>
          {/* Invisible backdrop for click-outside dismissal */}
          <div className="fixed inset-0 -z-10" onClick={() => setOpen(false)} />

          <div data-inspect-id="deathLogger-loggingPopover" className="w-72 bg-ow-card border border-ow-border rounded-lg shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <span data-inspect-id="deathLogger-popoverTitle" className="text-xs font-semibold text-[var(--faint)] uppercase tracking-widest">
                Death <b className="font-bold">{count + 1}</b> — who got you?
              </span>
              <button
                data-inspect-id="deathLogger-popoverCancelButton"
                type="button"
                onClick={() => setOpen(false)}
                className="text-[var(--faint)] hover:text-[var(--ink)] text-lg leading-none transition-colors"
                aria-label="Cancel"
              >
                ×
              </button>
            </div>

            <div className="px-4 pb-3">
              {mru.length > 0 && (
                <div className="mb-2.5">
                  <p className="text-[10px] text-[var(--faint-2)] uppercase tracking-wide mb-1">This match</p>
                  <div data-inspect-id="deathLogger-mruRow" className="flex flex-wrap gap-1.5">
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
                    className={`flex-1 text-xs font-semibold py-1 rounded-lg border transition-colors ${
                      role === r
                        ? 'bg-ow-accent/20 border-ow-accent/60 text-[var(--ink)]'
                        : 'bg-transparent border-ow-border text-[var(--faint)] hover:text-[var(--ink)]'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-4 gap-1">
                {HEROES_BY_ROLE[role].map(hero => (
                  <button
                    key={hero}
                    type="button"
                    data-inspect-id="deathLogger-heroGridButton"
                    onClick={() => logKill(hero)}
                    className="px-1 py-1 rounded-md bg-ow-darker border border-ow-border text-[10px] leading-tight text-[var(--ink-2)] hover:text-[var(--ink)] hover:border-ow-accent/50 active:scale-95 transition-all truncate"
                  >
                    {hero}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Buffer review panel */}
      {showBuffer && count > 0 && !open && (
        <div className="w-64 bg-ow-card border border-ow-border rounded-lg shadow-xl p-3">
          <p data-inspect-id="deathLogger-bufferReviewList" className="text-xs text-[var(--ink-2)] font-semibold mb-2">Deaths this match</p>
          <div className="space-y-1">
            {deathBuffer.map((d, i) => (
              <div key={i} className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-ow-darker">
                <span className="text-xs text-[var(--ink)] truncate">
                  <b className="font-bold">{i + 1}</b>. {d.killer}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    data-inspect-id="deathLogger-bufferUltToggle"
                    onClick={() => toggleDeathUlt(i)}
                    aria-label={d.ult ? 'Ult kill — tap to unmark' : 'Mark as ult kill'}
                    aria-pressed={d.ult}
                    className={`text-sm leading-none transition-opacity ${d.ult ? 'opacity-100' : 'opacity-30 hover:opacity-70'}`}
                  >
                    ⚡
                  </button>
                  <button
                    data-inspect-id="deathLogger-removeBufferedDeathButton"
                    type="button"
                    onClick={() => removeDeathFromBuffer(i)}
                    className="text-[var(--faint)] hover:text-red-500 transition-colors shrink-0 text-sm leading-none"
                    aria-label="Remove"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bottom row: count pill + skull button */}
      <div className="flex items-center gap-2">
        {count > 0 && (
          <button
            type="button"
            onClick={() => { setShowBuffer(s => !s); setOpen(false); }}
            data-inspect-id="deathLogger-deathCountPill"
            className="h-9 px-3 rounded-full bg-ow-card border border-ow-border shadow text-xs font-semibold text-[var(--ink-2)] hover:text-[var(--ink)] transition-colors"
          >
            <b className="font-bold">{count}</b> {count === 1 ? 'death' : 'deaths'}
          </button>
        )}

        <button
          type="button"
          onClick={openLogger}
          aria-label="Log a death"
          data-inspect-id="deathLogger-logDeathButton"
          className="w-14 h-14 rounded-full bg-ow-card border border-ow-border shadow-lg grid place-items-center hover:scale-105 active:scale-95 transition-transform"
        >
          <span className="text-2xl select-none" role="img" aria-hidden>💀</span>
        </button>
      </div>
    </div>
  );
}

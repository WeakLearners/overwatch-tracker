import { useState } from 'react';
import { DEATH_SCENARIOS, DeathRecord } from '../types';
import { useMatch } from '../contexts/MatchContext';

function randomPair(): [number, number] {
  const a = Math.floor(Math.random() * DEATH_SCENARIOS.length);
  let b = Math.floor(Math.random() * (DEATH_SCENARIOS.length - 1));
  if (b >= a) b++;
  return [a, b];
}

export default function DeathLogger() {
  const { deathBuffer, addDeathToBuffer, removeDeathFromBuffer } = useMatch();
  const [open, setOpen] = useState(false);
  const [pair, setPair] = useState<[number, number]>([0, 1]);
  const [showBuffer, setShowBuffer] = useState(false);

  function openLogger() {
    setPair(randomPair());
    setShowBuffer(false);
    setOpen(true);
  }

  function pick(record: DeathRecord) {
    addDeathToBuffer(record);
    setOpen(false);
  }

  const count = deathBuffer.length;

  return (
    // Anchor point — everything positions relative to this fixed corner
    <div className="fixed bottom-6 right-4 z-40 flex flex-col items-end gap-2">

      {/* Popover — grows upward from the button, aligned to the right edge */}
      {open && (
        <>
          {/* Invisible backdrop for click-outside dismissal */}
          <div className="fixed inset-0 -z-10" onClick={() => setOpen(false)} />

          <div className="w-72 bg-ow-card border border-ow-border rounded-2xl shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <span className="text-xs font-semibold text-[var(--faint)] uppercase tracking-widest">
                Death {count + 1} · closer to?
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-[var(--faint)] hover:text-[var(--ink)] text-lg leading-none transition-colors"
                aria-label="Cancel"
              >
                ×
              </button>
            </div>

            <div className="flex flex-col gap-2 px-3 pb-3">
              {pair.map(idx => {
                const s = DEATH_SCENARIOS[idx];
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => pick(s.record)}
                    className="w-full text-left rounded-xl border border-ow-border bg-ow-darker hover:border-ow-accent/60 hover:bg-ow-accent/5 active:scale-[0.98] transition-all px-3 py-2.5"
                  >
                    <div className="text-sm font-semibold text-[var(--ink)]">{s.label}</div>
                    <div className="text-xs text-[var(--faint)] mt-0.5">{s.hint}</div>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-full py-2 text-xs text-[var(--faint)] hover:text-[var(--ink)] transition-colors border-t border-ow-border"
            >
              Skip
            </button>
          </div>
        </>
      )}

      {/* Buffer review panel */}
      {showBuffer && count > 0 && !open && (
        <div className="w-64 bg-ow-card border border-ow-border rounded-xl shadow-xl p-3">
          <p className="text-xs text-[var(--ink-2)] font-semibold mb-2">Deaths this match</p>
          <div className="space-y-1">
            {deathBuffer.map((d, i) => {
              const scenario = DEATH_SCENARIOS.find(s =>
                s.record.trade === d.trade && s.record.timing === d.timing &&
                s.record.grouping === d.grouping && s.record.awareness === d.awareness
              );
              return (
                <div key={i} className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-ow-darker">
                  <span className="text-xs text-[var(--ink)] truncate">
                    {i + 1}. {scenario?.label ?? 'Death'}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeDeathFromBuffer(i)}
                    className="text-[var(--faint)] hover:text-red-500 transition-colors shrink-0 text-sm leading-none"
                    aria-label="Remove"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Bottom row: count pill + skull button */}
      <div className="flex items-center gap-2">
        {count > 0 && (
          <button
            type="button"
            onClick={() => { setShowBuffer(s => !s); setOpen(false); }}
            className="h-9 px-3 rounded-full bg-ow-card border border-ow-border shadow text-xs font-semibold text-[var(--ink-2)] hover:text-[var(--ink)] transition-colors"
          >
            {count} {count === 1 ? 'death' : 'deaths'}
          </button>
        )}

        <button
          type="button"
          onClick={openLogger}
          aria-label="Log a death"
          className="w-14 h-14 rounded-full bg-ow-card border border-ow-border shadow-lg grid place-items-center hover:scale-105 active:scale-95 transition-transform"
        >
          <span className="text-2xl select-none" role="img" aria-hidden>💀</span>
        </button>
      </div>
    </div>
  );
}

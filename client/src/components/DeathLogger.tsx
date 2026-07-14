import { useState } from 'react';
import { DEATH_AXES, DeathAxis, DeathAxisKey, DeathRecord } from '../types';
import { useMatch } from '../contexts/MatchContext';

const AXIS_BY_KEY: Record<DeathAxisKey, DeathAxis> =
  Object.fromEntries(DEATH_AXES.map(a => [a.key, a])) as Record<DeathAxisKey, DeathAxis>;

// Worded lean for a buffer entry: which pole the value leans toward, or neutral.
function leanLabel(axis: DeathAxisKey, value: number): string {
  const a = AXIS_BY_KEY[axis];
  if (value < 0.4) return a.lowShort;
  if (value > 0.6) return a.highShort;
  return 'Neutral';
}

export default function DeathLogger() {
  const { deathBuffer, addDeathToBuffer, removeDeathFromBuffer, nextDeathAxis } = useMatch();
  const [open, setOpen] = useState(false);
  const [axis, setAxis] = useState<DeathAxisKey>('trade');
  const [pos, setPos] = useState(50); // slider position 0–100 (→ value 0.0–1.0)
  const [showBuffer, setShowBuffer] = useState(false);

  function openLogger() {
    setAxis(nextDeathAxis());
    setPos(50); // start centred / neutral
    setShowBuffer(false);
    setOpen(true);
  }

  function confirm() {
    addDeathToBuffer({ axis, value: +(pos / 100).toFixed(2) });
    setOpen(false);
  }

  const count = deathBuffer.length;
  const spec = AXIS_BY_KEY[axis];

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
                Death {count + 1} · {spec.label}
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

            <div className="px-4 pb-3">
              {/* Slider: drag between the two poles of this one axis */}
              <input
                type="range"
                min={0}
                max={100}
                value={pos}
                onChange={e => setPos(Number(e.target.value))}
                className="w-full accent-ow-accent cursor-pointer"
                aria-label={`${spec.label}: ${spec.low} to ${spec.high}`}
              />
              <div className="flex justify-between gap-3 mt-1.5">
                <span className="text-xs text-[var(--faint)] leading-snug max-w-[45%]">{spec.low}</span>
                <span className="text-xs text-[var(--faint)] leading-snug max-w-[45%] text-right">{spec.high}</span>
              </div>

              <button
                type="button"
                onClick={confirm}
                className="w-full mt-3 rounded-xl bg-ow-accent/15 border border-ow-accent/50 text-[var(--ink)] text-sm font-semibold py-2.5 hover:bg-ow-accent/25 active:scale-[0.98] transition-all"
              >
                Log it
              </button>
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
            {deathBuffer.map((d, i) => (
              <div key={i} className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-ow-darker">
                <span className="text-xs text-[var(--ink)] truncate">
                  {i + 1}. {AXIS_BY_KEY[d.axis].label} · {leanLabel(d.axis, d.value)}
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

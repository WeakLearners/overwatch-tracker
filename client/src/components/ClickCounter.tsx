import { useState } from 'react';

// The repurposed sensitivity odometer.
//
// Its old job — dialing an in-game sens with rolling drums — died when the study
// froze sens at 2.5 and moved the variable onto the mouse's DPI stages. Its new
// job is the most tactile moment in the blind loop: pressing the DPI button
// EXACTLY N times to advance one stage. The drum shows how many presses remain
// and rolls down by one each time you tap "clicked", so you can keep count with
// your eyes off the screen (watching a video, staying blind to which stage you
// land on). At zero you're on the new stage.
//
// Same drum mechanics as the old SensWheel: the cell's position is a pure
// function of the remaining count (`translateY(-digit * CELL)`), so the display
// can never desync from the number.

const CELL = 64; // px height of one digit cell
const DUR = 220; // roll duration (ms)
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export default function ClickCounter({ count, onDone }: { count: number; onDone: () => void }) {
  const [remaining, setRemaining] = useState(Math.max(0, count));
  // The drum is a single digit; realistic click counts are 1..n-1 (≈1–4 for a
  // 5-stage set). If a large stage count ever pushes it past 9 the button label
  // stays authoritative, so the count is never actually lost.
  const digit = Math.min(9, Math.max(0, remaining));
  const done = remaining <= 0;

  return (
    <div className="flex flex-col items-center gap-4 py-2">
      <div className="text-xs text-[var(--faint)] text-center">
        {done ? 'Done — you’re on your new stage' : 'Press your mouse’s DPI button this many more times'}
      </div>
      <div
        className="relative overflow-hidden rounded-lg bg-ow-darker border border-ow-accent/40 select-none"
        style={{ width: 60, height: CELL }}
      >
        <div
          style={{
            transform: `translateY(${-digit * CELL}px)`,
            transition: `transform ${DUR}ms cubic-bezier(.2,.8,.3,1)`,
            willChange: 'transform',
          }}
        >
          {DIGITS.map(n => (
            <div key={n} className="grid place-items-center num-display text-5xl text-[var(--ink)]" style={{ height: CELL }}>{n}</div>
          ))}
        </div>
      </div>
      {done ? (
        <button type="button" onClick={onDone} className="btn-primary w-full py-2.5 text-sm">
          On my new stage — start playing →
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setRemaining(r => Math.max(0, r - 1))}
          className="btn-primary w-full py-3 text-base"
          aria-label="Register one DPI-button press"
        >
          Clicked — {remaining} left
        </button>
      )}
    </div>
  );
}

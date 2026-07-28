// Display-only odometer — the repurposed sensitivity wheel, now a blind-trial
// readout. Renders a non-negative integer across one or two rolling drums; each
// drum's position is a pure function of its digit (`translateY(-digit * CELL)`),
// so the shown number can never desync from the value it's given.

const DUR = 240; // roll duration (ms)
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function Drum({ digit, size }: { digit: number; size: number }) {
  return (
    <div
      className="relative overflow-hidden rounded-md bg-ow-darker border border-ow-accent/40 select-none"
      style={{ width: Math.round(size * 0.72), height: size }}
    >
      <div
        style={{
          transform: `translateY(${-digit * size}px)`,
          transition: `transform ${DUR}ms cubic-bezier(.2,.8,.3,1)`,
          willChange: 'transform',
        }}
      >
        {DIGITS.map(n => (
          <div key={n} className="grid place-items-center num-display text-[var(--ink)]" style={{ height: size, fontSize: Math.round(size * 0.62) }}>{n}</div>
        ))}
      </div>
    </div>
  );
}

export default function Odometer({ value, size = 46 }: { value: number; size?: number }) {
  const v = Math.max(0, Math.min(99, Math.round(value)));
  return (
    <div className="flex gap-1">
      <Drum digit={Math.floor(v / 10)} size={size} />
      <Drum digit={v % 10} size={size} />
    </div>
  );
}

// Display-only odometer — the repurposed sensitivity wheel, now a blind-trial
// readout. Renders a non-negative integer across `digits` rolling drums (1-3); each
// drum's position is a pure function of its digit (`translateY(-digit * CELL)`),
// so the shown number can never desync from the value it's given.

const DUR = 240; // roll duration (ms)
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function Drum({ digit, size, warn }: { digit: number; size: number; warn?: boolean }) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg bg-ow-card select-none ${warn ? 'odo-warn' : ''}`}
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

// `padTo` adds invisible spacer drums in front, so a short counter takes the
// same width as a longer one and its digits line up under theirs.
// `warn` lights the drums gold (.odo-warn in index.css): a heads-up that the
// value is nearing its limit. The glow is a shadow, so it takes no layout space.
export default function Odometer({ value, size = 46, digits = 2, padTo = 0, warn = false, dataInspectId = 'odometer-display' }: { value: number; size?: number; digits?: number; padTo?: number; warn?: boolean; dataInspectId?: string }) {
  const max = 10 ** digits - 1;
  const v = Math.max(0, Math.min(max, Math.round(value)));
  const places = Array.from({ length: digits }, (_, i) => 10 ** (digits - 1 - i));
  return (
    <div className="flex gap-0" data-inspect-id={dataInspectId}>
      {Array.from({ length: Math.max(0, padTo - digits) }, (_, i) => (
        <div key={`pad-${i}`} aria-hidden="true" style={{ width: Math.round(size * 0.72), height: size }} />
      ))}
      {places.map(pl => <Drum key={pl} digit={Math.floor(v / pl) % 10} size={size} warn={warn} />)}
    </div>
  );
}

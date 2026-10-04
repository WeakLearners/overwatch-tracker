// Final round score ("Score  us - them"), shared by Log Match and the edit
// drawer. Two small number inputs; blank is allowed and saves NULL. The values
// are strings so a blank box stays blank instead of reading as 0.
interface Props {
  us: string;
  them: string;
  onChange: (us: string, them: string) => void;
  dataInspectPrefix: string;
}

/** '' -> null, else a whole number. The server rejects anything outside 0-10. */
export const scoreOrNull = (s: string): number | null => (s.trim() === '' ? null : parseInt(s, 10));

export default function ScoreInputs({ us, them, onChange, dataInspectPrefix }: Props) {
  const box = 'w-14 text-center rounded-md border border-ow-border bg-transparent py-1.5 text-sm tabular-nums';
  return (
    <div className="flex items-baseline gap-2" data-inspect-id={`${dataInspectPrefix}-score`}>
      <label className="text-xs text-[var(--muted)]">
        Score <span className="text-[var(--faint-2)]">— final round score, blank if none</span>
      </label>
      <input type="number" inputMode="numeric" min={0} max={10} step={1} aria-label="Score, your team" className={box}
        value={us} onChange={e => onChange(e.target.value, them)} />
      <span className="text-[var(--faint)]">–</span>
      <input type="number" inputMode="numeric" min={0} max={10} step={1} aria-label="Score, enemy team" className={box}
        value={them} onChange={e => onChange(us, e.target.value)} />
    </div>
  );
}

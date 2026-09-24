// Shared by LogMatch.tsx and MatchEditDrawer.tsx — the leaver control is two
// thin sliver buttons ("mine"/"theirs") under the Win/Loss row: tap the
// selected side again to clear back to null. Extracted 2026-09-24 when the
// edit drawer needed the identical control plus one extra state LogMatch
// never has to handle — a historical row logged before leaver_side existed,
// where leaver=1 but which side is unknown. That case renders with neither
// sliver lit and a different label, but a tap still resolves it into a
// normal mine/theirs pick (see MatchEditDrawer's `leaverUnknown` local state).
export interface LeaverSliverProps {
  value: 'mine' | 'theirs' | null;
  onToggle: (side: 'mine' | 'theirs') => void;
  /** True only for "leaver=1, side never recorded" rows — see file header. */
  unknown?: boolean;
  /** Distinguishes data-inspect-id's per caller (logmatch-leaver-side-*,
   *  matchEditDrawer-leaver-side-*) so the frontend map keeps one anchor per
   *  screen instead of two callers colliding on the same id. */
  dataInspectPrefix: string;
}

export default function LeaverSliver({ value, onToggle, unknown, dataInspectPrefix }: LeaverSliverProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-1 mt-1.5" data-inspect-id={`${dataInspectPrefix}-toggle`}>
        {(['mine', 'theirs'] as const).map(side => {
          const selected = value === side;
          return (
            <button
              key={side}
              type="button"
              onClick={() => onToggle(side)}
              aria-pressed={selected}
              aria-label={`Leaver on ${side === 'mine' ? 'my' : 'their'} team`}
              title={`Leaver — ${side === 'mine' ? 'my team' : 'their team'}`}
              data-inspect-id={`${dataInspectPrefix}-option`}
              style={{ '--sel': '245 158 11' } as React.CSSProperties}
              className={`h-1.5 rounded-full transition-all ${
                selected ? 'bg-[rgb(var(--sel))]' : 'bg-ow-border hover:bg-[rgb(var(--sel)/0.4)]'
              }`}
            />
          );
        })}
      </div>
      <div className="text-center text-[9px] text-[var(--faint-2)] mt-1 uppercase tracking-wide" data-inspect-id={`${dataInspectPrefix}-label`}>
        {unknown ? 'Leaver — side not recorded' : value ? `Leaver — ${value === 'mine' ? 'my team' : 'their team'}` : 'Leaver'}
      </div>
    </>
  );
}

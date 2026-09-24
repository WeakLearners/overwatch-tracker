import { RANK_TIER_RGB, rankTier, rankDivision, rankLabel } from '../types';

// The rank badge, in one place.
//
// It was written inline on Pre-Match and would have been written a second
// time for the log page's promote/demote row. Two copies of a badge whose
// whole job is to say "this is your rank right now" is how the two pages end
// up disagreeing after one of them is restyled. Same reason heroStatLabels
// and lib/lut.ts live where they do.
//
// The tier name is deliberately ink, not the tier colour. Measured on the
// badge fill, tier-coloured text runs 1.86:1 (Master) to 3.98:1 (Bronze) in
// light theme and fails on three tiers in dark. The fill, border and bottom
// rule already say which tier this is.
export default function RankBadge({
  rank, size = 'lg', dataInspectId,
}: {
  rank: number | null;
  size?: 'lg' | 'sm';
  dataInspectId?: string;
}) {
  const lg = size === 'lg';
  return (
    <div
      className={`${lg ? 'w-20' : 'w-12'} aspect-square rounded-lg border-2 grid place-content-center text-center select-none ${
        rank == null ? 'border-ow-border' : 'is-selected mode-fill'
      }`}
      data-inspect-id={dataInspectId}
      style={rank == null ? undefined : ({ '--sel': RANK_TIER_RGB[rankTier(rank)] } as React.CSSProperties)}
      title={rank == null ? 'No rank set' : rankLabel(rank)}
    >
      {rank == null ? (
        <span className={`${lg ? 'text-[10px]' : 'text-[8px]'} uppercase tracking-widest text-[var(--faint-2)] px-1 leading-tight`}>
          Set<br />rank
        </span>
      ) : (
        <>
          <span className={`${lg ? 'text-[9px]' : 'text-[7px]'} uppercase tracking-widest font-bold leading-none text-[var(--ink-2)]`}>
            {rankTier(rank)}
          </span>
          <span className={`${lg ? 'text-3xl' : 'text-xl'} num-display font-black leading-none ${lg ? 'mt-1' : 'mt-0.5'} text-[var(--ink)]`}>
            {rankDivision(rank)}
          </span>
        </>
      )}
    </div>
  );
}

// Lab verdict chip (design-language.md section 5). Words only, never green or red.
export interface Finding {
  rate: number; lo: number; hi: number; n: number;
  p: number | null; threshold: number; groupsTested: number;
  verdict: 'holds' | 'unreliable' | 'thin' | 'none';
}

const CHIP = {
  holds:      { text: '✓ Holds up',     cls: 'text-ow-blue' },
  unreliable: { text: '~ Not reliable', cls: 'text-amber-500' },
  thin:       { text: '· Too few games', cls: 'text-[var(--muted)]' },
} as const;

export function findingTooltip(f: Finding, against = 'the other games'): string {
  if (f.verdict === 'thin' || f.p === null) return `Fewer than 10 games, so not tested.`;
  return `p = ${f.p.toFixed(4)} against ${against}. Threshold ${f.threshold.toFixed(4)} (0.05 over ${f.groupsTested} ${f.groupsTested === 1 ? 'group' : 'groups'} tested).`;
}

export default function FindingChip({ finding, against }: { finding: Finding; against?: string }) {
  if (finding.verdict === 'none') return null;
  const c = CHIP[finding.verdict];
  return (
    <span data-inspect-id="finding-chip" title={findingTooltip(finding, against)} className={`text-xs font-bold whitespace-nowrap ${c.cls}`}>
      {c.text}
    </span>
  );
}

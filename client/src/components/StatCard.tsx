interface Props {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
  /** Decimal places + suffix when value is numeric (e.g. 1 + '%' for win rate). */
  decimals?: number;
  suffix?: string;
  dataInspectId?: string;
  /** Tighter padding + smaller numeral, for dense multi-tile readout rows. */
  compact?: boolean;
}

export default function StatCard({ label, value, sub, color, decimals = 0, suffix = '', dataInspectId = 'statCard-card', compact = false }: Props) {
  const grad = color === 'win' ? 'grad-win' : color === 'loss' ? 'grad-loss' : 'grad-neutral';
  return (
    <div className={`card ${compact ? '!p-4' : ''}`} data-inspect-id={dataInspectId}>
      <div className={`${compact ? 'text-[1.75rem]' : 'text-4xl'} font-black tracking-tight num-display ${grad}`}>
        {typeof value === 'number'
          ? `${value.toFixed(decimals)}${suffix}`
          : value}
      </div>
      <div className={`stat-label ${compact ? 'text-[10px] leading-snug' : ''}`}>{label}</div>
      {sub && <div className="text-xs text-[var(--faint)] mt-1">{sub}</div>}
    </div>
  );
}

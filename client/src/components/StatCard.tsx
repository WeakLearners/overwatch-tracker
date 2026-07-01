interface Props {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
  /** Decimal places + suffix when value is numeric (e.g. 1 + '%' for win rate). */
  decimals?: number;
  suffix?: string;
}

export default function StatCard({ label, value, sub, color, decimals = 0, suffix = '' }: Props) {
  const grad = color === 'win' ? 'grad-win' : color === 'loss' ? 'grad-loss' : 'grad-neutral';
  return (
    <div className="card">
      <div className={`text-4xl font-black tracking-tight num-display ${grad}`}>
        {typeof value === 'number'
          ? `${value.toFixed(decimals)}${suffix}`
          : value}
      </div>
      <div className="stat-label">{label}</div>
      {sub && <div className="text-xs text-[var(--faint)] mt-1">{sub}</div>}
    </div>
  );
}

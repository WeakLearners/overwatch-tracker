interface Props {
  winRate: number;
  games: number;
  showLabel?: boolean;
}

export default function WinRateBar({ winRate, games, showLabel = true }: Props) {
  const color = winRate >= 60 ? 'bg-emerald-500' : winRate >= 50 ? 'bg-ow-blue' : winRate >= 40 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-3">
      <div data-inspect-id="winRateBar-progress" className="flex-1 h-1.5 bg-ow-border rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(winRate, 100)}%` }} />
      </div>
      {showLabel && (
        <span data-inspect-id="winRateBar-percent-label" className={`text-sm font-semibold w-12 text-right ${winRate >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
          {winRate}%
        </span>
      )}
      <span data-inspect-id="winRateBar-games-badge" className="text-xs text-[var(--faint)] w-16">{games}g</span>
    </div>
  );
}

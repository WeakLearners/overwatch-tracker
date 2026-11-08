import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useMatch } from '../contexts/MatchContext';

interface ControlArm { on: boolean; sens: number | null; minutes: number; target: number }

// Header chip (every page): shown only while the home-sens baseline (comp control arm,
// server/src/lib/controlArm.ts) is on, so Sean can always tell comp is being played at one sens.
// It reads the same /api/control-arm as ControlArmCard; the card's save calls revalidateAll(),
// which refetches this hook too, and matchLoggedSignal refreshes the minutes after a match.
export default function ControlArmChip() {
  const { matchLoggedSignal } = useMatch();
  const { data } = useApi<ControlArm>('/api/control-arm', [matchLoggedSignal]);
  if (!data?.on || data.sens == null) return null;
  const text = `Home sens ${data.sens} · baseline ${data.minutes}/${data.target} min`;
  return (
    <Link
      to="/sens#home-sens-baseline" title={`${text}. Click to open the Home-sens baseline card.`}
      data-inspect-id="app-control-arm-chip"
      className="min-w-0 truncate whitespace-nowrap border border-ow-accent text-ow-accent rounded-md px-2.5 py-1 text-xs font-semibold num-display hover:brightness-110 transition-all"
    >
      {text}
    </Link>
  );
}

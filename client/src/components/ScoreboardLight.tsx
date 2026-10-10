import type { LivePayload } from '../lib/scoreboardFill';

// "Scoreboard received" light at the top of the Log Match card. Green while a
// scoreboard group (Summary + Teams + Personal screenshots) waits for its match
// and was not already logged. The fill itself runs in LogMatch; this is the
// signal only; LogMatch fills blank fields on its own.
export default function ScoreboardLight({ live }: { live: LivePayload | null }) {
  const green = live?.light === 'green' && !!live.fill;
  const p = live?.fill?.pages;
  const pages = p ? [p.summary && 'summary', p.teams && 'teams', p.personal.length > 0 && `${p.personal.length} personal`].filter(Boolean).join(', ') : '';
  return (
    <div className="flex items-baseline gap-2 min-w-0" data-inspect-id="logmatch-scoreboard-light">
      <span
        aria-hidden="true"
        className={`inline-block w-2 h-2 rounded-full self-center shrink-0 ${green ? 'bg-emerald-500' : 'bg-[var(--faint-2)]'}`}
        data-inspect-id="logmatch-scoreboard-light-dot"
      />
      <span className="text-xs text-[var(--faint)] truncate" role="status">
        {green ? `Scoreboard received (${pages})` : 'No scoreboard waiting'}
      </span>
    </div>
  );
}

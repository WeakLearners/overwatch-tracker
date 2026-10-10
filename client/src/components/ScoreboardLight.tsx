import type { LivePayload } from '../lib/scoreboardFill';

// Pipeline light at the right edge of the Recording-as row (ml-auto, Sean's request).
// The server decides the stage (GET /api/scoreboards/live, lib/scoreboardStage.ts);
// this only draws it. The dot pulses slowly (.stage-pulse in index.css, off under
// reduced motion) while detected or partial.
//   idle grey, detected amber, partial sky, ready green (the form auto-fills in
//   LogMatch), problem red. The fill is driven by `light`/`fill`, not by the stage.
const DOT: Record<string, string> = {
  idle: 'bg-[var(--faint-2)]', detected: 'bg-amber-500', partial: 'bg-sky-500', ready: 'bg-emerald-500', problem: 'bg-red-500',
};
const list = (p: NonNullable<LivePayload['pages']>) =>
  [p.summary && 'summary', p.teams && 'teams', p.personal > 0 && `${p.personal} personal`].filter(Boolean).join(', ');

export function lightText(live: LivePayload | null): { stage: string; text: string } {
  const stage = live?.stage ?? 'idle';
  const p = live?.pages ?? null;
  switch (stage) {
    case 'detected': return { stage, text: `Reading ${live?.reading ?? 1} screenshot${live?.reading === 1 ? '' : 's'}…` };
    case 'partial': return { stage, text: `${p ? list(p) : 'Pages'} read, waiting for Summary` };
    case 'ready': return { stage, text: `Scoreboard filled (${p ? list(p) : ''})` };
    case 'problem': return { stage, text: `Screenshot failed: ${live?.reason ?? 'unreadable'}` };
    default: return { stage: 'idle', text: live?.ignored ? `No scoreboard waiting (${live.ignored} other image${live.ignored === 1 ? '' : 's'} ignored)` : 'No scoreboard waiting' };
  }
}

export default function ScoreboardLight({ live }: { live: LivePayload | null }) {
  const { stage, text } = lightText(live);
  return (
    <div className="flex items-baseline gap-2 min-w-0 ml-auto" data-inspect-id="logmatch-scoreboard-light">
      <span
        aria-hidden="true"
        className={`inline-block w-2 h-2 rounded-full self-center shrink-0 ${DOT[stage]}${stage === 'detected' || stage === 'partial' ? ' stage-pulse' : ''}`}
        data-inspect-id="logmatch-scoreboard-light-dot"
      />
      <span className="text-xs text-[var(--faint)] truncate" role="status" title={text}>{text}</span>
    </div>
  );
}

import { useLayoutEffect, useRef, useState } from 'react';
import type { LivePayload } from '../lib/scoreboardFill';

// Pipeline light at the right edge of the Recording-as row (ml-auto, Sean's request).
// Fixed width (w-64) so the dot and the row never move when the stage text changes.
// Text that does not fit scrolls as a slow marquee (.sb-marq-run in index.css, CSS
// transform only); under reduced motion it truncates with an ellipsis instead.
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

const SPEED = 30; // px per second
const HOLD = 0.75; // seconds per side; the reverse leg doubles it to 1.5 s at each end

export default function ScoreboardLight({ live }: { live: LivePayload | null }) {
  const { stage, text } = lightText(live);
  const viewRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [dist, setDist] = useState(0);

  useLayoutEffect(() => {
    const view = viewRef.current, inner = textRef.current;
    if (!view || !inner) return;
    const measure = () => setDist(Math.max(0, Math.ceil(inner.offsetWidth - view.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(view);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [text]);

  const travel = dist / SPEED;
  const dur = travel + 2 * HOLD;
  const pct = Math.round((HOLD / dur) * 1000) / 10;
  return (
    <div className="flex items-center gap-2 w-64 shrink-0 ml-auto" data-inspect-id="logmatch-scoreboard-light">
      <span
        aria-hidden="true"
        className={`inline-block w-2 h-2 rounded-full shrink-0 ${DOT[stage]}${stage === 'detected' || stage === 'partial' ? ' stage-pulse' : ''}`}
        data-inspect-id="logmatch-scoreboard-light-dot"
      />
      {dist > 0 && <style>{`@keyframes sb-marq{0%,${pct}%{transform:translateX(0)}${100 - pct}%,100%{transform:translateX(calc(var(--marq-dist) * -1))}}`}</style>}
      <span ref={viewRef} className="sb-marq-view flex-1 min-w-0 overflow-hidden whitespace-nowrap text-xs text-[var(--faint)]" role="status" title={text}>
        <span
          ref={textRef}
          className={`sb-marq-text inline-block${dist > 0 ? ' sb-marq-run' : ''}`}
          style={dist > 0 ? ({ '--marq-dist': `${dist}px`, '--marq-dur': `${dur}s` } as React.CSSProperties) : undefined}
        >{text}</span>
      </span>
    </div>
  );
}

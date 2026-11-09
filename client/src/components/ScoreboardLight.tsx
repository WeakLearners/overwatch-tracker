import type { LivePayload } from '../lib/scoreboardFill';

// The light is the dot + text in a pill that is also the Read button (Recording-as row, spans from column 2 to the
// Reset-all segment edge). Recheck is the segment under Reset all. Read starts the vision reads;
// the watcher only counts new images.
// The status text is short and truncates with an ellipsis; the full text is the hover tooltip (OW-0002).
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

/** Short status line for the row: a stage word and counts. No scrolling. */
export function lightText(live: LivePayload | null): { stage: string; text: string } {
  const stage = live?.stage ?? 'idle';
  const un = live?.unread ?? 0;
  const sk = live?.skipped ?? 0;
  const head =
    stage === 'detected' ? `Reading ${live?.reading ?? 1}…`
    : stage === 'partial' ? 'Waiting for Summary'
    : stage === 'ready' ? 'Scoreboard filled'
    : stage === 'problem' ? 'Screenshot failed'
    : un > 0 ? '' : 'Nothing waiting';
  const parts = [head, un > 0 && stage !== 'detected' ? `${un} to read` : '', sk > 0 ? `${sk} skipped` : ''].filter(Boolean);
  return { stage, text: parts.join(' · ') };
}
/** The long version, kept for the hover tooltip so no detail is lost. */
export function lightDetail(live: LivePayload | null): string {
  const stage = live?.stage ?? 'idle';
  const un = live?.unread ?? 0;
  const base = lightText0(stage, live, live?.pages ?? null);
  if (un === 0 || stage === 'detected') return withSkipped(base, live);
  const n = `${un} new image${un === 1 ? '' : 's'} to read`;
  return withSkipped(stage === 'idle' ? n : `${base} · ${n}`, live);
}
/** Images the watcher left out on purpose (unreadable, or waiting out a failed read). Recheck retries them. */
function withSkipped(text: string, live: LivePayload | null): string {
  const sk = live?.skipped ?? 0;
  return sk > 0 ? `${text} · ${sk} skipped (Recheck retries)` : text;
}
function lightText0(stage: string, live: LivePayload | null, p: LivePayload['pages']): string {
  switch (stage) {
    case 'detected': return `Reading ${live?.reading ?? 1} screenshot${live?.reading === 1 ? '' : 's'}…`;
    case 'partial': return `${p ? list(p) : 'Pages'} read, waiting for Summary`;
    case 'ready': return `Scoreboard filled (${p ? list(p) : ''})`;
    case 'problem': return `Screenshot failed: ${live?.reason ?? 'unreadable'}`;
    default: return live?.ignored ? `No scoreboard waiting (${live.ignored} other image${live.ignored === 1 ? '' : 's'} ignored)` : 'No scoreboard waiting';
  }
}

const SEG = 'h-8 w-full px-3 text-xs font-semibold leading-tight text-[var(--faint)] border-2 border-ow-border transition-colors';
const BOX: Record<string, string> = {
  idle: 'bg-[var(--field-bg)] border-ow-border',
  detected: 'bg-amber-500/15 border-amber-500/60',
  partial: 'bg-sky-500/15 border-sky-500/60',
  ready: 'bg-emerald-500/15 border-emerald-500/60',
  problem: 'bg-red-500/15 border-red-500/60',
};

/** Recheck: the right-hand segment under Reset all, joined to the status pill. Keeps its width in both labels. */
export function ScoreboardRecheck({ live, onRecheck, rechecking = false, reading = false }: { live: LivePayload | null; onRecheck?: () => void; rechecking?: boolean; reading?: boolean }) {
  return (
    <button
      type="button"
      onClick={onRecheck}
      disabled={!onRecheck || rechecking || reading || live?.stage === 'detected'}
      title="Rescan the share for new images. Nothing is read, moved or deleted."
      data-inspect-id="logmatch-scoreboard-recheck"
      className={`${SEG} rounded-md rounded-l-none border-l-0 hover:text-ow-accent hover:border-ow-accent/50 disabled:opacity-40 disabled:hover:text-[var(--faint)] disabled:hover:border-ow-border disabled:cursor-not-allowed`}
    >
      <span className="grid text-center">
        <span className={`col-start-1 row-start-1 ${rechecking ? 'invisible' : ''}`}>Recheck</span>
        <span className={`col-start-1 row-start-1 ${rechecking ? '' : 'invisible'}`}>Checking…</span>
      </span>
    </button>
  );
}

/** The status pill is also the Read button. aria-disabled (not disabled) keeps the status at full opacity;
 *  the click does nothing when there is nothing to read. */
export default function ScoreboardLight({ live, onRead, reading = false }: { live: LivePayload | null; onRead?: () => void; reading?: boolean }) {
  const { stage, text } = lightText(live);
  const detail = lightDetail(live);
  const canRead = !!onRead && !!live?.unread && !reading && live?.stage !== 'detected';
  return (
    <button
      type="button"
      aria-disabled={!canRead}
      onClick={() => { if (canRead) onRead!(); }}
      title={canRead ? `${detail}. Click to read the new screenshots now.` : detail}
      data-inspect-id="logmatch-scoreboard-refresh"
      className={`h-8 w-full min-w-0 border-2 rounded-md rounded-r-none px-3 flex items-center transition-colors ${BOX[stage]} ${canRead ? 'cursor-pointer hover:border-ow-accent/50' : 'cursor-default'}`}
    >
      <span className="flex items-center gap-2 min-w-0 w-full" data-inspect-id="logmatch-scoreboard-light" role="status">
        <span
          aria-hidden="true"
          className={`inline-block w-3 h-3 rounded-full shrink-0 ${DOT[stage]}${stage === 'detected' || stage === 'partial' ? ' stage-pulse' : ''}`}
          data-inspect-id="logmatch-scoreboard-light-dot"
        />
        <span className="flex-1 min-w-0 truncate text-left text-xs font-semibold leading-tight text-[var(--ink)]">{text}</span>
      </span>
    </button>
  );
}

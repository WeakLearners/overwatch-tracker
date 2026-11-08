import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { sensChangesNeeded, isStudyQueueMode, type SensChange, type SensChangeActive } from '../lib/blind';

// The one "Change sens" pop-up, mounted once in App.tsx. Any page calls
// checkSensChange() after a mutation that can move a hero's test target sens
// (match save/edit/delete, test-set start/advance/resume). It reads the
// state the server holds now and shows the pop-up for the listed heroes only.
let show: ((c: SensChange[]) => void) | null = null;

export async function checkSensChange(heroes: string[], queueMode: string | null | undefined = 'comp_role'): Promise<void> {
  const list = [...new Set(heroes.filter(h => !!h))];
  if (list.length === 0 || !show) return;
  try {
    const d = await fetch('/api/blind/state').then(r => r.json()) as { actives?: SensChangeActive[] };
    // Comp control arm: the target for every hero is the one home sens, not its trial stage.
    // Only a hero whose last logged sens is known and differs is asked to change.
    const arm = isStudyQueueMode(queueMode)
      ? await fetch('/api/control-arm').then(r => r.json()).catch(() => null) as { on: boolean; sens: number | null } | null
      : null;
    const actives: SensChangeActive[] = arm?.on && arm.sens != null
      ? list.flatMap(hero => {
          const a = (d.actives ?? []).find(x => x.hero === hero);
          return a?.last_sens != null ? [{ hero, sens: arm.sens as number, last_sens: a.last_sens }] : [];
        })
      : d.actives ?? [];
    const changes = sensChangesNeeded(list, actives, queueMode);
    if (changes.length > 0) show(changes);
  } catch { /* the pop-up is a convenience; a failed read must not break the save */ }
}

export default function SensChangeModal() {
  const [sensChanges, setSensChanges] = useState<SensChange[]>([]);
  useEffect(() => { show = setSensChanges; return () => { show = null; }; }, []);
  if (sensChanges.length === 0) return null;
  return createPortal(
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" role="alertdialog" aria-modal="true" aria-labelledby="sens-change-title" data-inspect-id="sens-change-modal">
          <div className="card w-full max-w-sm mx-4 text-center">
            <h2 id="sens-change-title" className="text-sm card-title mb-3">Change sens</h2>
            <div className="flex flex-col gap-4 mb-4">
              {sensChanges.map(c => (
                <div key={c.hero}>
                  <div className="text-sm font-semibold text-[var(--ink)]">{c.hero}</div>
                  <div className="text-xs text-[var(--muted)]">last game: {c.last ?? 'none'}</div>
                  <div className="text-xs text-[var(--muted)] mt-1">set now:</div>
                  <div className="text-4xl font-bold tabular-nums text-[var(--ink)] leading-tight">{c.target}</div>
                </div>
              ))}
            </div>
            <button
              type="button" autoFocus
              onClick={() => setSensChanges([])}
              className="btn-primary w-full py-2 text-sm"
              data-inspect-id="sens-change-ack"
            >I set it in game</button>
          </div>
        </div>,
    document.body,
  );
}

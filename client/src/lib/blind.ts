// Client mirror of server/src/lib/blind.ts's isStudyQueueMode. Kept in sync
// by hand, same convention as lib/aim.ts's MOUSE_DPI mirror.
//
// Switched off 2026-09-23 at Sean's request: only Competitive matches earn a
// stage-test credit now, for every role — Support's QP exception (thin-data
// era, retired server-side 2026-08-23) is gone too. This is the ONE place
// the client checks that condition; LogMatch.tsx's sensForHero calls it
// instead of re-deriving a role/queue check so the displayed sens can never
// again imply a QP match is being credited when the server has already
// stopped crediting it.
export function isStudyQueueMode(queueMode: string | null | undefined): boolean {
  return (queueMode ?? 'comp_role') !== 'qp_role';
}

// "Change sens" pop-up decision (Prematch, 2026-10-13). A selected hero needs a
// sens change when it has an active test sens and that sens differs from the
// sens of its last logged game, or there is no earlier logged game with a known
// sens (last = null). Compared at 2 decimals, the precision the UI shows.
// Quickplay never shows it: tests do not count in QP. `ackKey` identifies the
// (hero, target, last match) triple an acknowledgement applies to, so a new
// stage target or a newly logged match re-arms the pop-up.
export interface SensChangeActive { hero: string | null; sens: number | null; last_sens?: number | null; last_match_id?: number | null }
export interface SensChange { hero: string; target: string; last: string | null; ackKey: string }

export function sensChangesNeeded(
  pickedHeroes: string[],
  actives: SensChangeActive[],
  queueMode: string | null | undefined,
  acked: ReadonlySet<string>,
): SensChange[] {
  if (!isStudyQueueMode(queueMode)) return [];
  const out: SensChange[] = [];
  for (const hero of pickedHeroes) {
    const a = actives.find(x => x.hero === hero);
    if (!a || a.sens == null) continue;
    const target = a.sens.toFixed(2);
    const last = a.last_sens != null ? a.last_sens.toFixed(2) : null;
    if (last === target) continue;
    const ackKey = `${hero}|${target}|${a.last_match_id ?? 'none'}`;
    if (acked.has(ackKey)) continue;
    out.push({ hero, target, last, ackKey });
  }
  return out;
}

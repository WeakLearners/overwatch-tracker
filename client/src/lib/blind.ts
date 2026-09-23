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

// Which queue modes count toward the sensitivity study. Neutral on purpose:
// the tracker (routes/blind.ts, experiments/controller.ts) and the lab readers
// (routes/aimAnalysis.ts, scripts/nightlyAnalysis.ts) both import it, so it
// must not live in lib/blind.ts, which is study-side. See the import-boundary
// test in lab/importBan.test.ts.

// ── Queue-mode study eligibility ────────────────────────────────────────────
// Switched off 2026-09-23 at Sean's request: from now on ONLY Competitive
// matches earn a stage-test credit, for every role. Support briefly had a QP
// exception (added while support data was still thin, retired 2026-08-23 via
// commit 7d80e90 once support was on the same comp-only phase DPS already
// was) — before that, both DPS and Support QP matches credited a stage.
// matches.ts's insert and roster-recompute paths both call this at write
// time to decide whether to look up an active stage at all.
//
// The same condition also has to run at READ time: 469 blind_credits rows
// (2026-07-14 -> 2026-08-21, spanning both the pre-retirement DPS-only era
// and the brief Support-QP-exception era) were written under the old rule
// and are QP. Never delete or modify those rows — every analysis surface
// that reads blind_credits (SensAnalysis/byScale, curve fit, per-stage
// accuracy, findings/sweep, nightly report's bracket reads) calls this same
// function, joined to the match's queue_mode, to exclude them from the
// numbers without touching the rows themselves. Sean's decision 2026-09-23;
// reverse by removing the call sites that apply this filter to a read.
export function isStudyQueueMode(queueMode: string | null | undefined): boolean {
  return (queueMode ?? 'comp_role') !== 'qp_role';
}

// Same condition as isStudyQueueMode above, as a raw SQL fragment for the
// read-path queries that filter blind_credits in SQL rather than in JS
// (an in-process filter can't call a JS function from inside a prepared
// statement). Every query that interpolates this must alias the joined
// matches row as `m`. Kept textually identical to isStudyQueueMode on
// purpose — if one changes, the other must too.
export const NOT_QP_SQL = "COALESCE(m.queue_mode, 'comp_role') != 'qp_role'";

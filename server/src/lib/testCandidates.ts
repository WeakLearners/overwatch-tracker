// Test candidates (OW-0004). A hero that has logged matches but is not in the sens-test roster is a
// candidate. It may join active testing only after CANDIDATE_MIN_QP Quick Play matches (Sean, 2026-11-08:
// Quick Play only, 25). Counts come from `matches`; no new column. Nothing here starts a study.
import type { DatabaseSync } from 'node:sqlite';

export const CANDIDATE_MIN_QP = 25;

export interface TestCandidate { hero: string; qp_matches: number; eligible: boolean }

/** True when a hero with this many Quick Play matches may be added to active testing. */
export const candidateEligible = (qpMatches: number): boolean => qpMatches >= CANDIDATE_MIN_QP;

/** Phase tag of the newest set that carries one (the same rule as currentPhaseKey in routes/blind.ts). */
function currentPhase(db: DatabaseSync): string | null {
  const r = db.prepare(`SELECT phase FROM blind_stage_sets WHERE phase IS NOT NULL AND TRIM(phase) <> '' ORDER BY id DESC LIMIT 1`).get() as { phase: string } | undefined;
  return r?.phase ?? null;
}

/** Heroes already in the roster: a live or paused test set, or a hero of the CURRENT phase (its sets or its custom plan). Old phases do not count. */
export function rosterHeroes(db: DatabaseSync): Set<string> {
  const out = new Set<string>();
  for (const r of db.prepare(`SELECT DISTINCT hero FROM blind_stage_sets WHERE hero IS NOT NULL AND (active = 1 OR paused_at IS NOT NULL)`).all() as { hero: string }[]) out.add(r.hero);
  const phase = currentPhase(db);
  if (phase) {
    for (const r of db.prepare(`SELECT DISTINCT hero FROM blind_stage_sets WHERE hero IS NOT NULL AND phase = :phase`).all({ phase }) as { hero: string }[]) out.add(r.hero);
    for (const p of db.prepare(`SELECT plan FROM custom_phases WHERE key = :phase`).all({ phase }) as { plan: string }[]) {
      try { for (const h of JSON.parse(p.plan) as { hero?: string }[]) if (h?.hero) out.add(h.hero); } catch { /* a bad plan row adds nothing */ }
    }
  }
  return out;
}

/** Quick Play matches logged on each hero (the match's first hero). */
export function qpMatchCounts(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare(`SELECT hero, COUNT(*) n FROM matches WHERE queue_mode = 'qp_role' AND hero IS NOT NULL AND TRIM(hero) <> '' GROUP BY hero`).all() as { hero: string; n: number }[];
  return new Map(rows.map(r => [r.hero, Number(r.n)]));
}

/** Heroes with logged matches (any mode) and no roster slot, most Quick Play first. */
export function listTestCandidates(db: DatabaseSync): TestCandidate[] {
  const roster = rosterHeroes(db);
  const qp = qpMatchCounts(db);
  const played = db.prepare(`SELECT DISTINCT hero FROM matches WHERE hero IS NOT NULL AND TRIM(hero) <> ''`).all() as { hero: string }[];
  return played
    .map(p => p.hero)
    .filter(h => !roster.has(h))
    .map(h => ({ hero: h, qp_matches: qp.get(h) ?? 0, eligible: candidateEligible(qp.get(h) ?? 0) }))
    .sort((a, b) => b.qp_matches - a.qp_matches || a.hero.localeCompare(b.hero));
}

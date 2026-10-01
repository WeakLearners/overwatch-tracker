// Who earns what from one competitive match, under the 2026-10-01 rules
// (Sean, verbatim: "Count every minute played for each hero in competitive
// (min 1). Wins/losses are credited to any and all heroes that played at
// least one third of that match."). These REPLACE the 2026-09-24 pair (one
// hero with >= 2/3 of play time earns the credit; the matches_by_hero view
// drops a hero on for <= 20%).
//
// Two independent questions, answered per hero from that hero's own
// aim_stats_heroes.duration_min:
//   MINUTES — duration >= 1 minute: every one of the hero's minutes counts
//             toward its own test's 60-minute block clock, whatever its
//             share of the match. Under a minute counts nothing.
//   RESULT  — duration >= 1/3 of the match's total play time: the match's
//             win/loss counts as one game on the hero's own set.
// Stored as blind_credits.counts_minutes / counts_result, one row per hero
// that qualifies for either. Every game/result reader filters
// counts_result = 1; the block clock filters counts_minutes = 1.
export const MIN_CREDIT_MINUTES = 1;

export interface HeroMinutes { hero: string; duration_min: number }
export interface CreditFlags { hero: string; countsResult: 0 | 1; countsMinutes: 0 | 1 }

// `rows` are the match's per-hero minutes (any order). Before the Aim Stats
// form is saved there are no minutes at all: the slot-1 hero holds the credit
// (both flags) until the form says otherwise. Integer compare for the 1/3
// line (minutes * 3 >= total), never a 0.333 float: 5 of 15 minutes is
// exactly one third and must pass.
export function creditFlagsFor(rows: HeroMinutes[], slot1Hero: string): CreditFlags[] {
  const timed = rows.filter(r => r.duration_min > 0);
  const total = timed.reduce((a, r) => a + r.duration_min, 0);
  if (total === 0) return [{ hero: slot1Hero, countsResult: 1, countsMinutes: 1 }];
  const out: CreditFlags[] = [];
  for (const r of timed) {
    const countsMinutes = r.duration_min >= MIN_CREDIT_MINUTES ? 1 : 0;
    const countsResult = r.duration_min * 3 >= total ? 1 : 0;
    if (countsMinutes || countsResult) out.push({ hero: r.hero, countsResult, countsMinutes });
  }
  return out;
}

// Pure, framework-free helper for the "which PUT fields describe a slot-2/3
// roster edit" decision TodayMatchEditForm's save() makes
// (client/src/pages/LogMatch.tsx). Extracted so the rule has a test that
// doesn't need to render the form: a real roster change (a hero added,
// removed, or swapped in slots 2/3) sends `heroes` — the full-replace PUT
// field — while a pure sens correction on the same roster sends `heroSens`
// instead (the hero-keyed field SensLog.tsx's backfill form already uses).
// That split matters because `heroes` sets heroesProvided=true server-side
// (matches.ts), which re-runs syncStageCredits' roster recompute — exactly
// what would silently overwrite a hand-edited sens for a hero under an
// active stage test. `heroSens` never touches the roster, so it never
// triggers that recompute at all.
//
// MatchEditDrawer.tsx makes the same decision independently (added
// 2026-09-24, same day) but is intentionally NOT wired to this module — it's
// unreachable dead code (see its file header) and out of scope to refactor
// here. If it's ever brought back, point it at this helper too rather than
// letting the two copies drift.
export interface RosterEditInput {
  /** Slot 2/3 hero names in order, '' for an empty slot — same shape
   *  LogMatch's `switchHeroes` state already uses. */
  slotHeroes: [string, string];
  /** Matching per-slot sens text inputs, same shape as `slotHeroes`. */
  slotSens: [string, string];
  /** The hero names slots 2/3 were loaded with, compacted (no ''). */
  originalHeroNames: string[];
  roleOf: (hero: string) => string;
}

export interface RosterEditPayload {
  heroes?: Array<{ hero: string; role: string; sens?: number }>;
  heroSens?: Record<string, number>;
}

// Same "blank means unanswered, don't parse it as 0" convention SensLog.tsx's
// backfill form and MatchEditDrawer.tsx use for sens fields.
const num = (s: string) => (s.trim() === '' ? null : parseFloat(s));

export function buildRosterEditPayload({ slotHeroes, slotSens, originalHeroNames, roleOf }: RosterEditInput): RosterEditPayload {
  const currentNames = slotHeroes.filter((h): h is string => !!h);
  const rosterChanged =
    currentNames.length !== originalHeroNames.length ||
    currentNames.some((h, i) => h !== originalHeroNames[i]);

  if (rosterChanged) {
    const heroes = slotHeroes
      .map((h, i) => (h ? { h, sensStr: slotSens[i] } : null))
      .filter((e): e is { h: string; sensStr: string } => e !== null)
      .map(({ h, sensStr }) => {
        const n = num(sensStr);
        return n != null ? { hero: h, role: roleOf(h), sens: n } : { hero: h, role: roleOf(h) };
      });
    return { heroes };
  }

  if (currentNames.length > 0) {
    const heroSens: Record<string, number> = {};
    slotHeroes.forEach((h, i) => {
      if (!h) return;
      const n = num(slotSens[i]);
      if (n != null) heroSens[h] = n;
    });
    return Object.keys(heroSens).length > 0 ? { heroSens } : {};
  }

  return {};
}

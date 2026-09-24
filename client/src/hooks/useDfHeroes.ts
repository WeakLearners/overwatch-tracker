import { useApi } from './useApi';

// GET /api/df — one row per role that has a Designated Fallback (a role's
// safe pick when nothing else fits; never earns test credit, never has a
// test set opened on it). See server/src/db/schema.ts's df_heroes comment.
export interface DfMap { [role: string]: { hero: string; sens: number } }

export function useDfHeroes(): DfMap {
  const { data } = useApi<DfMap>('/api/df');
  return data ?? {};
}

// hero -> true if it's ANY role's DF, regardless of which role a given
// dropdown is currently scoped to — mirrors server lib/df.ts's isDfHero.
export function dfHeroSet(df: DfMap): Set<string> {
  return new Set(Object.values(df).map(d => d.hero));
}

// The fixed DF sens for a given hero name, if it's a DF for any role — used
// wherever "what sens is this hero at" needs to prefer the DF's own fixed
// value over whatever a stage lookup or manual fallback would otherwise show
// (see matches.ts's dfSensForHero on the server, same rule).
export function dfSensForHeroName(hero: string, df: DfMap): number | undefined {
  return Object.values(df).find(d => d.hero === hero)?.sens;
}

// Appends a small "◆ DF" badge to an already-formatted hero label (e.g. one
// that already carries the "(N) today" count suffix) — `hero` is the plain
// hero name used to check df_heroes, kept separate from `label` so callers
// don't have to un-format their own display string first. The diamond glyph
// (rather than a mid-dot) is what distinguishes a DF pick from a regular
// hero at a glance app-wide — LogMatch, MatchEditDrawer, and Prematch's
// hero picker all render the same mark through this one function.
export function withDfBadge(label: string, df: DfMap, hero: string): string {
  return dfHeroSet(df).has(hero) ? `${label} ◆ DF` : label;
}

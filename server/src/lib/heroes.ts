// Hero reference data for the server. Derived from server/data/roster.json
// (see roster.ts); the export names and shapes are unchanged. The advisor and
// blind.ts both import it from here.
import { HEROES_BY_ROLE } from './roster';
export { HEROES_BY_ROLE };
export function ALL_HEROES_BY_ROLE(roles: string[]): string[] {
  return roles.flatMap(r => HEROES_BY_ROLE[r] ?? []);
}

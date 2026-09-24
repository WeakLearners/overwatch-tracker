import { getDb } from '../db/schema';

// Designated Fallback (DF) heroes — see schema.ts's df_heroes table comment
// for the full rationale. One row per role; a role absent from the table has
// no DF. Read fresh every call (this table is tiny and changes rarely, same
// justification as player_ranks reading straight off the DB rather than
// caching).

export interface DfHero {
  role: string;
  hero: string;
  sens: number;
}

export function getDfHeroes(db: ReturnType<typeof getDb>): DfHero[] {
  return db.prepare('SELECT role, hero, sens FROM df_heroes').all() as unknown as DfHero[];
}

// True if `hero` is ANY role's designated fallback. DF status is a property
// of the hero name, not of the role a given match logs them under — Soldier:
// 76 is DF whether or not the surrounding query happens to know it's DPS.
export function isDfHero(db: ReturnType<typeof getDb>, hero: string): boolean {
  const row = db.prepare('SELECT 1 FROM df_heroes WHERE hero = :hero').get({ hero });
  return !!row;
}

// The DF hero for a given role, if one exists.
export function dfHeroForRole(db: ReturnType<typeof getDb>, role: string): DfHero | undefined {
  return db.prepare('SELECT role, hero, sens FROM df_heroes WHERE role = :role').get({ role }) as DfHero | undefined;
}

// This hero's own fixed DF sens, if it's a DF for any role — undefined if
// it's not a DF at all. Looked up by hero name, not role: matches.ts needs
// "is THIS hero name the fallback" regardless of which role a given match
// row happens to log it under.
export function dfSensForHero(db: ReturnType<typeof getDb>, hero: string): number | undefined {
  const row = db.prepare('SELECT sens FROM df_heroes WHERE hero = :hero').get({ hero }) as { sens: number } | undefined;
  return row?.sens;
}

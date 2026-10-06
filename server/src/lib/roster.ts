// The one hero/map roster. Source of truth is server/data/roster.json; the
// client bundles a copy and refreshes it from GET /api/roster. HEROES_BY_ROLE
// and MAPS_BY_NAME (heroes.ts, maps.ts) are views of it, refilled in place
// after an update so existing importers see the change without a restart.
import { readDataJson, writeDataJson } from './dataFiles';

export interface RosterHero { name: string; role: string; addedSeason: string | null }
export interface RosterMap { name: string; short: string; mode: string; retired: boolean }
export interface Roster { heroes: RosterHero[]; maps: RosterMap[] }

export const ROLES = ['DPS', 'Support', 'Tank'];
export const MAP_MODES = ['Control', 'Hybrid', 'Escort', 'Push', 'Flashpoint', 'Clash'];

export function readRoster(): Roster {
  return readDataJson<Roster>('roster.json');
}

export function writeRoster(r: Roster): void {
  const heroes = [...r.heroes].sort((a, b) => a.name.localeCompare(b.name));
  const maps = [...r.maps].sort((a, b) => a.name.localeCompare(b.name));
  writeDataJson('roster.json', { heroes, maps });
  syncRosterViews();
}

export const HEROES_BY_ROLE: Record<string, string[]> = {};
export const MAPS_BY_NAME: Record<string, string> = {};

export function syncRosterViews(): void {
  const r = readRoster();
  for (const k of Object.keys(HEROES_BY_ROLE)) delete HEROES_BY_ROLE[k];
  for (const role of ROLES) {
    HEROES_BY_ROLE[role] = r.heroes.filter(h => h.role === role).map(h => h.name).sort((a, b) => a.localeCompare(b));
  }
  for (const k of Object.keys(MAPS_BY_NAME)) delete MAPS_BY_NAME[k];
  for (const m of [...r.maps].sort((a, b) => a.name.localeCompare(b.name))) MAPS_BY_NAME[m.name] = m.mode;
}
syncRosterViews();

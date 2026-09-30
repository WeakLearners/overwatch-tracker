// Static list of all heroes by role — kept in sync with the client's HEROES map.
// (Server-side so we don't depend on importing client code.) Hero reference
// data belongs to the tracker; the advisor and blind.ts both import it from here.
export const HEROES_BY_ROLE: Record<string, string[]> = {
  DPS: ['Anran', 'Ashe', 'Bastion', 'Cassidy', 'Echo', 'Emre', 'Freja', 'Genji', 'Hanzo', 'Junkrat', 'Mei', 'Pharah', 'Reaper', 'Shion', 'Sierra', 'Sojourn', 'Soldier: 76', 'Sombra', 'Symmetra', 'Torbjörn', 'Tracer', 'Vendetta', 'Venture', 'Widowmaker'],
  Support: ['Ana', 'Baptiste', 'Brigitte', 'Illari', 'Jetpack Cat', 'Juno', 'Kiriko', 'Lifeweaver', 'Lúcio', 'Mercy', 'Mizuki', 'Moira', 'Wuyang', 'Zenyatta'],
  Tank: ['D.Mon', 'D.Va', 'Domina', 'Doomfist', 'Hazard', 'Junker Queen', 'Mauga', 'Orisa', 'Ramattra', 'Reinhardt', 'Roadhog', 'Sigma', 'Winston', 'Wrecking Ball', 'Zarya'],
};
export function ALL_HEROES_BY_ROLE(roles: string[]): string[] {
  return roles.flatMap(r => HEROES_BY_ROLE[r] ?? []);
}

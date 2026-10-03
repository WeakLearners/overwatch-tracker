// Map reference list, server side, so the v1 manifest does not depend on client
// code. Kept in sync with MAPS in client/src/types/index.ts (same reason as
// heroes.ts). Map name -> mode.
export const MAPS_BY_NAME: Record<string, string> = {
  Aatlis: 'Flashpoint', 'Antarctic Peninsula': 'Control',
  'Blizzard World': 'Hybrid', Busan: 'Control', 'Circuit Royal': 'Escort',
  Colosseo: 'Push', Dorado: 'Escort', Eichenwalde: 'Hybrid',
  Esperanca: 'Push', 'Watchpoint: Gibraltar': 'Escort', Havana: 'Escort',
  Hollywood: 'Hybrid', Ilios: 'Control', Junkertown: 'Escort',
  "King's Row": 'Hybrid', 'Lijiang Tower': 'Control', Midtown: 'Hybrid',
  Nepal: 'Control', 'Neon Junction': 'Hybrid',
  'New Junk City': 'Flashpoint', 'New Queen Street': 'Push',
  Numbani: 'Hybrid', Oasis: 'Control', Paraiso: 'Hybrid',
  Rialto: 'Escort', 'Route 66': 'Escort', Runasapi: 'Push',
  Samoa: 'Control', 'Shambali Monastery': 'Escort', Suravasa: 'Flashpoint',
  'Throne of Anubis': 'Clash',
};

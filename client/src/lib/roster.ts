// Client side of the roster: refreshes the bundled hero/map lists and the
// season table from GET /api/roster, and knows which Blizzard images exist
// locally. Nothing here talks to Blizzard — images come from this server's
// /assets route, and only when they are cached and images are switched on.
import seasonsData from '../../../server/data/seasons.json';
import { fillRoster, RosterData } from '../types';

export interface Season { label: string; start: string; end: string | null }
export const SEASONS: Season[] = [...(seasonsData as Season[])];

// Normalised name -> true for every hero with a cached portrait. Empty when
// images are off, so every <HeroIcon> renders nothing and the text name stays.
const heroImages = new Set<string>();

export const nameKey = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const heroImageUrl = (hero: string): string | null => (heroImages.has(nameKey(hero)) ? `/assets/heroes/${nameKey(hero)}.png` : null);

export interface RosterPayload extends RosterData { seasons: Season[]; images?: { enabled: boolean; heroes: string[] } }

export function applyRosterPayload(p: RosterPayload): void {
  fillRoster(p);
  SEASONS.length = 0; SEASONS.push(...p.seasons);
  heroImages.clear();
  if (p.images?.enabled) for (const k of p.images.heroes) heroImages.add(k);
}

// Called once before the first render. On any failure the bundled copy stands.
export async function loadRoster(): Promise<void> {
  try {
    const res = await fetch('/api/roster');
    if (res.ok) applyRosterPayload(await res.json());
  } catch { /* offline or API down: bundled roster, no images */ }
}

export function seasonOf(date: string): Season | null {
  return SEASONS.find(s => date >= s.start && (s.end === null || date < s.end)) ?? null;
}
export function seasonDay(date: string): number | null {
  const s = seasonOf(date);
  return s ? Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(s.start + 'T00:00:00Z')) / 86400000) + 1 : null;
}
export const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

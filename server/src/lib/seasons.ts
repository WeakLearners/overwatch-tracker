// Overwatch competitive season boundaries. Matches carry only a date, so this
// table is what places a match inside a season. The data lives in
// server/data/seasons.json so the "Check for game updates" button can append a
// season. Added 2026-09-27; moved to a data file 2026-10-06.
//
// Each season runs [start, end): a match on the changeover day belongs to the
// new season, and each end equals the next start, so no date falls in a gap.
// The current season has end null (open). Blizzard dropped the "2" on
// 2026-02-10 and restarted numbering at Season 1 under yearly story arcs,
// hence the "2026 S1" labels.
//
// Sources, checked 2026-09-27: strafe.com season list (S13–S20, 2026 S1–S2),
// dexerto.com calendar (2026 S1–S5). The two disagree on the 2026 S3/S4
// changeover (Aug 2 vs Aug 11); Aug 11 is used because dexerto and esports.gg
// both give it. 2026 S4 ended and 2026 S5 began 2026-10-06.
import { readDataJson, writeDataJson } from './dataFiles';

export interface Season {
  label: string;
  start: string;       // YYYY-MM-DD, inclusive
  end: string | null;  // YYYY-MM-DD, exclusive; null = the current, open season
}

export const SEASONS: Season[] = [];

export function loadSeasons(): void {
  SEASONS.length = 0;
  SEASONS.push(...readDataJson<Season[]>('seasons.json'));
}
loadSeasons();

// Close the open season on `start` and open a new one. Returns the new table.
export function appendSeason(label: string, start: string): Season[] {
  const next = SEASONS.map(s => (s.end === null ? { ...s, end: start } : s));
  next.push({ label, start, end: null });
  writeDataJson('seasons.json', next as unknown as Record<string, unknown>[]);
  loadSeasons();
  return SEASONS;
}

// The season a match date falls in, or null if outside every known season.
export function seasonOf(date: string): Season | null {
  return SEASONS.find(s => date >= s.start && (s.end === null || date < s.end)) ?? null;
}

// How far through its season a date sits: 0 at the first day, just under 1 at
// the last. null for a date in no season, and for the open season (no end, so
// no fraction to compute).
export function seasonProgress(date: string): number | null {
  const s = seasonOf(date);
  if (!s || s.end === null) return null;
  const t = (d: string) => Date.parse(d + 'T00:00:00Z');
  return (t(date) - t(s.start)) / (t(s.end) - t(s.start));
}

// 1 on the first day of the season the date falls in, or null.
export function seasonDay(date: string): number | null {
  const s = seasonOf(date);
  if (!s) return null;
  return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(s.start + 'T00:00:00Z')) / 86400000) + 1;
}

// SQL range for a season label: date >= from AND (to is null OR date < to).
export function seasonRange(label: string): { from: string; to: string | null } | null {
  const s = SEASONS.find(x => x.label === label);
  return s ? { from: s.start, to: s.end } : null;
}

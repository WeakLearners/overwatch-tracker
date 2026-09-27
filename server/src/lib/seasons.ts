// Overwatch competitive season boundaries. Matches carry only a date, so this
// table is what places a match inside a season. Added 2026-09-27.
//
// Each season runs [start, end): a match on the changeover day belongs to the
// new season. Blizzard dropped the "2" on 2026-02-10 and restarted numbering at
// Season 1 under yearly story arcs, hence the "2026 S1" labels.
//
// Sources, checked 2026-09-27: strafe.com season list (S13–S20, 2026 S1–S2),
// dexerto.com calendar (2026 S1–S5). The two disagree on the 2026 S3/S4
// changeover (Aug 2 vs Aug 11); Aug 11 is used because dexerto and esports.gg
// both give it. 2026 S5's end date is unannounced — update when it is.
export interface Season {
  label: string;
  start: string; // YYYY-MM-DD, inclusive
  end: string;   // YYYY-MM-DD, exclusive
}

export const SEASONS: Season[] = [
  { label: 'S13',     start: '2024-10-15', end: '2024-12-10' },
  { label: 'S14',     start: '2024-12-10', end: '2025-02-18' },
  { label: 'S15',     start: '2025-02-18', end: '2025-04-22' },
  { label: 'S16',     start: '2025-04-22', end: '2025-06-24' },
  { label: 'S17',     start: '2025-06-24', end: '2025-08-26' },
  { label: 'S18',     start: '2025-08-26', end: '2025-10-14' },
  { label: 'S19',     start: '2025-10-14', end: '2025-12-09' },
  { label: 'S20',     start: '2025-12-09', end: '2026-02-10' },
  { label: '2026 S1', start: '2026-02-10', end: '2026-04-14' },
  { label: '2026 S2', start: '2026-04-14', end: '2026-06-16' },
  { label: '2026 S3', start: '2026-06-16', end: '2026-08-11' },
  { label: '2026 S4', start: '2026-08-11', end: '2026-10-05' },
];

// The season a match date falls in, or null if outside every known season.
export function seasonOf(date: string): Season | null {
  return SEASONS.find(s => date >= s.start && date < s.end) ?? null;
}

// How far through its season a date sits: 0 at the first day, just under 1 at
// the last.
export function seasonProgress(date: string): number | null {
  const s = seasonOf(date);
  if (!s) return null;
  const t = (d: string) => Date.parse(d + 'T00:00:00Z');
  return (t(date) - t(s.start)) / (t(s.end) - t(s.start));
}

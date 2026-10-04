export const MIN_GAMES = 10;

export interface DayHourRow {
  day_of_week: string;
  hour: number;
  games: number;
  wins: number;
  win_rate: number;
}

export interface FoldCell {
  games: number;
  wins: number;
  rate: number;
  muted: boolean;
  hours: number[];
}

export interface FoldRow {
  key: string;
  kind: 'hour' | 'before' | 'after';
  hours: number[];
  cells: Map<string, FoldCell>;
}

// Session Window rows. An hour with MIN_GAMES or more games (all days summed)
// keeps its own row. Hours before the first such hour fold into one row, hours
// after the last fold into another, and a thin hour between two own-row hours
// keeps its own row. A fold row with no games is not made. If no hour reaches
// the minimum, every hour keeps its own row.
export function foldSessionRows(data: DayHourRow[], days: readonly string[]): FoldRow[] {
  const totals = new Map<number, number>();
  for (const r of data) totals.set(r.hour, (totals.get(r.hour) ?? 0) + r.games);
  const hours = [...totals.keys()].sort((a, b) => a - b);
  if (hours.length === 0) return [];
  const own = hours.filter(h => (totals.get(h) ?? 0) >= MIN_GAMES);
  const first = own.length ? own[0] : -Infinity;
  const last = own.length ? own[own.length - 1] : Infinity;

  const groups: { key: string; kind: FoldRow['kind']; hours: number[] }[] = [];
  const before = hours.filter(h => h < first);
  const after = hours.filter(h => h > last);
  if (before.length) groups.push({ key: 'before', kind: 'before', hours: before });
  for (const h of hours) if (h >= first && h <= last) groups.push({ key: `h${h}`, kind: 'hour', hours: [h] });
  if (after.length) groups.push({ key: 'after', kind: 'after', hours: after });
  if (!own.length) {
    groups.length = 0;
    for (const h of hours) groups.push({ key: `h${h}`, kind: 'hour', hours: [h] });
  }

  return groups.map(g => {
    const cells = new Map<string, FoldCell>();
    for (const d of days) {
      let games = 0, wins = 0;
      for (const r of data) {
        if (r.day_of_week === d && g.hours.includes(r.hour)) { games += r.games; wins += r.wins; }
      }
      if (games > 0) cells.set(d, { games, wins, rate: wins / games * 100, muted: games < MIN_GAMES, hours: g.hours });
    }
    return { ...g, cells };
  }).filter(r => r.cells.size > 0);
}

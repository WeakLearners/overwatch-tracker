// Prematch one-liner (S3): the action text of the first Play habits row that
// holds, or null when none holds (the card then shows nothing). The server has
// already decided "holds" (lib/habits.ts); this only picks what to print.
export interface HabitRowLite { status: 'holds' | 'none' | 'thin'; action: string | null }

export function holdingHabitLine(data: { rows: HabitRowLite[] } | null | undefined): string | null {
  const row = data?.rows.find(r => r.status === 'holds' && r.action);
  return row?.action ?? null;
}

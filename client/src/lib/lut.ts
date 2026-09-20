// One definition of how a Rawaccel lookup table is written and read.
//
// This lives in lib/ rather than beside either page because BOTH pages speak
// it and the two directions have to agree: the testing page formats a stored
// table back into the edit box, and parseLutString has to accept exactly what
// formatLut produced. Two copies of that format is two chances for them to
// drift apart, and the page that drifts is the one that silently records the
// wrong table. heroStatLabels.ts next door exists for the same reason, after
// a per-hero stat name lived as a private const in one component and the
// analysis page rendered the column under a name that was wrong for most
// heroes.

// Rawaccel writes a lookup table as "x,y;x,y;x,y" and accepts the same on the
// way back in, so that string is what Sean actually has in front of him. This
// parses it rather than asking him to retype six pairs into six boxes.
// Tolerant about whitespace and a trailing semicolon; strict about everything
// else, because a silently mis-parsed table would be recorded against real
// matches as if it were what ran.
export function parseLutString(raw: string): { points: [number, number][] } | { error: string } {
  const chunks = raw.split(';').map(c => c.trim()).filter(Boolean);
  if (chunks.length < 2) return { error: 'Need at least 2 points — a table with one row is not a curve.' };
  if (chunks.length > 32) return { error: `Too many points (${chunks.length}); Rawaccel tables here cap at 32.` };
  const points: [number, number][] = [];
  for (const c of chunks) {
    const parts = c.split(',').map(t => t.trim());
    if (parts.length !== 2) return { error: `"${c}" is not an x,y pair.` };
    const x = Number(parts[0]); const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: `"${c}" has a value that is not a number.` };
    points.push([x, y]);
  }
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] <= points[i - 1][0]) {
      return { error: `Speeds must increase left to right; ${points[i][0]} comes after ${points[i - 1][0]}.` };
    }
  }
  return { points };
}

export const formatLut = (pts: [number, number][]) => pts.map(([x, y]) => `${x},${y}`).join('; ');

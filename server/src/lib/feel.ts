// Feel is a three-way answer: Floaty (sens felt too slow), Snappy (right),
// Jittery (too fast). Stored in the existing `feel` integer column as 0, 50
// and 100 (OW-0009, 2026-11-12). No schema change. An unset feel stays null:
// an untouched control must never write 50 (see the 2026-09-21 cutover note
// in db/schema.ts).
//
// Rows logged with the old 0-100 slider keep their values. This one helper
// bands old and new values alike: below 40 is Floaty, 40 to 60 is Snappy,
// above 60 is Jittery. The client keeps a byte-identical copy at
// client/src/lib/feel.ts. Keep the two files the same.

export type FeelBand = 'floaty' | 'snappy' | 'jittery';

export const FEEL_BANDS: FeelBand[] = ['floaty', 'snappy', 'jittery'];

/** The value a button stores. */
export const FEEL_VALUE: Record<FeelBand, number> = { floaty: 0, snappy: 50, jittery: 100 };

export const FEEL_LABEL: Record<FeelBand, string> = { floaty: 'Floaty', snappy: 'Snappy', jittery: 'Jittery' };

export function feelBand(v: number | null | undefined): FeelBand | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v < 40) return 'floaty';
  if (v <= 60) return 'snappy';
  return 'jittery';
}

export interface FeelCounts { floaty: number; snappy: number; jittery: number; n: number }

/** Category counts over the answered values. Nulls are skipped, so n is the number of answers. */
export function feelCounts(values: (number | null | undefined)[]): FeelCounts {
  const c: FeelCounts = { floaty: 0, snappy: 0, jittery: 0, n: 0 };
  for (const v of values) {
    const b = feelBand(v);
    if (b) { c[b]++; c.n++; }
  }
  return c;
}

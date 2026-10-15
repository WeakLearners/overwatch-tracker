// Saved tile picks (table hero_tile_picks): which Personal-page tile fills a hero's accuracy slot when the
// hand map does not. The pick is fixed once saved. The only way out is resetPick, which refuses while any
// logged hero row holds a value in that slot, because a changed pick would change what old numbers mean.
import type { DatabaseSync } from 'node:sqlite';
import { HERO_TILE_MAP, SLOTS, normTileLabel, pickFormLabel, type HeroPicks, type Slot } from './heroTileLabels';

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Picks of a hero in HERO_TILE_MAP are ignored: a mapped hero's slots are set by the map (empty on purpose). */
export function loadPicks(db: DatabaseSync): Map<string, HeroPicks> {
  const out = new Map<string, HeroPicks>();
  const rows = db.prepare(`SELECT hero, slot, tile_label FROM hero_tile_picks`).all() as unknown as { hero: string; slot: Slot; tile_label: string | null }[];
  for (const r of rows) { if (hasOwn(HERO_TILE_MAP, r.hero)) continue; const p = out.get(r.hero) ?? {}; p[r.slot] = r.tile_label; out.set(r.hero, p); }
  return out;
}

export interface PickRow { hero: string; slot: Slot; tile_label: string | null; label: string | null }

/** Every saved pick with its form label (title-cased tile label + " %"); label is null for a None pick. */
export function listPicks(db: DatabaseSync): PickRow[] {
  const rows = db.prepare(`SELECT hero, slot, tile_label FROM hero_tile_picks ORDER BY hero, slot`).all() as unknown as { hero: string; slot: Slot; tile_label: string | null }[];
  return rows.filter(r => !hasOwn(HERO_TILE_MAP, r.hero)).map(r => ({ ...r, label: r.tile_label ? pickFormLabel(r.tile_label) : null }));
}

export const isSlot = (s: unknown): s is Slot => typeof s === 'string' && (SLOTS as readonly string[]).includes(s);

/** Saves a pick. Returns false when the slot already has one (fixed once saved). tileLabel null = None for this hero. */
export function savePick(db: DatabaseSync, hero: string, slot: Slot, tileLabel: string | null): boolean {
  const r = db.prepare(`INSERT OR IGNORE INTO hero_tile_picks (hero, slot, tile_label) VALUES (?, ?, ?)`).run(hero, slot, tileLabel == null ? null : normTileLabel(tileLabel));
  return Number(r.changes) === 1;
}

/** Logged aim_stats_heroes rows of this hero with a value in the slot's column. */
export function slotRowCount(db: DatabaseSync, hero: string, slot: Slot): number {
  const col = `${slot}_acc`; // slot is checked by isSlot() before it reaches here
  return (db.prepare(`SELECT COUNT(*) n FROM aim_stats_heroes WHERE hero = ? AND ${col} IS NOT NULL`).get(hero) as { n: number }).n;
}

export type ResetResult = { ok: true } | { ok: false; status: 404 | 409; error: string };
export function resetPick(db: DatabaseSync, hero: string, slot: Slot): ResetResult {
  if (!db.prepare(`SELECT 1 FROM hero_tile_picks WHERE hero = ? AND slot = ?`).get(hero, slot)) return { ok: false, status: 404, error: 'No saved pick for that hero and slot' };
  const n = slotRowCount(db, hero, slot);
  if (n > 0) return { ok: false, status: 409, error: `${n} logged ${hero} rows hold a ${slot} value; the pick cannot change` };
  db.prepare(`DELETE FROM hero_tile_picks WHERE hero = ? AND slot = ?`).run(hero, slot);
  return { ok: true };
}

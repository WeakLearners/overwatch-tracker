// match_hero_stats (Addendum 3, 2026-10-09): every Personal-page tile becomes one row.
// Written whenever a Personal page links to a match. Inserts only into this table.
// A tile that is not on the page has no row; a value that does not parse has no row.
// Zero is never stored for a missing tile.
import type { DatabaseSync } from 'node:sqlite';

export type StatUnit = 'pct' | 'count' | 'amount';
export interface HeroStatRow { stat: string; label: string; value: number; unit: StatUnit; per10: number | null; career_best: 0 | 1 }

// The game singularises a count label when the value is 1 ("FINAL BLOW" 1, "FINAL BLOWS" 5),
// so one measure would get two keys. For a count tile the stat key uses the plural: the last
// word gets an "s" unless it already ends in one or is a past-participle tile ("ENEMY HINDERED").
// A pct or amount tile keeps its words as they are. label keeps the text as shown.
const NOT_A_COUNT = /(ed|ept)$/;

/** "WEAPON ACCURACY" -> "weapon_accuracy"; count tiles "FINAL BLOW" and "FINAL BLOWS" -> "final_blows". */
export function normStat(label: string, unit: StatUnit): string {
  const words = label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const last = words[words.length - 1];
  if (unit === 'count' && last && !last.endsWith('s') && !NOT_A_COUNT.test(last)) words[words.length - 1] = last + 's';
  return words.join('_');
}

/** "33%" -> 33, "7,772" -> 7772, "12.4" -> 12.4, "05:28" -> 328 (seconds). Anything else -> null. */
export function parseStatValue(v: unknown): number | null {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  const t = s.match(/^(\d+):(\d{2})$/);
  if (t) return Number(t[1]) * 60 + Number(t[2]);
  const m = s.match(/^(\d+(?:\.\d+)?)\s*%?$/);
  return m ? Number(m[1]) : null;
}

const AMOUNT_LABEL = /damage|healing|mitigat|time/i;

export function statUnit(label: string, value: unknown): StatUnit {
  const s = String(value ?? '');
  if (s.includes('%')) return 'pct';
  if (/^\d+:\d{2}$/.test(s.trim()) || AMOUNT_LABEL.test(label)) return 'amount';
  return 'count';
}

interface RawTile { label?: unknown; value?: unknown; per10?: unknown; career_best?: unknown }

/** Tiles -> rows. Skips a tile with no label or an unreadable value. A repeated stat keeps its last tile. */
export function tilesToRows(tiles: unknown): HeroStatRow[] {
  if (!Array.isArray(tiles)) return [];
  const out = new Map<string, HeroStatRow>();
  for (const t of tiles as RawTile[]) {
    const label = String(t?.label ?? '').trim();
    const unit = statUnit(label, t?.value);
    const stat = normStat(label, unit);
    const value = parseStatValue(t?.value);
    if (!stat || value == null) continue;
    out.set(stat, {
      stat, label, value, unit,
      per10: parseStatValue(t.per10),
      career_best: t.career_best === true ? 1 : 0,
    });
  }
  return [...out.values()];
}

/**
 * Rebuild the rows for one match from its matched Personal pages. Idempotent
 * (INSERT OR REPLACE on the primary key). Touches only match_hero_stats.
 * Returns the number of rows written.
 */
export function syncMatchHeroStats(db: DatabaseSync, matchId: number): number {
  const pages = db.prepare(`
    SELECT id, page_hero, raw_json FROM match_scoreboards
    WHERE match_id = ? AND page_type = 'personal' AND status = 'matched' AND page_hero IS NOT NULL AND raw_json IS NOT NULL
    ORDER BY id
  `).all(matchId) as { id: number; page_hero: string; raw_json: string }[];
  // A true rebuild: keys written under an older normalisation must not linger.
  db.prepare(`DELETE FROM match_hero_stats WHERE match_id = ?`).run(matchId);
  const ins = db.prepare(`
    INSERT OR REPLACE INTO match_hero_stats (match_id, hero, stat, label, value, unit, per10, career_best, scoreboard_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let n = 0;
  for (const p of pages) {
    let tiles: unknown;
    try { tiles = JSON.parse(p.raw_json)?.personal?.tiles; } catch { continue; }
    for (const r of tilesToRows(tiles)) {
      ins.run(matchId, p.page_hero, r.stat, r.label, r.value, r.unit, r.per10, r.career_best, p.id);
      n++;
    }
  }
  return n;
}

// Play-time shares per match (2026-10-10). A match with a linked Summary page credits each
// hero by its share of the play time on that page, not the whole match to matches.hero.
// matches.hero stays the START hero: the form does not change, and the start hero is the
// right field for judging the advisor's pick (those readers do not use this file).
//
// Source: the match's linked Summary row in match_scoreboards (page_type 'summary',
// match_id set, status not 'dismissed'; the newest one wins). Hero names go through
// rosterHero, as everywhere else. A hero that does not map to the roster is dropped and
// the rest are renormalised so the shares sum to 1. If nothing maps, the match falls back.
//
// Fallback (no Summary, about 3,700 older matches): the heroes the matches_by_hero view
// already credits, each with share 1. That is the start hero alone for a plain match.
// For the ~250 matches with a hand-entered mid-match switch it keeps the one-third share
// rule of 2026-10-01 unchanged, so this change does not remove credit that rule gave.
import type { DatabaseSync } from 'node:sqlite';
import { normSummary, rosterHero } from './scoreboardPages';
import { HEROES_BY_ROLE } from './roster';

export interface HeroShare { hero: string; share: number }

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** Pure part: Summary hero list -> shares that sum to 1, or null if no hero maps. */
export function sharesFromSummary(heroes: { hero: string | null; percent: number }[]): HeroShare[] | null {
  const byHero = new Map<string, number>();
  for (const h of heroes) {
    if (!h.hero || !Number.isFinite(h.percent) || h.percent <= 0) continue;
    byHero.set(h.hero, (byHero.get(h.hero) ?? 0) + h.percent);
  }
  const total = [...byHero.values()].reduce((s, v) => s + v, 0);
  if (!(total > 0)) return null;
  return [...byHero].map(([hero, p]) => ({ hero, share: p / total })).sort((a, b) => b.share - a.share);
}

/** Matches that have a usable linked Summary -> their shares. Matches without one are absent. */
export function summaryShares(db: DatabaseSync, matchIds?: number[]): Map<number, HeroShare[]> {
  if (matchIds && matchIds.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT s.match_id, s.raw_json, s.file_mtime
    FROM match_scoreboards s JOIN matches m ON m.id = s.match_id
    WHERE s.page_type = 'summary' AND s.match_id IS NOT NULL AND s.status <> 'dismissed'
      AND m.crashed = 0 AND s.raw_json IS NOT NULL
      ${matchIds ? `AND s.match_id IN (${placeholders(matchIds.length)})` : ''}
    ORDER BY s.file_mtime, s.id
  `).all(...(matchIds ?? [])) as { match_id: number; raw_json: string; file_mtime: string }[];
  const out = new Map<number, HeroShare[]>();
  for (const r of rows) {
    let shares: HeroShare[] | null = null;
    try {
      const raw = JSON.parse(r.raw_json)?.summary;
      if (raw) shares = sharesFromSummary(normSummary(raw, Date.parse(r.file_mtime)).heroes);
    } catch { /* unreadable page: this row gives no shares */ }
    // Rows come oldest first, so a newer readable Summary replaces an older one.
    if (shares) out.set(r.match_id, shares);
  }
  return out;
}

/** Per match, the heroes credited and their shares. Summary shares when the match has them, else the fallback. */
export function heroShares(db: DatabaseSync, matchIds?: number[]): Map<number, HeroShare[]> {
  const out = summaryShares(db, matchIds);
  const fromSummary = new Set(out.keys());
  const rest = matchIds ? matchIds.filter(id => !out.has(id)) : null;
  if (rest && rest.length === 0) return out;
  const rows = db.prepare(`
    SELECT id, hero FROM matches_by_hero
    ${rest ? `WHERE id IN (${placeholders(rest.length)})` : ''}
    ORDER BY id, slot
  `).all(...(rest ?? [])) as { id: number; hero: string }[];
  for (const r of rows) {
    if (fromSummary.has(r.id)) continue; // a Summary match keeps its shares
    const list = out.get(r.id) ?? [];
    if (!list.some(x => x.hero === r.hero)) list.push({ hero: r.hero, share: 1 });
    out.set(r.id, list);
  }
  return out;
}

/**
 * Make the TEMP view matches_by_hero_credit current on this connection. One row per
 * (match, hero credited) with a `share` column: Summary shares for a Summary match,
 * the matches_by_hero rows at share 1 for every other match. Readers weight with
 * SUM(share) and SUM(share * win). TEMP objects live on the connection only, so
 * nothing is written to the database file. Call at the start of each reader.
 */
export function ensureHeroCredit(db: DatabaseSync): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS hero_shares (match_id INTEGER NOT NULL, hero TEXT NOT NULL, role TEXT, share REAL NOT NULL);
    CREATE TEMP VIEW IF NOT EXISTS matches_by_hero_credit AS
      SELECT b.id, b.date, b.time, b.day_of_week, b.hour, b.hero, b.role, b.map, b.game_type, b.win, b.queue_mode, 1.0 AS share
      FROM main.matches_by_hero b
      WHERE b.id NOT IN (SELECT match_id FROM temp.hero_shares)
      UNION ALL
      SELECT m.id, m.date, m.time, m.day_of_week, m.hour, s.hero, s.role, m.map, m.game_type, m.win, m.queue_mode, s.share
      FROM temp.hero_shares s JOIN main.matches m ON m.id = s.match_id;
    DELETE FROM temp.hero_shares;
  `);
  const roleOf = new Map<string, string>();
  for (const [role, names] of Object.entries(HEROES_BY_ROLE)) for (const n of names) roleOf.set(n, role);
  const ins = db.prepare(`INSERT INTO temp.hero_shares (match_id, hero, role, share) VALUES (?, ?, ?, ?)`);
  for (const [id, list] of summaryShares(db)) for (const h of list) ins.run(id, h.hero, roleOf.get(h.hero) ?? null, h.share);
}

/** SQL for the weighted columns every performance reader repeats. games and wins show one decimal at most. */
export const CREDIT_COLS = `
  ROUND(SUM(share), 1) AS games,
  ROUND(SUM(share * win), 1) AS wins,
  ROUND(SUM(share * win) * 100.0 / SUM(share), 1) AS win_rate`;

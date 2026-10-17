// One source of truth for a ladder's live rank (player_ranks).
//
// A ladder is account + slot, where slot is the role in Role Queue and 'Open'
// in Open Queue (the same key the client's ladderFor builds). Only competitive
// matches (comp_role, comp_open) belong to a ladder. The live rank is the
// player_rank of the newest comp match on the slot, so every path that can
// set matches.player_rank calls this afterwards. It never moves the rank from
// an older match, and it leaves the hand-set drum alone when the newest
// match has no rank (placements, rank-less saves).
import type { DatabaseSync } from 'node:sqlite';

/** SQL for a match's ladder slot. Matches share this with the rank-outcome walk. */
export const LADDER_SLOT_SQL = `CASE WHEN queue_mode = 'comp_open' THEN 'Open' ELSE role END`;

/** Move player_ranks to this match's player_rank when it is the newest comp match on its ladder. Returns true when player_ranks changed. */
export function syncLadderRank(db: DatabaseSync, matchId: number | bigint | string): boolean {
  const m = db.prepare(`
    SELECT id, COALESCE(account, '') AS account, ${LADDER_SLOT_SQL} AS slot, queue_mode, date, COALESCE(time, '') AS time, player_rank
    FROM matches WHERE id = ?
  `).get(Number(matchId)) as { id: number; account: string; slot: string; queue_mode: string | null; date: string; time: string; player_rank: number | null } | undefined;
  if (!m || m.player_rank == null || !['comp_role', 'comp_open'].includes(m.queue_mode ?? '')) return false;
  const newer = db.prepare(`
    SELECT 1 FROM matches
    WHERE queue_mode IN ('comp_role', 'comp_open') AND COALESCE(account, '') = :account AND ${LADDER_SLOT_SQL} = :slot
      AND (date, COALESCE(time, ''), id) > (:date, :time, :id)
    LIMIT 1
  `).get({ account: m.account, slot: m.slot, date: m.date, time: m.time, id: m.id });
  if (newer) return false;
  return db.prepare(`
    INSERT INTO player_ranks (account, role, rank) VALUES (:account, :slot, :rank)
    ON CONFLICT(account, role) DO UPDATE SET rank = :rank WHERE rank IS NOT :rank
  `).run({ account: m.account, slot: m.slot, rank: m.player_rank }).changes > 0;
}

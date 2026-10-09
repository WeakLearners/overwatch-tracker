import { Router } from 'express';
import { getDb } from '../db/schema';
import { organizeBoard } from '../lib/scoreboardOrganize';
import { DEFAULT_SCOREBOARD_DIR } from '../lib/scoreboardWatcher';
import { REMATCH_GRACE_MIN } from '../lib/scoreboard';
import { syncMatchHeroStats } from '../lib/matchHeroStats';
import { buildFill, linkGroup, TEAMS_ONLY, type GroupRow } from '../lib/scoreboardPages';

const root = () => process.env.SCOREBOARD_DIR || DEFAULT_SCOREBOARD_DIR;

// Attach and dismiss also move the file (scoreboardOrganize.ts).
// Scoreboard screenshot ingest, read side + the one manual write (attach an
// unmatched image to a logged match). Never touches the matches table.
const router = Router();

// The "scoreboard received" light. Green while the newest group is live (a Summary
// page arrived, no logged match fits it) and its last page is younger than
// REMATCH_GRACE_MIN, the same grace the unmatched list uses. `fill` is the ready
// payload for the log form: the server owns the tile map, the client only applies it.
router.get('/live', (_req, res) => {
  const db = getDb();
  const cutoff = new Date(Date.now() - REMATCH_GRACE_MIN * 60_000).toISOString();
  const g = db.prepare(`SELECT * FROM scoreboard_groups WHERE state = 'live' AND last_mtime >= ? ORDER BY summary_mtime DESC, id DESC LIMIT 1`).get(cutoff) as unknown as GroupRow | undefined;
  if (!g) { res.json({ light: 'off', group_id: null, fill: null }); return; }
  res.json({ light: 'green', group_id: g.id, fill: buildFill(db, g.id) });
});

// Unmatched / error images plus a count of ignored non-scoreboard images, and
// per image the recent logged matches that could be picked in "attach to match".
router.get('/unmatched', (_req, res) => {
  const db = getDb();
  const items = db.prepare(`
    SELECT s.id, s.file_path, s.file_mtime, s.status, s.reason,
           (SELECT player_name FROM scoreboard_rows r WHERE r.scoreboard_id = s.id AND r.is_self = 1) AS self_name,
           (SELECT hero FROM scoreboard_rows r WHERE r.scoreboard_id = s.id AND r.is_self = 1) AS self_hero,
           (SELECT role FROM scoreboard_rows r WHERE r.scoreboard_id = s.id AND r.is_self = 1) AS self_role,
           (SELECT COUNT(*) FROM scoreboard_rows r WHERE r.scoreboard_id = s.id) AS row_count
    FROM match_scoreboards s
    WHERE s.status IN ('unmatched', 'error')
      AND NOT (s.group_id IS NOT NULL AND EXISTS (SELECT 1 FROM scoreboard_groups g WHERE g.id = s.group_id AND g.state = 'live' AND g.last_mtime >= ?))
    ORDER BY s.file_mtime DESC
  `).all(new Date(Date.now() - REMATCH_GRACE_MIN * 60_000).toISOString()) as any[];
  const matches = db.prepare(`
    SELECT m.id, m.date, m.time, m.hero, m.role, m.map, m.account, m.win
    FROM matches m
    WHERE NOT EXISTS (SELECT 1 FROM match_scoreboards s WHERE s.match_id = m.id AND ${TEAMS_ONLY})
    ORDER BY m.id DESC LIMIT 40
  `).all();
  const ignored = (db.prepare(`SELECT COUNT(*) n FROM match_scoreboards WHERE status IN ('not_scoreboard', 'dismissed')`).get() as { n: number }).n;
  res.json({
    items: items.map(i => ({ ...i, file_name: String(i.file_path).split('/').pop() })),
    matches,
    ignored,
  });
});

// Full parsed rows for one logged match (consumer for every scoreboard_rows column).
router.get('/by-match/:matchId', (req, res) => {
  const db = getDb();
  const sb = db.prepare(`SELECT id, file_mtime, status FROM match_scoreboards s WHERE s.match_id = ? AND ${TEAMS_ONLY} AND s.status = 'matched' ORDER BY s.id LIMIT 1`).get(Number(req.params.matchId)) as any;
  if (!sb) { res.status(404).json({ error: 'No scoreboard for that match' }); return; }
  const rows = db.prepare(`
    SELECT team, slot, is_self, role, hero, player_name, e, a, d, dmg, h, mit
    FROM scoreboard_rows WHERE scoreboard_id = ? ORDER BY team DESC, slot
  `).all(sb.id);
  res.json({ ...sb, rows });
});

router.post('/:id/attach', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const matchId = Number((req.body ?? {}).match_id);
  if (!Number.isInteger(id) || !Number.isInteger(matchId)) { res.status(400).json({ error: 'match_id required' }); return; }
  const sb = db.prepare(`SELECT id, status, page_type, group_id FROM match_scoreboards WHERE id = ?`).get(id) as any;
  if (!sb) { res.status(404).json({ error: 'Scoreboard not found' }); return; }
  if (sb.status !== 'unmatched') { res.status(409).json({ error: `Scoreboard is ${sb.status}, not unmatched` }); return; }
  if (!db.prepare(`SELECT 1 FROM matches WHERE id = ?`).get(matchId)) { res.status(404).json({ error: 'Match not found' }); return; }
  const isTeams = sb.page_type == null || sb.page_type === 'teams';
  if ((isTeams || sb.group_id != null) && db.prepare(`SELECT 1 FROM match_scoreboards s WHERE s.match_id = ? AND ${TEAMS_ONLY}`).get(matchId)) { res.status(409).json({ error: 'That match already has a scoreboard' }); return; }
  if (sb.group_id != null) {
    // Any page of a group moves the whole group: Summary, Teams and every Personal page.
    linkGroup(db, sb.group_id, matchId, 'linked', 'attached by hand');
    const ids = db.prepare(`SELECT id FROM match_scoreboards WHERE group_id = ? AND status = 'matched'`).all(sb.group_id) as { id: number }[];
    for (const r of ids) organizeBoard(db, r.id, root());
    res.json({ ok: true });
    return;
  }
  db.prepare(`UPDATE match_scoreboards SET match_id = ?, status = 'matched', reason = 'attached by hand' WHERE id = ?`).run(matchId, id);
  syncMatchHeroStats(db, matchId);
  organizeBoard(db, id, root()); // moves to the date folder; skipped (and retried by the watcher) if the file is under 60 s old
  res.json({ ok: true });
});

// Hide a duplicate / unwanted image. The row stays so the watcher (which skips
// any file_path it has a row for) never spends a vision call on it again.
router.post('/:id/dismiss', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'bad id' }); return; }
  const sb = db.prepare(`SELECT id, status FROM match_scoreboards WHERE id = ?`).get(id) as any;
  if (!sb) { res.status(404).json({ error: 'Scoreboard not found' }); return; }
  if (sb.status !== 'unmatched' && sb.status !== 'error') { res.status(409).json({ error: `Scoreboard is ${sb.status}, only unmatched or error can be dismissed` }); return; }
  db.prepare(`UPDATE match_scoreboards SET status = 'dismissed', reason = 'dismissed by hand' WHERE id = ?`).run(id);
  organizeBoard(db, id, root());
  res.json({ ok: true });
});

export default router;

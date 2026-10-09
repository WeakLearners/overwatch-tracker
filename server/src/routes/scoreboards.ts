import { Router } from 'express';
import { getDb } from '../db/schema';

// Scoreboard screenshot ingest, read side + the one manual write (attach an
// unmatched image to a logged match). Never touches the matches table.
const router = Router();

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
    ORDER BY s.file_mtime DESC
  `).all() as any[];
  const matches = db.prepare(`
    SELECT m.id, m.date, m.time, m.hero, m.role, m.map, m.account, m.win
    FROM matches m
    WHERE NOT EXISTS (SELECT 1 FROM match_scoreboards s WHERE s.match_id = m.id)
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
  const sb = db.prepare(`SELECT id, file_mtime, status FROM match_scoreboards WHERE match_id = ?`).get(Number(req.params.matchId)) as any;
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
  const sb = db.prepare(`SELECT id, status FROM match_scoreboards WHERE id = ?`).get(id) as any;
  if (!sb) { res.status(404).json({ error: 'Scoreboard not found' }); return; }
  if (sb.status !== 'unmatched') { res.status(409).json({ error: `Scoreboard is ${sb.status}, not unmatched` }); return; }
  if (!db.prepare(`SELECT 1 FROM matches WHERE id = ?`).get(matchId)) { res.status(404).json({ error: 'Match not found' }); return; }
  if (db.prepare(`SELECT 1 FROM match_scoreboards WHERE match_id = ?`).get(matchId)) { res.status(409).json({ error: 'That match already has a scoreboard' }); return; }
  db.prepare(`UPDATE match_scoreboards SET match_id = ?, status = 'matched', reason = 'attached by hand' WHERE id = ?`).run(matchId, id);
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
  res.json({ ok: true });
});

export default router;

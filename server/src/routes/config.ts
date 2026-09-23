import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { CATEGORY_REGISTRY, FIELD_REGISTRY, CategoryId, categoryById } from '../lib/fieldRegistry';
import { activeSets } from './blind';

const router = Router();

// Branch A: exactly one owner, always id 1. Threaded through explicitly
// rather than hardcoded inline at each query site, per the roadmap's
// requirement 3 — Branch B swaps this constant for a real session's user
// id and nothing else here has to change shape.
const OWNER = 1;

// The stored set, plus 'core' which is always on and never persisted.
function currentEnabled(db: ReturnType<typeof getDb>): CategoryId[] {
  const row = db.prepare('SELECT enabled_categories FROM user_config WHERE user_id = :user_id')
    .get({ user_id: OWNER }) as { enabled_categories: string } | undefined;
  const stored: string[] = row ? JSON.parse(row.enabled_categories) : [];
  return ['core', ...stored.filter(c => c !== 'core')] as CategoryId[];
}

// The sens-study lock: while any blind_stage_sets row is still open (active,
// unrevealed — activeSets() is the same source of truth blind.ts's own
// /state endpoint and nightlyReport.ts use), the whole sens-study category
// is locked. Computed fresh on every call, never stored, so it can't go
// stale — same design the roadmap specifies for the original field-level
// version of this lock.
function lockedCategories(db: ReturnType<typeof getDb>): { id: CategoryId; reason: string }[] {
  const open = activeSets(db);
  if (open.length === 0) return [];
  return [{ id: 'sens-study', reason: 'locked — a sensitivity study stage is running' }];
}

function buildConfigPayload(db: ReturnType<typeof getDb>) {
  const enabled = new Set(currentEnabled(db));
  const locked = lockedCategories(db);
  return {
    enabledCategories: [...enabled],
    lockedCategories: locked,
    categories: CATEGORY_REGISTRY,
    fields: FIELD_REGISTRY.map(f => ({ ...f, enabled: enabled.has(f.category) })),
  };
}

router.get('/', (_req: Request, res: Response) => {
  res.json(buildConfigPayload(getDb()));
});

// Body: { enabledCategories: string[] } — the full desired non-core set.
// Enforcement (see modular-tracking-roadmap.md's "Enforcement rules,
// server-side"):
//   1. A locked category can't leave the desired set.
//   2. Enabling a category whose hard prerequisite is currently OFF
//      auto-enables that prerequisite too.
//   3. Disabling a category that's currently ON while something else in
//      the desired set still hard-depends on it is refused, with a reason
//      — it is NOT silently kept on; the request has to say what it means.
router.put('/', (req: Request, res: Response) => {
  const db = getDb();
  const requested = req.body?.enabledCategories;
  if (!Array.isArray(requested) || !requested.every((c: unknown) => typeof c === 'string')) {
    res.status(400).json({ error: 'enabledCategories must be an array of category id strings' });
    return;
  }
  const unknown = requested.filter((c: string) => !categoryById(c));
  if (unknown.length) {
    res.status(400).json({ error: `unknown category id(s): ${unknown.join(', ')}` });
    return;
  }

  const desired = new Set<string>(requested);
  desired.add('core');
  const current = new Set(currentEnabled(db));
  const locked = lockedCategories(db);

  for (const l of locked) {
    if (current.has(l.id) && !desired.has(l.id)) {
      res.status(409).json({ error: l.reason, category: l.id });
      return;
    }
  }

  // Fixpoint over hard dependencies: for every category in `desired`, its
  // prerequisites must end up in `desired` too. A prerequisite already ON
  // that the request tries to drop (while keeping the dependent category)
  // is refused rather than auto-corrected — only a prerequisite that was
  // already OFF gets silently pulled in as "enabling X brings its deps."
  let changed = true;
  while (changed) {
    changed = false;
    for (const cid of desired) {
      const cat = categoryById(cid)!;
      for (const dep of cat.hardDependsOn) {
        if (desired.has(dep)) continue;
        if (current.has(dep)) {
          res.status(409).json({ error: `${cid} needs ${dep} — enable both or neither`, category: dep });
          return;
        }
        desired.add(dep);
        changed = true;
      }
    }
  }

  const toStore = [...desired].filter(c => c !== 'core');
  db.prepare(`
    INSERT INTO user_config (user_id, enabled_categories) VALUES (:user_id, :cats)
    ON CONFLICT(user_id) DO UPDATE SET enabled_categories = :cats
  `).run({ user_id: OWNER, cats: JSON.stringify(toStore) });

  res.json(buildConfigPayload(db));
});

export default router;

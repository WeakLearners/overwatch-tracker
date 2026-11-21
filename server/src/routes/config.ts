import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { CATEGORY_REGISTRY, FIELD_REGISTRY, PRESET_REGISTRY, CategoryId, categoryById, presetById, isSubItem, fieldById } from '../lib/fieldRegistry';
import { activeSets } from './blind';

const router = Router();

// Branch A: exactly one owner, always id 1. Threaded through explicitly
// rather than hardcoded inline at each query site, per the roadmap's
// requirement 3 — Branch B swaps this constant for a real session's user
// id and nothing else here has to change shape.
const OWNER = 1;

// The stored set, plus 'core' which is always on and never persisted.
//
// No saved row means EVERY category is on. That is deliberate, and it is not
// the roadmap's Casual preset. The one user who exists today already captures
// all of these — deaths on every match, a sens study mid-stage — and the app
// did so unconditionally before the registry existed. A "core only" fallback
// silently hid the Log Match Deaths card on the day this shipped (2026-09-23),
// and reported the running sens study's category as off while locking it.
// Adding the switches must not change what an existing user sees. Presets for
// a brand-new user are Phase 3's job, and they will write a row explicitly.
function currentEnabled(db: ReturnType<typeof getDb>): CategoryId[] {
  const row = db.prepare('SELECT enabled_categories FROM user_config WHERE user_id = :user_id')
    .get({ user_id: OWNER }) as { enabled_categories: string } | undefined;
  const stored: string[] = row ? JSON.parse(row.enabled_categories) : CATEGORY_REGISTRY.map(c => c.id);
  return ['core', ...stored.filter(c => c !== 'core')] as CategoryId[];
}

// Sub-items the owner switched off (OW-0014). No row, or a row saved before the
// column existed, reads as none: every sub-item is on. Unknown ids are dropped,
// so a field removed from the registry later cannot hide anything.
function currentDisabled(db: ReturnType<typeof getDb>): string[] {
  const row = db.prepare('SELECT disabled_fields FROM user_config WHERE user_id = :user_id')
    .get({ user_id: OWNER }) as { disabled_fields: string | null } | undefined;
  const stored: unknown = row?.disabled_fields ? JSON.parse(row.disabled_fields) : [];
  return (Array.isArray(stored) ? stored : []).filter((id): id is string => {
    const f = typeof id === 'string' ? fieldById(id) : undefined;
    return !!f && isSubItem(f);
  });
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

// True when the owner has no saved row: nobody has picked a preset or toggled a
// category. A user with a row never sees the first-run preset screen.
function hasStoredConfig(db: ReturnType<typeof getDb>): boolean {
  return !!db.prepare('SELECT 1 FROM user_config WHERE user_id = :user_id').get({ user_id: OWNER });
}

export function buildConfigPayload(db: ReturnType<typeof getDb>) {
  const enabled = new Set(currentEnabled(db));
  const disabled = new Set(currentDisabled(db));
  const locked = lockedCategories(db);
  return {
    enabledCategories: [...enabled],
    disabledFields: [...disabled].filter(id => enabled.has(fieldById(id)!.category)),
    lockedCategories: locked,
    needsPreset: !hasStoredConfig(db),
    presets: PRESET_REGISTRY,
    categories: CATEGORY_REGISTRY,
    fields: FIELD_REGISTRY.map(f => ({ ...f, subItem: isSubItem(f), enabled: enabled.has(f.category) && !disabled.has(f.id) })),
  };
}

router.get('/', (_req: Request, res: Response) => {
  res.json(buildConfigPayload(getDb()));
});

// Body: { enabledCategories: string[], disabledFields?: string[] } — the full
// desired non-core set, and (OW-0014) the sub-items switched off. Omitting
// disabledFields keeps the stored list. A category that goes from off to on
// brings all of its sub-items on, because the category box turns them all on.
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

  const requestedOff = req.body?.disabledFields;
  if (requestedOff !== undefined) {
    if (!Array.isArray(requestedOff) || !requestedOff.every((c: unknown) => typeof c === 'string')) {
      res.status(400).json({ error: 'disabledFields must be an array of field id strings' });
      return;
    }
    const bad = requestedOff.filter((id: string) => { const f = fieldById(id); return !f || !isSubItem(f); });
    if (bad.length) {
      res.status(400).json({ error: `not a sub-item: ${bad.join(', ')}` });
      return;
    }
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
  let off = (requestedOff as string[] | undefined) ?? currentDisabled(db);
  // A category that turns on now (it was off before) starts with every sub-item on.
  off = off.filter(id => !(desired.has(fieldById(id)!.category) && !current.has(fieldById(id)!.category as CategoryId)));
  // A sub-item of a category that is off is not stored.
  off = [...new Set(off)].filter(id => desired.has(fieldById(id)!.category));
  db.prepare(`
    INSERT INTO user_config (user_id, enabled_categories, disabled_fields) VALUES (:user_id, :cats, :off)
    ON CONFLICT(user_id) DO UPDATE SET enabled_categories = :cats, disabled_fields = :off
  `).run({ user_id: OWNER, cats: JSON.stringify(toStore), off: JSON.stringify(off) });

  res.json(buildConfigPayload(db));
});

// Body: { preset: 'casual' | 'improver' | 'scientist' } — the first-run choice.
// Only allowed while no row is saved, so a preset can never overwrite a user's
// own setup. A category that a running sens study locks stays on, and every
// category's hard prerequisites are pulled in, as PUT / does.
router.post('/preset', (req: Request, res: Response) => {
  const db = getDb();
  const preset = presetById(String(req.body?.preset ?? ''));
  if (!preset) {
    res.status(400).json({ error: 'preset must be one of: casual, improver, scientist' });
    return;
  }
  if (hasStoredConfig(db)) {
    res.status(409).json({ error: 'a setup is already saved — change categories in Settings' });
    return;
  }
  const desired = new Set<CategoryId>(preset.categories);
  for (const l of lockedCategories(db)) desired.add(l.id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const cid of [...desired]) {
      for (const dep of categoryById(cid)!.hardDependsOn) {
        if (!desired.has(dep)) { desired.add(dep); changed = true; }
      }
    }
  }
  db.prepare('INSERT INTO user_config (user_id, enabled_categories) VALUES (:user_id, :cats)')
    .run({ user_id: OWNER, cats: JSON.stringify([...desired]) });
  res.json(buildConfigPayload(db));
});

export default router;

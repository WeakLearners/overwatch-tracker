// The field registry — Phase 1 of the modular-tracking-roadmap
// (projects/overwatch-analysis/modular-tracking-roadmap.md in the vault).
// One list, in code, of every trackable thing: what it is, what it writes,
// and what it feeds. A user's setup is "which CATEGORIES are on" — the
// toggle unit is the category, not the individual field (Sean's decision,
// 2026-09-23, see the roadmap's "Categories and dependencies" section for
// the full inventory and the dependency DAG this file implements).
//
// Decided here, at Phase 1 kickoff, per the roadmap's own "decide at Phase 1
// kickoff, not now": this registry lives server-side only. The client never
// imports this file — GET /config denormalizes everything a settings page
// or a gated card needs (enabled/locked booleans, labels) into its response,
// so there's no shared-package or path-alias problem to solve for one field.
// See server/src/routes/config.ts.

export type CategoryId =
  | 'core'
  | 'combat'
  | 'mouse-settings'
  | 'sens-study'
  | 'subjective'
  | 'rank';

export interface CategoryEntry {
  id: CategoryId;
  label: string;
  description: string;
  // Not offered a disable control at all — distinct from "has an empty
  // hardDependsOn list and could theoretically be turned off but never is."
  alwaysOn?: boolean;
  // Categories that MUST also be enabled for this one to mean anything —
  // verified against the running code, not assumed from field names. See
  // the roadmap's "Checking the brief's candidate dependencies against the
  // code" section for what was checked and rejected.
  hardDependsOn: CategoryId[];
}

export const CATEGORY_REGISTRY: CategoryEntry[] = [
  {
    id: 'core',
    label: 'Core match log',
    description: 'Date, hero, map, mode, win/loss, leaver — the base fact of a logged match.',
    alwaysOn: true,
    hardDependsOn: [],
  },
  {
    id: 'combat',
    label: 'Combat & death tracking',
    description: 'Self-reported accuracy/damage/healing (aim_stats) and who killed you (match_deaths).',
    hardDependsOn: [],
  },
  {
    id: 'mouse-settings',
    label: 'Mouse sensitivity & DPI',
    description: 'The raw sens/DPI value active on a match — meaningful on its own, with no experiment required.',
    hardDependsOn: [],
  },
  {
    id: 'sens-study',
    label: 'Sensitivity study',
    description: 'Curve fit, blind-trial stage/phase bookkeeping, and the feel rating scored against the sens fulcrum.',
    // Hard, confirmed against schema.ts's own comment: `feel` is "perceived
    // sens speed... the fulcrum the sens study scores against" — a feel
    // reading with no sens value has nothing to be a reading of, and
    // matches.ts writes `feel` independently of whether sens resolved to a
    // real number, so nothing stops that nonsense reading except this rule.
    hardDependsOn: ['mouse-settings'],
  },
  {
    id: 'subjective',
    label: 'Subjective ratings',
    description: 'Teammate rating, notes, match quality, result driver — skippable opinions about the match.',
    hardDependsOn: [],
  },
  {
    id: 'rank',
    label: 'Rank tracking',
    description: 'Your ladder rank in/out and the guessed enemy-lobby SR band.',
    hardDependsOn: [],
  },
];

export function categoryById(id: string): CategoryEntry | undefined {
  return CATEGORY_REGISTRY.find(c => c.id === id);
}

export interface FieldEntry {
  id: string;
  label: string;
  category: CategoryId;
  control:
    | { kind: 'death-logger' }
    | { kind: 'star-rating'; max: number }
    | { kind: 'number'; min?: number; max?: number }
    | { kind: 'slider'; min: number; max: number }
    | { kind: 'select'; options: string[] }
    | { kind: 'text' };
  writesTo: {
    table: 'matches' | 'match_deaths';
    columns: string[];
  };
  feedsCards: string[];
  defaultOn: boolean;
  // Optional study tag (added 2026-09-24, prerequisite to Phase 2 — see
  // modular-tracking-roadmap.md). A field with no `study` tag cannot be
  // split by GET /api/stats/split — that route's whitelist is exactly "has
  // a study tag", nothing more. Tagging a field here doesn't change what it
  // does today; it only makes it eligible for the generic split. A field
  // left untagged needs a stated reason (e.g. lobby_low/lobby_high below,
  // deferred as a numeric range rather than a category — see the roadmap).
  study?: { metrics: ('win_rate' | 'accuracy')[] };
}

export const FIELD_REGISTRY: FieldEntry[] = [
  {
    id: 'deaths',
    label: 'Track who kills me',
    category: 'combat',
    control: { kind: 'death-logger' },
    writesTo: { table: 'match_deaths', columns: ['killer', 'killer_role', 'ult'] },
    feedsCards: ['killer-frequency'],
    defaultOn: false,
  },
  // Freezing the RegistryField contract (2026-09-23): two more entries,
  // converted by hand in LogMatch.tsx alongside `deaths`, to prove the
  // generic (non-bespoke) control kinds before Phase 2 delegates the
  // remaining ~20 field groups to Haiku workers. `sens`/`dpi` were
  // considered and rejected as the third field here — they're not an
  // editable form control at all. LogMatch shows sens as a read-only
  // computed display (the active blind-stage-test value or a frozen
  // fallback; see LogMatch.tsx's own comment above the display div and
  // matches.ts:58-62), and dpi is either the blind-stage value or a fixed
  // 1600 constant (schema.ts:105-111) — neither is ever typed by hand.
  // Forcing a `{kind:'number'}` control onto either would let a user edit
  // a value the sens study depends on staying computed. `notes` was used
  // instead, to also exercise the plain `text` control kind.
  {
    id: 'team_rating',
    label: 'Team quality (stars)',
    category: 'subjective',
    control: { kind: 'star-rating', max: 5 },
    writesTo: { table: 'matches', columns: ['team_rating'] },
    // Was write-only (read back only for the match-history list) until the
    // 2026-09-24 study-tag pass. Now analyzable via GET /api/stats/split
    // (?by=team_rating) — split on the star value, not a dedicated card.
    // Accuracy only, same reason as result_driver: the stars are given after
    // the result is known, so they encode it. Live data 2026-09-24: 1 star
    // won 0 of 25, 4.5 stars won 52 of 54. A win-rate split would just
    // report the outcome back.
    feedsCards: [],
    defaultOn: true,
    study: { metrics: ['accuracy'] },
  },
  {
    id: 'notes',
    label: 'Main perceived factors',
    category: 'subjective',
    control: { kind: 'text' },
    writesTo: { table: 'matches', columns: ['notes'] },
    feedsCards: [],
    defaultOn: true,
  },
  // Minimal entries added 2026-09-24 as the field-registry prerequisite to
  // Phase 2 (see modular-tracking-roadmap.md's Phase 2 section). Control
  // kinds here are placeholders for the study tag only — Phase 2 owns the
  // real client conversion and may pick a different control shape (e.g. a
  // dedicated boolean kind for `leaver`, which today's `select` union has
  // no direct equivalent for).
  {
    id: 'leaver',
    label: 'Someone left the match',
    category: 'core',
    control: { kind: 'select', options: ['yes', 'no'] },
    writesTo: { table: 'matches', columns: ['leaver'] },
    feedsCards: ['dash-stat-leavers'],
    defaultOn: true,
    study: { metrics: ['win_rate', 'accuracy'] },
  },
  {
    id: 'leaver_side',
    label: 'Which team the leaver was on',
    category: 'core',
    control: { kind: 'select', options: ['mine', 'theirs'] },
    writesTo: { table: 'matches', columns: ['leaver_side'] },
    feedsCards: ['dash-stat-leavers'],
    defaultOn: true,
    study: { metrics: ['win_rate', 'accuracy'] },
  },
  {
    id: 'match_quality',
    label: 'Match quality',
    category: 'subjective',
    control: { kind: 'select', options: ['stomp', 'close'] },
    writesTo: { table: 'matches', columns: ['match_quality'] },
    // Was write-only (routes/matches.ts's edit-drawer readback only) until
    // this pass. Analyzable via GET /api/stats/split?by=match_quality.
    feedsCards: [],
    defaultOn: true,
    study: { metrics: ['win_rate', 'accuracy'] },
  },
  {
    id: 'result_driver',
    label: 'Who drove the result',
    category: 'subjective',
    control: { kind: 'select', options: ['me', 'team'] },
    writesTo: { table: 'matches', columns: ['result_driver'] },
    // accuracy ONLY — result_driver records Sean's own read on why the game
    // was won/lost, so splitting WIN RATE by it is circular (the field is
    // partly defined by the outcome it would be "predicting"). Accuracy is
    // an independent measurement, so that split is fine.
    feedsCards: [],
    defaultOn: true,
    study: { metrics: ['accuracy'] },
  },
  // lobby_low / lobby_high deliberately NOT tagged: a numeric SR range, not
  // a category to split rows by. Left for a later decision (roadmap).
  // ... more entries, one per remaining column/column-group, added in
  // Phase 2. sens/dpi's real registry entry (once Phase 2 decides how to
  // represent a read-only/computed control kind) still belongs to the
  // `mouse-settings` category per the roadmap's inventory table — it's
  // deferred, not dropped.
];

export function fieldById(id: string): FieldEntry | undefined {
  return FIELD_REGISTRY.find(f => f.id === id);
}

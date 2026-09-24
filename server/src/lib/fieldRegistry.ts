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
    // Confirmed by the roadmap's own inventory: write-only today, read
    // back only for the match-history list, not analyzed anywhere. That's
    // the declared "capture-only" case data-dependency-check allows.
    feedsCards: [],
    defaultOn: true,
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
  // ... 30 more entries, one per remaining column/column-group, added in
  // Phase 2. sens/dpi's real registry entry (once Phase 2 decides how to
  // represent a read-only/computed control kind) still belongs to the
  // `mouse-settings` category per the roadmap's inventory table — it's
  // deferred, not dropped.
];

export function fieldById(id: string): FieldEntry | undefined {
  return FIELD_REGISTRY.find(f => f.id === id);
}

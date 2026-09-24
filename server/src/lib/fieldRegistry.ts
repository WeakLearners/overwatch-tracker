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

// Mode/role tags — added at Phase 2 kickoff (2026-09-24, Sean's addition to
// the roadmap). Cheap to add now, one shape frozen across all Phase 2
// entries, so the eventual filter-settings screen doesn't have to reopen
// every field to backfill it. `appliesTo` omitted (or an empty sub-array)
// means "applies to everything" — no field needs to declare the common
// case. Nothing reads this yet; the filter UI is a later phase. Values are
// copied from client/src/types/index.ts's `QueueMode` and the informal
// hero-role union already used throughout the client (`HEROES` maps a hero
// to one of these three strings) — this file can't import that client type
// (Phase 1's server-only decision, see the top of this file), so the same
// three literals are declared here instead of shared.
export type QueueMode = 'qp_role' | 'comp_role' | 'comp_open';
export type Role = 'Tank' | 'DPS' | 'Support';

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
    | { kind: 'toggle-pair'; options: string[] }
    | { kind: 'rank-outcome' }
    | { kind: 'text' };
  writesTo: {
    table: 'matches' | 'match_deaths' | 'match_heroes';
    columns: string[];
  };
  appliesTo?: { modes?: QueueMode[]; roles?: Role[] };
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
    // toggle-pair, not select: the actual LogMatch.tsx control (converted
    // Phase 2, 2026-09-24) is the same tap-to-clear two-button grammar as
    // Win/Loss and Leaver, not a dropdown. `select` here until now was a
    // placeholder for the study tag only (see the comment that used to sit
    // above this block) — Phase 2 is what picks the real shape.
    control: { kind: 'toggle-pair', options: ['stomp', 'close'] },
    writesTo: { table: 'matches', columns: ['match_quality'] },
    // Was write-only (routes/matches.ts's edit-drawer readback only) until
    // the 2026-09-24 study-tag pass. Analyzable via GET /api/stats/split?by=match_quality.
    feedsCards: [],
    defaultOn: true,
    study: { metrics: ['win_rate', 'accuracy'] },
  },
  {
    id: 'result_driver',
    label: 'Who drove the result',
    category: 'subjective',
    control: { kind: 'toggle-pair', options: ['me', 'team'] },
    writesTo: { table: 'matches', columns: ['result_driver'] },
    // accuracy ONLY — result_driver records Sean's own read on why the game
    // was won/lost, so splitting WIN RATE by it is circular (the field is
    // partly defined by the outcome it would be "predicting"). Accuracy is
    // an independent measurement, so that split is fine.
    feedsCards: [],
    defaultOn: true,
    study: { metrics: ['accuracy'] },
  },
  // Phase 2 group 3 (2026-09-24): player_rank + player_rank_start, one
  // registry entry for the pair — LogMatch.tsx has always written and read
  // them as one decision ("did this match move the ladder"), never as two
  // independent fields. `rank-outcome` is bespoke, not select/number: the
  // control isn't a value Sean types, it's a derived promote/demote/no-
  // change choice built from the live rank drum plus this match's own
  // result. See client/src/components/RankOutcomeControl.tsx. No `study`
  // tag: the underlying value is a raw ladder number, not a category —
  // same reasoning as lobby_low/lobby_high below. A rank-tier-bucketed
  // split would be a real, separate piece of analysis work, not a
  // mechanical tag here.
  {
    id: 'player_rank',
    label: 'Rank outcome',
    category: 'rank',
    control: { kind: 'rank-outcome' },
    writesTo: { table: 'matches', columns: ['player_rank', 'player_rank_start'] },
    // Dashboard's trend candles read both columns for the tier-mark
    // annotations (a match's own before/after rank) — verified against
    // Dashboard.tsx's tierMarks computation, not assumed from the name.
    feedsCards: ['dash-recent-form-tier-mark'],
    defaultOn: true,
    // Competitive only — LogMatch.tsx hides this control outright on
    // Quick Play (`!isQP`), since QP never moves the ladder.
    appliesTo: { modes: ['comp_role', 'comp_open'] },
  },
  // Phase 2 group 4: lobby_low + lobby_high. The actual editable control
  // (LobbyRangeSlider) lives on Prematch.tsx, not LogMatch.tsx — LogMatch
  // only reads the two values off MatchContext at submit time. Gated
  // directly with `isFieldEnabled('lobby_range')` in Prematch.tsx rather
  // than through RegistryField's kind-dispatch switch: the slider takes
  // four own-state callbacks (onChange/onRememberWidth/onResize/onClear)
  // tied to Prematch's local tray-width state, which doesn't fit
  // RegistryField's single value/onChange contract without either
  // widening that contract for one field or lifting tray-width into
  // MatchContext — both bigger than this pass's mechanical scope. No
  // `control` kind is exercised for this entry as a result; it exists so
  // the field has one place to be documented, tagged, and gated by.
  // Deliberately no `study` tag, same reasoning as before: a numeric SR
  // range, not a category to split rows by.
  {
    id: 'lobby_range',
    label: 'Enemy lobby SR range',
    category: 'rank',
    control: { kind: 'number' },
    writesTo: { table: 'matches', columns: ['lobby_low', 'lobby_high'] },
    // No dashboard card reads lobby_low/lobby_high today — verified by
    // grep across client/src; it's write-only pending a future study.
    feedsCards: [],
    defaultOn: true,
    appliesTo: { modes: ['comp_role', 'comp_open'] },
  },
  // Phase 2 group 5: feel, per hero (match_heroes.feel — see schema.ts's
  // own comment: "perceived sens speed... the fulcrum the sens study
  // scores against", not a general mood rating). One slider per hero
  // actually played, same generic `slider` kind Phase 1 shipped but never
  // exercised until now — LogMatch.tsx's per-hero loop still owns the
  // required/unanswered styling and the "Floaty/Snappy/Jittery" labels;
  // only the bare <input type=range> moved into RegistryField. No `study`
  // tag: GET /api/stats/split only accepts a field whose `writesTo.table`
  // is `matches` (enforced in routes/stats.ts, not just this comment) —
  // `feel` lives on `match_heroes`, so tagging it would be silently
  // rejected by that route. The real feel-vs-accuracy analysis already
  // exists as its own bespoke query: SensAnalysis.tsx's "Feel vs. Data"
  // chart (`sensAnalysis-feel-vs-data-chart`).
  {
    id: 'feel',
    label: 'Feel (per hero)',
    category: 'sens-study',
    control: { kind: 'slider', min: 0, max: 100 },
    writesTo: { table: 'match_heroes', columns: ['feel'] },
    feedsCards: ['sensAnalysis-feel-vs-data-chart'],
    defaultOn: true,
  },
  // lobby_low / lobby_high deliberately NOT tagged: a numeric SR range, not
  // a category to split rows by. Left for a later decision (roadmap).
  //
  // curve_* (curve_growth_rate, curve_midpoint, curve_motivity, curve_lut,
  // curve_enabled) and the blind-trial fields (blind_trial, blind_set_id,
  // rel_pos, stage_index, revealed) are NOT converted in this Phase 2 pass.
  // Checked against the running code, same as the sens/dpi check Phase 1
  // did: none of these is ever typed by hand. `findActiveStage` in
  // server/src/routes/matches.ts stamps all of them unconditionally from
  // whichever blind_stage_sets row is active for the hero being logged
  // (made unconditional today, commit b193ef3) — LogMatch.tsx has no
  // control for any of them to convert. Forcing a `{kind:'number'}` or
  // `{kind:'select'}` control onto a computed value would let a user
  // overwrite ground truth the sens study depends on staying computed —
  // exactly the reasoning Sean gave for keeping sens/dpi out of the
  // registry entirely (DECIDED 2026-09-24, see the roadmap's Phase 2
  // section). These two groups need that same explicit decision, not a
  // silent mechanical conversion: this file does not add entries for them.
  // sens/dpi's own real registry entry, if one is ever added, still
  // belongs to `mouse-settings` per the roadmap's inventory table.
];

export function fieldById(id: string): FieldEntry | undefined {
  return FIELD_REGISTRY.find(f => f.id === id);
}

import type { getDb } from '../db/schema';

// The seam between the match tracker and the sensitivity study (Stage 1.5
// slice 4, blocker B2). The tracker writes matches and calls these hooks; it
// never imports the study's code. Whatever implements the hooks lives in
// server/src/experiments/. With nothing installed the tracker uses
// noopExperimentHooks: matches still save, with the sens/dpi the client sent,
// and no credits are written.
//
// Every hook takes the open db handle first because the controller's writes
// must land in the same transaction the tracker already opened.
type Db = ReturnType<typeof getDb>;

export interface StageRef { setId: number; stageIdx: number }

// What the study says a hero is at. `credit` is null whenever the match does
// not count for the study (not Competitive, or a Designated Fallback hero).
// `governsCurve` is false for a Designated Fallback: it has its own fixed
// sens/dpi, but the acceleration flag then stays whatever the client sent.
export interface SensAssignment {
  dpi: number;
  sens: number;
  curveEnabled: boolean;
  governsCurve: boolean;
  credit: StageRef | null;
}

export interface ExperimentHooks {
  // "What sens/dpi is this hero at right now." Mode-agnostic for the sens
  // itself; `queueMode` only decides whether `credit` is set. null = no
  // experiment governs this hero.
  sensFor(db: Db, hero: string, queueMode: string | undefined): SensAssignment | null;
  // After the match row and hero slots exist. Takes the primary hero's credit
  // from sensFor (not a second lookup) so insert and credit cannot disagree.
  onMatchSaved(db: Db, match: { matchId: number; hero: string; credit: StageRef | null }): void;
  // After aim stats rows are written: per-hero minutes decide the credits.
  onAimStatsSaved(db: Db, matchId: number | string): void;
  // After an edit that can move the match onto another stage, or off one.
  // `sensProvided`: the same request set sens directly, so that value wins.
  onRosterEdited(db: Db, matchId: string, opts: { sensProvided: boolean }): void;
  // Delete is two calls because the credit rows cascade away with the match:
  // read what is affected first, re-derive after. The token is opaque.
  beforeMatchDelete(db: Db, matchId: string): unknown;
  afterMatchDelete(db: Db, matchId: string, token: unknown): void;
  // Which heroes of this match hold a credit (the edit drawer's warning).
  creditedHeroes(db: Db, matchId: string): string[];
}

export const noopExperimentHooks: ExperimentHooks = {
  sensFor: () => null,
  onMatchSaved: () => {},
  onAimStatsSaved: () => {},
  onRosterEdited: () => {},
  beforeMatchDelete: () => undefined,
  afterMatchDelete: () => {},
  creditedHeroes: () => [],
};

let installed: ExperimentHooks = noopExperimentHooks;

export function getExperimentHooks(): ExperimentHooks { return installed; }

// Pass nothing to go back to the no-op.
export function setExperimentHooks(hooks?: ExperimentHooks): void {
  installed = hooks ?? noopExperimentHooks;
}

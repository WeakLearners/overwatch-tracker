// Lab-owned study tags (split plan B5). Which tracker fields can be split
// against which metrics is analysis knowledge, so it lives here, keyed by the
// tracker's field id. The tracker's field registry no longer carries `study`.
//
// A field with no entry cannot be split by GET /api/stats/split. The whitelist
// is exactly "has an entry here". `column` is the matches column the field
// writes; studyTags.test.ts checks it against the registry so the two cannot
// drift. Tags moved here unchanged from lib/fieldRegistry.ts (2026-09-24 pass).
//
// result_driver and team_rating are accuracy-only on purpose: both are given
// after the result is known, so a win-rate split would report the outcome back.
export type StudyMetric = 'win_rate' | 'accuracy';

export interface StudyTag {
  /** Column on the matches table. Never taken from a query string. */
  column: string;
  metrics: StudyMetric[];
}

export const STUDY_TAGS: Record<string, StudyTag> = {
  team_rating: { column: 'team_rating', metrics: ['accuracy'] },
  leaver: { column: 'leaver', metrics: ['win_rate', 'accuracy'] },
  leaver_side: { column: 'leaver_side', metrics: ['win_rate', 'accuracy'] },
  match_quality: { column: 'match_quality', metrics: ['win_rate', 'accuracy'] },
  result_driver: { column: 'result_driver', metrics: ['accuracy'] },
};

export function studyTagFor(fieldId: string): StudyTag | undefined {
  return Object.prototype.hasOwnProperty.call(STUDY_TAGS, fieldId) ? STUDY_TAGS[fieldId] : undefined;
}

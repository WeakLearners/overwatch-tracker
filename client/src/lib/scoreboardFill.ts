// The log form's fill from a scoreboard group. The server owns the hard part
// (GET /api/scoreboards/live reads the pages, applies the confirmed tile map,
// and sends a ready payload); this file only decides which blank fields take it.
// Rule: a field that already holds something is never overwritten.
import { HEROES } from '../types';
import type { StatFieldsT, HeroAccStat } from '../components/AimStatsFields';

export interface FillHero {
  hero: string; percent: number; seconds: number | null; duration: string;
  overall_acc: number | null; crit_acc: number | null; extra_acc: number | null;
  torpedo_damage: number | null; torpedo_healing: number | null; mapped: boolean;
}
export interface FormFill {
  group_id: number; map: string | null; win: 0 | 1 | null; score_us: number | null; score_them: number | null;
  heroes: FillHero[]; elims: number | null; assists: number | null; deaths: number | null;
  damage: number | null; healing: number | null;
  pages: { summary: boolean; teams: boolean; personal: string[] };
}
export type ScoreboardStage = 'idle' | 'detected' | 'partial' | 'ready' | 'problem';
export interface LivePayload {
  light: 'green' | 'off'; group_id: number | null; fill: FormFill | null;
  /** Pipeline stage from the server (lib/scoreboardStage.ts); drives the light's dot and text only. */
  stage?: ScoreboardStage; reading?: number; reason?: string | null; ignored?: number;
  pages?: { summary: boolean; teams: boolean; personal: number } | null;
}

export interface FormSnapshot {
  hero: string; switchHeroes: [string, string]; win: '' | '1' | '0'; map: string;
  scoreUs: string; scoreThem: string; aimStats: StatFieldsT;
}
export interface FormPatch {
  hero?: string; switchHeroes?: [string, string]; win?: '1' | '0'; map?: string;
  scoreUs?: string; scoreThem?: string; aimStats?: StatFieldsT; aimOpen?: true;
}

const s = (v: number | null) => (v == null ? '' : String(v));

export function fillPatch(f: FormSnapshot, fill: FormFill): FormPatch {
  const patch: FormPatch = {};
  const first = fill.heroes[0]?.hero;

  if (!f.map && fill.map) patch.map = fill.map;
  if (f.win === '' && fill.win != null) patch.win = String(fill.win) as '1' | '0';
  if (!f.scoreUs && !f.scoreThem && fill.score_us != null && fill.score_them != null) {
    patch.scoreUs = String(fill.score_us); patch.scoreThem = String(fill.score_them);
  }

  // Roster: take the scoreboard's heroes only when they agree with what is already picked.
  const hero = f.hero || first || '';
  const switchNow = f.switchHeroes.filter(Boolean);
  let roster: string[] = [hero, ...switchNow].filter(Boolean);
  const wanted = fill.heroes.map(h => h.hero);
  if (!f.hero && first) patch.hero = first;
  if (first && hero === first && switchNow.length === 0) {
    const rest = wanted.slice(1, 3);
    if (rest.length) patch.switchHeroes = [rest[0] ?? '', rest[1] ?? ''];
    roster = wanted.slice(0, 3);
  }
  const rosterAgrees = roster.length > 0 && roster.length === wanted.length && roster.every(h => wanted.includes(h));

  if (rosterAgrees) {
    const hasSupport = roster.some(h => HEROES[h] === 'Support');
    const a: StatFieldsT = { ...f.aimStats };
    const setIf = (k: 'elims' | 'deaths' | 'damage' | 'healing' | 'assists', v: number | null) => { if (a[k].trim() === '' && v != null) a[k] = String(v); };
    setIf('elims', fill.elims); setIf('deaths', fill.deaths); setIf('damage', fill.damage);
    if (hasSupport) { setIf('healing', fill.healing); setIf('assists', fill.assists); }
    a.heroAcc = roster.map(name => {
      const row: HeroAccStat = f.aimStats.heroAcc.find(r => r.hero === name)
        ?? { hero: name, overall_acc: '', crit_acc: '', extra_acc: '', torpedo_damage: '', torpedo_healing: '', duration_min: '' };
      const src = fill.heroes.find(h => h.hero === name);
      if (!src) return row;
      const next = { ...row };
      if (!next.duration_min.trim()) next.duration_min = src.duration;
      if (src.mapped) {
        if (!next.overall_acc.trim()) next.overall_acc = s(src.overall_acc);
        if (!next.crit_acc.trim()) next.crit_acc = s(src.crit_acc);
        if (!next.extra_acc.trim()) next.extra_acc = s(src.extra_acc);
        if (!next.torpedo_damage.trim()) next.torpedo_damage = s(src.torpedo_damage);
        if (!next.torpedo_healing.trim()) next.torpedo_healing = s(src.torpedo_healing);
      }
      return next;
    });
    if (JSON.stringify(a) !== JSON.stringify(f.aimStats)) { patch.aimStats = a; patch.aimOpen = true; }
  }
  return patch;
}

/** Changes whenever a page lands in the group, so late Personal pages fill their blanks too. */
export const fillSignature = (fill: FormFill) =>
  `${fill.group_id}:${fill.pages.summary ? 1 : 0}${fill.pages.teams ? 1 : 0}:${fill.pages.personal.join(',')}`;

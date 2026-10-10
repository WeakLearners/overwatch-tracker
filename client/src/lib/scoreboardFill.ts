// The log form's fill from a scoreboard group. The server owns the hard part
// (GET /api/scoreboards/live reads the pages, applies the confirmed tile map,
// and sends a ready payload); this file only decides which blank fields take it.
// Rule: a field that already holds something is never overwritten, unless the caller
// asks for overwrite mode (the refresh button), which still never touches the start hero.
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

export interface FillOptions {
  /** Re-read mode: scoreboard-sourced fields replace what the form holds. The start hero, Feel, Team, quality and notes are never touched. */
  overwrite?: boolean;
}

/** Heroes on the scoreboard, in play-time order, max 3. */
const boardHeroes = (fill: FormFill) => fill.heroes.map(h => h.hero).slice(0, 3);

export function fillPatch(f: FormSnapshot, fill: FormFill, opts: FillOptions = {}): FormPatch {
  const ow = !!opts.overwrite;
  const patch: FormPatch = {};
  const wanted = boardHeroes(fill);
  const first = wanted[0];

  if (fill.map && (ow || !f.map)) patch.map = fill.map;
  if (fill.win != null && (ow || f.win === '')) patch.win = String(fill.win) as '1' | '0';
  if (fill.score_us != null && fill.score_them != null && (ow || (!f.scoreUs && !f.scoreThem))) {
    patch.scoreUs = String(fill.score_us); patch.scoreThem = String(fill.score_them);
  }

  // Pickers. The start hero records the advisor's pick: filled only when blank.
  // Switch slots take the other scoreboard heroes in play-time order: blank slots only,
  // or both slots in overwrite mode.
  const start = f.hero || first || '';
  if (!f.hero && first) patch.hero = first;
  const others = wanted.filter(h => h !== start);
  let slots: [string, string];
  if (ow) slots = [others[0] ?? '', others[1] ?? ''];
  else {
    slots = [f.switchHeroes[0], f.switchHeroes[1]];
    const queue = others.filter(h => h !== start && !slots.includes(h));
    for (let i = 0; i < 2; i++) if (!slots[i]) slots[i] = queue.shift() ?? '';
  }
  if (slots[0] !== f.switchHeroes[0] || slots[1] !== f.switchHeroes[1]) patch.switchHeroes = slots;

  // Stats always use the scoreboard's heroes. A row exists only for a hero that has a picker
  // slot (the form drops other rows), in picker order.
  const picked = [...new Set([start, ...slots].filter(Boolean))];
  const hasSupport = wanted.some(h => HEROES[h] === 'Support');
  const a: StatFieldsT = { ...f.aimStats };
  const setIf = (k: 'elims' | 'deaths' | 'damage' | 'healing' | 'assists', v: number | null) => { if (v != null && (ow || a[k].trim() === '')) a[k] = String(v); };
  setIf('elims', fill.elims); setIf('deaths', fill.deaths); setIf('damage', fill.damage);
  if (hasSupport) { setIf('healing', fill.healing); setIf('assists', fill.assists); }
  a.heroAcc = picked.map(name => {
    const row: HeroAccStat = f.aimStats.heroAcc.find(r => r.hero === name)
      ?? { hero: name, overall_acc: '', crit_acc: '', extra_acc: '', torpedo_damage: '', torpedo_healing: '', duration_min: '' };
    const src = fill.heroes.find(h => h.hero === name);
    if (!src) return row;
    const next = { ...row };
    const put = (k: Exclude<keyof HeroAccStat, 'hero'>, v: number | string | null) => {
      if (v == null) return;
      if (ow || !next[k].trim()) next[k] = typeof v === 'number' ? String(v) : v;
    };
    put('duration_min', src.duration);
    if (src.mapped) {
      put('overall_acc', src.overall_acc); put('crit_acc', src.crit_acc); put('extra_acc', src.extra_acc);
      put('torpedo_damage', src.torpedo_damage); put('torpedo_healing', src.torpedo_healing);
    }
    return next;
  });
  if (JSON.stringify(a) !== JSON.stringify(f.aimStats)) { patch.aimStats = a; patch.aimOpen = true; }
  return patch;
}

export interface HeroMismatch {
  /** Scoreboard heroes with their play-time share, for the marker text. */
  board: { hero: string; percent: number }[];
  /** Picked heroes that are not on the scoreboard (their pickers get the ring). */
  notOnBoard: string[];
  /** Scoreboard heroes with no picker. */
  notPicked: string[];
}

/** Null when the picked set equals the scoreboard set. Judged on the form as it is now, so it follows later edits. */
export function heroMismatch(picked: (string | undefined)[], fill: FormFill): HeroMismatch | null {
  const have = [...new Set(picked.filter((h): h is string => !!h))];
  const wanted = boardHeroes(fill);
  const notOnBoard = have.filter(h => !wanted.includes(h));
  const notPicked = wanted.filter(h => !have.includes(h));
  if (!notOnBoard.length && !notPicked.length) return null;
  return { board: fill.heroes.slice(0, 3).map(h => ({ hero: h.hero, percent: h.percent })), notOnBoard, notPicked };
}

/** Changes whenever a page lands in the group, so late Personal pages fill their blanks too. */
export const fillSignature = (fill: FormFill) =>
  `${fill.group_id}:${fill.pages.summary ? 1 : 0}${fill.pages.teams ? 1 : 0}:${fill.pages.personal.join(',')}`;

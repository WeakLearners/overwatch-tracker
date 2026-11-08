// "Play habits": does how Sean plays (recent form, long days, late in a
// session) move his comp win rate? A pure function over match rows, the same
// pattern as sweepFindings in scripts/nightlyAnalysis.ts: it takes data and
// returns findings, so the page, the nightly job, and Prematch cannot disagree.
// Spec: projects/overwatch-lab/auto/winrate-decline-2026-11-08.md section 7.
//
// Rules fixed in advance (no cut date is searched):
//   - Comp only (comp_role, comp_open). Crashed games count: they have a result.
//   - Window = the last HABITS_WINDOW comp matches, ordered by date, time, id.
//   - Every group needs HABITS_MIN_GROUP matches, else the row is "thin".
//   - Verdicts come from makeFinding. Bonferroni runs over the HABITS_GROUPS
//     groups the card shows (form 100, form 200, day load, three position bins,
//     switch vs repeat, three hero-experience bins = 10), counted whether or
//     not a group is thin, so a thin group cannot loosen the bar for the others.
//     S2 (2026-11-08) raised the count from 6 to 10: threshold 0.05/10 = 0.005.
//   - Order-based rows (session position) use only rows with a real start
//     time: date 2026-03-01 or later with a time stamp. Before that, same-day
//     matches share one time stamp and any order is invented.
//   - Session rule (same as the analysis scripts): a gap of more than 90
//     minutes between two comp matches on `time` starts a new session.
import type { DatabaseSync } from 'node:sqlite';
import { makeFinding, type Finding } from './finding';
import { BLOCK_MINUTES, deriveBlockState } from './blind';

export const HABITS_WINDOW = 300;
export const HABITS_MIN_GROUP = 40;
export const HABITS_BIG_DAY = 9;
export const HABITS_SESSION_GAP_MIN = 90;
export const HABITS_REAL_TIME_FROM = '2026-03-01';
export const HABITS_GROUPS = 10;
/** Hero experience: matches on the hero in the prior 30 days. Bins fixed in advance. */
export const HABITS_EXPERIENCE_DAYS = 30;
export const HABITS_EXPERIENCE_BINS = [
  { label: '0-4 in 30 days', lo: 0, hi: 4 },
  { label: '5-19 in 30 days', lo: 5, hi: 19 },
  { label: '20+ in 30 days', lo: 20, hi: Infinity },
] as const;

export interface HabitMatch {
  id: number;
  date: string;          // YYYY-MM-DD
  time: string | null;   // YYYY-MM-DDTHH:MM:SS
  hero: string;
  win: number;           // 1 or 0
  queue_mode: string | null;
  /** Play minutes per hero from aim_stats_heroes.duration_min. Absent or empty: the match counts 0 minutes. */
  heroMinutes?: Record<string, number>;
}

/**
 * Comp-and-all match rows for computeHabits, with per-hero play minutes joined
 * from aim_stats_heroes. Shared by the route and the nightly report so they
 * read the same rows. Read-only.
 */
export function loadHabitMatches(db: DatabaseSync): HabitMatch[] {
  const rows = db.prepare(
    `SELECT id, date, time, hero, win, queue_mode FROM matches
     WHERE queue_mode IN ('comp_role', 'comp_open') ORDER BY date, time, id`,
  ).all() as unknown as HabitMatch[];
  const mins = db.prepare('SELECT match_id, hero, duration_min FROM aim_stats_heroes WHERE duration_min > 0')
    .all() as unknown as { match_id: number; hero: string; duration_min: number }[];
  const byMatch = new Map<number, Record<string, number>>();
  for (const r of mins) {
    const o = byMatch.get(r.match_id) ?? {};
    o[r.hero] = (o[r.hero] ?? 0) + r.duration_min;
    byMatch.set(r.match_id, o);
  }
  for (const m of rows) m.heroMinutes = byMatch.get(m.id);
  return rows;
}

export type HabitStatus = 'holds' | 'none' | 'thin';

export interface HabitGroup {
  label: string;
  finding: Finding;
  rest: { label: string; rate: number; n: number };
  status: HabitStatus;
  /** True when p < 0.05 before the Bonferroni correction but the group did not hold. */
  weakLead: boolean;
}

export interface HabitRow {
  id: 'form100' | 'form200' | 'dayLoad' | 'position' | 'switch' | 'experience';
  label: string;
  status: HabitStatus;
  groups: HabitGroup[];
  /** Shown only when status is "holds". */
  action: string | null;
}

export interface SpreadSide {
  n: number;                 // matches
  minutes: number;           // play minutes in closed chunks only
  chunks: number;            // closed 60-minute chunks
  perHour: number | null;    // mean distinct heroes per closed chunk
  topHero: string | null;
  topShare: number | null;
}

/** Descriptive only: no test, no verdict, no action line. */
export interface HeroSpread {
  label: string;
  window: SpreadSide;
  baseline: SpreadSide;
}

export interface HabitsResult {
  window: { n: number; from: string | null; to: string | null };
  baseline: { n: number; rate: number | null; from: string | null; to: string | null };
  minGroup: number;
  groupsTested: number;
  threshold: number;
  /** Window matches left out of the position row for lack of a real start time. */
  positionExcluded: number;
  /** Matches left out of switch vs repeat: first of a session, or no real start time. */
  switchExcluded: number;
  spread: HeroSpread;
  rows: HabitRow[];
}

const isComp = (m: HabitMatch) => m.queue_mode === 'comp_role' || m.queue_mode === 'comp_open';
const pct = (x: number) => `${(Math.round(x * 10) / 10).toFixed(1)}%`;
const sum = (rows: HabitMatch[]) => rows.reduce((s, m) => s + m.win, 0);

function testGroup(label: string, group: HabitMatch[], rest: HabitMatch[], restLabel: string): HabitGroup {
  const g = { wins: sum(group), n: group.length };
  const r = { wins: sum(rest), n: rest.length };
  // A thin comparison side makes the row thin too: the verdict needs both sides.
  const minN = rest.length < HABITS_MIN_GROUP ? Infinity : HABITS_MIN_GROUP;
  const finding = makeFinding(g, r, HABITS_GROUPS, minN);
  const status: HabitStatus = finding.verdict === 'holds' ? 'holds' : finding.verdict === 'thin' ? 'thin' : 'none';
  return {
    label, finding, status,
    rest: { label: restLabel, rate: r.n ? Math.round((r.wins / r.n) * 1000) / 10 : 0, n: r.n },
    weakLead: finding.verdict === 'unreliable',
  };
}

// holds if any group holds; thin if no group could be tested; else none.
function rowStatus(groups: HabitGroup[]): HabitStatus {
  if (groups.some(g => g.status === 'holds')) return 'holds';
  if (groups.every(g => g.status === 'thin')) return 'thin';
  return 'none';
}

const ms = (t: string) => Date.parse(`${t}Z`);

export function computeHabits(all: HabitMatch[]): HabitsResult {
  const comp = all.filter(isComp).sort((a, b) =>
    a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.id - b.id);
  const win = comp.slice(-HABITS_WINDOW);
  const before = comp.slice(0, comp.length - win.length);

  // 12-month baseline: comp matches before the window, within 12 months of its first date.
  let baseline: HabitMatch[] = [];
  if (win.length) {
    const d = new Date(`${win[0].date}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    const floor = d.toISOString().slice(0, 10);
    baseline = before.filter(m => m.date >= floor);
  }

  const rows: HabitRow[] = [];

  // Row 1: form. The last 100 and last 200 of the window against the baseline.
  for (const k of [100, 200] as const) {
    const grp = win.slice(-k);
    const g = testGroup(`Last ${k}`, grp, baseline, '12-month baseline');
    let action: string | null = null;
    if (g.status === 'holds') {
      const dir = g.finding.rate < g.rest.rate ? 'below' : 'above';
      action = `Last ${k} comp: ${pct(g.finding.rate)} against your 12-month baseline ${pct(g.rest.rate)} (${dir}). Check the rows below.`;
    }
    rows.push({ id: k === 100 ? 'form100' : 'form200', label: `Form, last ${k}`, status: g.status, groups: [g], action });
  }

  // Row 2: day load. Count comp matches per date over all comp rows, so a day
  // that the window cuts in half is still counted whole.
  const perDay = new Map<string, number>();
  for (const m of comp) perDay.set(m.date, (perDay.get(m.date) ?? 0) + 1);
  const big = win.filter(m => (perDay.get(m.date) ?? 0) >= HABITS_BIG_DAY);
  const small = win.filter(m => (perDay.get(m.date) ?? 0) < HABITS_BIG_DAY);
  {
    const g = testGroup(`${HABITS_BIG_DAY}+ matches a day`, big, small, `${HABITS_BIG_DAY - 1} or fewer`);
    let action: string | null = null;
    if (g.status === 'holds') {
      action = g.finding.rate < g.rest.rate
        ? `On days with ${HABITS_BIG_DAY}+ comp matches you win ${pct(g.finding.rate)} (n=${g.finding.n}) against ${pct(g.rest.rate)} (n=${g.rest.n}). Stop at ${HABITS_BIG_DAY - 1}.`
        : `On days with ${HABITS_BIG_DAY}+ comp matches you win ${pct(g.finding.rate)} (n=${g.finding.n}) against ${pct(g.rest.rate)} (n=${g.rest.n}). Long days do not hurt you.`;
    }
    rows.push({ id: 'dayLoad', label: 'Day load', status: g.status, groups: [g], action });
  }

  // Row 3: session position. Sessions are built over every comp match with a
  // real start time (so a session that began before the window keeps its
  // position), then only window matches are counted.
  const real = comp.filter(m => m.date >= HABITS_REAL_TIME_FROM && m.time);
  const pos = new Map<number, number>();
  let prev: number | null = null;
  let p = 0;
  for (const m of real) {
    const t = ms(m.time as string);
    p = prev !== null && Number.isFinite(t) && (t - prev) / 60000 <= HABITS_SESSION_GAP_MIN ? p + 1 : 1;
    pos.set(m.id, p);
    if (Number.isFinite(t)) prev = t;
  }
  const inPos = win.filter(m => pos.has(m.id));
  const bins: { label: string; lo: number; hi: number }[] = [
    { label: 'Matches 1-3', lo: 1, hi: 3 },
    { label: 'Matches 4-6', lo: 4, hi: 6 },
    { label: 'Matches 7+', lo: 7, hi: Infinity },
  ];
  const posGroups = bins.map(b => {
    const inBin = inPos.filter(m => (pos.get(m.id) as number) >= b.lo && (pos.get(m.id) as number) <= b.hi);
    const outBin = inPos.filter(m => !inBin.includes(m));
    return testGroup(b.label, inBin, outBin, 'other positions');
  });
  let posAction: string | null = null;
  const byP = (a: HabitGroup, b: HabitGroup) => (a.finding.p ?? 1) - (b.finding.p ?? 1);
  const held = posGroups.filter(g => g.status === 'holds');
  const bad = held.filter(g => g.finding.rate < g.rest.rate).sort(byP)[0];
  const top = bad ?? held.sort(byP)[0];
  if (top) {
    const first = bins.find(b => b.label === top.label)!.lo;
    posAction = `${top.label} of a session: you win ${pct(top.finding.rate)} (n=${top.finding.n}) against ${pct(top.rest.rate)} (n=${top.rest.n}) in the other positions.${bad ? ` Stop before match ${first}.` : ''}`;
  }
  rows.push({ id: 'position', label: 'Session position', status: rowStatus(posGroups), groups: posGroups, action: posAction });

  // Row 4: switch vs repeat. Order-based like position: same real-time rows and
  // the same 90 minute session rule. A match is "switch" when its hero differs
  // from the previous comp match in the same session. First of a session has no
  // previous match and is left out.
  const heroKind = new Map<number, 'switch' | 'repeat'>();
  {
    let prevHero: string | null = null;
    for (const m of real) {
      if (pos.get(m.id) === 1) prevHero = null;
      if (prevHero !== null) heroKind.set(m.id, m.hero === prevHero ? 'repeat' : 'switch');
      prevHero = m.hero;
    }
  }
  const inSw = win.filter(m => heroKind.has(m.id));
  {
    const sw = inSw.filter(m => heroKind.get(m.id) === 'switch');
    const rep = inSw.filter(m => heroKind.get(m.id) === 'repeat');
    const g = testGroup('Switched hero', sw, rep, 'same hero as the match before');
    let action: string | null = null;
    if (g.status === 'holds') {
      action = g.finding.rate < g.rest.rate
        ? `You win ${pct(g.finding.rate)} (n=${g.finding.n}) when you switch heroes against ${pct(g.rest.rate)} (n=${g.rest.n}) when you stay. Stay on a hero.`
        : `You win ${pct(g.finding.rate)} (n=${g.finding.n}) when you switch heroes against ${pct(g.rest.rate)} (n=${g.rest.n}) when you stay. Switch sooner after a loss streak on one hero.`;
    }
    rows.push({ id: 'switch', label: 'Switch vs repeat', status: g.status, groups: [g], action });
  }

  // Row 5: hero experience. Matches on the same hero in the prior 30 days
  // (calendar days, earlier in order, counted over all comp rows).
  const exp = new Map<number, number>();
  {
    const byHero = new Map<string, HabitMatch[]>();
    for (const m of comp) {
      const list = byHero.get(m.hero) ?? [];
      const floor = new Date(`${m.date}T00:00:00Z`);
      floor.setUTCDate(floor.getUTCDate() - HABITS_EXPERIENCE_DAYS);
      const f = floor.toISOString().slice(0, 10);
      exp.set(m.id, list.filter(x => x.date >= f).length);
      list.push(m);
      byHero.set(m.hero, list);
    }
  }
  {
    const eg = HABITS_EXPERIENCE_BINS.map(b => {
      const inBin = win.filter(m => (exp.get(m.id) as number) >= b.lo && (exp.get(m.id) as number) <= b.hi);
      const outBin = win.filter(m => !inBin.includes(m));
      return testGroup(b.label, inBin, outBin, 'other bins');
    });
    const held = eg.filter(g => g.status === 'holds').sort(byP);
    const top = held[0];
    const action = top
      ? `On heroes with ${top.label.replace(' in 30 days', '')} matches in the prior 30 days you win ${pct(top.finding.rate)} (n=${top.finding.n}) against ${pct(top.rest.rate)} (n=${top.rest.n}) in the other bins.`
      : null;
    rows.push({ id: 'experience', label: 'Hero experience', status: rowStatus(eg), groups: eg, action });
  }

  // Descriptive: hero spread. Distinct heroes per closed chunk of BLOCK_MINUTES
  // (60) comp play minutes, averaged: the same unit as the sens study blocks.
  // Matches are walked in order, each adding its minutes; the chunk closes the
  // instant deriveBlockState reports a closed block, and overflow is dropped,
  // never carried. A match with no Aim Stats row gives 0 minutes and no heroes.
  // The open tail is dropped. A hero counts when it has >= 1 minute in the chunk.
  const spreadOf = (ms: HabitMatch[]): SpreadSide => {
    const chunks: number[] = [];
    let durations: number[] = [];
    let heroMin = new Map<string, number>();
    let closedMinutes = 0;
    for (const x of ms) {
      const hm = x.heroMinutes ?? {};
      let total = 0;
      for (const [h, v] of Object.entries(hm)) { total += v; heroMin.set(h, (heroMin.get(h) ?? 0) + v); }
      durations.push(total);
      if (deriveBlockState(durations).closedBlocks > 0) {
        chunks.push([...heroMin.values()].filter(v => v >= 1).length);
        closedMinutes += BLOCK_MINUTES;
        durations = [];
        heroMin = new Map();
      }
    }
    const counts = new Map<string, number>();
    for (const x of ms) counts.set(x.hero, (counts.get(x.hero) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      n: ms.length,
      minutes: closedMinutes,
      chunks: chunks.length,
      perHour: chunks.length ? Math.round((chunks.reduce((a, b) => a + b, 0) / chunks.length) * 10) / 10 : null,
      topHero: top?.[0] ?? null,
      topShare: top ? Math.round((top[1] / ms.length) * 1000) / 10 : null,
    };
  };

  const bRate = baseline.length ? Math.round((sum(baseline) / baseline.length) * 1000) / 10 : null;
  return {
    window: { n: win.length, from: win[0]?.date ?? null, to: win[win.length - 1]?.date ?? null },
    baseline: { n: baseline.length, rate: bRate, from: baseline[0]?.date ?? null, to: baseline[baseline.length - 1]?.date ?? null },
    minGroup: HABITS_MIN_GROUP,
    groupsTested: HABITS_GROUPS,
    threshold: 0.05 / HABITS_GROUPS,
    positionExcluded: win.length - inPos.length,
    switchExcluded: win.length - inSw.length,
    spread: { label: 'Hero spread', window: spreadOf(win), baseline: spreadOf(baseline) },
    rows,
  };
}

/** The rows that hold, each with its action text. Same rule for Slack and Prematch. */
export function holdingHabits(r: HabitsResult): { id: HabitRow['id']; label: string; action: string }[] {
  return r.rows.filter(x => x.status === 'holds' && x.action).map(x => ({ id: x.id, label: x.label, action: x.action as string }));
}

/**
 * The one nightly Slack line (S3). A row that holds adds its action text; when
 * no row holds the line says so (a null result is a finding, same as the metric
 * sweep). Never more than one line.
 */
export function describeHabits(r: HabitsResult): string {
  const held = holdingHabits(r);
  if (held.length === 0) return `*Play habits:* no finding (last ${r.window.n} comp, no row holds).`;
  return `*Play habits:* ${held.map(h => `${h.label}: ${h.action}`).join(' | ')}`;
}

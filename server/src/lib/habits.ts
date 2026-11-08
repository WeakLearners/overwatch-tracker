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
//     groups the card shows (form 100, form 200, day load, three position bins),
//     counted whether or not a group is thin, so a thin group cannot loosen
//     the bar for the others.
//   - Order-based rows (session position) use only rows with a real start
//     time: date 2026-03-01 or later with a time stamp. Before that, same-day
//     matches share one time stamp and any order is invented.
//   - Session rule (same as the analysis scripts): a gap of more than 90
//     minutes between two comp matches on `time` starts a new session.
import { makeFinding, type Finding } from './finding';

export const HABITS_WINDOW = 300;
export const HABITS_MIN_GROUP = 40;
export const HABITS_BIG_DAY = 9;
export const HABITS_SESSION_GAP_MIN = 90;
export const HABITS_REAL_TIME_FROM = '2026-03-01';
export const HABITS_GROUPS = 6;

export interface HabitMatch {
  id: number;
  date: string;          // YYYY-MM-DD
  time: string | null;   // YYYY-MM-DDTHH:MM:SS
  win: number;           // 1 or 0
  queue_mode: string | null;
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
  id: 'form100' | 'form200' | 'dayLoad' | 'position';
  label: string;
  status: HabitStatus;
  groups: HabitGroup[];
  /** Shown only when status is "holds". */
  action: string | null;
}

export interface HabitsResult {
  window: { n: number; from: string | null; to: string | null };
  baseline: { n: number; rate: number | null; from: string | null; to: string | null };
  minGroup: number;
  groupsTested: number;
  threshold: number;
  /** Window matches left out of the position row for lack of a real start time. */
  positionExcluded: number;
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

  const bRate = baseline.length ? Math.round((sum(baseline) / baseline.length) * 1000) / 10 : null;
  return {
    window: { n: win.length, from: win[0]?.date ?? null, to: win[win.length - 1]?.date ?? null },
    baseline: { n: baseline.length, rate: bRate, from: baseline[0]?.date ?? null, to: baseline[baseline.length - 1]?.date ?? null },
    minGroup: HABITS_MIN_GROUP,
    groupsTested: HABITS_GROUPS,
    threshold: 0.05 / HABITS_GROUPS,
    positionExcluded: win.length - inPos.length,
    rows,
  };
}

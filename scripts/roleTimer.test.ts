import { computeRoleTimers, RoleTimerMatch } from '../server/src/lib/roleTimer';

// Newest first, as the route returns them. `d` = date label, h = [role, minutes] pairs, null = no per-hero minutes yet.
type H = [string, number][] | null;
const mk = (rows: { d: string; role: string; q?: string; h: H }[]): RoleTimerMatch[] =>
  rows.map(r => ({ date: r.d, role: r.role, queue_mode: r.q ?? 'comp_role', heroes: r.h && r.h.map(([role, duration_min]) => ({ role, duration_min })) })).reverse();
const get = (t: ReturnType<typeof computeRoleTimers>, role: string) => t.roles.find(r => r.role === role)!;

const cases: [string, () => boolean][] = [
  ['empty: all three roles, in order, zeros', () => {
    const t = computeRoleTimers([], 20);
    return t.roles.map(r => r.role).join() === 'Tank,DPS,Support' && t.roles.every(r => r.totalMin === 0 && r.matches === 0 && r.since === null && r.resets === 0);
  }],
  ['split DPS+Support match adds to both clocks', () => {
    const t = computeRoleTimers(mk([{ d: 'd1', role: 'DPS', h: [['DPS', 10], ['Support', 7]] }]), 20);
    return get(t, 'DPS').totalMin === 10 && get(t, 'Support').totalMin === 7 && get(t, 'Tank').totalMin === 0 && get(t, 'DPS').matches === 1 && get(t, 'Support').matches === 1;
  }],
  ['sub-1-minute hero adds nothing', () => {
    const t = computeRoleTimers(mk([{ d: 'd1', role: 'DPS', h: [['DPS', 10], ['Support', 0.9]] }]), 20);
    return get(t, 'Support').totalMin === 0 && get(t, 'Support').matches === 0 && get(t, 'DPS').totalMin === 10;
  }],
  ['crossing resets only that role', () => {
    const t = computeRoleTimers(mk([
      { d: 'd1', role: 'DPS', h: [['DPS', 100], ['Support', 20]] },
      { d: 'd2', role: 'DPS', h: [['DPS', 100], ['Support', 20]] },
      { d: 'd3', role: 'DPS', h: [['DPS', 60], ['Support', 20]] },
    ]), 20);
    const d = get(t, 'DPS'), s = get(t, 'Support');
    return d.totalMin === 0 && d.matches === 0 && d.resets === 1 && d.since === 'd3' && s.totalMin === 60 && s.matches === 3 && s.resets === 0 && s.since === 'd1';
  }],
  ['minutes past the line are dropped', () => {
    const t = computeRoleTimers(mk([{ d: 'd1', role: 'Tank', h: [['Tank', 200]] }, { d: 'd2', role: 'Tank', h: [['Tank', 100]] }, { d: 'd3', role: 'Tank', h: [['Tank', 5]] }]), 20);
    return get(t, 'Tank').totalMin === 5 && get(t, 'Tank').matches === 1 && get(t, 'Tank').resets === 1;
  }],
  ['QP ignored', () => {
    const t = computeRoleTimers(mk([{ d: 'd1', role: 'DPS', q: 'qp_role', h: [['DPS', 50]] }, { d: 'd2', role: 'DPS', q: 'qp_role', h: null }]), 20);
    return t.roles.every(r => r.totalMin === 0 && r.matches === 0);
  }],
  ['open queue counts (comp_open)', () => {
    const t = computeRoleTimers(mk([{ d: 'd1', role: 'DPS', q: 'comp_open', h: [['DPS', 12]] }]), 20);
    return get(t, 'DPS').totalMin === 12;
  }],
  ['no-minutes match: average goes to matches.role, marked estimated', () => {
    const t = computeRoleTimers(mk([{ d: 'd1', role: 'Support', h: [['Support', 10]] }, { d: 'd2', role: 'Support', h: null }]), 20);
    const s = get(t, 'Support');
    return s.recordedMin === 10 && s.estimatedMin === 20 && s.totalMin === 30 && s.matches === 2 && get(t, 'DPS').totalMin === 0;
  }],
  ['same-role heroes in one match sum and count one match', () => {
    const t = computeRoleTimers(mk([{ d: 'd1', role: 'DPS', h: [['DPS', 6], ['DPS', 4]] }]), 20);
    return get(t, 'DPS').totalMin === 10 && get(t, 'DPS').matches === 1;
  }],
];
let bad = 0;
for (const [n, f] of cases) { const ok = f(); if (!ok) bad++; console.log(ok ? 'PASS' : 'FAIL', n); }
process.exit(bad ? 1 : 0);

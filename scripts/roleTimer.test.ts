import { computeRoleTimer } from '../server/src/lib/roleTimer';
const mk = (seq: string) => seq.split(' ').map((t, i) => {
  const [r, m] = t.split(':'); const open = false;
  return { date: `d${i}`, role: r[0] === 'S' ? 'Support' : r[0] === 'T' ? 'Tank' : 'DPS', queue_mode: open ? 'comp_open' : r.endsWith('q') ? 'qp_role' : 'comp_role', minutes: Number(m) };
}).reverse();
const cases: [string, string, (t: any) => boolean][] = [
  ['S-D-S detour', 'S:10 D:10 S:10', t => t.role === 'Support' && t.totalMin === 20 && t.matches === 2 && !t.held],
  ['S-S-S-D-D switch', 'S:10 S:10 S:10 D:5 D:7', t => t.role === 'DPS' && t.totalMin === 12 && !t.held],
  ['S-S-S-D pending', 'S:10 S:10 S:10 D:5', t => t.role === 'DPS' && t.totalMin === 5 && t.held?.role === 'Support' && t.held.totalMin === 30],
  ['alternation', 'S:10 D:10 S:10 D:10 S:10', t => t.role === 'Support' && t.totalMin === 30 && !t.held],
  ['QP interleaved', 'S:10 Dq:99 D:5', t => t.role === 'DPS' && t.totalMin === 5 && t.held?.totalMin === 10],
  ['today', 'D:1 D:1 D:1 S:4.9 S:10.7 S:15.7 S:13.7 D:9 S:15.5', t => t.role === 'Support' && t.totalMin === 60.5 && !t.held],
  ['close flips DPS->Support at 0', 'D:100 D:100 D:50', t => t.role === 'Support' && t.matches === 0 && t.totalMin === 0 && t.since === 'd2' && !t.held && !t.reached],
  ['Support after close accumulates', 'D:100 D:100 D:50 S:10 S:15', t => t.role === 'Support' && t.matches === 2 && t.totalMin === 25 && !t.held],
  ['DPS after close starts fresh', 'D:100 D:100 D:50 D:7', t => t.role === 'DPS' && t.matches === 1 && t.totalMin === 7 && !t.held],
  ['no detour merge across closed run', 'D:100 D:100 D:50 S:10 D:7', t => t.role === 'DPS' && t.matches === 1 && t.totalMin === 7 && t.held?.role === 'Support' && t.held.totalMin === 10],
  ['Tank close resets same role', 'T:240', t => t.role === 'Tank' && t.matches === 0 && t.totalMin === 0],
];
let bad = 0;
for (const [n, s, f] of cases) { const t = computeRoleTimer(mk(s), 20); const ok = f(t); if (!ok) { bad++; console.log(JSON.stringify(t)); } console.log(ok ? 'PASS' : 'FAIL', n); }
process.exit(bad ? 1 : 0);

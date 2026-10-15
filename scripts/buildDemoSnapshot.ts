// Builds client/src/demo/snapshot.json: the bundled data behind the static,
// read-only demo (scripts/build-demo.sh). Nothing in it is real. A throwaway
// SQLite file is seeded with synthetic matches through the real POST
// /api/matches path, then every GET the dashboard makes is recorded.
//
//   node --experimental-sqlite -r tsx/cjs scripts/buildDemoSnapshot.ts
//
// Deterministic: the same script writes the same file. Never opens
// data/overwatch.db (the harness uses its own temp file). Blizzard images are
// forced off, so the roster payload lists no portraits and the demo build
// carries no image from server/data/assets/.
process.env.OW_BLIZZARD_IMAGES = 'off';

import fs from 'fs';
import path from 'path';
import { startHarness } from '../server/src/test/httpHarness';

interface Hero { name: string; role: 'DPS' | 'Tank' | 'Support' }
const roster = JSON.parse(fs.readFileSync(path.join(__dirname, '../server/data/roster.json'), 'utf8')) as { heroes: Hero[]; maps: { name: string }[] | string[] };
const heroes = roster.heroes;
const mapNames: string[] = (roster.maps as any[]).map(m => (typeof m === 'string' ? m : m.name));

// mulberry32: small seeded PRNG so the snapshot is reproducible.
let seed = 20261009;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

// Played pool: a few heroes per role, weighted toward the first.
const pool: Record<string, Hero[]> = { DPS: [], Tank: [], Support: [] };
for (const role of Object.keys(pool)) {
  const all = heroes.filter(h => h.role === role);
  pool[role] = [all[2 % all.length], all[0], all[4 % all.length], all[6 % all.length], all[1]].filter(Boolean);
}
const heroEdge = new Map<string, number>();
for (const role of Object.keys(pool)) pool[role].forEach((h, i) => heroEdge.set(h.name, 0.08 - i * 0.05));
const killerPool = heroes.filter(h => ['DPS', 'Tank', 'Support'].includes(h.role));

const pad = (n: number) => String(n).padStart(2, '0');
const DAYS = 'Sunday Monday Tuesday Wednesday Thursday Friday Saturday'.split(' ');

async function main() {
  const h = await startHarness({ experiments: false });
  try {
    let rank = 17;
    const start = Date.UTC(2026, 5, 1);
    const matchIds: number[] = [];
    for (let day = 0; day < 124; day++) {
      if (rnd() < 0.22) continue;
      const d = new Date(start + day * 86400000);
      const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
      const games = 2 + Math.floor(rnd() * 5);
      let hour = 17 + Math.floor(rnd() * 5);
      for (let g = 0; g < games; g++) {
        const role = pick(['DPS', 'DPS', 'Support', 'Tank']);
        const hero = pick(pool[role].slice(0, 3 + Math.floor(rnd() * 3)));
        const pWin = 0.5 + (heroEdge.get(hero.name) ?? 0) + (hour >= 23 ? -0.08 : 0);
        const win = rnd() < pWin;
        const rankStart = rank;
        rank = Math.max(8, Math.min(40, rank + (win ? 1 : -1) * (rnd() < 0.35 ? 1 : 0) * 0.5));
        const deaths = Array.from({ length: 2 + Math.floor(rnd() * 6) }, () => {
          const k = pick(killerPool);
          return { killer: k.name, killer_role: k.role, ult: rnd() < 0.15 };
        });
        const r = await h.post('/api/matches', {
          date, time: `${pad(hour % 24)}:${pad(Math.floor(rnd() * 60))}`,
          day_of_week: DAYS[d.getUTCDay()], hour: hour % 24,
          hero: hero.name, role: hero.role, map: pick(mapNames),
          game_type: 'comp', queue_mode: 'comp_role', win,
          feel: Math.round(30 + rnd() * 40),
          player_rank: Math.round(rank), player_rank_start: Math.round(rankStart),
          match_deaths: deaths,
        });
        if (r.status !== 200) throw new Error(`seed failed: ${JSON.stringify(r.body)}`);
        matchIds.push(r.body.id);
        if (rnd() < 0.5) hour++;
      }
    }
    await h.put('/api/ranks', { account: '', role: 'DPS', rank: Math.round(rank) });

    const out: Record<string, unknown> = {};
    const record = async (url: string) => {
      const r = await h.get(url);
      if (r.status === 200) out[url] = r.body;
      else process.stderr.write(`skip ${url} -> ${r.status}\n`);
    };

    const stats = ['overview', 'streaks', 'mode-comparison', 'prematch', 'momentum', 'insights', 'by-day-hour', 'killer-frequency',
      'trends?window=20', 'by-map?min_games=1', 'map-voting?queue_mode=comp_role', 'hero-counts', 'map-counts'];
    const urls = [
      '/api/roster', '/api/config', '/api/ranks', '/api/df', '/api/role-timer',
      '/api/blind/state', '/api/blind/sets', '/api/blind/next?queue_mode=comp_role',
      '/api/aim/analysis', '/api/aim/pending?limit=40', '/api/aim/pending?limit=1',
      '/api/custom-phases', '/api/scoreboards/live', '/api/scoreboards/unmatched',
      '/api/matches?limit=100', '/api/matches?limit=50',
      ...stats.map(s => `/api/stats/${s}`),
    ];
    for (const u of urls) await record(u);

    const played = [...new Set(Object.values(pool).flat().map(x => x.name))];
    for (const hero of played) await record(`/api/stats/hero-detail/${encodeURIComponent(hero)}`);
    for (const map of mapNames) await record(`/api/stats/map-detail/${encodeURIComponent(map)}`);
    for (const id of matchIds.slice(-40)) {
      for (const suffix of ['', '/heroes', '/hero-stats', '/hero-history', '/map-history']) await record(`/api/matches/${id}${suffix}`);
    }

    const dest = path.join(__dirname, '../client/src/demo/snapshot.json');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(out) + '\n');
    process.stdout.write(`snapshot: ${Object.keys(out).length} responses, ${matchIds.length} synthetic matches -> ${dest}\n`);
  } finally {
    await h.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });

import { useMapDrawer } from '../contexts/MapDrawerContext';
import { useApi } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { MAPS, TYPE_COLORS, ROLE_COLORS } from '../types';

interface HeroRow { hero: string; role: string; games: number; win_rate: number }
interface MapDetail {
  overall:  { games: number; win_rate: number; wins: number; losses: number };
  momentum: { recent_wr: number | null; prev_wr: number | null; recent_games: number; prev_games: number };
  heroes:   { DPS: HeroRow[]; Tank: HeroRow[]; Support: HeroRow[] };
  recent5:  { win: number; hero: string; date: string }[];
}

function WR({ rate }: { rate: number }) {
  const cls = rate >= 60 ? 'text-emerald-600' : rate >= 50 ? 'text-ow-blue' : rate >= 40 ? 'text-yellow-400' : 'text-red-600';
  return <span className={`font-bold ${cls}`}>{rate.toFixed(1)}%</span>;
}

interface MapTableRow { map: string; game_type: string; games: number; wins: number }

// Every map with a game, sorted by games played, n on every row, no ranking
// language and no best/worst mark (split plan decision 5, replacing the
// Pre-Match best/worst pills). Same /by-map read as every other map count,
// with the usual 3-game floor lifted so no map hides. Crashed matches count:
// they carry a real map and a result. A row opens that map's own drawer.
function AllMapsTable({ current }: { current: string }) {
  const { openMap } = useMapDrawer();
  const { data } = useApi<MapTableRow[]>('/api/stats/by-map?min_games=1');
  if (!data) return null;
  const byMap = new Map<string, { games: number; wins: number }>();
  for (const r of data) {
    const e = byMap.get(r.map) ?? { games: 0, wins: 0 };
    e.games += r.games; e.wins += r.wins;
    byMap.set(r.map, e);
  }
  const rows = [...byMap].map(([map, v]) => ({ map, ...v })).sort((a, b) => b.games - a.games || a.map.localeCompare(b.map));
  if (rows.length === 0) return null;
  return (
    <div data-inspect-id="mapDrawer-all-maps-table">
      <div className="text-xs text-[var(--faint)] uppercase tracking-wider mb-2">All maps</div>
      <div className="flex items-center gap-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--muted)]">
        <span className="flex-1">Map</span>
        <span className="w-14 text-right">Games</span>
        <span className="w-14 text-right">Win rate</span>
      </div>
      <div className="divide-y divide-ow-border/30">
        {rows.map(r => (
          <button
            key={r.map}
            onClick={() => openMap(r.map)}
            className="w-full flex items-center gap-2 py-1 text-left hover:bg-ow-darker/60 transition-colors"
          >
            <span className={`flex-1 min-w-0 truncate text-xs map-name ${r.map === current ? 'text-ow-accent' : 'text-[var(--ink)]'}`}>{r.map}</span>
            <span className="w-14 text-right text-xs text-[var(--faint)]">{r.games}</span>
            <span className="w-14 text-right text-xs text-[var(--ink)]">{(r.wins / r.games * 100).toFixed(1)}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DrawerContent({ map }: { map: string }) {
  const { data } = useApi<MapDetail>(`/api/stats/map-detail/${encodeURIComponent(map)}`);
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();

  if (!data) return <div className="p-5 text-sm text-[var(--faint)]">Loading…</div>;

  const { recent_wr, prev_wr, recent_games, prev_games } = data.momentum;
  const delta = recent_wr !== null && prev_wr !== null
    ? Math.round((recent_wr - prev_wr) * 10) / 10
    : null;

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-6">

      {/* Overall */}
      <div>
        <div data-inspect-id="mapDrawer-overall-stat" className="text-xs text-[var(--faint)] uppercase tracking-wider mb-2">Overall</div>
        <div className="flex items-end gap-2">
          <span className={`text-4xl font-black ${data.overall.win_rate >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
            {data.overall.win_rate.toFixed(1)}%
          </span>
          <span className="text-sm text-[var(--faint)] pb-1 font-bold">{data.overall.games} games</span>
        </div>
        <div className="text-xs text-[var(--faint-2)] mt-0.5"><b className="font-bold">{data.overall.wins}</b>W · <b className="font-bold">{data.overall.losses}</b>L</div>
      </div>

      {/* Trend */}
      {delta !== null && (
        <div>
          <div data-inspect-id="mapDrawer-trend-stat" className="text-xs text-[var(--faint)] uppercase tracking-wider mb-2">Trend</div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--muted)] font-bold">{prev_wr!.toFixed(1)}%</span>
            <span className="text-[var(--faint-2)]">→</span>
            <WR rate={recent_wr!} />
            {delta > 0 && <span className="text-xs font-bold text-emerald-600">↑ +{delta.toFixed(1)} pts</span>}
            {delta < 0 && <span className="text-xs font-bold text-red-600">↓ {delta.toFixed(1)} pts</span>}
            {delta === 0 && <span className="text-xs text-[var(--faint)]">→ flat</span>}
          </div>
          <div className="text-xs text-[var(--faint-2)] mt-0.5">
            <b className="font-bold">{recent_games}</b> games last 30d · <b className="font-bold">{prev_games}</b> games prior 90d
          </div>
        </div>
      )}

      {/* Heroes by role */}
      {(['DPS', 'Tank', 'Support'] as const).map(role => {
        const heroes = data.heroes[role];
        if (!heroes?.length) return null;
        return (
          <div key={role} data-inspect-id="mapDrawer-heroes-list">
            <div className={`text-xs font-bold uppercase tracking-widest mb-2 ${ROLE_COLORS[role].split(' ')[1]}`}>
              {role}
            </div>
            <div className="divide-y divide-ow-border/30">
              {heroes.map(h => (
                <div key={h.hero} className="flex items-center gap-2 py-1.5">
                  <span className={`text-sm ${h.win_rate >= 50 ? 'text-emerald-700' : 'text-red-500'}`}>
                    {h.win_rate >= 50 ? '↑' : '↓'}
                  </span>
                  <span className="flex-1 text-xs hero-name text-[var(--ink)]">{withHeroCount(h.hero, heroCounts)}</span>
                  <WR rate={h.win_rate} />
                  <span className="text-xs text-[var(--faint-2)] shrink-0 text-right font-bold">{h.games} games</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Last 5 */}
      {data.recent5.length > 0 && (
        <div>
          <div data-inspect-id="mapDrawer-last5-list" className="text-xs text-[var(--faint)] uppercase tracking-wider mb-2">Last <b className="font-bold">{data.recent5.length}</b></div>
          <div className="flex items-center gap-2">
            {data.recent5.map((m, i) => (
              <div
                key={i}
                title={`${m.win ? 'W' : 'L'} · ${withHeroCount(m.hero, heroCounts).toUpperCase()}`}
                className={`w-7 h-7 rounded flex items-center justify-center text-xs font-bold border ${
                  m.win
                    ? 'bg-emerald-500/20 text-emerald-600 border-emerald-500/30'
                    : 'bg-red-500/20 text-red-600 border-red-500/30'
                }`}
              >
                {m.win ? 'W' : 'L'}
              </div>
            ))}
          </div>
        </div>
      )}

      <AllMapsTable current={map} />
    </div>
  );
}

export default function MapDrawer() {
  const { activeMap, closeMap } = useMapDrawer();
  const mapType = activeMap ? (MAPS[activeMap] ?? '') : '';
  const mapCounts = useTodayMapCounts();

  return (
    <>
      {/* Backdrop */}
      <div
        data-inspect-id="mapDrawer-backdrop"
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${activeMap ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={closeMap}
      />
      {/* Drawer */}
      <div data-inspect-id="mapDrawer-panel" className={`fixed inset-y-0 right-0 w-96 bg-ow-dark border-l border-ow-border z-50 flex flex-col transition-transform duration-300 ${activeMap ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-start justify-between p-5 border-b border-ow-border shrink-0">
          <div>
            <h2 data-inspect-id="mapDrawer-title" className="text-xl map-name text-[var(--ink)] leading-tight">{activeMap ? withMapCount(activeMap, mapCounts) : ''}</h2>
            {mapType && <span data-inspect-id="mapDrawer-type-badge" className={`pill mt-1 ${TYPE_COLORS[mapType] ?? ''}`}>{mapType}</span>}
          </div>
          <button onClick={closeMap} data-inspect-id="mapDrawer-close-button" className="text-[var(--faint)] hover:text-[var(--ink)] transition-colors text-2xl leading-none ml-4">
            ×
          </button>
        </div>
        {activeMap && <DrawerContent key={activeMap} map={activeMap} />}
      </div>
    </>
  );
}

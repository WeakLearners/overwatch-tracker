import { useMapDrawer } from '../contexts/MapDrawerContext';
import { useApi } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { MAPS, TYPE_COLORS, ROLE_COLORS, DeathInsights as DeathInsightsData } from '../types';
import DeathInsights from './DeathInsights';

interface HeroRow { hero: string; role: string; games: number; win_rate: number }
interface MapDetail {
  overall:  { games: number; win_rate: number; wins: number; losses: number };
  momentum: { recent_wr: number | null; prev_wr: number | null; recent_games: number; prev_games: number };
  heroes:   { DPS: HeroRow[]; Tank: HeroRow[]; Support: HeroRow[] };
  recent5:  { win: number; hero: string; date: string }[];
  deaths:   DeathInsightsData;
}

function WR({ rate }: { rate: number }) {
  const cls = rate >= 60 ? 'text-emerald-600' : rate >= 50 ? 'text-ow-blue' : rate >= 40 ? 'text-yellow-400' : 'text-red-600';
  return <span className={`font-bold ${cls}`}>{rate}%</span>;
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
            {data.overall.win_rate}%
          </span>
          <span className="text-sm text-[var(--faint)] pb-1 font-bold">{data.overall.games}g</span>
        </div>
        <div className="text-xs text-[var(--faint-2)] mt-0.5"><b className="font-bold">{data.overall.wins}</b>W · <b className="font-bold">{data.overall.losses}</b>L</div>
      </div>

      {/* Trend */}
      {delta !== null && (
        <div>
          <div data-inspect-id="mapDrawer-trend-stat" className="text-xs text-[var(--faint)] uppercase tracking-wider mb-2">Trend</div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--muted)] font-bold">{prev_wr}%</span>
            <span className="text-[var(--faint-2)]">→</span>
            <WR rate={recent_wr!} />
            {delta > 0 && <span className="text-xs font-bold text-emerald-600">↑ +{delta}%</span>}
            {delta < 0 && <span className="text-xs font-bold text-red-600">↓ {delta}%</span>}
            {delta === 0 && <span className="text-xs text-[var(--faint)]">→ flat</span>}
          </div>
          <div className="text-xs text-[var(--faint-2)] mt-0.5">
            <b className="font-bold">{recent_games}</b>g last 30d · <b className="font-bold">{prev_games}</b>g prior 90d
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
                  <span className="text-xs text-[var(--faint-2)] w-7 text-right font-bold">{h.games}g</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Death patterns */}
      <DeathInsights dataInspectId="mapDrawer-death-insights" data={data.deaths} label={withMapCount(map, mapCounts)} />

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

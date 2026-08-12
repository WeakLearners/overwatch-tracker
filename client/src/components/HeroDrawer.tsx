import { useHeroDrawer } from '../contexts/HeroDrawerContext';
import { useApi } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { ROLE_COLORS, TYPE_COLORS, DeathInsights as DeathInsightsData } from '../types';
import DeathInsights from './DeathInsights';

interface MapRow  { map: string; game_type: string; games: number; win_rate: number }
interface TypeRow { game_type: string; games: number; win_rate: number }
interface HeroDetail {
  overall:   { games: number; win_rate: number; wins: number; losses: number };
  momentum:  { recent_wr: number | null; prev_wr: number | null; recent_games: number; prev_games: number };
  bestMaps:  MapRow[];
  worstMaps: MapRow[];
  bestType:  TypeRow | null;
  worstType: TypeRow | null;
  recent10:  { win: number; map: string; date: string }[];
  deaths:    DeathInsightsData;
}

function WR({ rate }: { rate: number }) {
  const cls = rate >= 60 ? 'text-emerald-600' : rate >= 50 ? 'text-ow-blue' : rate >= 40 ? 'text-yellow-400' : 'text-red-600';
  return <span data-inspect-id="hero-drawer-wr-badge" className={`font-bold ${cls}`}>{rate}%</span>;
}

function DrawerContent({ hero, role }: { hero: string; role?: string }) {
  const { data } = useApi<HeroDetail>(`/api/stats/hero-detail/${encodeURIComponent(hero)}`);
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
        <div data-inspect-id="hero-drawer-overall-tile" className="text-xs text-[var(--faint)] uppercase tracking-wider mb-2">Overall</div>
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
          <div data-inspect-id="hero-drawer-trend-section" className="text-xs text-[var(--faint)] uppercase tracking-wider mb-2">Trend</div>
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

      {/* Maps */}
      {(data.bestMaps.length > 0 || data.worstMaps.length > 0) && (
        <div>
          <div data-inspect-id="hero-drawer-maps-list" className="text-xs text-[var(--faint)] uppercase tracking-wider mb-2">Maps</div>
          <div className="divide-y divide-ow-border/30">
            {data.bestMaps.map(m => (
              <div key={'b' + m.map} className="flex items-center gap-2 py-1.5">
                <span className="text-sm text-emerald-700">↑</span>
                <div className="flex-1 min-w-0">
                  <span className="text-xs map-name text-[var(--ink)] truncate">{withMapCount(m.map, mapCounts)}</span>
                  <span data-inspect-id="hero-drawer-type-pill-badge" className={`pill ml-1 ${TYPE_COLORS[m.game_type] ?? ''}`}>{m.game_type}</span>
                </div>
                <WR rate={m.win_rate} />
                <span className="text-xs text-[var(--faint-2)] w-7 text-right font-bold">{m.games}g</span>
              </div>
            ))}
            {data.worstMaps.map(m => (
              <div key={'w' + m.map} className="flex items-center gap-2 py-1.5">
                <span className="text-sm text-red-500">↓</span>
                <div className="flex-1 min-w-0">
                  <span className="text-xs map-name text-[var(--ink)] truncate">{withMapCount(m.map, mapCounts)}</span>
                  <span className={`pill ml-1 ${TYPE_COLORS[m.game_type] ?? ''}`}>{m.game_type}</span>
                </div>
                <WR rate={m.win_rate} />
                <span className="text-xs text-[var(--faint-2)] w-7 text-right font-bold">{m.games}g</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Game modes */}
      {(data.bestType || data.worstType) && (
        <div>
          <div data-inspect-id="hero-drawer-game-mode-list" className="text-xs text-[var(--faint)] uppercase tracking-wider mb-2">Game Mode</div>
          <div className="divide-y divide-ow-border/30">
            {data.bestType && (
              <div className="flex items-center gap-2 py-1.5">
                <span className="text-sm text-emerald-700">↑</span>
                <span className={`pill ${TYPE_COLORS[data.bestType.game_type] ?? ''}`}>{data.bestType.game_type}</span>
                <div className="ml-auto flex items-center gap-1.5">
                  <WR rate={data.bestType.win_rate} />
                  <span className="text-xs text-[var(--faint-2)] font-bold">{data.bestType.games}g</span>
                </div>
              </div>
            )}
            {data.worstType && data.worstType.game_type !== data.bestType?.game_type && (
              <div className="flex items-center gap-2 py-1.5">
                <span className="text-sm text-red-500">↓</span>
                <span className={`pill ${TYPE_COLORS[data.worstType.game_type] ?? ''}`}>{data.worstType.game_type}</span>
                <div className="ml-auto flex items-center gap-1.5">
                  <WR rate={data.worstType.win_rate} />
                  <span className="text-xs text-[var(--faint-2)] font-bold">{data.worstType.games}g</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Death patterns */}
      <DeathInsights dataInspectId="hero-drawer-death-patterns-section" data={data.deaths} label={withHeroCount(hero, heroCounts)} />

      {/* Last 10 */}
      {data.recent10.length > 0 && (
        <div>
          <div data-inspect-id="hero-drawer-last10-list" className="text-xs text-[var(--faint)] uppercase tracking-wider mb-2">Last <b className="font-bold">{data.recent10.length}</b></div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {data.recent10.map((m, i) => (
              <div
                key={i}
                title={`${m.win ? 'W' : 'L'} · ${withMapCount(m.map, mapCounts).toUpperCase()}`}
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

export default function HeroDrawer() {
  const { activeHero, closeHero } = useHeroDrawer();
  const heroCounts = useTodayHeroCounts();

  return (
    <>
      <div
        data-inspect-id="hero-drawer-backdrop"
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${activeHero ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={closeHero}
      />
      <div data-inspect-id="hero-drawer-panel" className={`fixed inset-y-0 right-0 w-96 bg-ow-dark border-l border-ow-border z-50 flex flex-col transition-transform duration-300 ${activeHero ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-start justify-between p-5 border-b border-ow-border shrink-0">
          <div>
            <h2 data-inspect-id="hero-drawer-title-header" className="text-xl hero-name text-[var(--ink)] leading-tight">{activeHero ? withHeroCount(activeHero, heroCounts) : ''}</h2>
          </div>
          <button onClick={closeHero} data-inspect-id="hero-drawer-close-button" className="text-[var(--faint)] hover:text-[var(--ink)] transition-colors text-2xl leading-none ml-4">
            ×
          </button>
        </div>
        {activeHero && <DrawerContent key={activeHero} hero={activeHero} />}
      </div>
    </>
  );
}

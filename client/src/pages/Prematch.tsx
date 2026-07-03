import { useState, useRef, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import { MAPS, HEROES, QUEUE_MODES, ROLE_COLORS, TYPE_COLORS, TANK_ARCHETYPES, MapVotingRow } from '../types';
import AdvisorCard from '../components/AdvisorCard';
import EmptyState from '../components/EmptyState';
import { useMapDrawer } from '../contexts/MapDrawerContext';
import { useHeroDrawer } from '../contexts/HeroDrawerContext';
import { useMatch } from '../contexts/MatchContext';

const ALL_MAPS = Object.keys(MAPS).sort();

interface HeroRow { hero: string; role: string; games: number; wins: number; win_rate: number }

interface PrematchData {
  byHero:         HeroRow[];
  bestHeroes:     HeroRow[];
  session: {
    games_today:    number;
    next_game_pos:  number;
    on_tilt:        boolean;
    last3:          boolean[];
    depth_win_rate: number | null;
    depth_games:    number;
    tilt_win_rate:  number | null;
    tilt_games:     number;
  } | null;
  bestByGameType: HeroRow | null;
}

export default function Prematch() {
  // Shared, single-instance match state (queue mode, map, advisor) lives here
  // and is consumed by the Log Match section too.
  const { queueMode, map, setMap, mapType, alliedTank, setAlliedTank, rec, recLoading, recError, refreshRec, setPendingHero, matchLoggedSignal } = useMatch();

  const TANK_LIST = Object.entries(HEROES)
    .filter(([, role]) => role === 'Tank')
    .map(([name]) => name)
    .sort();

  const ARCHETYPE_COLORS: Record<string, string> = {
    dive:   'bg-blue-500/15 text-blue-700 dark:text-blue-400',
    brawl:  'bg-red-500/15 text-red-700 dark:text-red-400',
    anchor: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  };

  const params = new URLSearchParams();
  if (map) params.set('map', map);
  if (mapType) params.set('game_type', mapType);

  const { data } = useApi<PrematchData>(`/api/stats/prematch?${params}`, [map]);

  const { openMap } = useMapDrawer();
  const { openHero } = useHeroDrawer();
  const { data: votingData } = useApi<MapVotingRow[]>('/api/stats/map-voting');
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery]       = useState('');
  const [open, setOpen]         = useState(false);
  const [expandedOther, setExpandedOther] = useState<string | null>(null);
  const inputRef                = useRef<HTMLInputElement>(null);

  // Reset the voting picks after a match is logged (skips the initial mount).
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; return; }
    setSelected([]);
    setQuery('');
    setOpen(false);
  }, [matchLoggedSignal]);

  const scoreMap = Object.fromEntries((votingData ?? []).map(r => [r.map, r]));

  const results = query.length > 0
    ? ALL_MAPS.filter(m => m.toLowerCase().includes(query.toLowerCase()) && !selected.includes(m))
    : [];

  function selectMap(m: string) {
    if (selected.length >= 3 || selected.includes(m)) return;
    setSelected(prev => [...prev, m]);
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  }

  function toggleMap(m: string) {
    setSelected(prev => {
      const next = prev.includes(m) ? prev.filter(x => x !== m) : prev.length < 3 ? [...prev, m] : prev;
      if (!next.includes(map)) setMap('');
      return next;
    });
  }

  const ranked  = [...selected].sort((a, b) => (scoreMap[b]?.blended_score ?? 0) - (scoreMap[a]?.blended_score ?? 0));
  const winner  = ranked[0];
  const topOnMap = data?.byHero ?? [];

  // For each role, show up to 3 qualified heroes (>=2 games), then roll the
  // remaining heroes on this map into a single combined "Other heroes" slot.
  const MIN_GAMES = 2;
  function buildRole(role: string) {
    const all = topOnMap.filter(h => h.role === role); // already win_rate desc
    const top = all.filter(h => h.games >= MIN_GAMES).slice(0, 3);
    const topSet = new Set(top.map(h => h.hero));
    const rest = all.filter(h => !topSet.has(h.hero));
    let other: { games: number; wins: number; win_rate: number; count: number; tooltip: string } | null = null;
    if (top.length < 3 && rest.length > 0) {
      const games = rest.reduce((s, h) => s + h.games, 0);
      const wins  = rest.reduce((s, h) => s + (h.wins ?? 0), 0);
      const tooltip = rest.map(h => `${h.hero} ${h.win_rate}% (${h.games}g)`).join('\n');
      other = { games, wins, win_rate: games ? Math.round((wins / games) * 1000) / 10 : 0, count: rest.length, tooltip };
    }
    return { top, other };
  }
  const byRole = {
    DPS:     buildRole('DPS'),
    Tank:    buildRole('Tank'),
    Support: buildRole('Support'),
  };
  const recommendation = topOnMap.find(h => h.games >= MIN_GAMES) ?? data?.bestHeroes[0];

  const queueLabel = QUEUE_MODES.find(q => q.value === queueMode)?.label ?? '';

  return (
    <div>

      {/* Map Voting + Hero Advisor — 2-col row */}
      <div className="grid grid-cols-2 gap-4 mb-4">

        {/* Map Voting */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm heading-display text-[var(--ink)] whitespace-nowrap">Map Voting</h2>
              <span className="text-xs text-[var(--faint)] bg-ow-border/50 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">tap up to 3</span>
            </div>
            {selected.length > 0 && (
              <button onClick={() => setSelected([])} className="text-xs text-[var(--faint)] hover:text-[var(--ink)] transition-colors">
                clear
              </button>
            )}
          </div>

          {/* Search input */}
          <div className="relative mb-3">
            <input
              ref={inputRef}
              id="map-search"
              type="text"
              value={query}
              onChange={e => { setQuery(e.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onBlur={() => setTimeout(() => setOpen(false), 100)}
              onKeyDown={e => {
                if (e.key === 'Escape') { setQuery(''); setOpen(false); }
                if (e.key === 'Enter' && results.length > 0) selectMap(results[0]);
              }}
              placeholder={selected.length >= 3 ? '3 maps selected' : 'Type a map name…'}
              disabled={selected.length >= 3}
              className="w-full field px-3 py-2 text-sm"
            />
            {open && results.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-ow-card border border-ow-border rounded-lg shadow-xl z-30 overflow-hidden">
                {results.map(m => (
                  <button
                    key={m}
                    onMouseDown={() => selectMap(m)}
                    className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-white/5 transition-colors text-left"
                  >
                    <span className="text-[var(--ink)]">{m}</span>
                    <span className={`pill ${TYPE_COLORS[MAPS[m]] ?? ''}`}>{MAPS[m]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Selected chips */}
          {selected.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {selected.map(m => (
                <button
                  key={m}
                  onClick={() => toggleMap(m)}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium border transition-colors ${
                    m === winner
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-700'
                      : 'bg-ow-accent/15 border-ow-accent/60 text-ow-accent'
                  }`}
                >
                  {m === winner && <span className="text-xs">✓</span>}
                  {m}
                  <span className="text-xs opacity-60">×</span>
                </button>
              ))}
            </div>
          )}

          {/* Vote recommendation */}
          {ranked.length > 0 && (
            <div className="border-t border-ow-border pt-4 mt-4">
              {ranked.length === 1 ? (
                <div className="text-sm text-[var(--muted)]">Select more maps to compare.</div>
              ) : (
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <div className="text-xs text-[var(--faint)] mb-1 uppercase tracking-wider">Vote for</div>
                    <button onClick={() => openMap(winner)} className="text-xl font-bold text-emerald-600 hover:text-emerald-700 transition-colors text-left">
                      {winner}
                    </button>
                    {scoreMap[winner] && (
                      <div className="text-xs text-[var(--faint)] mt-0.5">
                        {scoreMap[winner].blended_score}% blended · {scoreMap[winner].total_games}g played
                      </div>
                    )}
                  </div>
                  <div className="text-right space-y-1">
                    {ranked.slice(1).map(m => (
                      <div key={m} className="text-sm text-[var(--faint)]">
                        {m}{scoreMap[m] ? ` · ${scoreMap[m].blended_score}%` : ' · no data'}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Hero Advisor — Map selector */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm heading-display text-[var(--ink)] whitespace-nowrap">Hero Advisor</h2>
              <span className="text-xs text-[var(--faint)] bg-ow-border/50 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">pick a map</span>
            </div>
            {map && (
              <button onClick={() => { setMap(''); setAlliedTank(''); }} className="text-xs text-[var(--faint)] hover:text-[var(--ink)] transition-colors">
                clear
              </button>
            )}
          </div>

          <div className="mb-3">
            <select
              value={map}
              onChange={e => setMap(e.target.value)}
              className="w-full field px-3 py-2 text-sm"
            >
              <option value="">— Select map —</option>
              {(selected.length > 0 ? selected : Object.keys(MAPS)).sort().map(m => (
                <option key={m} value={m}>{m} ({MAPS[m]})</option>
              ))}
            </select>
          </div>
          {mapType && <span className={`pill ${TYPE_COLORS[mapType] ?? ''}`}>{mapType}</span>}

          <div className="mt-3">
            <label className="block text-xs text-[var(--muted)] mb-1.5">Ally Tank <span className="text-[var(--faint-2)]">— optional</span></label>
            <select
              value={alliedTank}
              onChange={e => setAlliedTank(e.target.value)}
              className="w-full field px-3 py-2 text-sm"
            >
              <option value="">— No tank selected —</option>
              {TANK_LIST.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            {alliedTank && TANK_ARCHETYPES[alliedTank] && (
              <span className={`pill mt-1.5 ${ARCHETYPE_COLORS[TANK_ARCHETYPES[alliedTank]] ?? ''}`}>
                {TANK_ARCHETYPES[alliedTank]}
              </span>
            )}
          </div>
        </div>

      </div>

      {/* Consolidated advisor — recommendation + coaching + your heroes in one
          card below the row. When a map is picked these three used to repeat the
          same "what to play" answer across separate cards; here they read as one
          flow: the pick, the coaching behind it, then the full breakdown. */}
      <div className="card">
        <div className="flex items-start justify-between gap-3 mb-1">
          <div>
            <h2 className="text-sm heading-display text-[var(--ink-2)]">
              {map ? (
                <>Your Heroes on <button onClick={() => openMap(map)} className="text-ow-accent hover:text-ow-accent/80 transition-colors">{map}</button></>
              ) : 'Your Best Heroes Overall'}
            </h2>
            <p className="text-xs text-[var(--faint)] mt-0.5">By role · min 2 games · tap hero to pre-fill log</p>
          </div>
          {map && (
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest shrink-0 pt-0.5">
              <span className="text-[var(--faint)]">{queueLabel}</span>
              <button
                onClick={refreshRec}
                disabled={recLoading}
                className="text-[var(--faint)] hover:text-emerald-600 disabled:opacity-40"
                title="Refresh advisor"
              >
                {recLoading ? '…' : '↻'}
              </button>
            </div>
          )}
        </div>

        {/* Recommended pick — only with no map selected; once a map is chosen the
            coaching block's primary stands as the pick, so this would just repeat it. */}
        {recommendation && !map && (
          <div className="rounded-xl border border-ow-accent/40 bg-gradient-to-br from-ow-accent/10 via-ow-accent/[0.04] to-transparent px-4 py-3 mt-3">
            <div className="text-[10px] grad-brand font-bold uppercase tracking-widest mb-1">Recommended pick</div>
            <div className="flex items-center gap-3">
              <div>
                <button onClick={() => openHero(recommendation.hero)} className="text-xl font-black tracking-tight text-[var(--ink)] hover:text-ow-accent transition-colors text-left">
                  {recommendation.hero}
                </button>
                <span className={`pill ml-2 ${ROLE_COLORS[recommendation.role]}`}>{recommendation.role}</span>
              </div>
              <div className="ml-auto text-right">
                <div className={`text-2xl font-black tracking-tight num-display ${recommendation.win_rate >= 50 ? 'grad-win' : 'grad-loss'}`}>
                  {recommendation.win_rate}%
                </div>
                <div className="text-[11px] text-[var(--muted)]">
                  {recommendation.games} games overall
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Coaching — LLM tactical read + death patterns, only once a map is set */}
        {map && (
          <div id="coaching" className="scroll-mt-24 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-3 mt-3">
            <div className="text-[10px] text-emerald-600 uppercase tracking-widest font-semibold mb-2">Coaching</div>
            <AdvisorCard
              bare
              map={map}
              queueLabel={queueLabel}
              alliedTank={alliedTank || undefined}
              tankArchetype={alliedTank ? TANK_ARCHETYPES[alliedTank] : undefined}
              rec={rec}
              loading={recLoading}
              error={recError}
              onRefresh={refreshRec}
              onOpenHero={openHero}
            />
          </div>
        )}

        {/* Your heroes by role — the full breakdown */}
        <div className="mt-4 pt-4 border-t border-ow-border/40">
        {topOnMap.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {(['DPS', 'Tank', 'Support'] as const).map(role => {
              const { top, other } = byRole[role];
              return (
                <div key={role}>
                  <div className={`text-xs font-bold uppercase tracking-widest mb-2 ${ROLE_COLORS[role].split(' ')[1]}`}>{role}</div>
                  <div className="divide-y divide-ow-border/30">
                    {top.map(h => (
                      <button
                        key={h.hero}
                        onClick={() => setPendingHero(h.hero)}
                        className="flex items-center gap-3 w-full text-left py-2 hover:bg-white/5 transition-colors group rounded px-1 -mx-1"
                      >
                        <span className={`text-sm ${h.win_rate >= 50 ? 'text-emerald-700' : 'text-red-500'}`}>{h.win_rate >= 50 ? '↑' : '↓'}</span>
                        <span className="flex-1 text-sm font-medium text-[var(--ink)] group-hover:text-ow-accent transition-colors">{h.hero}</span>
                        <span className={`text-sm font-semibold ${h.win_rate >= 60 ? 'text-emerald-600' : h.win_rate >= 50 ? 'text-ow-blue' : h.win_rate >= 40 ? 'text-yellow-400' : 'text-red-600'}`}>{h.win_rate}%</span>
                        <span className="text-xs text-[var(--faint-2)] w-7 text-right">{h.games}g</span>
                      </button>
                    ))}
                    {other && (() => {
                      const isOpen = expandedOther === role;
                      const rest = topOnMap.filter(h => h.role === role && !byRole[role].top.find(t => t.hero === h.hero));
                      return (
                        <>
                          <button
                            onClick={() => setExpandedOther(isOpen ? null : role)}
                            className="flex items-center gap-3 w-full text-left py-2 px-1 -mx-1 hover:bg-white/5 transition-colors rounded group"
                          >
                            <span className={`text-sm transition-transform ${isOpen ? 'rotate-90' : ''} text-[var(--faint-2)]`}>›</span>
                            <span className="flex-1 text-sm font-medium text-[var(--faint)] italic group-hover:text-[var(--ink)] transition-colors">
                              Other heroes <span className="not-italic text-[var(--faint-2)]">({other.count})</span>
                            </span>
                            <span className={`text-sm font-semibold ${other.win_rate >= 60 ? 'text-emerald-600' : other.win_rate >= 50 ? 'text-ow-blue' : other.win_rate >= 40 ? 'text-yellow-400' : 'text-red-600'}`}>{other.win_rate}%</span>
                            <span className="text-xs text-[var(--faint-2)] w-7 text-right">{other.games}g</span>
                          </button>
                          {isOpen && rest.map(h => (
                            <button
                              key={h.hero}
                              onClick={() => setPendingHero(h.hero)}
                              className="flex items-center gap-3 w-full text-left py-1.5 pl-5 pr-1 -mx-1 hover:bg-white/5 transition-colors group rounded"
                            >
                              <span className={`text-sm ${h.win_rate >= 50 ? 'text-emerald-700' : 'text-red-500'}`}>{h.win_rate >= 50 ? '↑' : '↓'}</span>
                              <span className="flex-1 text-sm text-[var(--muted)] group-hover:text-ow-accent transition-colors">{h.hero}</span>
                              <span className={`text-sm font-semibold ${h.win_rate >= 60 ? 'text-emerald-600' : h.win_rate >= 50 ? 'text-ow-blue' : h.win_rate >= 40 ? 'text-yellow-400' : 'text-red-600'}`}>{h.win_rate}%</span>
                              <span className="text-xs text-[var(--faint-2)] w-7 text-right">{h.games}g</span>
                            </button>
                          ))}
                        </>
                      );
                    })()}
                    {top.length === 0 && !other && (
                      <div className="py-2 text-xs text-[var(--faint-2)]">No games yet</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={map ? '⌖' : '☷'}
            title={map ? `No games logged on ${map} yet` : 'Pick a map to see your heroes'}
            hint={map
              ? 'Once you log a match here, your best heroes for this map appear by role.'
              : 'Select a map above and this fills with your strongest picks for it, broken out by role.'}
          />
        )}
        </div>
      </div>
    </div>
  );
}

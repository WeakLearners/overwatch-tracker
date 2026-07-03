import { useState, useEffect } from 'react';
import { HEROES, ROLE_COLORS, TYPE_COLORS, TANK_ARCHETYPES, DeathRecord, QueueMode, QUEUE_MODES, QUEUE_MODE_COLORS } from '../types';
import { useMatch } from '../contexts/MatchContext';
import EmptyState from '../components/EmptyState';
import ModeWatermark from '../components/ModeWatermark';
import { useApi, revalidateAll } from '../hooks/useApi';
import { format } from 'date-fns';

interface FormState {
  date: string;
  time: string;
  hero: string;
  win: '' | '1' | '0';
  alliedTank: string;
}

const TANK_LIST = Object.entries(HEROES)
  .filter(([, role]) => role === 'Tank')
  .map(([name]) => name)
  .sort();

const HERO_LIST = Object.entries(HEROES).sort((a, b) => a[0].localeCompare(b[0]));

const MAX_DEATHS = 3;

// Two-line labels for the in-form mode toggle (the full names are too wide for
// three narrow columns).
const MODE_COMPACT: Record<string, { top: string; bot: string }> = {
  qp_role:   { top: 'Quickplay',   bot: 'Role' },
  comp_role: { top: 'Competitive', bot: 'Role' },
  comp_open: { top: 'Competitive', bot: 'Open' },
};

// Faint per-mode row tint for the logged-match strips. The big italic tag
// watermark itself lives in the shared ModeWatermark component.
const MODE_ROW_BG: Record<string, string> = {
  qp_role:   'bg-blue-500/10',
  comp_role: 'bg-red-500/10',
  comp_open: 'bg-pink-500/10',
};

// Factual death axes — the player records observable facts post-match, not a
// felt verdict mid-match. Each axis is a quick, decidable choice.
const DEATH_AXES: { key: keyof DeathRecord; label: string; hint: string; options: { value: string; label: string }[] }[] = [
  { key: 'trade',     label: 'Trade',     hint: 'Kill, cooldown, or space?', options: [{ value: 'traded', label: 'Got Value' }, { value: 'free', label: 'Wasted' }] },
  { key: 'timing',    label: 'Timing',    hint: 'When in the fight?',       options: [{ value: 'first', label: 'First' }, { value: 'middle', label: 'Middle' }, { value: 'last', label: 'Last' }] },
  { key: 'grouping',  label: 'Grouping',  hint: 'With team or alone?',      options: [{ value: 'grouped', label: 'Grouped' }, { value: 'alone', label: 'Alone' }] },
  { key: 'awareness', label: 'Awareness', hint: 'Full read or missed info?', options: [{ value: 'saw', label: 'Read it' }, { value: 'caught', label: 'Caught out' }] },
];

function getDayOfWeek(dateStr: string) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[new Date(dateStr + 'T12:00:00').getDay()];
}

// Smooth-scroll so the Coaching → Match Details block sits centred in the
// viewport (falls back to the Match Details card if Coaching isn't shown).
// Note: scrollTo is called directly — wrapping it in requestAnimationFrame gets
// swallowed here, so callers handle any "wait for layout" delay themselves.
function centerLogArea() {
  const bottomEl = document.getElementById('match-details');
  if (!bottomEl) return;
  const topEl = document.getElementById('coaching') ?? bottomEl;
  const top = topEl.getBoundingClientRect().top + window.scrollY;
  const bottom = bottomEl.getBoundingClientRect().bottom + window.scrollY;
  const target = (top + bottom) / 2 - window.innerHeight / 2;
  window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

const PENDING_KEY = 'ow-pending-match';

export default function LogMatch() {
  // Map + queue mode are shared with the Pre-Match section via context; this
  // section only owns date/time/hero/win plus the death tags.
  const { queueMode, setQueueMode, map, setMap, mapType, alliedTank: contextTank, pendingHero, setPendingHero, revalidateRec, notifyMatchLogged } = useMatch();
  const [form, setForm] = useState<FormState>(() => {
    const n = new Date();
    let pending: { hero?: string } = {};
    try {
      pending = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}');
    } catch { /* ignore */ }
    return {
      date: format(n, 'yyyy-MM-dd'),
      time: format(n, 'HH:mm'),
      hero: pending.hero ?? '',
      win: '',
      alliedTank: '',
    };
  });

  // Pre-fill ally tank from pre-match context when it changes.
  useEffect(() => {
    setForm(f => ({ ...f, alliedTank: contextTank }));
  }, [contextTank]);

  // A hero tapped in the Pre-Match hero list pre-fills the form here, then we
  // centre the Coaching → Match Details block so the auto-fill is visible.
  useEffect(() => {
    if (pendingHero) {
      setForm(f => ({ ...f, hero: pendingHero }));
      setPendingHero(null);
      setDeaths(ds => (ds.length === 0 ? [{}] : ds)); // open the first death's options
      centerLogArea();
    }
  }, [pendingHero, setPendingHero]);

  // Scroll into view when the ally tank is chosen — that's now the final
  // pre-match step, so the coaching + form should centre once it's set.
  useEffect(() => {
    if (!contextTank) return;
    const t = setTimeout(centerLogArea, 350);
    return () => clearTimeout(t);
  }, [contextTank]);

  // Persist hero selection until it's logged or cleared.
  useEffect(() => {
    if (form.hero) localStorage.setItem(PENDING_KEY, JSON.stringify({ hero: form.hero }));
    else localStorage.removeItem(PENDING_KEY);
  }, [form.hero]);
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  // Post-match death logging: up to 3 notable deaths, each tagged on 4 factual axes.
  const [deaths, setDeaths] = useState<Partial<DeathRecord>[]>([]);
  const setAxis = (i: number, key: keyof DeathRecord, value: string) =>
    setDeaths(ds => ds.map((d, j) => (j === i ? { ...d, [key]: value } : d)));
  const addDeath = () => setDeaths(ds => (ds.length < MAX_DEATHS ? [...ds, {}] : ds));
  const removeDeath = (i: number) => setDeaths(ds => ds.filter((_, j) => j !== i));
  const completeDeaths = deaths.filter(d => d.trade && d.timing && d.grouping && d.awareness) as DeathRecord[];

  // "Recently Logged" reads today's matches straight from the DB — the single
  // source of truth — so it's always accurate and resets on its own when the
  // date rolls over, since the query is scoped to the current day.
  const today = format(new Date(), 'yyyy-MM-dd');
  const { data: todayData } = useApi<{ rows: { id: number; hero: string; map: string; win: 0 | 1; queue_mode: QueueMode }[] }>(
    `/api/matches?from=${today}&to=${today}&limit=50`
  );
  const recent = todayData?.rows ?? [];

  // Per-row "last 5 on this map" pip strip — fetched per unique map. Keyed off a
  // stable string of today's maps so it only refires when that set changes.
  const [mapHistory, setMapHistory] = useState<Record<string, boolean[]>>({});
  const mapKey = [...new Set(recent.map(r => r.map))].sort().join('|');
  useEffect(() => {
    const maps = mapKey ? mapKey.split('|') : [];
    if (maps.length === 0) { setMapHistory({}); return; }
    Promise.all(
      maps.map(m =>
        fetch(`/api/matches?map=${encodeURIComponent(m)}&limit=5`)
          .then(r => r.json())
          .then((data: any) => [m, data.rows.map((d: any) => d.win === 1)] as [string, boolean[]])
      )
    )
      .then(results => setMapHistory(Object.fromEntries(results)))
      .catch(() => {});
  }, [mapKey]);

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const heroRole = form.hero ? HEROES[form.hero] : '';
  const valid = form.hero && map && form.win !== '' && form.date;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setStatus('saving');
    try {
      const [datePart, timePart] = [form.date, form.time];
      const hour = timePart ? parseInt(timePart.split(':')[0]) : null;
      const day_of_week = getDayOfWeek(datePart);
      const res = await fetch('/api/matches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: datePart,
          time: timePart ? `${datePart}T${timePart}:00` : null,
          day_of_week,
          hour,
          hero: form.hero,
          role: heroRole,
          map,
          game_type: mapType,
          win: form.win === '1',
          deaths: completeDeaths.length > 0 ? { v: 2, deaths: completeDeaths } : null,
          queue_mode: queueMode,
          allied_tank: form.alliedTank || null,
        }),
      });
      if (!res.ok) throw new Error('Failed');
      const loggedMode = queueMode;
      const loggedWin = form.win === '1';
      setStatus('success');
      setDeaths([]);
      setForm(f => ({ ...f, hero: '', win: '', time: format(new Date(), 'HH:mm'), alliedTank: '' }));
      // Clear the carried-over match intent: the Hero Advisor map selector and
      // its dependent advisor reset so nothing lingers from the logged match.
      setMap('');
      // Bring the win-rate cards into view first.
      window.scrollTo({ top: 0, behavior: 'smooth' });
      // Once the scroll settles, flash a win/loss arrow overlay across the
      // logged mode's tile (the signal also resets Map Voting).
      setTimeout(() => notifyMatchLogged({ mode: loggedMode, win: loggedWin }), 550);
      // After the overlay has swept through and cleared (~1s), refresh so the
      // revealed tile's win rate rolls from its old value to the new one.
      setTimeout(() => {
        revalidateAll();
        revalidateRec();
      }, 1650);
      // Once the result animation has played, return to the (now reset) Map
      // Voting search so the next match's prep is one keystroke away.
      setTimeout(() => {
        const mapInput = document.getElementById('map-search') as HTMLInputElement | null;
        mapInput?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        mapInput?.focus({ preventScroll: true });
      }, 2400);
      setTimeout(() => setStatus('idle'), 2600);
    } catch {
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
  }

  return (
    <div className="mt-6">
      {/* Notable Deaths — logged post-match on factual axes (no in-match counter) */}
      <div id="notable-deaths" className="card mb-6 scroll-mt-24">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm heading-display text-[var(--ink)]">Notable Deaths</h2>
          {deaths.length > 0 && (
            <button
              type="button"
              onClick={() => setDeaths([])}
              className="text-xs text-[var(--faint)] hover:text-red-600 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
        <p className="text-xs text-[var(--faint)] mb-4">
          After the match, log up to {MAX_DEATHS} deaths that stuck out — just the facts, not how it felt. Optional.
        </p>

        <div className="space-y-3">
          {deaths.map((d, i) => {
            const complete = d.trade && d.timing && d.grouping && d.awareness;
            return (
              <div key={i} className={`rounded-xl border px-3 py-3 ${complete ? 'border-ow-border bg-ow-darker/40' : 'border-ow-accent/40 bg-ow-accent/5'}`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-[var(--ink-2)]">
                    Death {i + 1}
                    {!complete && <span className="text-ow-accent/80 font-normal"> · pick all four</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeDeath(i)}
                    className="text-[var(--faint-2)] hover:text-red-600 text-base leading-none px-1"
                    aria-label="Remove death"
                  >
                    ×
                  </button>
                </div>
                <div className="space-y-2">
                  {DEATH_AXES.map(axis => (
                    <div key={axis.key} className="flex items-center gap-2">
                      <div className="w-[5.5rem] shrink-0">
                        <div className="text-[11px] text-[var(--ink-2)] leading-tight">{axis.label}</div>
                        <div className="text-[9px] text-[var(--faint-2)] leading-tight">{axis.hint}</div>
                      </div>
                      <div className="flex gap-1.5 flex-1">
                        {axis.options.map(opt => {
                          const active = d[axis.key] === opt.value;
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => setAxis(i, axis.key, opt.value)}
                              className={`flex-1 py-1.5 rounded-lg border text-xs font-medium transition-all ${
                                active
                                  ? 'border-ow-accent/60 bg-ow-accent/15 text-[var(--ink)]'
                                  : 'border-ow-border bg-ow-darker text-[var(--muted)] hover:text-[var(--ink)] hover:border-gray-500'
                              }`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {deaths.length < MAX_DEATHS && (
          <button
            type="button"
            onClick={addDeath}
            className="mt-3 w-full py-2 rounded-lg border border-dashed border-ow-border text-xs text-[var(--muted)] hover:text-[var(--ink)] hover:border-gray-500 transition-colors"
          >
            + Add a death
          </button>
        )}
      </div>

      <div id="match-details" className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm heading-display text-[var(--ink)]">Match Details</h2>
            <button
              type="button"
              onClick={() => { setForm(f => ({ ...f, hero: '' })); setMap(''); }}
              disabled={!form.hero && !map}
              className="text-xs text-[var(--faint)] hover:text-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-[var(--faint)]"
            >
              Reset
            </button>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1.5">Date</label>
                <input
                  type="date"
                  value={form.date}
                  onChange={set('date')}
                  className="w-full field px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1.5">Time</label>
                <input
                  type="time"
                  value={form.time}
                  onChange={set('time')}
                  className="w-full field px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-[var(--muted)] mb-1.5">Hero</label>
              <select
                value={form.hero}
                onChange={set('hero')}
                className="w-full field px-3 py-2 text-sm"
              >
                <option value="">— Select hero —</option>
                {(['DPS', 'Tank', 'Support'] as const).map(role => (
                  <optgroup key={role} label={role}>
                    {HERO_LIST.filter(([, r]) => r === role).map(([h]) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {heroRole && <span className={`pill mt-1.5 ${ROLE_COLORS[heroRole]}`}>{heroRole}</span>}
            </div>

            <div>
              <label className="block text-xs text-[var(--muted)] mb-1.5">Map</label>
              {map ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--ink)] font-medium">{map}</span>
                  {mapType && <span className={`pill ${TYPE_COLORS[mapType] ?? ''}`}>{mapType}</span>}
                </div>
              ) : (
                <div className="text-xs text-[var(--faint)] italic">Pick a map in the Pre-Match section above to log a result.</div>
              )}
            </div>

            <div>
              <label className="block text-xs text-[var(--muted)] mb-1.5">
                Mode <span className="text-[var(--faint-2)]">— recording this match as</span>
              </label>
              <div className="grid grid-cols-3 gap-2">
                {QUEUE_MODES.map(m => {
                  const active = queueMode === m.value;
                  const c = QUEUE_MODE_COLORS[m.value];
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setQueueMode(m.value)}
                      className={`relative overflow-hidden py-2 rounded-lg border text-xs font-semibold leading-tight transition-all ${
                        active ? `${c.card} ${c.accent} ${c.glow}` : 'border-ow-border text-[var(--faint)] hover:text-[var(--ink)] hover:border-gray-500'
                      }`}
                    >
                      <ModeWatermark mode={m.value} variant="selector" />
                      <div className="relative z-10">{MODE_COMPACT[m.value].top}</div>
                      <div className="relative z-10 text-[10px] font-normal opacity-80">{MODE_COMPACT[m.value].bot}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs text-[var(--muted)] mb-1.5">
                Ally Tank <span className="text-[var(--faint-2)]">— optional</span>
              </label>
              <select
                value={form.alliedTank}
                onChange={set('alliedTank')}
                className="w-full field px-3 py-2 text-sm"
              >
                <option value="">— None / unknown —</option>
                {TANK_LIST.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {form.alliedTank && TANK_ARCHETYPES[form.alliedTank] && (
                <span className={`pill mt-1.5 ${
                  TANK_ARCHETYPES[form.alliedTank] === 'dive'   ? 'bg-blue-500/15 text-blue-700 dark:text-blue-400' :
                  TANK_ARCHETYPES[form.alliedTank] === 'brawl'  ? 'bg-red-500/15 text-red-700 dark:text-red-400' :
                  'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                }`}>
                  {TANK_ARCHETYPES[form.alliedTank]}
                </span>
              )}
            </div>

            <div>
              <label className="block text-xs text-[var(--muted)] mb-1.5">Result</label>
              <div className="flex gap-3">
                {[{ v: '1', label: 'Win', cls: 'border-emerald-500 bg-emerald-500/20 text-emerald-600' },
                  { v: '0', label: 'Loss', cls: 'border-red-500 bg-red-500/20 text-red-600' }].map(({ v, label, cls }) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, win: v as '0' | '1' }))}
                    className={`flex-1 py-2.5 rounded-lg border text-sm font-semibold transition-all ${
                      form.win === v ? cls : 'border-ow-border text-[var(--faint)] hover:text-[var(--ink)]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={!valid || status === 'saving'}
              className="btn-primary w-full py-2.5 text-sm"
            >
              {status === 'saving' ? 'Saving…' : status === 'success' ? '✓ Saved' : 'Log Match'}
            </button>
            {status === 'error' && <p className="text-red-600 text-xs text-center">Failed to save — is the server running?</p>}
          </form>
        </div>

        <div className="card">
          <h2 className="text-sm heading-display text-[var(--ink-2)] mb-4">Recently Logged</h2>
          {recent.length > 0 ? (
            <div className="space-y-2">
              {recent.map(r => {
                // Build 5 display slots: oldest on left, newest on right.
                // API returns newest-first; display newest on the left (direct index).
                const hist = mapHistory[r.map];
                const slots = Array.from({ length: 5 }, (_, j) =>
                  hist ? (j < hist.length ? hist[j] : undefined) : undefined
                );
                return (
                  <div key={r.id} className={`relative overflow-hidden flex items-center gap-3 py-2.5 px-3 rounded-lg ${MODE_ROW_BG[r.queue_mode]}`}>
                    {/* Mode-tinted strip with a big centred italic tag watermark —
                        same lettering as the mode selectors. */}
                    <ModeWatermark mode={r.queue_mode} variant="strip" />
                    <div className={`relative z-10 w-8 h-8 rounded flex items-center justify-center text-xs font-bold shrink-0 ${r.win ? 'bg-emerald-500/20 text-emerald-600' : 'bg-red-500/20 text-red-600'}`}>
                      {r.win ? 'W' : 'L'}
                    </div>
                    <div className="relative z-10 flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--ink)]">{r.hero}</div>
                      <div className="text-xs text-[var(--faint)]">{r.map}</div>
                    </div>
                    <div className="relative z-10 flex flex-col items-end gap-0.5 shrink-0">
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-[var(--faint-2)] tracking-tight">recent</span>
                        <div className="flex gap-0.5">
                          {slots.map((pip, j) => (
                            <div
                              key={j}
                              title={pip === undefined ? 'No data' : pip ? 'Win' : 'Loss'}
                              className={`w-3 h-3 rounded-sm ${
                                pip === undefined
                                  ? 'bg-gray-700'
                                  : pip
                                  ? 'bg-emerald-400'
                                  : 'bg-red-400'
                              }`}
                            />
                          ))}
                        </div>
                        <span className="text-[10px] text-[var(--faint-2)] tracking-tight">older</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon="✎"
              title="Nothing logged today"
              hint="Today's matches show here with each map's recent record, and reset when the day rolls over."
            />
          )}
        </div>
      </div>
    </div>
  );
}

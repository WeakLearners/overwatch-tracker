import { useState, useEffect, useRef } from 'react';
import { HEROES, ROLE_COLORS, TYPE_COLORS, DEATH_AXES, QueueMode, QUEUE_MODES, QUEUE_MODE_COLORS } from '../types';
import { useMatch } from '../contexts/MatchContext';
import EmptyState from '../components/EmptyState';
import ModeWatermark from '../components/ModeWatermark';
import { useApi, revalidateAll } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { format } from 'date-fns';

interface FormState {
  date: string;
  time: string;
  hero: string;
  win: '' | '1' | '0';
  notes: string;
}

const HERO_LIST = Object.entries(HEROES).sort((a, b) => a[0].localeCompare(b[0]));

// Perceived sens speed, 0 (felt slow) to 10 (felt fast) — not a quality rating.
// Captured here, live, rather than backfilled later on /sens: the sensation is
// gone by the next match, so this is the only point it can honestly be logged.
const FEEL_MIN = 0, FEEL_MAX = 10, FEEL_MID = 5;

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
  const { queueMode, setQueueMode, map, setMap, mapType, sens, pendingHero, setPendingHero, revalidateRec, notifyMatchLogged, deathBuffer, removeDeathFromBuffer, clearDeathBuffer } = useMatch();
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();
  const [feel, setFeel] = useState(FEEL_MID);
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
      notes: '',
    };
  });

  // The date field defaults to the current day but stays editable for backfill.
  // Once the user manually picks a date we stop auto-advancing it so their choice
  // sticks; a successful log clears this back to "follow the clock".
  const dateTouched = useRef(false);
  // Same story for time: once the user hand-edits it (backfill), stop following
  // the clock so their choice sticks; a successful log clears this back.
  const timeTouched = useRef(false);

  // Keep the log date pinned to the current wall-clock day while the app stays
  // open. Without this, a session left running past midnight logs the new day's
  // matches under yesterday's date (and they'd stay there — the date is written
  // to the DB at log time, so a later refresh can't move them). The 60s interval
  // catches the rollover with the tab open; focus/visibility catches a return.
  useEffect(() => {
    const syncNow = () => {
      const now = new Date();
      setForm(f => {
        const today = format(now, 'yyyy-MM-dd');
        const clock = format(now, 'HH:mm');
        const nextDate = dateTouched.current ? f.date : today;
        // Keep the visible time honest too. Without this the field holds a stale
        // value across an idle gap or midnight rollover, so the first match of the
        // next session gets a fresh date but last session's time — sorting it into
        // the wrong slot in the Recent Matches bar.
        const nextTime = timeTouched.current ? f.time : clock;
        if (f.date === nextDate && f.time === nextTime) return f;
        return { ...f, date: nextDate, time: nextTime };
      });
    };
    const onVisible = () => { if (document.visibilityState === 'visible') syncNow(); };
    window.addEventListener('focus', syncNow);
    document.addEventListener('visibilitychange', onVisible);
    const id = window.setInterval(syncNow, 60_000);
    syncNow();
    return () => {
      window.removeEventListener('focus', syncNow);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(id);
    };
  }, []);

  // A hero tapped in the Pre-Match hero list pre-fills the form here, then we
  // centre the Coaching → Match Details block so the auto-fill is visible.
  useEffect(() => {
    if (pendingHero) {
      setForm(f => ({ ...f, hero: pendingHero }));
      setPendingHero(null);
      centerLogArea();
    }
  }, [pendingHero, setPendingHero]);

  // Picking a map from the Hero Advisor dropdown brings the Coaching → Match
  // Details block into a centred view, ready to review and log. The short delay
  // lets the map's hero list finish loading so the block is at full height
  // before we measure and centre it.
  useEffect(() => {
    if (!map) return;
    const t = setTimeout(centerLogArea, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // Persist hero selection until it's logged or cleared.
  useEffect(() => {
    if (form.hero) localStorage.setItem(PENDING_KEY, JSON.stringify({ hero: form.hero }));
    else localStorage.removeItem(PENDING_KEY);
  }, [form.hero]);
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');

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

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement>) => {
    if (k === 'date') dateTouched.current = true;
    if (k === 'time') timeTouched.current = true;
    setForm(f => ({ ...f, [k]: e.target.value }));
  };

  const heroRole = form.hero ? HEROES[form.hero] : '';
  const valid = form.hero && map && form.win !== '' && form.date && parseFloat(sens) > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setStatus('saving');
    try {
      // Unless the user hand-picked a date, stamp the log with the current day
      // as of this exact moment — guards the edge where a match is logged in the
      // first seconds after midnight, before the 60s sync tick has fired.
      const datePart = dateTouched.current ? form.date : format(new Date(), 'yyyy-MM-dd');
      // Mirror the date guard: unless hand-edited, stamp the true current time so a
      // field left stale across an idle gap can never be written to the DB.
      const timePart = timeTouched.current ? form.time : format(new Date(), 'HH:mm');
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
          deaths: deathBuffer.length > 0 ? { v: 3, deaths: deathBuffer } : null,
          queue_mode: queueMode,
          sens: parseFloat(sens),
          feel,
          notes: form.notes.trim() || null,
        }),
      });
      if (!res.ok) throw new Error('Failed');
      const loggedMode = queueMode;
      const loggedWin = form.win === '1';
      setStatus('success');
      clearDeathBuffer();
      setFeel(FEEL_MID);
      dateTouched.current = false;
      timeTouched.current = false;
      setForm(f => ({ ...f, hero: '', win: '', notes: '', date: datePart, time: format(new Date(), 'HH:mm') }));
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
      {/* Deaths buffered via the floating 💀 button during the match */}
      <div id="notable-deaths" className="card mb-6 scroll-mt-24">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm heading-display text-[var(--ink)]">Deaths</h2>
          {deathBuffer.length > 0 && (
            <button
              type="button"
              onClick={clearDeathBuffer}
              className="text-xs text-[var(--faint)] hover:text-red-600 transition-colors"
            >
              Clear all
            </button>
          )}
        </div>

        {deathBuffer.length === 0 ? (
          <p className="text-xs text-[var(--faint)]">
            Tap 💀 during the match to log each death as it happens.
          </p>
        ) : (
          <div className="space-y-1.5">
            {deathBuffer.map((d, i) => {
              const axis = DEATH_AXES.find(a => a.key === d.axis);
              // Word the spectrum position toward the nearer pole (or neutral).
              const lean = !axis ? '' : d.value < 0.4 ? axis.low : d.value > 0.6 ? axis.high : 'Neutral';
              return (
                <div key={i} className="flex items-center justify-between gap-2 py-2 px-3 rounded-lg bg-ow-darker border border-ow-border">
                  <div>
                    <span className="text-xs text-[var(--faint-2)] mr-2">{i + 1}</span>
                    <span className="text-sm text-[var(--ink)]">{axis?.label ?? 'Death'}</span>
                    {axis && <span className="text-xs text-[var(--faint)] ml-2">{lean}</span>}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeDeathFromBuffer(i)}
                    className="text-[var(--faint)] hover:text-red-500 transition-colors text-base leading-none px-1 shrink-0"
                    aria-label="Remove"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div id="match-details" className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm heading-display text-[var(--ink)]">Match Details</h2>
            <button
              type="button"
              onClick={() => { setForm(f => ({ ...f, hero: '', notes: '' })); setMap(''); setFeel(FEEL_MID); }}
              disabled={!form.hero && !map}
              className="text-xs text-[var(--faint)] hover:text-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-[var(--faint)]"
            >
              Reset
            </button>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
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
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1.5">Sensitivity</label>
                {/* Read-only — frozen at the study's in-game value (2.5). */}
                <div className="w-full field px-3 py-2 text-sm num-display text-[var(--ink)] whitespace-nowrap overflow-hidden">
                  {parseFloat(sens) > 0 ? parseFloat(sens).toFixed(2) : '—'}
                </div>
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
                      <option key={h} value={h}>{withHeroCount(h, heroCounts)}</option>
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
                  <span className="text-sm text-[var(--ink)] font-medium">{withMapCount(map, mapCounts)}</span>
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
              <label className="block text-xs text-[var(--muted)] mb-1.5">Feel <span className="text-[var(--faint-2)]">— did the sens feel slow or fast?</span></label>
              <input
                type="range"
                min={FEEL_MIN}
                max={FEEL_MAX}
                step={1}
                value={feel}
                onChange={e => setFeel(Number(e.target.value))}
                className="w-full accent-violet-500"
                aria-label="Feel — slow to fast"
              />
              <div className="flex justify-between text-[10px] text-[var(--faint-2)] mt-1 px-0.5"><span>Slow</span><span>Just Right</span><span>Fast</span></div>
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

            <div>
              <label className="block text-xs text-[var(--muted)] mb-1.5">Main Perceived Factors</label>
              <textarea
                value={form.notes}
                onChange={set('notes')}
                rows={2}
                className="w-full field px-3 py-2 text-sm resize-none"
                placeholder="fatigue, warmup, just switched stage…"
              />
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
                      <div className="text-sm font-medium text-[var(--ink)]">{withHeroCount(r.hero, heroCounts)}</div>
                      <div className="text-xs text-[var(--faint)]">{withMapCount(r.map, mapCounts)}</div>
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

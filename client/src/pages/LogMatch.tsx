import { useState, useEffect, useRef } from 'react';
import { HEROES, ROLE_COLORS, TYPE_COLORS, DEATH_AXES, QueueMode, QUEUE_MODES, QUEUE_MODE_COLORS } from '../types';
import { useMatch } from '../contexts/MatchContext';
import EmptyState from '../components/EmptyState';
import ModeWatermark from '../components/ModeWatermark';
import StarRating from '../components/StarRating';
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

// Heroes switched to mid-match, 2nd/3rd only — slot 1 is always `form.hero`
// (pre-filled from the Pre-Match picker). Both stay optional; a match with no
// switch just sends slot 1, same as before this feature existed.
type SwitchHeroes = [string, string];

const HERO_LIST = Object.entries(HEROES).sort((a, b) => a[0].localeCompare(b[0]));

// Perceived sens speed, 0 (felt slow) to 10 (felt fast) — not a quality rating.
// Captured here, live, rather than backfilled later on /sens: the sensation is
// gone by the next match, so this is the only point it can honestly be logged.
const FEEL_MIN = 0, FEEL_MAX = 100, FEEL_MID = 50;

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

// Smooth-scroll so a single element sits centred in the viewport. Map pick
// and hero pick each centre a different landmark (Coaching, then Match
// Details) rather than one shared midpoint — falls back to Match Details if
// the requested id isn't rendered yet.
// Note: scrollTo is called directly — wrapping it in requestAnimationFrame gets
// swallowed here, so callers handle any "wait for layout" delay themselves.
function centerOnElement(id: string) {
  const el = document.getElementById(id) ?? document.getElementById('match-details');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const target = rect.top + window.scrollY + rect.height / 2 - window.innerHeight / 2;
  window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

const PENDING_KEY = 'ow-pending-match';

// Active stage-test sets, as returned by /api/blind/state — used to show the
// in-game sens this match will actually be tagged with, not the stale frozen
// value in context. Mirrors the priority `matches.ts` uses server-side: a
// hero-tagged set beats the hero-less ad-hoc one, and only Competitive
// matches ever land on a stage at all.
interface DpiTestActive {
  hero: string | null;
  in_game_sens: number;
  sens: number | null;
}
interface DpiTestState { actives: DpiTestActive[] }

export default function LogMatch() {
  // Map + queue mode are shared with the Pre-Match section via context; this
  // section only owns date/time/hero/win plus the death tags.
  const { queueMode, setQueueMode, map, setMap, mapType, sens, pendingHero, setPendingHero, revalidateRec, notifyMatchLogged, deathBuffer, removeDeathFromBuffer, clearDeathBuffer } = useMatch();
  const { data: dpiState } = useApi<DpiTestState>('/api/blind/state');
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();
  // One feel reading per hero actually played (mirrors switchHeroes/duration_min
  // per-hero) — a mid-match switch can feel different on the hero you started
  // on than the one you switched to, especially if they're on different sens.
  // Keyed by hero name; a hero not yet in here just reads as FEEL_MID.
  const [feelByHero, setFeelByHero] = useState<Record<string, number>>({});
  const feelFor = (h: string) => feelByHero[h] ?? FEEL_MID;
  const setFeelFor = (h: string, v: number) => setFeelByHero(prev => ({ ...prev, [h]: v }));
  const [teamRating, setTeamRating] = useState(0);
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
  // 2nd/3rd hero played this match, if the player switched — optional, both
  // default empty. Result (win/loss) attaches to every non-empty slot.
  const [switchHeroes, setSwitchHeroes] = useState<SwitchHeroes>(['', '']);
  const setSwitchHero = (i: 0 | 1) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSwitchHeroes(prev => {
      const next: SwitchHeroes = [...prev];
      next[i] = e.target.value;
      return next;
    });
  };

  // The in-game sens this match will actually be tagged with. QP only lands
  // on a stage for Support heroes (matches.ts's isCompetitive check — Support
  // QP counts toward the study same as Competitive); every other QP hero
  // falls straight to the frozen fallback. Competitive checks for a set
  // tagged to the selected hero, then the hero-less ad-hoc set — same
  // priority order the server uses when it stamps the match.
  // Same lookup as activeSetSens below, generalized to any hero — used to
  // label each hero's own Feel slider with the sens it was actually played
  // at, since a mid-match switch can land on a different hero's own test.
  const sensForHero = (h: string): number | null => {
    if (!h || (queueMode === 'qp_role' && HEROES[h] !== 'Support')) return null;
    const actives = dpiState?.actives ?? [];
    const active = actives.find(a => a.hero === h) ?? actives.find(a => a.hero === null);
    return active ? active.sens ?? active.in_game_sens : null;
  };
  const displaySensForHero = (h: string): number | null => sensForHero(h) ?? (parseFloat(sens) > 0 ? parseFloat(sens) : null);
  const activeSetSens = sensForHero(form.hero);

  // Hero dropdowns only offer heroes with an active (in-testing) DPI test —
  // logging is meant to feed the running test, not just record any match.
  const inTestingHeroes = new Set((dpiState?.actives ?? []).map(a => a.hero).filter((h): h is string => !!h));
  const HERO_TEST_LIST = HERO_LIST.filter(([h]) => inTestingHeroes.has(h));
  const displaySens = activeSetSens ?? (parseFloat(sens) > 0 ? parseFloat(sens) : null);
  // Every hero actually played this match, in slot order, deduped (picking
  // the same hero twice in the switch dropdowns shouldn't double its slider).
  const playedHeroes = [...new Set([form.hero, ...switchHeroes].filter((h): h is string => !!h))];

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
  // centre Match Details so the auto-fill is visible.
  useEffect(() => {
    if (pendingHero) {
      setForm(f => ({ ...f, hero: pendingHero }));
      setPendingHero(null);
      centerOnElement('match-details');
    }
  }, [pendingHero, setPendingHero]);

  // Picking a map from the Hero Advisor dropdown brings the whole
  // Consolidated Advisor card into a centred view first — not just the
  // Coaching sub-section — so its header and pick are visible too, ready to
  // review before a hero is chosen. The short delay lets the map's hero list
  // finish loading so the page is at full height before we measure and
  // centre it.
  useEffect(() => {
    if (!map) return;
    const t = setTimeout(() => centerOnElement('consolidated-advisor'), 350);
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
  // Gate on displaySens (what the Sensitivity box actually shows — the active
  // DPI stage's value when one's running, else the raw fallback), not the raw
  // context `sens` string directly: nothing in the app ever calls setSens, so
  // that value is frozen at whatever localStorage held on load and can go
  // stale independently of what's displayed, silently failing this check.
  const valid = form.hero && map && form.win !== '' && form.date && displaySens != null;

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
          heroes: switchHeroes.filter(h => h).map(h => ({ hero: h, role: HEROES[h], feel: feelFor(h) })),
          map,
          game_type: mapType,
          win: form.win === '1',
          deaths: deathBuffer.length > 0 ? { v: 3, deaths: deathBuffer } : null,
          queue_mode: queueMode,
          sens: displaySens,
          feel: feelFor(form.hero),
          team_rating: teamRating,
          notes: form.notes.trim() || null,
        }),
      });
      if (!res.ok) throw new Error('Failed');
      const loggedMode = queueMode;
      const loggedWin = form.win === '1';
      setStatus('success');
      clearDeathBuffer();
      setFeelByHero({});
      setTeamRating(0);
      dateTouched.current = false;
      timeTouched.current = false;
      setForm(f => ({ ...f, hero: '', win: '', notes: '', date: datePart, time: format(new Date(), 'HH:mm') }));
      setSwitchHeroes(['', '']);
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
      <div id="notable-deaths" className="card mb-6 scroll-mt-24" data-inspect-id="logmatch-deaths-card">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm heading-display text-[var(--ink)]">Deaths</h2>
          {deathBuffer.length > 0 && (
            <button
              type="button"
              onClick={clearDeathBuffer}
              data-inspect-id="logmatch-clear-all-deaths-button"
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
          <div className="space-y-1.5" data-inspect-id="logmatch-death-buffer-list">
            {deathBuffer.map((d, i) => {
              const axis = DEATH_AXES.find(a => a.key === d.axis);
              // Word the spectrum position toward the nearer pole (or neutral).
              const lean = !axis ? '' : d.value < 0.4 ? axis.low : d.value > 0.6 ? axis.high : 'Neutral';
              return (
                <div key={i} className="flex items-center justify-between gap-2 py-2 px-3 rounded-lg bg-ow-darker border border-ow-border">
                  <div>
                    <span className="text-xs text-[var(--faint-2)] mr-2 font-bold">{i + 1}</span>
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
        <div className="card" data-inspect-id="logmatch-match-details-card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm heading-display text-[var(--ink)]">Match Details</h2>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  if (deathBuffer.length > 0 && !window.confirm('Cancel this match? Hero, notes, map, feel, and the deaths tracked so far will all be cleared.')) return;
                  setForm(f => ({ ...f, hero: '', win: '', notes: '' }));
                  setSwitchHeroes(['', '']);
                  setMap('');
                  setFeelByHero({});
                  setTeamRating(0);
                  clearDeathBuffer();
                  const mapInput = document.getElementById('map-search') as HTMLInputElement | null;
                  mapInput?.focus({ preventScroll: true });
                }}
                disabled={!form.hero && !map && deathBuffer.length === 0}
                data-inspect-id="logmatch-cancel-match-button"
                className="text-xs text-[var(--faint)] hover:text-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-[var(--faint)]"
              >
                Match Cancelled
              </button>
              <button
                type="button"
                onClick={() => { setForm(f => ({ ...f, hero: '', notes: '' })); setSwitchHeroes(['', '']); setMap(''); setFeelByHero({}); setTeamRating(0); }}
                disabled={!form.hero && !map}
                data-inspect-id="logmatch-reset-button"
                className="text-xs text-[var(--faint)] hover:text-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-[var(--faint)]"
              >
                Reset
              </button>
            </div>
          </div>
          <form onSubmit={submit} className="space-y-4" data-inspect-id="logmatch-match-details-form">
            <div>
              <label className="block text-xs text-[var(--muted)] mb-1.5">
                Mode <span className="text-[var(--faint-2)]">— recording this match as</span>
              </label>
              <div className="grid grid-cols-3 gap-2" data-inspect-id="logmatch-mode-toggle">
                {QUEUE_MODES.map(m => {
                  const active = queueMode === m.value;
                  const c = QUEUE_MODE_COLORS[m.value];
                  const activeBorder = {
                    qp_role: 'border-sky-400', comp_role: 'border-red-400', comp_open: 'border-orange-400',
                  }[m.value];
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setQueueMode(m.value)}
                      className={`relative overflow-hidden py-2 rounded-lg border-2 text-xs font-semibold leading-tight transition-all ${
                        active ? `${c.card} ${c.accent} ${c.glow} ${activeBorder}` : 'border-transparent text-[var(--faint)] hover:text-[var(--ink)]'
                      }`}
                    >
                      {/* V5/V6 digits carry more side-bearing than QP's letters,
                          so they read looser at the same tracking — tighten them
                          to visually match QP. */}
                      <ModeWatermark
                        mode={m.value}
                        variant="selector"
                        style={m.value === 'qp_role' ? undefined : { letterSpacing: '-0.13em' }}
                      />
                      <div className="relative z-10 font-display italic">{MODE_COMPACT[m.value].top}</div>
                      <div className="relative z-10 text-[10px] font-normal opacity-80">{MODE_COMPACT[m.value].bot}</div>
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-[var(--faint)] mt-1.5 leading-snug">
                Sens test only tracks Competitive games (any role) and Quickplay games played as Support — everything else logs at the frozen fallback sens instead of the active test value.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1.5">Date</label>
                <input
                  type="date"
                  value={form.date}
                  onChange={set('date')}
                  data-inspect-id="logmatch-date-input"
                  className="w-full field px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1.5">Time</label>
                <input
                  type="time"
                  value={form.time}
                  onChange={set('time')}
                  data-inspect-id="logmatch-time-input"
                  className="w-full field px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1.5">Sensitivity</label>
                {/* Read-only — the in-game sens this match will actually be
                    logged at: the active stage-test's current value if one's
                    running for this hero (or the ad-hoc set), otherwise the
                    frozen fallback. Matches what matches.ts stamps server-side. */}
                <div data-inspect-id="logmatch-sensitivity-display" className="w-full field px-3 py-2 text-sm num-display text-[var(--ink)] whitespace-nowrap overflow-hidden">
                  {displaySens != null ? displaySens.toFixed(2) : '—'}
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs text-[var(--muted)] mb-1.5">
                Hero <span className="text-[var(--faint-2)]">— 2nd/3rd only if you switched mid-match</span>
              </label>
              {/* Three columns: 1st is the match's starting hero (pre-filled
                  from the Pre-Match picker above), 2nd/3rd are optional
                  switches made mid-match. The match's result attaches to
                  every hero filled in, not just the first. */}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <select
                    value={form.hero}
                    onChange={set('hero')}
                    data-inspect-id="logmatch-hero-select"
                    className="w-full field px-2 py-2 text-sm"
                  >
                    <option value="">— 1st hero —</option>
                    {(['DPS', 'Tank', 'Support'] as const).map(role => (
                      <optgroup key={role} label={role}>
                        {HERO_TEST_LIST.filter(([, r]) => r === role).map(([h]) => {
                          const heroSens = displaySensForHero(h);
                          return (
                            <option key={h} value={h} className="uppercase">
                              {withHeroCount(h, heroCounts)}{heroSens != null && ` @ ${heroSens.toFixed(2)}`}
                            </option>
                          );
                        })}
                      </optgroup>
                    ))}
                  </select>
                  {heroRole && <span data-inspect-id="logmatch-hero-role-badge" className={`pill mt-1.5 ${ROLE_COLORS[heroRole]}`}>{heroRole}</span>}
                </div>
                {([0, 1] as const).map(i => {
                  const h = switchHeroes[i];
                  const r = h ? HEROES[h] : '';
                  return (
                    <div key={i}>
                      <select
                        value={h}
                        onChange={setSwitchHero(i)}
                        data-inspect-id={`logmatch-hero-switch-select-${i + 2}`}
                        className="w-full field px-2 py-2 text-sm"
                      >
                        <option value="">— {i === 0 ? '2nd' : '3rd'} hero —</option>
                        {(['DPS', 'Tank', 'Support'] as const).map(role => (
                          <optgroup key={role} label={role}>
                            {HERO_TEST_LIST.filter(([, rl]) => rl === role).map(([hh]) => {
                              const heroSens = displaySensForHero(hh);
                              return (
                                <option key={hh} value={hh} className="uppercase">
                                  {withHeroCount(hh, heroCounts)}{heroSens != null && ` @ ${heroSens.toFixed(2)}`}
                                </option>
                              );
                            })}
                          </optgroup>
                        ))}
                      </select>
                      {r && <span data-inspect-id={`logmatch-hero-switch-role-badge-${i + 2}`} className={`pill mt-1.5 ${ROLE_COLORS[r]}`}>{r}</span>}
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs text-[var(--muted)] mb-1.5">Map</label>
              {map ? (
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-bold map-name text-[var(--ink)]">{withMapCount(map, mapCounts)}</span>
                  {mapType && <span data-inspect-id="logmatch-map-type-badge" className={`pill ${TYPE_COLORS[mapType] ?? ''}`}>{mapType}</span>}
                </div>
              ) : (
                <div data-inspect-id="logmatch-map-display" className="text-xs text-[var(--faint)] italic">Pick a map in the Pre-Match section above to log a result.</div>
              )}
            </div>

            <div>
              <label data-inspect-id="logmatch-result-toggle" className="block text-xs text-[var(--muted)] mb-1.5">Result</label>
              <div className="relative flex h-[3.25rem] w-full rounded-lg overflow-hidden">
                {/* Sliding fill — animates to the selected half and takes its color;
                    hidden until a result is chosen. */}
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-y-0 left-0 w-1/2 transition-all duration-200 ease-out ${
                    form.win === '1' ? 'translate-x-0 bg-emerald-800'
                    : form.win === '0' ? 'translate-x-full bg-red-800'
                    : 'opacity-0'
                  }`}
                />
                {[{ v: '1', label: 'Win',  onColor: 'text-emerald-400', litColor: 'text-emerald-300' },
                  { v: '0', label: 'Loss', onColor: 'text-red-400',     litColor: 'text-red-300' }].map(({ v, label, onColor, litColor }) => {
                  const selected = form.win === v;
                  // Stacked chevrons like a military rank insignia — pointing up
                  // for Win, down for Loss. Filled bands so the arm-ends are cut
                  // perfectly vertical (x is constant on each end edge).
                  const T = 5;                              // band thickness
                  const apex = v === '1' ? -6 : 6;          // apex above / below the arms
                  const bases = v === '1' ? [6, 12, 18, 24] : [0, 6, 12, 18];
                  const chevrons = bases.map(
                    y => `M0 ${y} L24 ${y + apex} L48 ${y} L48 ${y + T} L24 ${y + apex + T} L0 ${y + T} Z`,
                  );
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, win: v as '0' | '1' }))}
                      className={`group relative z-10 flex-1 flex items-center justify-center overflow-hidden text-sm font-bold uppercase tracking-wider transition-colors ${
                        selected ? 'text-white' : 'text-[var(--faint)] hover:text-[var(--ink)]'
                      }`}
                    >
                      {/* Stacked-chevron rank insignia behind the label. Darkens
                          against the bright fill when selected. */}
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 48 28"
                        fill="currentColor"
                        className={`chev pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-auto ${
                          selected ? `is-selected ${litColor}` : onColor
                        }`}
                      >
                        {chevrons.map((d, i) => {
                          // Win: bottom chevron leads → highlight travels up.
                          // Loss: top chevron leads → highlight travels down.
                          const order = v === '1' ? chevrons.length - 1 - i : i;
                          return <path key={i} d={d} style={{ animationDelay: `${order * 0.4}s` }} />;
                        })}
                      </svg>
                      <span className="relative z-10 font-display italic font-black text-xl">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="block text-xs text-[var(--muted)] mb-1.5">Main Perceived Factors</label>
              <textarea
                value={form.notes}
                onChange={set('notes')}
                rows={2}
                data-inspect-id="logmatch-notes-textarea"
                className="w-full field px-3 py-2 text-sm resize-none"
                placeholder="fatigue, warmup, just switched stage…"
              />
            </div>

            <div className="space-y-3" data-inspect-id="logmatch-feel-sliders">
              {playedHeroes.map(h => {
                const heroSens = displaySensForHero(h);
                return (
                  <div key={h}>
                    <label className="block text-xs text-[var(--muted)] mb-1.5">
                      Feel <span className="text-[var(--ink)] font-bold">— {h}{heroSens != null ? ` @ ${heroSens.toFixed(2)}` : ''}</span>
                      <span className="text-[var(--faint-2)]"> — did the sens feel slow or fast?</span>
                    </label>
                    <input
                      type="range"
                      min={FEEL_MIN}
                      max={FEEL_MAX}
                      step={1}
                      value={feelFor(h)}
                      onChange={e => setFeelFor(h, Number(e.target.value))}
                      className="w-full accent-ow-accent"
                      aria-label={`Feel — slow to fast — ${h}`}
                      data-inspect-id="logmatch-feel-slider"
                    />
                    <div className="flex justify-between text-[10px] text-[var(--faint-2)] mt-1 px-0.5"><span>Slow</span><span>Just Right</span><span>Fast</span></div>
                  </div>
                );
              })}
            </div>

            <div>
              <label className="block text-xs text-[var(--muted)] mb-1.5">Team <span className="text-[var(--faint-2)]">— how was the team this match?</span></label>
              <StarRating value={teamRating} onChange={setTeamRating} dataInspectId="logmatch-team-rating-stars" />
            </div>

            <button
              type="submit"
              disabled={!valid || status === 'saving'}
              data-inspect-id="logmatch-log-match-button"
              className="btn-primary w-full py-2.5 text-sm"
            >
              {status === 'saving' ? 'Saving…' : status === 'success' ? '✓ Saved' : 'Log Match'}
            </button>
            {status === 'error' && <p data-inspect-id="logmatch-save-error-banner" className="text-red-600 text-xs text-center">Failed to save — is the server running?</p>}
          </form>
        </div>

        <div className="card" data-inspect-id="logmatch-recently-logged-card">
          <h2 className="text-sm heading-display text-[var(--ink-2)] mb-4">Recently Logged</h2>
          {recent.length > 0 ? (
            <div className="space-y-2" data-inspect-id="logmatch-recently-logged-list">
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
                      <div className="text-xs hero-name text-[var(--ink)]">{withHeroCount(r.hero, heroCounts)}</div>
                      <div className="text-xs map-name text-[var(--faint)]">{withMapCount(r.map, mapCounts)}</div>
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
              dataInspectId="logmatch-nothing-logged-empty-state"
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

import { useEffect, useState } from 'react';
import { useMatchEditDrawer } from '../contexts/MatchEditDrawerContext';
import { revalidateAll } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { useDfHeroes, withDfBadge } from '../hooks/useDfHeroes';
import LeaverSliver from './LeaverSliver';
import {
  HEROES, MAPS, ROLE_COLORS, TYPE_COLORS,
  QUEUE_MODES, QUEUE_MODE_COLORS, QueueMode, TrendPoint,
} from '../types';
import { format, parseISO } from 'date-fns';

// Same "blank means unanswered, don't parse it as 0" convention SensLog.tsx's
// backfill form uses for sens fields.
const num = (s: string) => (s.trim() === '' ? null : parseFloat(s));

// Full match row, fetched separately from TrendPoint (the chart-derived shape
// this drawer is opened with) — TrendPoint never carried leaver/leaver_side/
// sens/blind_trial, so there was nothing to prefill the new controls from
// until GET /api/matches/:id existed to supply them.
interface FullMatchRow {
  leaver: 0 | 1 | null;
  leaver_side: 'mine' | 'theirs' | null;
  sens: number | null;
  blind_trial: 0 | 1 | null;
}

const HERO_LIST = Object.entries(HEROES).sort((a, b) => a[0].localeCompare(b[0]));
const MAP_LIST = Object.keys(MAPS).sort();

// Two-line labels for the mode toggle, matching the Log Match form.
const MODE_COMPACT: Record<string, { top: string; bot: string }> = {
  qp_role:   { top: 'Quickplay',   bot: 'Role' },
  comp_role: { top: 'Competitive', bot: 'Role' },
  comp_open: { top: 'Competitive', bot: 'Open' },
};

interface EditState {
  date: string;
  hero: string;
  map: string;
  win: 0 | 1;
  queue_mode: QueueMode;
}

interface MatchHero {
  hero: string;
  role: string;
  feel: number | null;
  sens: number | null;
  /** True when this exact (match, hero) pair has a blind_credits row — only
   *  ever slot 1 in practice (2026-09-24: only the starting hero can earn
   *  test credit), but read off the server's actual join rather than assumed
   *  here, so the sens-edit warning below stays correct if that rule moves. */
  credited: boolean;
}

function DrawerForm({ match }: { match: TrendPoint }) {
  const { closeEdit } = useMatchEditDrawer();
  const [form, setForm] = useState<EditState>({
    date: match.date,
    hero: match.hero,
    map: match.map,
    win: match.win,
    queue_mode: match.queue_mode,
  });
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Slots 2/3 — heroes switched to mid-match. Slot 1 stays on `form.hero` above.
  const [extraHeroes, setExtraHeroes] = useState<string[]>([]);
  // Editable sens, one field per slot. Strings (not numbers) so a field can
  // sit blank while being typed, same convention as SensLog's backfill form.
  // slot1Sens starts '' until the full-row fetch below lands — the Save
  // button stays disabled on rowLoaded until then so an unfetched '' can
  // never overwrite a real recorded sens.
  const [slot1Sens, setSlot1Sens] = useState('');
  const [slot1OriginalSens, setSlot1OriginalSens] = useState<number | null>(null);
  const [slot1Credited, setSlot1Credited] = useState(false);
  const [extraSens, setExtraSens] = useState<string[]>([]);
  const [extraOriginalSens, setExtraOriginalSens] = useState<(number | null)[]>([]);
  const [extraCredited, setExtraCredited] = useState<boolean[]>([]);
  // The hero names slots 2/3 were loaded with — save() compares against this
  // to decide whether the roster itself changed. Only a real roster change
  // sends `heroes` (a full replace slots>1 endpoint, which recomputes each
  // extra slot's sens off its active stage same as it always has); a pure
  // sens correction sends `heroSens` instead, which never touches the roster
  // or re-runs that recompute — see save() below for why this split exists.
  const [originalExtraHeroNames, setOriginalExtraHeroNames] = useState<string[]>([]);
  // Leaver — same sliver control as LogMatch, prefilled from the match's
  // current leaver/leaver_side. `leaverUnknown` covers a historical row
  // logged before leaver_side existed (leaver=1, side never recorded): both
  // slivers render unselected and the label says so, but this must NOT be
  // read as "no leaver was chosen" — Save only clears it if the user
  // actually taps a sliver (see the label logic in LeaverSliver and the
  // save() payload below).
  const [leaverSide, setLeaverSide] = useState<'mine' | 'theirs' | null>(null);
  const [leaverUnknown, setLeaverUnknown] = useState(false);
  const [rowLoaded, setRowLoaded] = useState(false);
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();
  const dfMap = useDfHeroes();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/matches/${match.id}/heroes`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        const rows = (data.rows ?? []) as MatchHero[];
        const extras = rows.slice(1);
        setExtraHeroes(extras.map(h => h.hero));
        setOriginalExtraHeroNames(extras.map(h => h.hero));
        setExtraSens(extras.map(h => (h.sens != null ? String(h.sens) : '')));
        setExtraOriginalSens(extras.map(h => h.sens));
        setExtraCredited(extras.map(h => h.credited));
        const slot1 = rows[0];
        if (slot1) setSlot1Credited(slot1.credited);
      })
      .catch(() => { if (!cancelled) { setExtraHeroes([]); setExtraSens([]); setExtraOriginalSens([]); setExtraCredited([]); } });
    return () => { cancelled = true; };
  }, [match.id]);

  // Full match row — carries leaver/leaver_side/sens/blind_trial, none of
  // which TrendPoint (what this drawer is opened with) includes.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/matches/${match.id}`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        const row = data.row as FullMatchRow | undefined;
        if (!row) return;
        setSlot1Sens(row.sens != null ? String(row.sens) : '');
        setSlot1OriginalSens(row.sens);
        setLeaverSide(row.leaver_side ?? null);
        setLeaverUnknown(!!row.leaver && row.leaver_side == null);
        setRowLoaded(true);
      })
      .catch(() => { if (!cancelled) setRowLoaded(true); });
    return () => { cancelled = true; };
  }, [match.id]);

  function addHero() {
    setExtraHeroes(prev => (prev.length >= 2 ? prev : [...prev, HERO_LIST[0][0]]));
    setExtraSens(prev => (prev.length >= 2 ? prev : [...prev, '']));
    setExtraOriginalSens(prev => (prev.length >= 2 ? prev : [...prev, null]));
    setExtraCredited(prev => (prev.length >= 2 ? prev : [...prev, false]));
  }
  function updateHero(i: number, hero: string) {
    setExtraHeroes(prev => prev.map((h, idx) => (idx === i ? hero : h)));
  }
  function updateExtraSens(i: number, v: string) {
    setExtraSens(prev => prev.map((s, idx) => (idx === i ? v : s)));
  }
  function removeHero(i: number) {
    setExtraHeroes(prev => prev.filter((_, idx) => idx !== i));
    setExtraSens(prev => prev.filter((_, idx) => idx !== i));
    setExtraOriginalSens(prev => prev.filter((_, idx) => idx !== i));
    setExtraCredited(prev => prev.filter((_, idx) => idx !== i));
  }
  // Positive-number check only — same bound SensLog/blind.ts use (`> 0`),
  // no invented upper cap.
  const sensValid = (s: string) => { const n = num(s); return n == null || n > 0; };
  function toggleLeaver(side: 'mine' | 'theirs') {
    // Any tap resolves the "unknown historical side" case into a normal
    // mine/theirs pick — see the leaverUnknown comment above.
    setLeaverUnknown(false);
    setLeaverSide(prev => (prev === side ? null : side));
  }

  const heroRole = form.hero ? HEROES[form.hero] : '';
  const mapType = form.map ? MAPS[form.map] : '';

  // A real roster change (hero added/removed/swapped in slots 2/3) — as
  // opposed to just correcting a sens value on the same heroes already
  // there. Only this case sends `heroes` below.
  const extraRosterChanged =
    extraHeroes.length !== originalExtraHeroNames.length ||
    extraHeroes.some((h, i) => h !== originalExtraHeroNames[i]);

  async function save() {
    setStatus('saving');
    try {
      const body: Record<string, unknown> = {
        date: form.date,
        day_of_week: getDayOfWeek(form.date),
        hero: form.hero,
        role: heroRole,
        map: form.map,
        game_type: mapType,
        win: form.win,
        queue_mode: form.queue_mode,
        // Slot 1's sens is always sent, current-value or not (RULES: "the
        // drawer always sends the current per-slot sens") — that's what lets
        // the server's existing `sensProvided` check keep a hand-edited value
        // even when this same save also changes hero/queue_mode and would
        // otherwise re-stamp it from the active stage.
        sens: num(slot1Sens),
        // 0/1, not a boolean — PUT's generic field writer (matches.ts's
        // EDITABLE loop) only coerces `win`, so a raw boolean here reaches
        // better-sqlite3 and throws. POST's own insert path converts
        // booleans itself, which is why LogMatch's `leaver: leaverSide !==
        // null` works there but the same value would 500 through PUT.
        leaver: leaverUnknown ? 1 : (leaverSide !== null ? 1 : 0),
        leaver_side: leaverUnknown ? null : leaverSide,
      };
      if (extraRosterChanged) {
        // Roster actually changed — full replace, same as before this
        // feature existed. Each entry's own sens rides along, but a stage
        // recompute can still override it for a hero under an active test
        // (existing behavior, unchanged here — see syncStageCredits).
        body.heroes = extraHeroes.map((h, i) => {
          const sensNum = num(extraSens[i]);
          return sensNum != null ? { hero: h, role: HEROES[h], sens: sensNum } : { hero: h, role: HEROES[h] };
        });
      } else if (extraHeroes.length > 0) {
        // Roster unchanged — correct sens only, through the same
        // hero-keyed `heroSens` the /sens backfill form uses. This path
        // never touches match_heroes' hero/role, never sends `heroes`, so
        // heroesProvided/rosterChanged stay false and syncStageCredits never
        // runs — nothing recomputes the value straight back out.
        const heroSens: Record<string, number> = {};
        extraHeroes.forEach((h, i) => {
          const n = num(extraSens[i]);
          if (n != null) heroSens[h] = n;
        });
        if (Object.keys(heroSens).length > 0) body.heroSens = heroSens;
      }
      const res = await fetch(`/api/matches/${match.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed');
      revalidateAll();
      closeEdit();
    } catch {
      setStatus('error');
    }
  }

  async function remove() {
    setStatus('saving');
    try {
      const res = await fetch(`/api/matches/${match.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed');
      revalidateAll();
      closeEdit();
    } catch {
      setStatus('error');
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      {/* Mode */}
      <div>
        <label data-inspect-id="matchEditDrawer-mode-toggle" className="block text-xs text-[var(--muted)] mb-1.5">Mode</label>
        <div className="grid grid-cols-3 gap-2">
          {QUEUE_MODES.map(m => {
            const active = form.queue_mode === m.value;
            const c = QUEUE_MODE_COLORS[m.value];
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => setForm(f => ({ ...f, queue_mode: m.value }))}
                className={`py-2 rounded-lg border text-xs font-semibold leading-tight transition-all ${
                  active ? `${c.card} ${c.accent} ${c.glow}` : 'border-ow-border text-[var(--faint)] hover:text-[var(--ink)] hover:border-gray-500'
                }`}
              >
                <div>{MODE_COMPACT[m.value].top}</div>
                <div className="text-[10px] font-normal opacity-80">{MODE_COMPACT[m.value].bot}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Hero */}
      <div>
        <label data-inspect-id="matchEditDrawer-hero-select" className="block text-xs text-[var(--muted)] mb-1.5">Hero</label>
        <select
          value={form.hero}
          onChange={e => setForm(f => ({ ...f, hero: e.target.value }))}
          className="w-full field px-3 py-2 text-sm"
        >
          {(['DPS', 'Tank', 'Support'] as const).map(role => (
            <optgroup key={role} label={role}>
              {HERO_LIST.filter(([, r]) => r === role).map(([h]) => (
                <option key={h} value={h} className="uppercase">{withDfBadge(withHeroCount(h, heroCounts), dfMap, h)}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {heroRole && <span data-inspect-id="matchEditDrawer-hero-role-badge" className={`pill mt-1.5 ${ROLE_COLORS[heroRole]}`}>{heroRole}</span>}

        {/* Sens — the in-game sensitivity this hero was actually recorded at.
            Editing it never touches test credit (blind_credits/blind_trial/
            games_on_stage): the server stores whatever's sent here as-is
            rather than recomputing it from the active stage, same as an
            explicit sens has always beaten a recomputed one on this endpoint
            (matches.ts's `sensProvided`). The warning below is informational
            only — it never blocks Save. */}
        <div className="mt-2">
          <label className="block text-[10px] text-[var(--faint)] mb-1">Sens — {form.hero || 'slot 1'}</label>
          <input
            type="number"
            step="0.01"
            min={0.01}
            value={slot1Sens}
            onChange={e => setSlot1Sens(e.target.value)}
            data-inspect-id="matchEditDrawer-slot1-sens-input"
            className={`w-full field px-3 py-2 text-sm ${!sensValid(slot1Sens) ? 'border-red-500' : ''}`}
          />
          {!sensValid(slot1Sens) && <p className="text-[10px] text-red-600 mt-0.5">Sens must be a positive number.</p>}
          {slot1Credited && slot1OriginalSens != null && num(slot1Sens) !== slot1OriginalSens && (
            <p data-inspect-id="matchEditDrawer-slot1-sens-credit-warning" className="text-[10px] text-ow-accent mt-0.5">
              Test game — credit stays on its stage.
            </p>
          )}
        </div>

        {extraHeroes.length > 0 && (
          <div data-inspect-id="matchEditDrawer-extra-heroes" className="mt-3 space-y-2">
            <div className="text-[10px] text-[var(--faint)]">Also played (switched mid-match)</div>
            {extraHeroes.map((h, i) => {
              const r = HEROES[h];
              const sensStr = extraSens[i] ?? '';
              return (
                <div key={i} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <select
                      value={h}
                      onChange={e => updateHero(i, e.target.value)}
                      data-inspect-id={`matchEditDrawer-extra-hero-select-${i}`}
                      className="flex-1 field px-3 py-2 text-sm"
                    >
                      {(['DPS', 'Tank', 'Support'] as const).map(role => (
                        <optgroup key={role} label={role}>
                          {HERO_LIST.filter(([, rr]) => rr === role).map(([hh]) => (
                            <option key={hh} value={hh} className="uppercase">{withDfBadge(hh, dfMap, hh)}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    {r && <span className={`pill ${ROLE_COLORS[r]}`}>{r}</span>}
                    <input
                      type="number"
                      step="0.01"
                      min={0.01}
                      value={sensStr}
                      onChange={e => updateExtraSens(i, e.target.value)}
                      placeholder="Sens"
                      data-inspect-id={`matchEditDrawer-extra-hero-sens-input-${i}`}
                      className={`w-24 field px-2 py-2 text-sm ${!sensValid(sensStr) ? 'border-red-500' : ''}`}
                    />
                    <button
                      type="button"
                      onClick={() => removeHero(i)}
                      data-inspect-id={`matchEditDrawer-extra-hero-remove-${i}`}
                      className="text-[var(--faint)] hover:text-red-600 transition-colors text-lg leading-none px-1"
                      aria-label="Remove hero"
                    >
                      ×
                    </button>
                  </div>
                  {extraCredited[i] && extraOriginalSens[i] != null && num(sensStr) !== extraOriginalSens[i] && (
                    <p data-inspect-id={`matchEditDrawer-extra-hero-sens-credit-warning-${i}`} className="text-[10px] text-ow-accent">
                      Test game — credit stays on its stage.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {extraHeroes.length < 2 && (
          <button
            type="button"
            onClick={addHero}
            data-inspect-id="matchEditDrawer-add-hero-button"
            className="mt-2 w-full py-1.5 rounded-lg border border-dashed border-ow-border text-xs text-[var(--faint)] hover:text-[var(--ink)] hover:border-gray-500 transition-colors"
          >
            + Add hero
          </button>
        )}
      </div>

      {/* Map */}
      <div>
        <label data-inspect-id="matchEditDrawer-map-select" className="block text-xs text-[var(--muted)] mb-1.5">Map</label>
        <select
          value={form.map}
          onChange={e => setForm(f => ({ ...f, map: e.target.value }))}
          className="w-full field px-3 py-2 text-sm"
        >
          {MAP_LIST.map(m => (
            <option key={m} value={m}>{withMapCount(m, mapCounts).toUpperCase()} ({MAPS[m]})</option>
          ))}
        </select>
        {mapType && <span data-inspect-id="matchEditDrawer-map-type-badge" className={`pill mt-1.5 ${TYPE_COLORS[mapType] ?? ''}`}>{mapType}</span>}
      </div>

      {/* Result */}
      <div>
        <label data-inspect-id="matchEditDrawer-result-toggle" className="block text-xs text-[var(--muted)] mb-1.5">Result</label>
        <div className="flex gap-3">
          {[{ v: 1, label: 'Win', cls: 'border-emerald-500 bg-emerald-500/20 text-emerald-600' },
            { v: 0, label: 'Loss', cls: 'border-red-500 bg-red-500/20 text-red-600' }].map(({ v, label, cls }) => (
            <button
              key={v}
              type="button"
              onClick={() => setForm(f => ({ ...f, win: v as 0 | 1 }))}
              className={`flex-1 py-2.5 rounded-lg border text-sm font-semibold transition-all ${
                form.win === v ? cls : 'border-ow-border text-[var(--faint)] hover:text-[var(--ink)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Leaver — same sliver control LogMatch uses, extracted into
            LeaverSliver.tsx so both stay in sync. `leaverUnknown` covers a
            row logged before leaver_side existed (see the state comment
            above) — neither sliver lights up, and the label says the side
            was never recorded rather than implying "no leaver." */}
        <LeaverSliver
          value={leaverSide}
          onToggle={toggleLeaver}
          unknown={leaverUnknown}
          dataInspectPrefix="matchEditDrawer-leaver-side"
        />
      </div>

      {/* Date */}
      <div>
        <label data-inspect-id="matchEditDrawer-date-input" className="block text-xs text-[var(--muted)] mb-1.5">Date</label>
        <input
          type="date"
          value={form.date}
          onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
          className="w-full field px-3 py-2 text-sm"
        />
      </div>

      {/* Actions */}
      <div className="pt-2 space-y-3">
        <button
          type="button"
          onClick={save}
          disabled={
            status === 'saving' || !form.hero || !form.map || !rowLoaded ||
            slot1Sens.trim() === '' || !sensValid(slot1Sens) ||
            extraSens.some(s => !sensValid(s))
          }
          data-inspect-id="matchEditDrawer-save-button"
          className="btn-primary w-full py-2.5 text-sm"
        >
          {status === 'saving' ? 'Saving…' : 'Save Changes'}
        </button>
        {status === 'error' && <p data-inspect-id="matchEditDrawer-save-error-banner" className="text-red-600 text-xs text-center">Failed to save — is the server running?</p>}

        {confirmDelete ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={remove}
              disabled={status === 'saving'}
              data-inspect-id="matchEditDrawer-confirm-delete-button"
              className="flex-1 py-2 rounded-lg border border-red-500 bg-red-500/15 text-red-600 text-sm font-semibold hover:bg-red-500/25 transition-colors"
            >
              Confirm delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              data-inspect-id="matchEditDrawer-cancel-delete-button"
              className="flex-1 py-2 rounded-lg border border-ow-border text-[var(--muted)] text-sm hover:text-[var(--ink)] transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            data-inspect-id="matchEditDrawer-delete-button"
            className="w-full py-2 rounded-lg border border-ow-border text-xs text-[var(--faint)] hover:text-red-600 hover:border-red-500/50 transition-colors"
          >
            Delete this match
          </button>
        )}
      </div>
    </div>
  );
}

function getDayOfWeek(dateStr: string) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[new Date(dateStr + 'T12:00:00').getDay()];
}

export default function MatchEditDrawer() {
  const { editMatch, closeEdit } = useMatchEditDrawer();

  return (
    <>
      {/* Backdrop */}
      <div
        data-inspect-id="matchEditDrawer-backdrop"
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${editMatch ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={closeEdit}
      />
      {/* Drawer */}
      <div data-inspect-id="matchEditDrawer-panel" className={`fixed inset-y-0 right-0 w-96 bg-ow-dark border-l border-ow-border z-50 flex flex-col transition-transform duration-300 ${editMatch ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-start justify-between p-5 border-b border-ow-border shrink-0">
          <div>
            <h2 data-inspect-id="matchEditDrawer-header-title" className="text-lg heading-display text-[var(--ink)] leading-tight">Edit Match</h2>
            {editMatch && (
              <div data-inspect-id="matchEditDrawer-logged-date-label" className="text-xs text-[var(--faint)] mt-1">
                Logged {format(parseISO(editMatch.date), 'MMM d, yyyy')}
              </div>
            )}
          </div>
          <button onClick={closeEdit} data-inspect-id="matchEditDrawer-close-button" className="text-[var(--faint)] hover:text-[var(--ink)] transition-colors text-2xl leading-none ml-4">
            ×
          </button>
        </div>
        {editMatch && <DrawerForm key={editMatch.id} match={editMatch} />}
      </div>
    </>
  );
}

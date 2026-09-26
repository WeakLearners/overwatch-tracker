import { useState, useEffect, useRef } from 'react';
import { HEROES, MAPS, ROLE_COLORS, ROLE_PILL_CLASS, ROLE_PILL_CLASS_DARK, TYPE_COLORS, QueueMode, QUEUE_MODES, QUEUE_MODE_COLORS, QUEUE_MODE_SEL_RGB, MODE_WASH_CLASS, MODE_COMPACT, OLDEST_DASH_FADE_STYLE, isAccount, rankLabel, clampRank } from '../types';
import { useMatch } from '../contexts/MatchContext';
import { useDeathBuffer } from '../contexts/DeathBufferContext';
import { revalidateRec } from '../contexts/AdvisorContext';
import EmptyState from '../components/EmptyState';
import ModeWatermark from '../components/ModeWatermark';
import RegistryField from '../components/RegistryField';
import LeaverSliver from '../components/LeaverSliver';
import { buildRosterEditPayload } from '../lib/matchEditRoster';
import { useApi, revalidateAll } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { useDfHeroes, dfSensForHeroName, withDfBadge } from '../hooks/useDfHeroes';
import { format } from 'date-fns';
import { useFieldConfig } from '../contexts/FieldConfigContext';
import type { RankOutcomeValue, RankOutcomeChange } from '../components/RankOutcomeControl';

// Shared by the two rank-outcome buttons so they cannot drift apart.
const btnSmall = 'border border-ow-border rounded-md px-2.5 py-1 text-[11px] font-semibold text-[var(--ink-2)] transition-colors';

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
const MAP_LIST = Object.keys(MAPS).sort();

// Same "blank means unanswered, don't parse it as 0" convention SensLog.tsx's
// backfill form (and MatchEditDrawer.tsx) use for sens fields.
const num = (s: string) => (s.trim() === '' ? null : parseFloat(s));
// Positive-number check only — same bound SensLog/blind.ts use (`> 0`), no
// invented upper cap.
const sensValid = (s: string) => { const n = num(s); return n == null || n > 0; };

interface TodayMatchRow {
  id: number;
  hero: string;
  map: string;
  win: 0 | 1;
  queue_mode: QueueMode;
  time: string | null;
  stage_index: number | null;
  sens: number | null;
  // leaver/leaver_side: /api/matches already SELECT *s these onto every row —
  // just weren't declared here until the edit form needed them 2026-09-24.
  leaver: 0 | 1 | null;
  leaver_side: 'mine' | 'theirs' | null;
  // Also already on every row via SELECT *; declared 2026-09-26 for the
  // card's promotion/demotion fix.
  role: string;
  account: string | null;
  player_rank: number | null;
  player_rank_start: number | null;
}

type RankFixOutcome = 'promoted' | 'demoted' | 'none';

interface MatchHeroRow {
  hero: string;
  role: string;
  feel: number | null;
  sens: number | null;
  /** True when this exact (match, hero) pair has a blind_credits row — only
   *  ever slot 1 in practice (2026-09-24: only the starting hero can earn
   *  test credit), read off the server's actual join (GET /:id/heroes)
   *  rather than assumed. */
  credited: boolean;
}

// Inline editable-fields panel for a Today's Matches row — expands in place
// below the row's header block instead of opening a side drawer, matching
// the Awaiting Stats card's collapsed-row/inline-form pattern on the Sens page.
function TodayMatchEditForm({ match, heroCounts, mapCounts, onDone, toggleQueueMode, togglingId }: {
  match: TodayMatchRow;
  heroCounts: ReturnType<typeof useTodayHeroCounts>;
  mapCounts: ReturnType<typeof useTodayMapCounts>;
  onDone: () => void;
  toggleQueueMode: (id: number, current: QueueMode) => void;
  togglingId: number | null;
}) {
  const [hero, setHero] = useState(match.hero);
  const [map, setMap] = useState(match.map);
  const [win, setWin] = useState<0 | 1>(match.win);
  // Fixed 2nd/3rd hero slots, '' meaning none — same shape as the Log Match
  // form's own switch-hero dropdowns, so a mid-match switch edits the same way
  // it was originally logged.
  const [switchHeroes, setSwitchHeroes] = useState<[string, string]>(['', '']);
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dfMap = useDfHeroes();

  // Slot 1 sens — prefilled straight from `match.sens` (the list row already
  // carries it, no separate fetch needed the way MatchEditDrawer needed one
  // for TrendPoint-shaped data). Original value kept alongside for the
  // credited-game diff check below.
  const [slot1Sens, setSlot1Sens] = useState(match.sens != null ? String(match.sens) : '');
  const slot1OriginalSens = match.sens;
  const [slot1Credited, setSlot1Credited] = useState(false);
  // Slots 2/3 sens, parallel to switchHeroes — populated once the heroes
  // fetch below lands.
  const [extraSens, setExtraSens] = useState<[string, string]>(['', '']);
  const [extraOriginalSens, setExtraOriginalSens] = useState<(number | null)[]>([null, null]);
  const [extraCredited, setExtraCredited] = useState<boolean[]>([false, false]);
  // The hero names slots 2/3 were loaded with — save() compares against this
  // to decide whether the roster itself changed. Only a real roster change
  // sends `heroes` (the full-replace endpoint, which can recompute an extra
  // slot's sens off its active stage); a pure sens correction sends
  // `heroSens` instead, which never touches the roster and never re-runs
  // that recompute. Same split as MatchEditDrawer.tsx's save().
  const [originalExtraHeroNames, setOriginalExtraHeroNames] = useState<string[]>([]);
  // Leaver — same sliver control LogMatch's own (top) form uses, prefilled
  // from this row's leaver/leaver_side. `leaverUnknown` covers a historical
  // row logged before leaver_side existed (leaver=1, side never recorded):
  // both slivers render unselected and the label says so, but this must NOT
  // be read as "no leaver was chosen" — Save only clears it if the user
  // actually taps a sliver.
  const [leaverSide, setLeaverSide] = useState<'mine' | 'theirs' | null>(match.leaver_side ?? null);
  const [leaverUnknown, setLeaverUnknown] = useState(!!match.leaver && match.leaver_side == null);
  // Promotion/demotion — for when it was forgotten at log time. Read off the
  // row's own start/end ranks. Saved through its own endpoint, which also
  // shifts every later game on this ladder and the live rank (matches.ts).
  const { applyRankFix } = useMatch();
  const rankStart = match.player_rank_start;
  const origOutcome: RankFixOutcome | null = rankStart == null ? null
    : (match.player_rank ?? rankStart) > rankStart ? 'promoted'
    : (match.player_rank ?? rankStart) < rankStart ? 'demoted' : 'none';
  const [rankOutcome, setRankOutcome] = useState<RankFixOutcome | null>(origOutcome);
  const showRankFix = match.queue_mode !== 'qp_role' && (match.role === 'DPS' || match.role === 'Support');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/matches/${match.id}/heroes`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        const rows = (data.rows ?? []) as MatchHeroRow[];
        const extraRows = rows.slice(1);
        const extra = extraRows.map(h => h.hero);
        setSwitchHeroes([extra[0] ?? '', extra[1] ?? '']);
        setOriginalExtraHeroNames(extra);
        setExtraSens([
          extraRows[0]?.sens != null ? String(extraRows[0].sens) : '',
          extraRows[1]?.sens != null ? String(extraRows[1].sens) : '',
        ]);
        setExtraOriginalSens([extraRows[0]?.sens ?? null, extraRows[1]?.sens ?? null]);
        setExtraCredited([!!extraRows[0]?.credited, !!extraRows[1]?.credited]);
        if (rows[0]) setSlot1Credited(rows[0].credited);
      })
      .catch(() => { if (!cancelled) setSwitchHeroes(['', '']); });
    return () => { cancelled = true; };
  }, [match.id]);

  // Each switch slot excludes whichever hero the other slots already hold, so
  // picking a hero already used elsewhere in this match can't silently dupe it.
  const switchOptionsFor = (i: 0 | 1) => {
    const otherPicks = new Set([hero, switchHeroes[i === 0 ? 1 : 0]].filter(Boolean));
    return HERO_LIST.filter(([h]) => !otherPicks.has(h));
  };
  function setSwitchHero(i: 0 | 1, h: string) {
    setSwitchHeroes(prev => { const next: [string, string] = [...prev]; next[i] = h; return next; });
  }
  function setExtraSensAt(i: 0 | 1, v: string) {
    setExtraSens(prev => { const next: [string, string] = [...prev]; next[i] = v; return next; });
  }
  function toggleLeaver(side: 'mine' | 'theirs') {
    // Any tap resolves the "unknown historical side" case into a normal
    // mine/theirs pick — see the leaverUnknown state comment above.
    setLeaverUnknown(false);
    setLeaverSide(prev => (prev === side ? null : side));
  }

  const heroRole = hero ? HEROES[hero] : '';
  const mapType = map ? TYPE_COLORS[MAPS[map]] : '';

  async function save() {
    setStatus('saving');
    try {
      const body: Record<string, unknown> = {
        hero, role: heroRole, map, game_type: MAPS[map], win,
        // Slot 1's sens is always sent, current-value or not — that's what
        // lets the server's existing `sensProvided` check (matches.ts) keep
        // a hand-edited value even when this same save also changes hero/
        // queue_mode and would otherwise re-stamp it from the active stage.
        sens: num(slot1Sens),
        // 0/1, not a boolean — PUT's generic field writer only coerces
        // `win`, so a raw boolean 500s against better-sqlite3 (found while
        // building MatchEditDrawer's identical control).
        leaver: leaverUnknown ? 1 : (leaverSide !== null ? 1 : 0),
        leaver_side: leaverUnknown ? null : leaverSide,
        // heroes vs. heroSens: a real roster change (hero added/removed/
        // swapped in slots 2/3) sends `heroes`, the full-replace field; a
        // pure sens correction on the same roster sends `heroSens` instead,
        // which never touches match_heroes' hero/role and never re-runs
        // syncStageCredits' roster recompute (matches.ts) — that recompute
        // is exactly what would clobber a hand-edited slot-2/3 sens for a
        // hero under an active stage test. See matchEditRoster.ts (and its
        // test) for the decision itself, pulled out pure/framework-free so
        // it has a test that doesn't need to render this form.
        ...buildRosterEditPayload({
          slotHeroes: switchHeroes,
          slotSens: extraSens,
          originalHeroNames: originalExtraHeroNames,
          roleOf: h => HEROES[h],
        }),
      };
      const res = await fetch(`/api/matches/${match.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed');
      if (rankOutcome && rankOutcome !== origOutcome) {
        const rr = await fetch(`/api/matches/${match.id}/rank-outcome`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outcome: rankOutcome }),
        });
        if (!rr.ok) throw new Error('Failed');
        const fix = await rr.json();
        if (isAccount(fix.account) && (fix.role === 'DPS' || fix.role === 'Support')) {
          applyRankFix(fix.account, fix.role, fix.rank, fix.latestEnd);
        }
      }
      revalidateAll();
      onDone();
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
      onDone();
    } catch {
      setStatus('error');
    }
  }

  return (
    <div className="space-y-3" onClick={e => e.stopPropagation()}>
      <div>
        <label className="block text-xs text-[var(--muted)] mb-1.5">Mode</label>
        <div className="flex items-center gap-2" data-inspect-id="logmatch-inline-edit-mode-toggle-group">
          <span className="text-xs font-black text-blue-400">Q</span>
          <button
            type="button"
            onClick={() => toggleQueueMode(match.id, match.queue_mode)}
            disabled={togglingId === match.id}
            aria-label={`Match type: ${match.queue_mode === 'qp_role' ? 'Quick Play' : 'Competitive'} — tap to switch`}
            data-inspect-id="logmatch-inline-edit-mode-toggle"
            className={`relative shrink-0 w-9 h-5 rounded-full transition-colors disabled:opacity-50 ${match.queue_mode === 'qp_role' ? 'bg-blue-500' : 'bg-red-500'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${match.queue_mode === 'qp_role' ? 'translate-x-0' : 'translate-x-4'}`} />
          </button>
          <span className="text-xs font-black text-red-400">C</span>
        </div>
      </div>

      <div>
        <label className="block text-xs text-[var(--muted)] mb-1.5">
          Hero <span className="text-[var(--faint-2)]">— 2nd/3rd only if you switched mid-match</span>
        </label>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <select value={hero} onChange={e => setHero(e.target.value)} data-inspect-id="logmatch-inline-edit-hero-select" className="w-full field px-2 py-2 text-sm">
              <option value="">— 1st hero —</option>
              {(['DPS', 'Tank', 'Support'] as const).map(role => (
                <optgroup key={role} label={role}>
                  {HERO_LIST.filter(([, r]) => r === role).map(([h]) => (
                    <option key={h} value={h}>{withDfBadge(withHeroCount(h, heroCounts), dfMap, h)}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            {heroRole && <span className={`pill mt-1.5 ${ROLE_COLORS[heroRole]}`}>{heroRole}</span>}
          </div>
          {([0, 1] as const).map(i => {
            const h = switchHeroes[i];
            const r = h ? HEROES[h] : '';
            return (
              <div key={i}>
                <select
                  value={h}
                  onChange={e => setSwitchHero(i, e.target.value)}
                  data-inspect-id={`logmatch-inline-edit-hero-switch-select-${i + 2}`}
                  className="w-full field px-2 py-2 text-sm"
                >
                  <option value="">— {i === 0 ? '2nd' : '3rd'} hero —</option>
                  {(['DPS', 'Tank', 'Support'] as const).map(role => (
                    <optgroup key={role} label={role}>
                      {switchOptionsFor(i).filter(([, rl]) => rl === role).map(([hh]) => (
                        <option key={hh} value={hh}>{withDfBadge(withHeroCount(hh, heroCounts), dfMap, hh)}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {r && <span className={`pill mt-1.5 ${ROLE_COLORS[r]}`}>{r}</span>}
              </div>
            );
          })}
        </div>

        {/* Sens, one input per hero slot actually filled above. Editing it
            never touches test credit (blind_credits/blind_trial/
            games_on_stage) — see save()'s comment on `sens`/`heroSens`. The
            warning is informational only and never blocks Save. */}
        <div className="grid grid-cols-3 gap-2 mt-2">
          <div>
            <label className="block text-[10px] text-[var(--faint)] mb-1">Sens{hero ? ` — ${hero}` : ''}</label>
            <input
              type="number"
              step="0.01"
              min={0.01}
              value={slot1Sens}
              onChange={e => setSlot1Sens(e.target.value)}
              data-inspect-id="logmatch-inline-edit-slot1-sens-input"
              className={`w-full field px-2 py-2 text-sm ${!sensValid(slot1Sens) ? 'border-red-500' : ''}`}
            />
            {slot1Credited && slot1OriginalSens != null && num(slot1Sens) !== slot1OriginalSens && (
              <p data-inspect-id="logmatch-inline-edit-slot1-sens-credit-warning" className="text-[9px] text-ow-accent mt-0.5 leading-tight">
                Test game — credit stays on its stage.
              </p>
            )}
          </div>
          {([0, 1] as const).map(i => {
            const h = switchHeroes[i];
            return (
              <div key={i}>
                <label className="block text-[10px] text-[var(--faint)] mb-1">Sens{h ? ` — ${h}` : ''}</label>
                <input
                  type="number"
                  step="0.01"
                  min={0.01}
                  value={extraSens[i]}
                  onChange={e => setExtraSensAt(i, e.target.value)}
                  disabled={!h}
                  data-inspect-id={`logmatch-inline-edit-extra-sens-input-${i + 2}`}
                  className={`w-full field px-2 py-2 text-sm disabled:opacity-40 ${!sensValid(extraSens[i]) ? 'border-red-500' : ''}`}
                />
                {extraCredited[i] && extraOriginalSens[i] != null && num(extraSens[i]) !== extraOriginalSens[i] && (
                  <p data-inspect-id={`logmatch-inline-edit-extra-sens-credit-warning-${i + 2}`} className="text-[9px] text-ow-accent mt-0.5 leading-tight">
                    Test game — credit stays on its stage.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <label className="block text-xs text-[var(--muted)] mb-1.5">Map</label>
        <select value={map} onChange={e => setMap(e.target.value)} data-inspect-id="logmatch-inline-edit-map-select" className="w-full field px-3 py-2 text-sm">
          {MAP_LIST.map(m => (
            <option key={m} value={m}>{withMapCount(m, mapCounts).toUpperCase()} ({MAPS[m]})</option>
          ))}
        </select>
        {mapType && <span className={`pill mt-1.5 ${mapType}`}>{MAPS[map]}</span>}
      </div>

      <div>
        <label className="block text-xs text-[var(--muted)] mb-1.5">Result</label>
        <div className="flex gap-3">
          {[{ v: 1, label: 'Win', cls: 'border-emerald-500 bg-emerald-500/20 text-emerald-600' },
            { v: 0, label: 'Loss', cls: 'border-red-500 bg-red-500/20 text-red-600' }].map(({ v, label, cls }) => (
            <button
              key={v}
              type="button"
              onClick={() => setWin(v as 0 | 1)}
              data-inspect-id={`logmatch-inline-edit-result-${label.toLowerCase()}`}
              className={`flex-1 py-2.5 rounded-lg border text-sm font-semibold transition-all ${win === v ? cls : 'border-ow-border text-[var(--faint)] hover:text-[var(--ink)]'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Leaver — same sliver control as the main Log Match form, rendered
            by the shared LeaverSliver.tsx component. `leaverUnknown` covers a
            row logged before leaver_side existed (see the state comment
            above) — neither sliver lights up, and the label says the side
            was never recorded rather than implying "no leaver". */}
        <LeaverSliver
          value={leaverSide}
          onToggle={toggleLeaver}
          unknown={leaverUnknown}
          dataInspectPrefix="logmatch-inline-edit-leaver-side"
          gapClass="gap-3"
        />
      </div>

      {showRankFix && (
        <div data-inspect-id="logmatch-inline-edit-rank-outcome">
          <label className="block text-xs text-[var(--muted)] mb-1.5">
            Rank
            {rankStart != null && rankOutcome && (
              <span className="text-ow-accent">
                {' · '}{rankLabel(rankStart)} → {rankLabel(clampRank(rankStart + (rankOutcome === 'promoted' ? 1 : rankOutcome === 'demoted' ? -1 : 0)))}
              </span>
            )}
          </label>
          {rankStart == null ? (
            <p className="text-xs text-[var(--faint)]">No starting rank on this match, so there's nothing to move from.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {([['demoted', 'Demoted'], ['none', 'No change'], ['promoted', 'Promoted']] as const).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setRankOutcome(v)}
                  aria-pressed={rankOutcome === v}
                  data-inspect-id={`logmatch-inline-edit-rank-outcome-${v}`}
                  className={`text-xs font-semibold py-2 rounded-lg border transition-colors ${
                    rankOutcome === v ? 'is-selected text-[var(--ink)]' : 'border-ow-border text-[var(--faint)] hover:text-[var(--ink)]'
                  }`}
                >{rankOutcome === v ? <span className="lit-text">{label}</span> : label}</button>
              ))}
            </div>
          )}
          {rankOutcome !== origOutcome && (
            <p className="text-[10px] text-[var(--faint)] mt-1">Later games on {match.account ?? 'this account'} {match.role}, and the live rank, shift to match.</p>
          )}
        </div>
      )}

      <div className="pt-1 space-y-2">
        <button
          type="button"
          onClick={save}
          disabled={
            status === 'saving' || !hero || !map ||
            slot1Sens.trim() === '' || !sensValid(slot1Sens) ||
            extraSens.some(s => !sensValid(s))
          }
          data-inspect-id="logmatch-inline-edit-save-button"
          className="btn-primary w-full py-2.5 text-sm"
        >
          {status === 'saving' ? 'Saving…' : 'Save Changes'}
        </button>
        {status === 'error' && <p className="text-red-600 text-xs text-center">Failed to save — is the server running?</p>}

        {confirmDelete ? (
          <div className="flex gap-2">
            <button type="button" onClick={remove} disabled={status === 'saving'} data-inspect-id="logmatch-inline-edit-confirm-delete-button" className="flex-1 py-2 rounded-lg border border-red-500 bg-red-500/15 text-red-600 text-sm font-semibold hover:bg-red-500/25 transition-colors">
              Confirm delete
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className="flex-1 py-2 rounded-lg border border-ow-border text-[var(--muted)] text-sm hover:text-[var(--ink)] transition-colors">
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} data-inspect-id="logmatch-inline-edit-delete-button" className="w-full py-2 rounded-lg border border-ow-border text-xs text-[var(--faint)] hover:text-red-600 hover:border-red-500/50 transition-colors">
            Delete this match
          </button>
        )}
      </div>
    </div>
  );
}

// Perceived sens speed, 0 (felt slow) to 10 (felt fast) — not a quality rating.
// Captured here, live, rather than backfilled later on /sens: the sensation is
// gone by the next match, so this is the only point it can honestly be logged.
// FEEL_MID is a display-only starting position for the slider thumb — it is
// never allowed to reach the database on its own. 50 is also the fulcrum the
// whole sens study scores against (|feel - 50|, minimised), so an untouched
// slider silently recording 50 was indistinguishable from Sean deliberately
// rating a sens "just right". Fixed 2026-09-21 — see the CUTOVER note by
// matches.feel in server/src/db/schema.ts for the full history and the
// pre-cutover rows this deliberately left ambiguous rather than backfilling.
const FEEL_MIN = 0, FEEL_MAX = 100, FEEL_MID = 50;



function getDayOfWeek(dateStr: string) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[new Date(dateStr + 'T12:00:00').getDay()];
}

// Smooth-scroll so a single element sits centred in the viewport. Map pick is
// the only caller left — hero pick used to centre Match Details as well, but
// that auto-scroll was removed 2026-09-10: it moved the page out from under a
// hero list still being clicked. Falls back to Match Details if the requested
// id isn't rendered yet.
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

// /api/blind/sets — every DPI/sens-test set ever created, tagged with its
// testing phase. Same shape/route Prematch's Select Your Hero reads to build
// the current phase's full roster; fetched independently here too (same
// pattern this file already uses for /api/blind/state) so the hero dropdowns
// below can be scoped to "heroes being tested in the selected role" rather
// than just whichever hero currently has an active run.
interface BlindSetSummary {
  set_id: number;
  hero: string | null;
  phase: string | null;
  active: boolean;
  completed: boolean;
}

export default function LogMatch() {
  // Map + queue mode are shared with the Pre-Match section via context; this
  // section only owns date/time/hero/win plus the death tags.
  const { queueMode, setQueueMode, map, setMap, mapType, sens, testRole, pendingHeroes, setPendingHeroes, notifyMatchLogged, playerRank, setPlayerRank, rankAtLastLog, commitRankAtLastLog, lobbyLow, lobbyHigh, account } = useMatch();
  const { deathBuffer, removeDeathFromBuffer, toggleDeathUlt, clearDeathBuffer } = useDeathBuffer();
  const { data: dpiState } = useApi<DpiTestState>('/api/blind/state');
  const { isFieldEnabled, fields } = useFieldConfig();
  const registryField = (id: string) => fields.find(f => f.id === id);
  const { data: blindSets } = useApi<{ sets: BlindSetSummary[] }>('/api/blind/sets');
  const dfMap = useDfHeroes();
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();
  // One feel reading per hero actually played (mirrors switchHeroes/duration_min
  // per-hero) — a mid-match switch can feel different on the hero you started
  // on than the one you switched to, especially if they're on different sens.
  // Keyed by hero name. A hero absent from this map has not answered — feelFor
  // below is a DISPLAY position only, so the slider thumb has somewhere to
  // rest before it's touched, and must never be read to decide what gets
  // saved. feelAnswered/feelValueFor are the only things submit() may read.
  const [feelByHero, setFeelByHero] = useState<Record<string, number>>({});
  const feelFor = (h: string) => feelByHero[h] ?? FEEL_MID;
  const feelAnswered = (h: string) => Object.prototype.hasOwnProperty.call(feelByHero, h);
  const feelValueFor = (h: string): number | null => feelAnswered(h) ? feelByHero[h] : null;
  const setFeelFor = (h: string, v: number) => setFeelByHero(prev => ({ ...prev, [h]: v }));
  const [teamRating, setTeamRating] = useState(0);
  // Both start unselected and stay null if untouched — no pre-selection, and
  // clicking the already-selected option deselects it back to null.
  const [matchQuality, setMatchQuality] = useState<'stomp' | 'close' | null>(null);
  const [resultDriver, setResultDriver] = useState<'me' | 'team' | null>(null);
  // Did somebody leave this match, and whose team. null means "nobody left" —
  // unlike matchQuality/resultDriver, an untouched control here is a true
  // answer, not a skipped question, so the submit payload derives the old
  // boolean `leaver` fact from whether a side got picked rather than
  // tracking it separately. Was a plain boolean until 2026-09-24, when which
  // team mattered enough to become its own column (schema.ts's `leaver_side`
  // comment).
  const [leaverSide, setLeaverSide] = useState<'mine' | 'theirs' | null>(null);

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

  // The in-game sens this match will actually be tagged with. Fixed
  // 2026-09-24: "what sens is this hero at" and "does this match count for
  // the study" are two different questions — isStudyQueueMode answers the
  // second one only (Competitive vs QP), and used to gate this lookup too,
  // which meant a hero under an active stage test displayed and recorded
  // the frozen fallback sens (2.5) in QP instead of its real current sens.
  // A hero under test is at that sens whichever queue it's played in; QP
  // simply never earns a credit for it (server-side gate, matches.ts's
  // findActiveStage/isCompetitive — unchanged). Checks for a set tagged to
  // the selected hero, then the hero-less ad-hoc set — same priority order
  // the server uses when it stamps the match.
  // Same lookup as activeSetSens below, generalized to any hero — used to
  // label each hero's own Feel slider with the sens it was actually played
  // at, since a mid-match switch can land on a different hero's own test.
  const sensForHero = (h: string): number | null => {
    if (!h) return null;
    // Designated Fallback always shows/records its own fixed sens (never the
    // 2.5 study fallback, never an ad-hoc set it was never actually part of)
    // — same priority the server enforces in matches.ts's dfSensForHero.
    const dfSens = dfSensForHeroName(h, dfMap);
    if (dfSens != null) return dfSens;
    const actives = dpiState?.actives ?? [];
    const active = actives.find(a => a.hero === h) ?? actives.find(a => a.hero === null);
    return active ? active.sens ?? active.in_game_sens : null;
  };
  const displaySensForHero = (h: string): number | null => sensForHero(h) ?? (parseFloat(sens) > 0 ? parseFloat(sens) : null);
  const activeSetSens = sensForHero(form.hero);

  // Hero dropdowns only offer heroes actually being tested — logging is meant
  // to feed the running test, not just record any match — scoped down
  // further to whichever role Role Pick has selected (Prematch's toggle,
  // shared via context), not the full DPS/Support roster class. "Being
  // tested" = the current testing phase's roster (active OR already finished
  // this phase — same phaseHeroes/currentPhase logic as Prematch's Select
  // Your Hero, so a hero clicked there always has a matching option here),
  // unioned with any currently-active test so an active ad-hoc/legacy test
  // outside the current phase still shows too. QP is the exception: no QP
  // match ever earns a stage credit (server-side gate, unrelated to
  // sensForHero above, which now labels a tested hero's real sens in QP
  // too), so restricting the list there just gets in the way — every hero
  // is offered instead.
  const isQP = queueMode === 'qp_role';
  // Which outcome Sean picked for THIS match. Required before logging, the
  // same as hero and result: a match that moved the ladder and one that did
  // not are different facts, and leaving it unanswered writes "no change"
  // silently. Null means unanswered, so the button stays disabled. The
  // promote/demote/no-change render logic itself (rankMoved, rankBase,
  // rankStep) moved into RankOutcomeControl.tsx during the field-registry
  // Phase 2 conversion (2026-09-24) — this component still owns the state.
  const [rankOutcome, setRankOutcome] = useState<'moved' | 'none' | null>(null);
  // Switching the result after answering would leave a promotion standing on
  // a loss. Clear the answer and hand the rank back to where it started.
  const winValue = form.win;
  useEffect(() => {
    setRankOutcome(null);
    if (rankAtLastLog != null && playerRank !== rankAtLastLog) setPlayerRank(rankAtLastLog);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winValue]);
  const inTestingHeroes = new Set((dpiState?.actives ?? []).map(a => a.hero).filter((h): h is string => !!h));
  const allBlindSets = blindSets?.sets ?? [];
  const currentPhase = [...allBlindSets].reverse().find(s => s.phase)?.phase ?? null;
  const phaseHeroes = new Set(
    (currentPhase ? allBlindSets.filter(s => s.phase === currentPhase) : [])
      .map(s => s.hero).filter((h): h is string => !!h),
  );
  const testableHeroes = new Set([...inTestingHeroes, ...phaseHeroes]);
  // Designated Fallback (server/src/db/schema.ts's df_heroes) is never under
  // test — it can't appear in testableHeroes above, since a test set can
  // never be created on it — but LogMatch still has to offer it in
  // Competitive, where the dropdown is otherwise restricted to heroes under
  // test: a fallback pick you can't log defeats the point of having one.
  const dfHeroForRole = dfMap[testRole]?.hero;
  const HERO_TEST_LIST = isQP ? HERO_LIST : HERO_LIST.filter(([h, r]) => (testableHeroes.has(h) || h === dfHeroForRole) && r === testRole);
  // In QP mode the switch dropdowns offer every hero, so without this a
  // mid-match "switch" could silently re-pick a hero already in another slot
  // — each switch slot excludes whichever hero the *other* slots hold.
  const switchOptionsFor = (i: 0 | 1) => {
    if (!isQP) return HERO_TEST_LIST;
    const otherPicks = new Set([form.hero, switchHeroes[i === 0 ? 1 : 0]].filter((h): h is string => !!h));
    return HERO_TEST_LIST.filter(([h]) => !otherPicks.has(h));
  };
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

  // Heroes tapped in the Pre-Match "Select Your Hero" list pre-fill the form
  // here, in click order — index 0 is the starting hero (form.hero), 1/2 are
  // the two switch-hero slots, mirroring that section's own click-order
  // badges exactly. Sent as the FULL current click list on every click (not
  // a delta), so this always fully re-derives all 3 slots from whatever's
  // currently clicked — including clearing a slot back out when a hero is
  // toggled off there. No scroll follows — the page stays where it is so
  // successive hero clicks land on a list that hasn't moved.
  useEffect(() => {
    if (pendingHeroes) {
      const [h1, h2, h3] = pendingHeroes;
      setForm(f => ({ ...f, hero: h1 ?? '' }));
      setSwitchHeroes([h2 ?? '', h3 ?? '']);
      setPendingHeroes(null);
    }
  }, [pendingHeroes, setPendingHeroes]);

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

  // "Today's Matches" reads today's matches straight from the DB — the single
  // source of truth — so it's always accurate and resets on its own when the
  // date rolls over, since the query is scoped to the current day. This card
  // is the only place a match's queue mode can be corrected after logging —
  // consolidated here (instead of also living on the Sens page) so there's
  // one place to look, not two independent toggles that can drift.
  const today = format(new Date(), 'yyyy-MM-dd');
  const { data: todayData } = useApi<{ rows: TodayMatchRow[] }>(
    `/api/matches?from=${today}&to=${today}&limit=50`
  );
  const recent = todayData?.rows ?? [];
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Mid-match switch heroes (slots 2/3) per row — fetched separately since
  // /api/matches only returns each match's primary hero. Keyed off a stable
  // string of today's match ids so it only refires when that set changes —
  // plus a manual tick bumped after an inline edit saves, since a roster
  // change (e.g. adding/removing a switch hero) doesn't change the id set.
  const [extraHeroesByMatch, setExtraHeroesByMatch] = useState<Record<number, MatchHeroRow[]>>({});
  const [heroesTick, setHeroesTick] = useState(0);
  const recentIdsKey = recent.map(r => r.id).join(',');
  useEffect(() => {
    const ids = recentIdsKey ? recentIdsKey.split(',').map(Number) : [];
    if (ids.length === 0) { setExtraHeroesByMatch({}); return; }
    let cancelled = false;
    Promise.all(
      ids.map(id =>
        fetch(`/api/matches/${id}/heroes`)
          .then(res => res.json())
          .then((data: { rows?: MatchHeroRow[] }) => [id, (data.rows ?? []).slice(1)] as [number, MatchHeroRow[]])
      )
    )
      .then(results => { if (!cancelled) setExtraHeroesByMatch(Object.fromEntries(results)); })
      .catch(() => { if (!cancelled) setExtraHeroesByMatch({}); });
    return () => { cancelled = true; };
  }, [recentIdsKey, heroesTick]);

  // Win/mode history for the same hero's last 5 matches strictly before each
  // row — same batched-fetch-keyed-on-id-set pattern as extraHeroesByMatch
  // above, backing the colored history strip shown under the hero pill in
  // place of a plain timestamp.
  const [heroHistoryByMatch, setHeroHistoryByMatch] = useState<Record<number, { win: 0 | 1; queue_mode: QueueMode }[]>>({});
  useEffect(() => {
    const ids = recentIdsKey ? recentIdsKey.split(',').map(Number) : [];
    if (ids.length === 0) { setHeroHistoryByMatch({}); return; }
    let cancelled = false;
    Promise.all(
      ids.map(id =>
        fetch(`/api/matches/${id}/hero-history`)
          .then(res => res.json())
          .then((data: { rows?: { win: 0 | 1; queue_mode: QueueMode }[] }) => [id, data.rows ?? []] as [number, { win: 0 | 1; queue_mode: QueueMode }[]])
      )
    )
      .then(results => { if (!cancelled) setHeroHistoryByMatch(Object.fromEntries(results)); })
      .catch(() => { if (!cancelled) setHeroHistoryByMatch({}); });
    return () => { cancelled = true; };
  }, [recentIdsKey, heroesTick]);

  // Same idea, keyed on this row's map instead of its hero — backs the
  // history strip shown under the map name.
  const [mapHistoryByMatch, setMapHistoryByMatch] = useState<Record<number, { win: 0 | 1; queue_mode: QueueMode }[]>>({});
  useEffect(() => {
    const ids = recentIdsKey ? recentIdsKey.split(',').map(Number) : [];
    if (ids.length === 0) { setMapHistoryByMatch({}); return; }
    let cancelled = false;
    Promise.all(
      ids.map(id =>
        fetch(`/api/matches/${id}/map-history`)
          .then(res => res.json())
          .then((data: { rows?: { win: 0 | 1; queue_mode: QueueMode }[] }) => [id, data.rows ?? []] as [number, { win: 0 | 1; queue_mode: QueueMode }[]])
      )
    )
      .then(results => { if (!cancelled) setMapHistoryByMatch(Object.fromEntries(results)); })
      .catch(() => { if (!cancelled) setMapHistoryByMatch({}); });
    return () => { cancelled = true; };
  }, [recentIdsKey, heroesTick]);

  const [togglingId, setTogglingId] = useState<number | null>(null);
  async function toggleQueueMode(id: number, current: QueueMode) {
    const newMode: QueueMode = current === 'qp_role' ? 'comp_role' : 'qp_role';
    // Comp -> QP is a correction, not a flip: it rolls back this match's
    // stage-test credit (drops its blind_credits row server-side, see
    // syncStageCredits in matches.ts) and pulls it out of Awaiting Stats on
    // the Sens page entirely, since QP games never need aim stats. That's a
    // bigger consequence than the reverse direction, so confirm before doing it.
    if (newMode === 'qp_role' && !window.confirm('Switch this match to Quick Play? It will roll back its stage-test count by 1 and remove it from Awaiting Stats.')) {
      return;
    }
    setTogglingId(id);
    try {
      const res = await fetch(`/api/matches/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queue_mode: newMode }),
      });
      if (!res.ok) throw new Error('mode toggle failed');
      revalidateAll();
    } finally {
      setTogglingId(null);
    }
  }

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
  // The rank answer is required on a ranked match that has a rank to move.
  // With no rank set there is nothing to choose between, so it does not gate
  // — the row says to go set one instead of trapping the form.
  const rankAnswered = isQP || !isFieldEnabled('player_rank') || playerRank == null || rankOutcome != null;
  // Every hero actually played needs an explicit feel answer — an untouched
  // slider must not reach the database at all (see FEEL_MID note above).
  // Bypassed the same way rankAnswered bypasses on QP above: RegistryField
  // gates the slider itself on `isFieldEnabled('feel')` (the field-registry
  // Phase 2 conversion, 2026-09-24), so a user with sens-study turned off
  // sees no slider at all — this form must not then also refuse to let
  // them submit a match over an answer it never showed them.
  const feelsAnswered = !isFieldEnabled('feel') || (playedHeroes.length > 0 && playedHeroes.every(feelAnswered));
  const valid = form.hero && map && form.win !== '' && form.date && displaySens != null && rankAnswered && feelsAnswered;

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
          heroes: switchHeroes.filter(h => h).map(h => ({ hero: h, role: HEROES[h], feel: feelValueFor(h), sens: displaySensForHero(h) })),
          map,
          game_type: mapType,
          win: form.win === '1',
          match_deaths: deathBuffer,
          queue_mode: queueMode,
          sens: displaySens,
          feel: feelValueFor(form.hero),
          team_rating: teamRating,
          match_quality: matchQuality,
          result_driver: resultDriver,
          leaver: leaverSide !== null,
          leaver_side: leaverSide,
          player_rank: isQP ? null : playerRank,
          // Where the ladder stood going in. Carried from the rank the last
          // match on this account+role ended at, so the row records the move
          // itself rather than leaving the chart to infer one by comparing
          // against whichever earlier row it can find.
          player_rank_start: isQP ? null : rankAtLastLog,
          lobby_low: isQP ? null : lobbyLow,
          lobby_high: isQP ? null : lobbyHigh,
          // Unlike rank, the account isn't gated on isQP — who played is a
          // fact about the match regardless of whether the queue has a ladder.
          account,
          notes: form.notes.trim() || null,
        }),
      });
      if (!res.ok) throw new Error('Failed');
      const loggedMode = queueMode;
      const loggedWin = form.win === '1';
      setStatus('success');
      // This match's finishing rank is the next one's starting rank. Written
      // only after the save succeeds — a failed POST must not move the ladder.
      if (!isQP) commitRankAtLastLog(playerRank);
      setRankOutcome(null);
      clearDeathBuffer();
      setFeelByHero({});
      setTeamRating(0);
      setMatchQuality(null);
      setResultDriver(null); setLeaverSide(null);
      // The lobby range deliberately survives the submit. It is a reading of
      // the ladder you are playing in, not a property of the match just
      // logged, and the next lobby is nearly always the same one. Wiping it
      // meant re-placing the bar from scratch every game to record something
      // that had not changed. Now it stays put and gets nudged.
      dateTouched.current = false;
      timeTouched.current = false;
      setForm(f => ({ ...f, hero: '', win: '', notes: '', date: datePart, time: format(new Date(), 'HH:mm') }));
      setSwitchHeroes(['', '']);
      // Clear the carried-over match intent: the Hero Advisor map selector and
      // its dependent advisor reset so nothing lingers from the logged match.
      setMap('');
      // Land exactly where SensNav's "← Match Tracker" (backlog return) lands:
      // the Match section header at the top (2026-09-24, Sean). Standalone
      // /log has no #sec-match, so there it centres the map search instead.
      const matchHeader = document.getElementById('sec-match');
      if (matchHeader) matchHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else document.getElementById('map-search')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Flash the win/loss overlay on the logged mode's tile (the signal also
      // resets Map Voting), then refresh so its win rate rolls to the new value.
      setTimeout(() => notifyMatchLogged({ mode: loggedMode, win: loggedWin }), 550);
      setTimeout(() => {
        revalidateAll();
        revalidateRec();
      }, 1650);
      // Focus the (now reset) Map Voting search once the reset has landed, so
      // the next match's prep is one keystroke away. preventScroll keeps the
      // page on the Match header.
      setTimeout(() => {
        (document.getElementById('map-search') as HTMLInputElement | null)?.focus({ preventScroll: true });
      }, 700);
      setTimeout(() => setStatus('idle'), 2600);
    } catch {
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
  }

  return (
    <div className="mt-6">
      {/* Capture (DeathLogger) and the buffer it fills live in the same card —
          one place for "log a death" and "what I've logged", rather than a
          corner FAB whose popover was too narrow to read at a glance mid-
          respawn. Two columns from lg up: logged history left, picker right,
          so a growing list never pushes the capture control down the screen
          mid-match. Below lg they stack, history first and picker last, which
          keeps that same "new deaths appear above the picker" reading. */}
      {isFieldEnabled('deaths') && (
      <div id="notable-deaths" className="card mb-6 scroll-mt-24" data-inspect-id="logmatch-deaths-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm card-title">Deaths</h2>
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          <div data-inspect-id="logmatch-death-history-column">
          {deathBuffer.length === 0 ? (
            <p className="text-xs text-[var(--faint)]">
              Log each death as it happens — one tap per death.
            </p>
          ) : (
            <div className="space-y-1.5" data-inspect-id="logmatch-death-buffer-list">
              {deathBuffer.map((d, i) => (
                <div key={i} className="flex items-center justify-between gap-2 py-2 px-3 rounded-lg bg-ow-darker border border-ow-border">
                  <div>
                    <span className="text-xs text-[var(--faint-2)] mr-2 font-bold">{i + 1}</span>
                    <span className="text-sm text-[var(--ink)]">{d.killer}</span>
                    <span className="text-xs text-[var(--faint)] ml-2">{d.killer_role}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => toggleDeathUlt(i)}
                      data-inspect-id="logmatch-death-ult-toggle"
                      aria-label={d.ult ? 'Ult kill — tap to unmark' : 'Mark as ult kill'}
                      aria-pressed={d.ult}
                      className={`text-base leading-none transition-opacity ${d.ult ? 'opacity-100' : 'opacity-30 hover:opacity-70'}`}
                    >
                      ⚡
                    </button>
                    <button
                      type="button"
                      onClick={() => removeDeathFromBuffer(i)}
                      className="text-[var(--faint)] hover:text-red-500 transition-colors text-base leading-none px-1"
                      aria-label="Remove"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          </div>

          <div data-inspect-id="logmatch-death-capture-column" className="lg:sticky lg:top-24">
            {registryField('deaths') && <RegistryField field={registryField('deaths')!} />}
          </div>
        </div>
      </div>
      )}

      <div id="match-details" className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card" data-inspect-id="logmatch-match-details-card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm card-title">Match Details</h2>
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
                  setMatchQuality(null);
                  setResultDriver(null); setLeaverSide(null);
                  clearDeathBuffer();
                  notifyMatchLogged();
                  // Wait a paint cycle so the layout has settled from the resets above
                  // (the Map Voting card collapses once its pills clear) before scrolling —
                  // scrolling against the pre-reset layout lands short of the map card.
                  requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                      const mapInput = document.getElementById('map-search') as HTMLInputElement | null;
                      mapInput?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      mapInput?.focus({ preventScroll: true });
                    });
                  });
                }}
                disabled={!form.hero && !map && deathBuffer.length === 0}
                data-inspect-id="logmatch-cancel-match-button"
                className="text-xs text-[var(--faint)] hover:text-red-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-[var(--faint)]"
              >
                Match Cancelled
              </button>
              <button
                type="button"
                onClick={() => { setForm(f => ({ ...f, hero: '', notes: '' })); setSwitchHeroes(['', '']); setMap(''); setFeelByHero({}); setTeamRating(0); setMatchQuality(null); setResultDriver(null); setLeaverSide(null); }}
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
                  return (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setQueueMode(m.value)}
                      // .is-selected supplies the fill and the bottom-lit edge;
                      // --sel tells it which hue to do it in. The flat c.card
                      // fill and the hand-written border are gone, since the
                      // shared class now owns both.
                      style={active ? ({ '--sel': QUEUE_MODE_SEL_RGB[m.value] } as React.CSSProperties) : undefined}
                      className={`relative overflow-hidden py-2 rounded-lg border-2 text-xs font-semibold leading-tight transition-all ${
                        active ? `is-selected mode-fill ${c.accent}` : 'border-transparent text-[var(--faint)] hover:text-[var(--ink)]'
                      }`}
                    >
                      {/* V5/V6 digits carry more side-bearing than QP's letters,
                          so they read looser at the same tracking — tighten them
                          to visually match QP. */}
                      <ModeWatermark
                        mode={m.value}
                        variant="selector"
                        style={m.value === 'qp_role' ? undefined : { letterSpacing: '-0.13em' }}
                        lit={active}
                      />
                      <div className={`relative z-10 font-display italic pr-0.5 ${active ? 'lit-text lit-strong' : ''}`}>{MODE_COMPACT[m.value].top}</div>
                      <div className={`relative z-10 text-[10px] font-normal opacity-80 ${active ? 'lit-text lit-strong' : ''}`}>{MODE_COMPACT[m.value].bot}</div>
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
                              {withDfBadge(withHeroCount(h, heroCounts), dfMap, h)}{heroSens != null && ` @ ${heroSens.toFixed(2)}`}
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
                            {switchOptionsFor(i).filter(([, rl]) => rl === role).map(([hh]) => {
                              const heroSens = displaySensForHero(hh);
                              return (
                                <option key={hh} value={hh} className="uppercase">
                                  {withDfBadge(withHeroCount(hh, heroCounts), dfMap, hh)}{heroSens != null && ` @ ${heroSens.toFixed(2)}`}
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
              {/* Two plain buttons in the app's shared selected style. The
                  sliding fill and the animated chevron insignia that used to
                  live here are retired: the chevrons also collided by name with
                  the new .is-selected class, so the SVG was picking up a border
                  and a gradient meant for buttons. Win keeps teal, Loss keeps
                  pink; --sel carries the hue, .is-selected the treatment. */}
              <div className="grid grid-cols-2 gap-2" data-inspect-id="logmatch-result-buttons">
                {/* Light theme needs the dark end of each ramp: teal-300 on the
                    pale selected fill measures 1.35:1, pink-300 1.61:1 — both
                    invisible. The 700s measure 5.00:1 and 5.36:1. */}
                {[{ v: '1', label: 'Win',  sel: '45 212 191',  text: 'text-teal-700 dark:text-teal-300' },
                  { v: '0', label: 'Loss', sel: '244 114 182', text: 'text-pink-700 dark:text-pink-300' }].map(({ v, label, sel, text }) => {
                  const selected = form.win === v;
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, win: f.win === v ? '' : v as '0' | '1' }))}
                      aria-pressed={selected}
                      data-inspect-id="logmatch-result-option"
                      style={{ '--sel': sel } as React.CSSProperties}
                      className={`h-[3.25rem] rounded-lg border-2 font-display italic font-black text-xl uppercase tracking-wider transition-all ${
                        selected
                          ? `is-selected ${text}`
                          : 'border-ow-border text-[var(--faint)] hover-sel hover:text-[var(--ink)]'
                      }`}
                    >
                      {selected ? <span className="lit-text pr-1">{label}</span> : label}
                    </button>
                  );
                })}
              </div>
              {/* Leaver, moved 2026-09-24 from a square button beside Loss to a
                  sliver strip directly under the Win/Loss row — almost an
                  underline under it, because which team's leaver it was now
                  matters more than the old yes/no did and needed room for a
                  second choice without growing back into a full-size control.
                  Tap the selected side again to clear, same grammar as Match
                  quality / Result driver above. Each bar takes a muted Win/Loss
                  hue (see LeaverSliver's SIDE_HUES). Extracted into LeaverSliver the same
                  day MatchEditDrawer needed the identical control. */}
              <LeaverSliver
                value={leaverSide}
                onToggle={side => setLeaverSide(prev => (prev === side ? null : side))}
                dataInspectPrefix="logmatch-leaver-side"
              />
            </div>

            {isFieldEnabled('notes') && (
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1.5">Main Perceived Factors</label>
                <RegistryField
                  field={registryField('notes')!}
                  value={form.notes}
                  onChange={(v) => setForm(f => ({ ...f, notes: v as string }))}
                  placeholder="fatigue, warmup, just switched stage…"
                />
              </div>
            )}

            {isFieldEnabled('feel') && (
            <div className="space-y-3" data-inspect-id="logmatch-feel-sliders">
              {playedHeroes.map(h => {
                const heroSens = displaySensForHero(h);
                const answered = feelAnswered(h);
                return (
                  <div key={h}>
                    <label className="block text-xs text-[var(--muted)] mb-1.5 flex items-baseline justify-between gap-2">
                      <span>
                        Feel <span className="text-[var(--ink)] font-bold">— {h}{heroSens != null ? ` @ ${heroSens.toFixed(2)}` : ''}</span>
                        <span className="text-[var(--faint-2)]"> — did the sens feel floaty or jittery?</span>
                      </span>
                      {!answered && <span className="text-[10px] font-bold text-ow-accent shrink-0">required</span>}
                    </label>
                    <RegistryField
                      field={registryField('feel')!}
                      value={feelFor(h)}
                      onChange={(v) => setFeelFor(h, v as number)}
                      className={!answered ? 'opacity-50' : ''}
                      ariaLabel={`Feel — floaty to jittery — ${h}`}
                    />
                    {!answered && <p className="text-[10px] text-[var(--faint-2)] mt-0.5">Not touched yet — drag it to answer. Left alone, this match records no feel for {h} rather than a silent 50.</p>}
                    <div className="flex justify-between text-xs text-[var(--muted)] mt-0.5 px-0.5"><span>Floaty</span><span>Snappy</span><span>Jittery</span></div>
                  </div>
                );
              })}
            </div>
            )}

            {isFieldEnabled('team_rating') && (
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1.5">Team <span className="text-[var(--faint-2)]">— how was the team this match?</span></label>
                <RegistryField field={registryField('team_rating')!} value={teamRating} onChange={(v) => setTeamRating(v as number)} />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              {isFieldEnabled('match_quality') && (
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1.5">Match quality</label>
                  <RegistryField
                    field={registryField('match_quality')!}
                    value={matchQuality}
                    onChange={(v) => setMatchQuality(v as typeof matchQuality)}
                    dataInspectId="logmatch-match-quality"
                  />
                </div>
              )}
              {isFieldEnabled('result_driver') && (
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1.5">Result driver</label>
                  <RegistryField
                    field={registryField('result_driver')!}
                    value={resultDriver}
                    onChange={(v) => setResultDriver(v as typeof resultDriver)}
                    dataInspectId="logmatch-result-driver"
                  />
                </div>
              )}
            </div>

            {/* Rank outcome — required, like hero and result.
                A match that moved the ladder and one that did not are
                different facts. Leaving it unanswered used to record "no
                change" silently, which is how a derank goes missing.
                The badge is the live server rank, so pressing a button here
                moves the Pre-Match badge too: rank is one row in
                player_ranks, not a copy per page. Hidden on quickplay. */}
            {!isQP && isFieldEnabled('player_rank') && (
              <RegistryField
                field={registryField('player_rank')!}
                value={{ playerRank, rankAtLastLog, rankOutcome, win: form.win, account, testRole } as RankOutcomeValue}
                onChange={(v) => {
                  const { rankOutcome: ro, playerRank: pr } = v as RankOutcomeChange;
                  setRankOutcome(ro);
                  if (pr != null) setPlayerRank(pr);
                }}
              />
            )}

            <button
              type="submit"
              disabled={!valid || status === 'saving'}
              data-inspect-id="logmatch-log-match-button"
              className="btn-primary w-full py-2.5 text-sm"
              style={{ backgroundImage: 'linear-gradient(to bottom right, rgb(247 147 30 / 0.1), rgb(247 147 30 / 0.04), transparent)' }}
            >
              {status === 'saving' ? 'Saving…' : status === 'success' ? '✓ Saved' : 'Log Match'}
            </button>
            {status === 'error' && <p data-inspect-id="logmatch-save-error-banner" className="text-red-600 text-xs text-center">Failed to save — is the server running?</p>}
          </form>
        </div>

        <div className="card" data-inspect-id="logmatch-todays-matches-card">
          <h2 className="text-sm card-title mb-4">Today's Matches</h2>
          {recent.length > 0 ? (
            <div className="space-y-2" data-inspect-id="logmatch-recently-logged-list">
              {recent.map(r => {
                const expanded = expandedId === r.id;
                const c = QUEUE_MODE_COLORS[r.queue_mode];
                return (
                  <div
                    key={r.id}
                    data-inspect-id="logmatch-todays-matches-card-row"
                    className={`relative overflow-hidden rounded-lg transition-all ${expanded ? `${c.accent} ${c.glow} ring-1 ring-inset` : ''}`}
                  >
                    {/* Header block gets its own relative/overflow-hidden box so the
                        absolutely-positioned watermark stays clipped to the collapsed
                        row instead of re-centering on the whole card once the form
                        expands below — same fix as the Awaiting Stats card on the Sens
                        page. */}
                    <div
                      onClick={() => setExpandedId(expanded ? null : r.id)}
                      className={`relative overflow-hidden flex items-center gap-3 min-h-16 py-2.5 px-3 rounded-lg cursor-pointer transition-colors hover:brightness-110 ${MODE_WASH_CLASS[r.queue_mode]}`}
                    >
                      {/* Oversized W/L result watermark + right-aligned map name — same
                          treatment as the Logged Today card on the Sens page. Queue mode
                          is signaled by this row's background wash (c.card above) instead
                          of a second big watermark glyph competing with this one. */}
                      <span
                        aria-hidden="true"
                        data-inspect-id="logmatch-todays-matches-result-watermark"
                        className={`pointer-events-none select-none absolute top-7 -translate-y-1/2 right-0 text-[7rem] font-display font-black italic leading-none tracking-[-0.07em] whitespace-nowrap opacity-15 ${r.win ? 'translate-x-[20%] text-emerald-500' : 'translate-x-[-15%] text-red-500'}`}
                      >
                        {r.win ? 'W' : 'L'}
                      </span>
                      <div className="relative z-10 flex-1 min-w-0">
                        {(() => {
                          const extra = extraHeroesByMatch[r.id] ?? [];
                          return (
                            <div className="flex items-stretch h-6 min-w-0" title={extra.length > 0 ? extra.map(h => h.hero).join(', ') : undefined}>
                              <span
                                className={`pill hero-name border-2 text-white relative z-10 h-full box-border shadow-[3px_3px_0_rgba(0,0,0,0.7)] w-24 justify-center truncate ${
                                  ROLE_PILL_CLASS[HEROES[r.hero]] ?? ROLE_PILL_CLASS.Support
                                }`}
                              >
                                {r.hero}
                              </span>
                              {/* Hidden mid-match switch heroes rendered as the actual right-edge
                                  slice of a pill (real chamfered corner, not an invented rectangle)
                                  peeking out from behind the primary tag — same treatment as the
                                  Logged Today card on the Sens page. */}
                              {extra.map((h, i) => (
                                <span key={h.hero} aria-hidden="true" className="relative w-3 h-full overflow-hidden ml-px" style={{ zIndex: 5 - i }}>
                                  <span
                                    className={`pill hero-name absolute inset-y-0 right-0 border-2 shadow-[3px_3px_0_rgba(0,0,0,0.7)] ${
                                      (ROLE_PILL_CLASS_DARK[h.role] ?? ROLE_PILL_CLASS_DARK.Support)[i]
                                    }`}
                                    style={{ width: '3.5rem' }}
                                  />
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                        {/* Last 5 matches on this hero, including this one (heroHistoryByMatch,
                            fetched from /api/matches/:id/hero-history) — each a win/loss-colored
                            dash instead of this row's own timestamp/sens, since those already show
                            once the row is expanded. */}
                        <div className="flex items-center gap-1 mt-2 w-24" data-inspect-id="logmatch-todays-matches-hero-history">
                          {(() => {
                            const hist = [...(heroHistoryByMatch[r.id] ?? [])].reverse();
                            return hist.map((h, i) => (
                              <span
                                key={i}
                                style={i === hist.length - 1 ? OLDEST_DASH_FADE_STYLE : undefined}
                                className={`flex-1 h-[3px] rounded-full ${h.win ? 'bg-emerald-500' : 'bg-red-500'}`}
                                title={`${h.win ? 'Win' : 'Loss'} · ${MODE_COMPACT[h.queue_mode]?.top ?? h.queue_mode} ${MODE_COMPACT[h.queue_mode]?.bot ?? ''}`.trim()}
                              />
                            ));
                          })()}
                        </div>
                      </div>
                      {/* Fixed to the card, not the hero column's flow — anchored by absolute
                          left/right offsets (padding + hero pill width on the left, padding +
                          map column width on the right) so it holds its position regardless of
                          how wide the hero column's mid-match-switch peek slices make it. */}
                      <div
                        className="absolute inset-y-0 left-[6.75rem] right-[8.625rem] z-10 flex flex-col items-center justify-center gap-0.5 text-center pointer-events-none"
                        data-inspect-id="logmatch-todays-matches-time-sens"
                      >
                        <span className="text-[11px] text-[var(--faint)]">{r.time ? format(new Date(r.time), 'MMM d, h:mm a') : today}</span>
                        <span className="text-[11px] text-[var(--faint)]">{r.stage_index != null ? <>stage <b className="font-bold">{r.stage_index}</b> · sens <b className="font-bold">{r.sens}</b></> : r.sens != null ? <>sens <b className="font-bold">{r.sens}</b></> : 'no sens'}</span>
                      </div>
                      <div className="relative z-10 flex flex-col items-end shrink-0 self-center mr-1.5 w-[7.5rem]">
                        <span className="text-xs map-name text-[var(--ink)] text-right leading-tight whitespace-normal break-words">{r.map}</span>
                        {/* Last 5 matches on this map, including this one (mapHistoryByMatch,
                            fetched from /api/matches/:id/map-history) — same win/loss-colored
                            dash treatment as the hero history strip above. */}
                        <div className="flex items-center gap-1 mt-2 w-24" data-inspect-id="logmatch-todays-matches-map-history">
                          {(() => {
                            const hist = [...(mapHistoryByMatch[r.id] ?? [])].reverse();
                            return hist.map((h, i) => (
                              <span
                                key={i}
                                style={i === hist.length - 1 ? OLDEST_DASH_FADE_STYLE : undefined}
                                className={`flex-1 h-[3px] rounded-full ${h.win ? 'bg-emerald-500' : 'bg-red-500'}`}
                                title={`${h.win ? 'Win' : 'Loss'} · ${MODE_COMPACT[h.queue_mode]?.top ?? h.queue_mode} ${MODE_COMPACT[h.queue_mode]?.bot ?? ''}`.trim()}
                              />
                            ));
                          })()}
                        </div>
                      </div>
                    </div>
                    {expanded && (
                      <div className={`border-t border-ow-border px-3 py-3 ${c.card}`} data-inspect-id="logmatch-inline-edit-form">
                        <TodayMatchEditForm
                          key={r.id}
                          match={r}
                          heroCounts={heroCounts}
                          mapCounts={mapCounts}
                          onDone={() => { setExpandedId(null); setHeroesTick(t => t + 1); }}
                          toggleQueueMode={toggleQueueMode}
                          togglingId={togglingId}
                        />
                      </div>
                    )}
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

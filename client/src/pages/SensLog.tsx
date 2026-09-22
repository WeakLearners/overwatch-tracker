import { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useApi, revalidateAll } from '../hooks/useApi';
// Per-hero stat-slot labels — shared with SensAnalysis so a label travels
// with its data instead of living only in this form. See lib/heroStatLabels.
import { EXTRA_ACC_LABEL, RAW_STAT_FIELDS, critSlot, overallSlot, hasCrit } from '../lib/heroStatLabels';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { eDPI, MOUSE_DPI } from '../lib/aim';
import {
  QueueMode, QUEUE_MODE_COLORS, MODE_WASH_CLASS, HEROES, ROLE_PILL_CLASS, ROLE_PILL_CLASS_DARK,
  MODE_COMPACT, OLDEST_DASH_FADE_STYLE,
} from '../types';
import { format } from 'date-fns';
import SensNav from '../components/SensNav';
import { parseLutString, formatLut } from '../lib/lut';

// ── Types ────────────────────────────────────────────────────────────────────
interface PendingMatch {
  id: number; date: string; time: string | null;
  hero: string; role: string; map: string; game_type: string;
  queue_mode: QueueMode; win: 0 | 1; sens: number | null;
  stage_index?: number | null;
  // Every hero actually played this match, slot order (slot 1 = hero/role
  // above) — a match with a mid-match switch has more than one. Each hero's
  // own sens (match_heroes.sens) — a real per-hero value in Overwatch, not
  // just the match-level `sens` above, which is only slot 1's — null when a
  // historical switch-hero row couldn't be reconstructed (see schema.ts).
  heroes: { hero: string; role: string; sens: number | null }[];
}
// A match that already has aim stats saved today — /api/aim/today's shape.
// Mirrors PendingMatch (same heroes[] ordering) plus the saved combat totals
// and per-hero accuracy needed to prefill an edit.
interface LoggedHeroAcc {
  hero: string; overall_acc: number | null; crit_acc: number | null; extra_acc: number | null;
  torpedo_damage: number | null; torpedo_healing: number | null; duration_min: number | null;
}
interface LoggedMatch extends PendingMatch {
  elims: number | null; deaths: number | null; damage: number | null; healing: number | null; assists: number | null;
  heroAcc: LoggedHeroAcc[];
}
// A stage-trial set as returned by /api/blind/state. Several can be active at
// once — one per hero, plus at most one ad-hoc (hero-less) set — so the UI
// renders a card per entry rather than assuming a single global test.
interface DpiTestActive {
  set_id: number; in_game_sens: number; base_dpi: number; created_at: string;
  batch_size: number; cur_stage: number; games_on_stage: number;
  dpi: number | null; sens: number | null; n_stages: number;
  hero: string | null; phase: string | null; totalGames: number; completed: boolean;
  needSwitch: boolean;
  stages: { stage_index: number; dpi: number; sens: number | null }[];
  curveEnabled: boolean;
}
interface DpiTestState {
  actives: DpiTestActive[];
}
interface DpiTestSetSummary {
  set_id: number; hero: string | null; phase: string | null; active: boolean; completed: boolean;
  batch_size: number; n_stages: number; totalGames: number; created_at: string;
  values: number[];
}
interface AnswerStage {
  stage_index: number; dpi: number; sens: number | null; pct_delta: number;
  eDPI: number; cm360: number; n: number; feelMean: number | null; feelVar: number | null;
  games: number; winRate: number | null; accMean: number | null; elimsPer10: number | null; dmgPer10: number | null;
}
// One overall/crit accuracy + duration reading per hero actually played — a
// match with a mid-match switch gets one row per hero here instead of a
// single match-wide number (duration especially: a switch can leave one hero
// on-screen for 2 minutes and another for 15).
interface HeroAccStat {
  hero: string; overall_acc: string; crit_acc: string; extra_acc: string;
  torpedo_damage: string; torpedo_healing: string; duration_min: string;
}
interface StatFieldsT {
  heroAcc: HeroAccStat[];
  elims: string; deaths: string; damage: string; healing: string; assists: string;
}

const emptyStats = (heroes: { hero: string }[]): StatFieldsT => ({
  heroAcc: heroes.map(h => ({
    hero: h.hero, overall_acc: '', crit_acc: '', extra_acc: '',
    torpedo_damage: '', torpedo_healing: '', duration_min: '',
  })),
  elims: '', deaths: '', damage: '', healing: '', assists: '',
});

const num = (s: string) => (s.trim() === '' ? null : parseFloat(s));
// Seeds a per-hero sens input map from a match's own heroes[] — each hero's
// existing match_heroes.sens value (blank when null, e.g. an unreconstructed
// historical switch-hero row — see schema.ts's match_heroes.sens comment).
const heroSensFromMatch = (m: PendingMatch): Record<string, string> =>
  Object.fromEntries(m.heroes.map(h => [h.hero, h.sens != null ? String(h.sens) : '']));
// Builds the sens portion of a stats-backfill PUT body: `sens` corrects
// slot 1 (matches.sens' column of record) same as always, `heroSens` carries
// any additional hero's own value — omitted entirely for the common
// single-hero match so the PUT body doesn't grow for the 95% case.
const heroSensBody = (m: PendingMatch, heroSens: Record<string, string>) => ({
  sens: num(heroSens[m.heroes[0]?.hero] ?? ''),
  ...(m.heroes.length > 1 ? {
    heroSens: Object.fromEntries(
      m.heroes.slice(1).map(h => [h.hero, num(heroSens[h.hero] ?? '')]).filter((e): e is [string, number] => e[1] != null),
    ),
  } : {}),
});
// Duration is entered as m:ss (e.g. "4:32", "12:01") rather than decimal
// minutes — easier to read off the in-game match timer than converting.
const parseDurationMin = (s: string): number | null => {
  const m = s.trim().match(/^(\d{1,3}):([0-5]\d)$/);
  return m ? parseInt(m[1], 10) + parseInt(m[2], 10) / 60 : null;
};
// Inverse of parseDurationMin, for prefilling an edit form from the decimal
// minutes stored server-side.
const formatDurationMin = (mins: number | null): string => {
  if (mins == null) return '';
  let m = Math.floor(mins);
  let sec = Math.round((mins - m) * 60);
  if (sec === 60) { sec = 0; m += 1; }
  return `${m}:${String(sec).padStart(2, '0')}`;
};
// Rehydrates a logged match's saved stats into the editable string shape
// StatFields expects.
const statsFromLogged = (m: LoggedMatch): StatFieldsT => ({
  heroAcc: m.heroes.map(h => {
    const a = m.heroAcc.find(ha => ha.hero === h.hero);
    return {
      hero: h.hero,
      overall_acc: a?.overall_acc != null ? String(a.overall_acc) : '',
      crit_acc: a?.crit_acc != null ? String(a.crit_acc) : '',
      extra_acc: a?.extra_acc != null ? String(a.extra_acc) : '',
      torpedo_damage: a?.torpedo_damage != null ? String(a.torpedo_damage) : '',
      torpedo_healing: a?.torpedo_healing != null ? String(a.torpedo_healing) : '',
      duration_min: formatDurationMin(a?.duration_min ?? null),
    };
  }),
  elims: m.elims != null ? String(m.elims) : '',
  deaths: m.deaths != null ? String(m.deaths) : '',
  damage: m.damage != null ? String(m.damage) : '',
  healing: m.healing != null ? String(m.healing) : '',
  assists: m.assists != null ? String(m.assists) : '',
});
const field = 'w-full field px-3 py-2 text-sm num-display';
const compactField = 'w-full field px-2 py-1 text-xs num-display';
const btnSecondary = 'border border-ow-border rounded-lg text-[var(--ink)] font-semibold hover:border-gray-500 transition-all disabled:opacity-40 disabled:cursor-not-allowed';

// ── Shared aim-stat inputs (used by both the stage-trial loop and the backfill form) ─
function StatFields({ s, upd, updHeroAcc, showHealing, firstDurationRef, heroSens }: {
  s: StatFieldsT; upd: <K extends Exclude<keyof StatFieldsT, 'heroAcc'>>(k: K, v: StatFieldsT[K]) => void;
  updHeroAcc: (i: number, k: 'overall_acc' | 'crit_acc' | 'extra_acc' | 'torpedo_damage' | 'torpedo_healing' | 'duration_min', v: string) => void;
  showHealing: boolean;
  firstDurationRef?: React.RefObject<HTMLInputElement>;
  heroSens?: Record<string, string>;
}) {
  const t = (k: Exclude<keyof StatFieldsT, 'heroAcc'>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => upd(k, e.target.value as never);
  const combatFields = showHealing
    ? ([['elims', 'Elims'], ['assists', 'Assists'], ['deaths', 'Deaths'], ['damage', 'Damage'], ['healing', 'Healing']] as const)
    : ([['elims', 'Elims'], ['deaths', 'Deaths'], ['damage', 'Damage']] as const);
  return (
    <>
      {/* One overall/crit accuracy + duration row per hero played — most
          matches are one row (no switch), but a mid-match switch gets a row
          per hero, since time-on-hero varies switch to switch. */}
      <div className="space-y-3" data-inspect-id="sl-hero-acc-inputs">
        {s.heroAcc.map((h, i) => {
          const extraLabel = EXTRA_ACC_LABEL[h.hero];
          const showCrit = hasCrit(h.hero);
          const critLabels = critSlot(h.hero);
          const rawFields = RAW_STAT_FIELDS[h.hero] ?? [];
          const cols = 2 + (showCrit ? 1 : 0) + (extraLabel ? 1 : 0) + rawFields.length;
          return (
          <div key={h.hero}>
            <div className="flex items-baseline justify-between text-xs hero-name text-[var(--ink)] mb-1.5">
              <span>{h.hero}</span>
              {(() => {
                const sens = parseFloat(heroSens?.[h.hero] ?? '');
                return sens > 0 ? (
                  <span className="text-[var(--ink)] font-normal normal-case tracking-normal">
                    {sens.toFixed(2)} @ {MOUSE_DPI} (eDPI {Math.round(eDPI(sens))})
                  </span>
                ) : null;
              })()}
            </div>
            <div className={`grid gap-3 ${cols === 5 ? 'grid-cols-5' : cols === 4 ? 'grid-cols-4' : cols === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1.5">Duration <span className="text-ow-accent">*</span></label>
                <input
                  ref={i === 0 ? firstDurationRef : undefined}
                  type="text" inputMode="numeric" value={h.duration_min}
                  onChange={e => updHeroAcc(i, 'duration_min', e.target.value)}
                  data-inspect-id="sl-hero-duration-input"
                  className={`${field} num-display ${parseDurationMin(h.duration_min) != null ? '' : 'ring-1 ring-ow-accent/60'}`}
                  placeholder="m:ss" aria-label={`${h.hero} duration, minutes:seconds`} required
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1.5">{overallSlot(h.hero).label}</label>
                <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={h.overall_acc} onChange={e => updHeroAcc(i, 'overall_acc', e.target.value)} data-inspect-id="sl-overall-acc-input" className={field} placeholder="e.g. 41.2" aria-label={`${h.hero} ${overallSlot(h.hero).aria} %`} />
              </div>
              {showCrit && (
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1.5">{critLabels.label}</label>
                  <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={h.crit_acc} onChange={e => updHeroAcc(i, 'crit_acc', e.target.value)} data-inspect-id="sl-crit-acc-input" className={field} placeholder="e.g. 22.5" aria-label={`${h.hero} ${critLabels.aria} %`} />
                </div>
              )}
              {extraLabel && (
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1.5">{extraLabel}</label>
                  <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={h.extra_acc} onChange={e => updHeroAcc(i, 'extra_acc', e.target.value)} data-inspect-id="sl-extra-acc-input" className={field} placeholder="e.g. 18.0" aria-label={`${h.hero} ${extraLabel}`} />
                </div>
              )}
              {rawFields.map(rf => (
                <div key={rf.key}>
                  <label className="block text-xs text-[var(--muted)] mb-1.5">{rf.label}</label>
                  <input type="number" step="1" min="0" inputMode="numeric" value={h[rf.key]} onChange={e => updHeroAcc(i, rf.key, e.target.value)} data-inspect-id={`sl-${rf.key.replace('_', '-')}-input`} className={field} placeholder="e.g. 2400" aria-label={`${h.hero} ${rf.label}`} />
                </div>
              ))}
            </div>
          </div>
          );
        })}
      </div>
      <div>
        <label className="block text-xs text-[var(--muted)] mb-1.5">Combat <span className="text-[var(--faint-2)]">— endgame scoreboard</span></label>
        <div className={`grid gap-2 ${showHealing ? 'grid-cols-5' : 'grid-cols-3'}`} data-inspect-id="sl-combat-stats-inputs">
          {combatFields.map(([key, lbl]) => (
            <div key={key}>
              <input type="number" min="0" step="1" inputMode="numeric" value={s[key]} onChange={t(key)} className="w-full field px-2 py-2 text-sm num-display" placeholder="0" aria-label={lbl} />
              <div className="text-[10px] text-[var(--faint-2)] text-center mt-1">{lbl}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

const statsBody = (match_id: number, s: StatFieldsT) => ({
  match_id,
  heroes: s.heroAcc.map(h => ({
    hero: h.hero, overall_acc: num(h.overall_acc), crit_acc: num(h.crit_acc),
    extra_acc: num(h.extra_acc), torpedo_damage: num(h.torpedo_damage),
    torpedo_healing: num(h.torpedo_healing), duration_min: parseDurationMin(h.duration_min),
  })),
  elims: num(s.elims), deaths: num(s.deaths), damage: num(s.damage), healing: num(s.healing), assists: num(s.assists),
});

export default function SensLog() {
  const { data: dpiState } = useApi<DpiTestState>('/api/blind/state');
  const { data: pendingData, loading } = useApi<{ rows: PendingMatch[] }>('/api/aim/pending?limit=40');
  const pending = pendingData?.rows ?? [];
  // This page always opens at the top, however it was reached. It used to
  // deep-link into the backlog when arriving from Prematch's "Go →", which
  // dropped the user mid-page with the curve params and the header scrolled
  // off. A single-page app keeps the old scroll position across a route
  // change, so landing at the top has to be asked for explicitly.
  useEffect(() => { window.scrollTo(0, 0); }, []);

  return (
    <div className="mt-2">
      <SensNav dataInspectId="sl-nav" />
      <div className="mb-6">
        <h1 data-inspect-id="sl-header-title" className="text-2xl heading-display text-[var(--ink)]">Sensitivity Study</h1>
        <p className="text-sm text-[var(--faint)] mt-1">Enter each match's combat details here after the game. DPI stage trials are driven from the panel below and land in the same queue.</p>
      </div>

      <CurveParamsCard />

      <BackfillPanel pending={pending} loading={loading} />

      <div className="mt-10 pt-8 border-t border-ow-border">
        <h2 data-inspect-id="sl-header-stage-trials" className="text-sm card-title mb-1">Sens stage trials</h2>
        <p className="text-xs text-[var(--faint)] mb-4">Mouse DPI is locked at 1600 permanently — set your in-game sens to the value shown, play a batch, switch to the next stage. Log each game in the Match Tracker — it auto-tags to your current stage and queues up above for its combat details. Heroes can be tested in parallel — start as many as you like at once.</p>
        <PlanCard tabs={PLAN_TABS} state={dpiState} />
        <TestPanel state={dpiState} />
      </div>
    </div>
  );
}

interface CurveParams {
  smooth: number; input: number; output: number;
  lutSteps: number | null; lutMaxSpeed: number | null; lutPoints: [number, number][] | null;
}
// smooth/input/output stay in the type because PUT /curve still requires
// them and the editor round-trips them untouched. They are no longer shown or
// edited anywhere: the Jump grid was removed 2026-09-20 as useless, since
// nothing seeds from it and nothing is stamped on a match from it.

// The lookup table, as a row of editable points.
//
// Each point is two boxes: the speed you are moving the mouse at (counts per
// millisecond) and what your sensitivity gets multiplied by once you reach it.
// A table is just that pair, repeated, and Rawaccel draws the staircase
// between them. So the honest control is the pairs themselves, not a smooth
// curve's parameters that happen to pass near them.
//
// Nothing here generates or approximates a table. That matters more than it
// sounds: matches.curve_lut reads as "what this match ran under," and a
// plausible-looking invented table sitting in that column is precisely the
// confound the analysis page exists to warn about.
//
// lutSteps and lutMaxSpeed are derived on save, never typed. The server
// requires steps to equal the point count and max speed to be the largest
// speed in the table, so a box for either could only ever disagree with the
// rows above it.
type LutRow = { x: string; y: string };

const rowsFromPoints = (pts: [number, number][] | null): LutRow[] =>
  pts ? pts.map(([x, y]) => ({ x: String(x), y: String(y) })) : [{ x: '1', y: '1' }, { x: '40', y: '1' }];

const rowsToString = (rows: LutRow[]) => rows.map(r => `${r.x.trim()},${r.y.trim()}`).join('; ');

// Sized to the number, not to the column. A speed tops out around 140 and a
// multiplier around 1.1, so five characters covers every value either box
// will ever hold; a full-width field would be mostly empty space. Plain text
// with a decimal keypad rather than type=number, whose spinner arrows would
// cost more width than the digits do.
const lutCell = 'w-[4.5ch] bg-transparent text-xs num-display text-[var(--ink)] text-center outline-none';

function LutEditor({ data }: { data: CurveParams }) {
  const [rows, setRows] = useState<LutRow[]>(() => rowsFromPoints(data.lutPoints));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [paste, setPaste] = useState('');

  // Re-sync when the saved table changes underneath (another tab, or this
  // editor's own save landing). Keyed on the stored value, so typing in the
  // boxes never triggers it.
  const savedKey = data.lutPoints ? formatLut(data.lutPoints) : '';
  useEffect(() => { setRows(rowsFromPoints(data.lutPoints)); }, [savedKey]);

  // One validator for both entry paths — the boxes and the paste box are just
  // two ways of producing the same text.
  const parsed = parseLutString(rowsToString(rows));
  const parseError = 'error' in parsed ? parsed.error : null;
  const points = 'points' in parsed ? parsed.points : null;
  const dirty = rowsToString(rows) !== rowsToString(rowsFromPoints(data.lutPoints)) || !data.lutPoints;

  const setCell = (i: number, k: keyof LutRow, v: string) =>
    setRows(rs => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  async function put(body: Partial<CurveParams>) {
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/aim/curve', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, ...body }),
      });
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? 'Save failed'); return false; }
      revalidateAll();
      return true;
    } finally { setSaving(false); }
  }

  const save = () => points && put({
    lutPoints: points, lutSteps: points.length, lutMaxSpeed: Math.max(...points.map(([x]) => x)),
  });

  // Copies in Rawaccel's own tight form so it can go straight into its LUT
  // field. Copies what is on screen, not what is saved — after tuning a point
  // the whole reason to copy is to carry the NEW table over to Rawaccel.
  async function copyTable() {
    if (!points) return;
    try {
      await navigator.clipboard.writeText(formatLut(points, ';'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not reach the clipboard.');
    }
  }

  function applyPaste() {
    const r = parseLutString(paste);
    if ('error' in r) { setError(r.error); return; }
    setRows(rowsFromPoints(r.points));
    setPasting(false); setPaste(''); setError(null);
  }

  return (
    <div data-inspect-id="sl-lut-editor">
      <p className="text-[10px] uppercase tracking-wide text-[var(--faint-2)] mb-1">speed (counts/ms), multiplier</p>
      <div className="flex flex-wrap gap-1.5 mb-2" data-inspect-id="sl-lut-rows">
        {rows.map((r, i) => (
          <div
            key={i} data-inspect-id="sl-lut-row"
            className="inline-flex items-center rounded-md bg-ow-darker border border-ow-border pl-1.5 pr-0.5 py-0.5 focus-within:border-gray-500"
          >
            <input
              value={r.x} onChange={e => setCell(i, 'x', e.target.value)}
              inputMode="decimal" size={1} aria-label={`Point ${i + 1} speed`}
              data-inspect-id="sl-lut-row-x" className={lutCell}
            />
            <span className="text-[var(--faint-2)] text-xs px-px">,</span>
            <input
              value={r.y} onChange={e => setCell(i, 'y', e.target.value)}
              inputMode="decimal" size={1} aria-label={`Point ${i + 1} multiplier`}
              data-inspect-id="sl-lut-row-y" className={lutCell}
            />
            <button
              type="button" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}
              disabled={rows.length <= 2} title={rows.length <= 2 ? 'A table needs at least 2 points' : 'Remove this point'}
              data-inspect-id="sl-lut-row-remove-btn"
              className="text-[var(--faint-2)] hover:text-red-400 disabled:opacity-0 px-1 text-[11px] leading-none"
            >×</button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
        <button
          type="button" data-inspect-id="sl-lut-add-row-btn"
          onClick={() => setRows(rs => [...rs, { x: String(Number(rs[rs.length - 1]?.x || 0) + 10), y: rs[rs.length - 1]?.y ?? '1' }])}
          disabled={rows.length >= 32} className={`${btnSecondary} px-2 py-0.5 text-[10px]`}
        >+ Add point</button>
        <button
          type="button" onClick={() => setPasting(v => !v)}
          data-inspect-id="sl-lut-paste-toggle-btn" className={`${btnSecondary} px-2 py-0.5 text-[10px]`}
        >{pasting ? 'Close paste' : 'Paste from Rawaccel'}</button>
        <button
          type="button" onClick={copyTable} disabled={!points}
          title={points ? "Copy in Rawaccel's format" : 'Fix the table first'}
          data-inspect-id="sl-lut-copy-btn" className={`${btnSecondary} px-2 py-0.5 text-[10px]`}
        >{copied ? 'Copied' : 'Copy'}</button>
        {dirty && (
          <button
            type="button" onClick={save} disabled={saving || !points}
            data-inspect-id="sl-lut-save-btn" className={`${btnSecondary} px-2 py-0.5 text-[10px] text-ow-accent`}
          >{saving ? '…' : 'Save table'}</button>
        )}
        {dirty && data.lutPoints && (
          <button
            type="button" onClick={() => { setRows(rowsFromPoints(data.lutPoints)); setError(null); }} disabled={saving}
            data-inspect-id="sl-lut-revert-btn" className="text-[10px] text-[var(--faint-2)] hover:text-[var(--ink)] px-1"
          >Revert</button>
        )}
        {data.lutPoints && !dirty && (
          <button
            type="button" onClick={() => put({ lutPoints: null })} disabled={saving}
            data-inspect-id="sl-lut-clear-btn" className="text-[10px] text-[var(--faint-2)] hover:text-red-400 px-1 ml-auto"
          >Clear table</button>
        )}
      </div>

      {pasting && (
        <div className="mb-1.5" data-inspect-id="sl-lut-paste">
          <textarea
            value={paste} onChange={e => setPaste(e.target.value)} autoFocus rows={2}
            placeholder="1,1; 16,1; 16.1,1.02; 32,1.02; 32.1,1.1; 140,1.1"
            data-inspect-id="sl-lut-paste-input" className={`${compactField} mb-1`}
          />
          <button
            type="button" onClick={applyPaste} disabled={!paste.trim()}
            data-inspect-id="sl-lut-paste-apply-btn" className={`${btnSecondary} px-2 py-0.5 text-[10px]`}
          >Fill the rows</button>
        </div>
      )}

      {parseError
        ? <p className="text-xs text-red-400" data-inspect-id="sl-lut-parse-error">{parseError}</p>
        : points && <p className="text-[10px] text-[var(--faint-2)]" data-inspect-id="sl-lut-summary">
            {points.length} points, up to {Math.max(...points.map(([x]) => x))} counts/ms
            {dirty && <span className="text-amber-600 dark:text-amber-400"> — unsaved</span>}
          </p>}
      {error && <p className="text-xs text-red-400 mt-1" data-inspect-id="sl-lut-save-error">{error}</p>}
    </div>
  );
}

// The Rawaccel lookup table card. One live setting — not staged, not
// per-hero, not per-phase — applied on top of whatever per-hero sens is
// active, and stamped on every match logged while it is on file.
//
// Two things were removed on 2026-09-20 and should not come back.
//
// The Jump grid (smooth/input/output) went because it was useless: Sean is on
// a lookup table, nothing seeds from those three any more, and nothing is
// stamped on a match from them. They stay in the type only because PUT
// /curve still requires them; the editor round-trips them untouched.
//
// The stage-test lock went with it. It existed to stop those three changing
// mid-test, back when they WERE the live config and an edit would silently
// change what a test was measuring. They are not the live config now, so the
// lock guarded nothing. The table itself is deliberately NOT locked either —
// a retune mid-test is a real event, and recording it as its own curve
// variant is the point of matches.curve_lut.
function CurveParamsCard() {
  const { data } = useApi<CurveParams>('/api/aim/curve');
  if (!data) return null;
  return (
    <div className="card mb-6" data-inspect-id="sl-curve-params-card">
      <div className="flex items-start justify-between mb-1">
        <h2 className="text-sm card-title">Rawaccel lookup table</h2>
        {data.lutPoints
          ? <span data-inspect-id="sl-lut-on-file-badge" className="text-[10px] text-[var(--faint-2)]">{data.lutPoints.length} points on file</span>
          : <span data-inspect-id="sl-lut-missing-badge" className="text-[10px] text-amber-600 dark:text-amber-400">no table on file</span>}
      </div>
      <p className="text-xs text-[var(--faint)] mb-3">
        The points Rawaccel is actually running: at each mouse speed, what your sens gets multiplied by. Every match
        you log while a table is saved records exactly these, so a retune shows up in the analysis as its own row
        instead of blending into the old one. With no table saved, a match records only that acceleration was on.
      </p>
      <LutEditor data={data} />
    </div>
  );
}

// ── Phase 2 test plan (reference card) ──────────────────────────────────────
// Static reference for the current round of per-hero test blocks — set up a
// test set per hero using these exact DPIs and games/slot. Update this list
// when the plan changes; it's not derived from live data.
const PHASE2_PLAN = [
  { hero: 'Sojourn', archetype: 'Hitscan', dpis: [1500, 1600, 1700], gamesPerSlot: 12, note: 'Clean curve — drop both weak extremes.' },
  { hero: 'Shion', archetype: 'Hitscan', dpis: [1600, 1700, 1750], gamesPerSlot: 12, note: 'Nearly flat in Phase 1 — confirm/kill, not a search for a winner.' },
  { hero: 'Tracer', archetype: 'Hitscan', dpis: [1500, 1600, 1750], gamesPerSlot: 12, note: 'Noisy, bimodal on thin data — real exploration.' },
  { hero: 'Pharah', archetype: 'Projectile', dpis: [1450, 1500, 1750], gamesPerSlot: 12, note: 'Same bimodal shape, thinnest data of the four.' },
] as const;

// ── Phase 3 test plan (reference card) ──────────────────────────────────────
// Tighter two-stage follow-up per hero, built from the Phase 2 results: each
// hero gets exactly the two DPI stages that resolve its own open question,
// 12 games apiece.
const PHASE3_PLAN = [
  {
    hero: 'Sojourn', archetype: 'Hitscan', dpis: [1500, 1750], gamesPerSlot: 12,
    note: 'Accuracy is flat for her — head-to-head at matched n between the solid baseline (1500) and the thin high-win-rate outlier (1750) settles whether that edge is real.',
  },
  {
    hero: 'Shion', archetype: 'Hitscan', dpis: [1750, 1850], gamesPerSlot: 12,
    note: "Accuracy and consistency both still climbing at the fastest tested scale — confirm 1750 and push a stage past it to see if the trend continues.",
  },
  {
    hero: 'Tracer', archetype: 'Hitscan', dpis: [1450, 1700], gamesPerSlot: 12,
    note: 'Backfill the two thin scales (both under n=8) flanking her 1500 accuracy peak before trusting the dip between them.',
  },
  {
    hero: 'Pharah', archetype: 'Projectile', dpis: [1500, 1750], gamesPerSlot: 12,
    note: 'Tie-break her two strongest, already-solid edges — skip the thin, likely-losing middle band.',
  },
] as const;

// ── Phase 4 test plan (reference card) ───────────────────────────────────────
// Narrow bracket around each hero's Phase 3 leader (0.4×win% + 0.4×acc% +
// 0.2×secondary-stat weighting), 5 games/stage instead of 12 — switching to
// Competitive since QP win% proved too unreliable (bad teammates, ~30-40% of
// matches) to trust at the narrower gap.
//
// Sojourn's set is already in flight (started 2026-08-05, DPI-varying —
// values left as the DPIs it's actually running: 1700/1800) and stays that
// way to completion. Mouse DPI locked at 1600 permanently 2026-08-08 — the
// mouse config app floored DPI changes at 50-unit steps, too coarse to
// narrow further, so every hero that hadn't started yet (Pharah, Shion,
// Tracer) switched to varying in-game sens instead, which has no such floor.
// Their values below are the exact same eDPI targets their old ±50 DPI
// brackets were approximating, expressed as sens = (dpi × 2.5) / 1600.
const PHASE4_PLAN = [
  {
    hero: 'Sojourn', archetype: 'Hitscan', dpis: [1700, 1800], gamesPerSlot: 5,
    note: 'Phase 3 leaned 1750 on win%/hero-stat, but ~half that win-rate gap turned out to be map-mix, not DPI — hold this one loosely. Already in flight on DPI; finishing as started.',
  },
  {
    hero: 'Pharah', archetype: 'Projectile', senses: [2.27, 2.42], gamesPerSlot: 5,
    note: "75%-vs-42% swing toward 1500 in Phase 3 survived a map-mix check better than Sojourn's did, but acc/hero-stat still favor 1750 — the most contested pick of the four. Same eDPI target as the old 1450/1550 DPI bracket, via sens now.",
  },
  {
    hero: 'Shion', archetype: 'Hitscan', senses: [2.66, 2.81], gamesPerSlot: 5,
    note: 'Cleanest Phase 3 signal — win%, acc, crit%, and kills all agreed on 1750, and it held up after adjusting for map mix. Also matches the DPI you said you were hating (1850) losing decisively. Same eDPI target as the old 1700/1800 DPI bracket, via sens now.',
  },
  {
    hero: 'Tracer', archetype: 'Hitscan', senses: [2.58, 2.73], gamesPerSlot: 5,
    note: 'Phase 3 was a near-exact tie on the weighted score — 1700 edges it only on Pulse Bomb Attach% and elims. Basically a coin flip; this round is to break it. Same eDPI target as the old 1650/1750 DPI bracket, via sens now.',
  },
  // New for 2026-08-08: every other hero with >=5 games logged (2026-08-08
  // snapshot), added straight into Phase 4 rather than a new phase — none of
  // these went through Phase 2/3, so there's no measured eDPI target to
  // reproduce. Brackets below are a best guess from archetype alone: tighter,
  // higher-sens pairs for hitscan/precision heroes (in Sojourn/Shion/Tracer's
  // range), lower/wider pairs for arcing-projectile support heroes (in
  // Pharah's range).
  {
    hero: 'Ana', archetype: 'Projectile', senses: [2.20, 2.35], gamesPerSlot: 5,
    note: '253 games logged, no prior phase data — best guess. Biotic Rifle darts arc and reward precision over raw flick speed, so starting lower like Pharah rather than the hitscan trio.',
  },
  {
    hero: 'Juno', archetype: 'Projectile', senses: [2.35, 2.50], gamesPerSlot: 5,
    note: '179 games logged, no prior phase data — best guess. Pulsar Torpedoes home in flight, so precision matters less than Ana\'s darts — split the difference between the projectile and hitscan brackets.',
  },
  {
    hero: 'Soldier: 76', archetype: 'Hitscan', senses: [2.50, 2.65], gamesPerSlot: 5,
    note: '55 games logged, no prior phase data — best guess. Straightforward hitscan rifle, no falloff quirks — centered on the mid-to-upper end of the hitscan trio\'s range.',
  },
  {
    hero: 'Kiriko', archetype: 'Projectile', senses: [2.55, 2.70], gamesPerSlot: 5,
    note: "44 games logged, no prior phase data — best guess. Kunai travel fast and flat enough to play like hitscan in practice, so bracketed closer to Shion/Tracer than the slower support projectiles.",
  },
  {
    hero: 'Zenyatta', archetype: 'Projectile', senses: [2.05, 2.20], gamesPerSlot: 5,
    note: "30 games logged, no prior phase data — best guess. Slowest-traveling projectile of the group and mostly played at range/stationary — lowest sens bracket here.",
  },
  {
    hero: 'Reaper', archetype: 'Hitscan', senses: [2.65, 2.80], gamesPerSlot: 5,
    note: "12 games logged, no prior phase data — best guess. Shotgun spread forgives imprecision and he's played up close, where faster turns matter more than fine aim — highest sens bracket of the DPS heroes.",
  },
  {
    hero: 'Cassidy', archetype: 'Hitscan', senses: [2.40, 2.55], gamesPerSlot: 5,
    note: "10 games logged, no prior phase data — best guess. Revolver plays at mid-range with a fair bit of precision aim — centered on the hitscan trio's range.",
  },
  {
    hero: 'Baptiste', archetype: 'Projectile', senses: [2.25, 2.40], gamesPerSlot: 5,
    note: "9 games logged, no prior phase data — best guess. Burst-round projectiles reward precision similarly to Ana's darts — same low-end bracket.",
  },
] as const;

// ── Phase 5 test plan (reference card) ───────────────────────────────────────
// Same 12-hero roster as Phase 4, each narrowed to a fresh 0.1-sens bracket
// (tightened down from Phase 4's 0.15 gap). Narrowing is driven by win%,
// accuracy, elims/min, and dmg/min from each hero's completed Phase 4
// set — NOT by in-session feel rating, which only measures fast-vs-slow
// preference and was explicitly ruled out as a signal for "which sens
// performs better." Sojourn and Shion drop their DPI-varying carve-out and
// move onto the standard locked-1600-DPI/sens convention like everyone else,
// now that Sojourn's in-flight set (the reason for the carve-out) is done.
const PHASE5_PLAN = [
  {
    hero: 'Sojourn', archetype: 'Hitscan', senses: [2.56, 2.66], gamesPerSlot: 5,
    note: 'Phase 4 (1700 vs 1800 dpi) tied on win% but 1700 led on accuracy and elims/min — narrowing toward the 1700-equivalent instead of extending upward.',
  },
  {
    hero: 'Shion', archetype: 'Hitscan', senses: [2.71, 2.81], gamesPerSlot: 5,
    note: '1800-equivalent edged 1700 on accuracy and elims/min in Phase 4. Staying well clear of the ~2.89 (1850 dpi) zone that already lost decisively in Phase 3 and that you flagged as miserable to play on.',
  },
  {
    hero: 'Pharah', archetype: 'Projectile', senses: [2.42, 2.52], gamesPerSlot: 5,
    note: 'Phase 4 was decisive: 2.42 beat 2.27 on win% (40→60), accuracy, elims/min, and dmg/min. Pushing further in that direction.',
  },
  {
    hero: 'Tracer', archetype: 'Hitscan', senses: [2.48, 2.58], gamesPerSlot: 5,
    note: 'Phase 4 feel rating favored the faster 2.73, but win%, accuracy, elims/min, and dmg/min all favored 2.58 instead — narrowing toward the slower value.',
  },
  {
    hero: 'Soldier: 76', archetype: 'Hitscan', senses: [2.53, 2.63], gamesPerSlot: 5,
    note: 'Phase 4 was a genuine split: win% tied, accuracy favored 2.65, dmg/min favored 2.50. Re-testing narrower around the same midpoint rather than guessing a direction.',
  },
  {
    hero: 'Ana', archetype: 'Projectile', senses: [2.23, 2.33], gamesPerSlot: 5,
    note: 'No Phase 4 data (set never got games logged) — carrying the same bracket forward, narrowed to a 0.1 gap.',
  },
  {
    hero: 'Juno', archetype: 'Hitscan', senses: [2.50, 2.60], gamesPerSlot: 5,
    note: 'Reclassified hitscan — moved off the old projectile-split bracket into the hitscan cluster (between Cassidy and Soldier/Tracer). No Phase 4 data to narrow from either way.',
  },
  {
    hero: 'Kiriko', archetype: 'Projectile', senses: [2.58, 2.68], gamesPerSlot: 5,
    note: 'No Phase 4 data (set never got games logged) — carrying the same bracket forward, narrowed to a 0.1 gap.',
  },
  {
    hero: 'Zenyatta', archetype: 'Projectile', senses: [2.08, 2.18], gamesPerSlot: 5,
    note: 'No Phase 4 data (set never got games logged) — carrying the same bracket forward, narrowed to a 0.1 gap.',
  },
  {
    hero: 'Cassidy', archetype: 'Hitscan', senses: [2.40, 2.55], gamesPerSlot: 5,
    note: 'Only 2 games logged in Phase 4 — not enough to narrow. Carried over unchanged so the active set (and its 2 logged games) continues rather than resetting.',
  },
  {
    hero: 'Reaper', archetype: 'Hitscan', senses: [2.65, 2.80], gamesPerSlot: 5,
    note: 'Only 1 game logged in Phase 4 — not enough to narrow. Carried over unchanged so the active set (and its 1 logged game) continues rather than resetting.',
  },
  {
    hero: 'Baptiste', archetype: 'Hitscan', senses: [2.38, 2.48], gamesPerSlot: 5,
    note: "New for Phase 5 — never got a test set in Phase 4. Bracketed on the hitscan half of his kit only (revolver/burst rounds); the AoE heal projectile doesn't reward precision the way his gunplay does, so it's excluded from this reasoning.",
  },
] as const;

interface PlanHero {
  hero: string; archetype: string; gamesPerSlot: number; note: string;
  dpis?: readonly number[]; senses?: readonly number[];
}
interface PlanTab { key: string; label: string; description: string; plan: readonly PlanHero[]; curveEnabled?: boolean }

const valuesOf = (h: PlanHero): readonly number[] => h.senses ?? h.dpis ?? [];

// Tab labels are stored as "Phase 2" / "Phase 11" — in PLAN_TABS above and in
// custom_phases.label server-side. The tab row shows just the number; the word is
// redundant once the row is read as a row. Display-only on purpose: the stored
// label is still the DB's field and still what the delete tooltip names.
const tabDisplay = (label: string) => label.replace(/^Phase\s+/i, '');

const PLAN_TABS: readonly PlanTab[] = [
  {
    key: 'phase2', label: 'Phase 2', plan: PHASE2_PLAN,
    description: `In-game sens frozen at 2.50. One test set per hero — heroes can run in parallel, each tagging its own matches. ${PHASE2_PLAN.length} heroes × 3 DPI levels, ${PHASE2_PLAN.reduce((sum, h) => sum + h.dpis.length * h.gamesPerSlot, 0)} games total.`,
  },
  {
    key: 'phase3', label: 'Phase 3', plan: PHASE3_PLAN,
    description: `In-game sens frozen at 2.50. Two-stage, tighter follow-up per hero — 2 rounds × 12 games. ${PHASE3_PLAN.length} heroes × 2 DPI levels, ${PHASE3_PLAN.reduce((sum, h) => sum + h.dpis.length * h.gamesPerSlot, 0)} games total.`,
  },
  {
    key: 'phase4', label: 'Phase 4', plan: PHASE4_PLAN,
    description: `Mouse DPI locked at 1600 permanently — Sojourn's in-flight set stays DPI-varying to finish as started; every other hero varies in-game sens instead (no more 50-unit DPI floor). Pharah/Shion/Tracer target the same eDPI their Phase 3 brackets already found; the rest are heroes with ≥5 games logged and no prior phase data, bracketed on a best guess from archetype alone. ${PHASE4_PLAN.length} heroes × 2 levels, ${PHASE4_PLAN.reduce((sum, h) => sum + valuesOf(h).length * h.gamesPerSlot, 0)} games total.`,
  },
  {
    key: 'phase5', label: 'Phase 5', plan: PHASE5_PLAN,
    description: `Same 12-hero roster as Phase 4, each narrowed to a 0.1-sens bracket (down from Phase 4's 0.15) using win%/accuracy/elims/dmg per stage — not feel rating. Sojourn and Shion move off DPI-varying onto the standard locked-1600-DPI/sens convention. Cassidy and Reaper carry their Phase 4 sets over unchanged (too few games logged to narrow); Ana/Juno/Kiriko/Zenyatta carry their Phase 4 brackets forward narrowed (no data was ever logged). Baptiste is new, bracketed hitscan-only. ${PHASE5_PLAN.length} heroes × 2 levels, ${PHASE5_PLAN.reduce((sum, h) => sum + valuesOf(h).length * h.gamesPerSlot, 0)} games total.`,
  },
];

// Custom phases built through the "+ Add new phase" form are session-authored
// (no hand-written analysis notes), so they're kept separate from the
// hardcoded PLAN_TABS above — persisted server-side via /api/custom-phases so
// a phase built on one device shows up on every device (moved off
// localStorage 2026-08-30, which silently stranded phases on whichever
// browser created them).

// Evenly spaces `stages` sens values between low and high inclusive (2
// decimal places), matching the bracket shape every hand-authored phase uses.
function spreadSens(low: number, high: number, stages: number): number[] {
  if (stages <= 1) return [Math.round(low * 100) / 100];
  return Array.from({ length: stages }, (_, i) =>
    Math.round((low + (high - low) * (i / (stages - 1))) * 100) / 100);
}

// Shrink ratio applied to a hero's bracket width, but only when there's an
// actual reliable signal that justifies narrowing (see suggestCenter's
// `narrow` decision) — narrowing is a claim that the data already confirms
// we're close, not something every phase does automatically regardless of
// what was actually found.
const NARROW_RATIO = 2 / 3;

// Heroes Sean has stopped playing — dropped from the "+ Add new phase" roster
// carry-over so new phases stop re-testing sens on heroes that will never
// accumulate more games. Historical PHASE2-5/custom-phase records that already
// include them are left untouched: retiring a hero ends their future, not
// their past.
//
// Cassidy, Emre, Reaper retired 2026-08-31.
// Baptiste retired 2026-09-15 — Sean doesn't enjoy playing him. The stated
// reason is a roster signal worth keeping: he gravitates to heroes with real
// movement in the kit, and Baptiste has none. Ana is the deliberate exception
// — also low-mobility, but her kit is fun enough to outweigh it. If a future
// phase ever needs a judgement call on whether to add a support, that's the
// bar. His Phase 5-9 data stays fully intact and still feeds the analysis.
const RETIRED_HEROES = new Set(['Cassidy', 'Emre', 'Reaper', 'Baptiste']);

type HeroTestStatus = 'none' | 'testing' | 'completed';

const sameValues = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.001);

// A hero's status comes from whichever set is authoritative for it: an active
// set tagged to this hero (live progress — several heroes can each have one
// active at once, tested in parallel), otherwise its most recent past set (so
// "Completed" survives after that hero's active set finishes). Matches a set
// to this plan entry by hero AND the exact bracket values (not just batch
// size × stage count) — two phases can share the same shape (e.g. 5
// games/slot × 2 stages) with different DPI/sens targets, so shape alone
// would mistake an earlier phase's completed set for this phase's progress.
// The four original plan tabs predate the `phase` tag on blind_stage_sets —
// their own historical sets are all untagged (phase: null), so they keep
// matching by shape/values alone, same as always. Every other phase key
// (every custom phase built via "+ Add new phase", including future ones)
// additionally requires an exact phase match — otherwise a brand-new phase
// that happens to recompute the same bracket as some earlier, unrelated,
// already-completed phase (see suggestCenter's "holding" case) would read
// that old set as its own progress and show "Completed" before anything
// was ever created for it (caught 2026-08-26).
const LEGACY_PHASE_KEYS = new Set(['phase2', 'phase3', 'phase4', 'phase5']);

function statusForHero(
  hero: string, actives: DpiTestActive[], sets: DpiTestSetSummary[], batchSize: number, values: readonly number[],
  phaseKey: string,
): { status: HeroTestStatus; totalGames: number; target: number; setId: number | null } {
  const nStages = values.length;
  const target = batchSize * nStages;
  const scoped = !LEGACY_PHASE_KEYS.has(phaseKey);
  const active = actives.find(a =>
    a.hero === hero && a.batch_size === batchSize && a.n_stages === nStages
    && sameValues(a.stages.map(s => s.sens ?? s.dpi), values)
    && (!scoped || a.phase === phaseKey));
  if (active) {
    return { status: active.completed ? 'completed' : 'testing', totalGames: active.totalGames, target, setId: active.set_id };
  }
  const past = [...sets]
    .filter(s => s.hero === hero && s.batch_size === batchSize && s.n_stages === nStages && sameValues(s.values, values)
      && (!scoped || s.phase === phaseKey))
    .sort((a, b) => b.set_id - a.set_id)[0];
  if (past) {
    // A retired (active=0) set normally only got that way by hitting its
    // target — but games_on_stage/blind_credits can still drop below target
    // afterward if a credited match is later deleted or edited off this set
    // (matches.ts's delete/sync routes decrement the count but never
    // reactivate the set). Report that honestly as still-in-progress rather
    // than silently reporting "no test" — the set is real, it's just short.
    if (past.totalGames >= target) return { status: 'completed', totalGames: past.totalGames, target, setId: past.set_id };
    return { status: 'testing', totalGames: past.totalGames, target, setId: past.set_id };
  }
  return { status: 'none', totalGames: 0, target, setId: null };
}

// One row of the "+ Add new phase" form — string-valued so number inputs can
// sit blank/mid-edit without fighting controlled-input parsing.
// `locked` rows are carried over from the latest phase — their sens range is
// computed automatically (suggestCenter + NARROW_RATIO, see openAddPhase)
// and shown read-only, since re-testing is always a results-driven bracket,
// never a hand-picked one — though a "result" isn't always a narrower
// bracket; it only narrows when the cumulative data reliably confirms the
// current range (see suggestCenter's `narrow` decision). Manually added
// heroes have no prior-phase range to narrow from, so theirs stays editable.
interface NewPhaseRow {
  hero: string; archetype: string; gamesPerSlot: string; low: string; high: string; note: string;
  locked: boolean; reliable: boolean; basis: string;
}
const blankRow = (): NewPhaseRow => ({
  hero: '', archetype: '', gamesPerSlot: '5', low: '', high: '', note: '',
  locked: false, reliable: true, basis: 'manually added — no prior-phase data to narrow from',
});

// Shape of the fields used from GET /api/aim/analysis's per-hero curve fit —
// see server/src/routes/aim.ts / client/src/pages/SensAnalysis.tsx for the
// full response; only what's needed to recenter a row is declared here.
interface CurveFit {
  points: number; totalN: number; r2: number;
  optimalSens: number | null; predictedDelta: number | null;
  hasInteriorPeak: boolean; inRange: boolean;
  testedSensMin: number; testedSensMax: number;
}
interface CumulativeHero {
  hero: string; n: number;
  bestScaleEDPI: number | null; bestScaleN: number; bestScaleReliable: boolean;
  curveFit: CurveFit | null;
}

const FIT_R2_THRESHOLD = 0.1; // below this, the fit is too noisy to trust over the last round
const BEST_SCALE_MIN_N = 3; // minimum games at a single tested point before nudging toward it
const CONFIRM_THRESHOLD = 0.05; // how close the fit's optimum must be to the old center to count as "confirms it"

// Recenters a hero's next-phase bracket using their *entire* logged
// history (GET /api/aim/analysis's weighted-quadratic curve fit), and
// decides separately whether narrowing the bracket is actually justified.
// Center and width are independent: the center always moves to wherever the
// best available evidence points, but the width only shrinks when the data
// both gives a confident answer AND that answer confirms the current
// bracket — i.e. narrowing means "we're already close, tighten around it,"
// never "it's the next phase, so shrink regardless of what the data says."
// `reliable` (drives the row's ⚠ badge) is true whenever there's real
// evidence behind the suggestion at all, independent of whether that
// evidence happens to justify narrowing.
function suggestCenter(oldLow: number, oldHigh: number, ch: CumulativeHero | undefined): { center: number; basis: string; narrow: boolean; reliable: boolean } {
  const oldCenter = (oldLow + oldHigh) / 2;
  const cf = ch?.curveFit;
  if (cf && cf.hasInteriorPeak && cf.inRange && cf.r2 >= FIT_R2_THRESHOLD && cf.optimalSens != null) {
    const agrees = Math.abs(cf.optimalSens - oldCenter) < CONFIRM_THRESHOLD;
    const basis = agrees
      ? `cumulative fit r²=${cf.r2.toFixed(2)} (n=${cf.totalN}) confirms this range — narrowing`
      : `cumulative fit r²=${cf.r2.toFixed(2)} (n=${cf.totalN}) points elsewhere — recentering, not narrowing`;
    return { center: cf.optimalSens, basis, narrow: agrees, reliable: true };
  }
  // Reliability is the server's call now (MIN_SCALE_N), not a local threshold.
  if (ch?.bestScaleReliable && ch.bestScaleEDPI != null) {
    const bestSens = ch.bestScaleEDPI / MOUSE_DPI;
    const center = (oldCenter + bestSens) / 2;
    return { center, basis: `nudged toward best-tested point (n=${ch.bestScaleN}) — not narrowing`, narrow: false, reliable: true };
  }
  return { center: oldCenter, basis: 'no reliable data yet for this hero — holding, not narrowing', narrow: false, reliable: false };
}

function PlanCard({ tabs, state }: { tabs: readonly PlanTab[]; state: DpiTestState | null }) {
  const { data } = useApi<{ sets: DpiTestSetSummary[] }>('/api/blind/sets');
  const sets = data?.sets ?? [];
  const actives = state?.actives ?? [];
  const [creating, setCreating] = useState<string | null>(null);
  const { data: customPhasesData } = useApi<{ phases: PlanTab[] }>('/api/custom-phases');
  const customPhases = customPhasesData?.phases ?? [];
  const allTabs = [...tabs, ...customPhases];
  // Default to the most recent phase with a built-out plan — the one that's
  // actually active. A newly added phase tab starts empty until its plan is
  // filled in, so skip past it rather than opening on a blank grid.
  const lastBuilt = [...allTabs].reverse().find(t => t.plan.length > 0) ?? allTabs[allTabs.length - 1];
  const [tabKey, setTabKeyRaw] = useState(lastBuilt.key);
  // Custom phases load asynchronously (/api/custom-phases), so the useState
  // initializer above only ever sees the hardcoded PLAN_TABS on first render
  // and locks onto Phase 5 forever. Once real data arrives and lastBuilt
  // moves past that, follow it here — but only until the user actually picks
  // a tab themselves, so this doesn't fight a manual selection.
  const userPickedTab = useRef(false);
  const setTabKey = (key: string) => { userPickedTab.current = true; setTabKeyRaw(key); };
  useEffect(() => {
    if (!userPickedTab.current) setTabKeyRaw(lastBuilt.key);
  }, [lastBuilt.key]);
  const { plan, description, curveEnabled: tabCurveEnabled } = allTabs.find(t => t.key === tabKey) ?? lastBuilt;

  const statuses = new Map(plan.map(h => [h.hero, statusForHero(h.hero, actives, sets, h.gamesPerSlot, valuesOf(h), tabKey)]));
  const [cancelling, setCancelling] = useState(false);

  const [showAddPhase, setShowAddPhase] = useState(false);
  const [loadingAddPhase, setLoadingAddPhase] = useState(false);
  const [stages, setStages] = useState('2');
  const [rows, setRows] = useState<NewPhaseRow[]>([blankRow()]);
  // Phase-wide "was mouse acceleration on for this whole phase" — same
  // in_game_sens-style constant every hero's set in the phase shares, not a
  // per-hero or per-match setting. Passed into every hero's POST /api/blind/sets
  // call via setBodyFor below, and stamped onto matches server-side the same
  // way dpi/sens already are (routes/matches.ts findActiveStage).
  const [phaseCurveEnabled, setPhaseCurveEnabled] = useState(false);

  // Every phase after the first is a re-test of the same roster, so the form
  // opens pre-loaded with the latest phase's heroes — excluding a hero is
  // just clicking its × instead of building the list from scratch. Each
  // hero's new range is centered using their *entire* logged history (see
  // suggestCenter), not just whichever two stages happened to run last
  // round — a hero's most recent narrow round can be noise on a small
  // batch, and the fuller history is what should actually drive the next
  // bracket.
  async function openAddPhase() {
    const latest = allTabs[allTabs.length - 1];
    setLoadingAddPhase(true);
    try {
      const res = await fetch('/api/aim/analysis');
      const analysis: CumulativeHero[] = res.ok ? ((await res.json()) as { heroes: CumulativeHero[] }).heroes : [];
      const built: NewPhaseRow[] = latest.plan.filter(h => !RETIRED_HEROES.has(h.hero)).map((h): NewPhaseRow => {
        const values = valuesOf(h);
        const oldLow = Math.min(...values);
        const oldHigh = Math.max(...values);
        const ch = analysis.find(a => a.hero === h.hero);
        const { center, basis, narrow, reliable } = suggestCenter(oldLow, oldHigh, ch);
        const width = narrow ? (oldHigh - oldLow) * NARROW_RATIO : oldHigh - oldLow;
        const low = Math.round((center - width / 2) * 100) / 100;
        const high = Math.round((center + width / 2) * 100) / 100;
        return {
          hero: h.hero, archetype: h.archetype, gamesPerSlot: String(h.gamesPerSlot),
          low: String(low), high: String(high), note: '', locked: true, reliable, basis,
        };
      });
      setStages('2');
      setRows(built);
      setPhaseCurveEnabled(false);
      setShowAddPhase(true);
    } finally {
      setLoadingAddPhase(false);
    }
  }

  function updateRow(i: number, patch: Partial<NewPhaseRow>) {
    setRows(prev => prev.map((r, ri) => (ri === i ? { ...r, ...patch } : r)));
  }

  async function saveNewPhase() {
    const nStages = Math.max(2, parseInt(stages) || 2);
    const validRows = rows.filter(r => r.hero.trim() && r.low.trim() && r.high.trim());
    if (validRows.length === 0) {
      alert('Add at least one hero with a sens range.');
      return;
    }
    const plan: PlanHero[] = validRows.map(r => ({
      hero: r.hero.trim(), archetype: r.archetype.trim() || 'Unknown',
      gamesPerSlot: Math.max(1, parseInt(r.gamesPerSlot) || 5),
      note: r.note.trim(),
      senses: spreadSens(parseFloat(r.low), parseFloat(r.high), nStages),
    }));
    const nextNumber = allTabs.length + 2; // PLAN_TABS starts at "Phase 2"
    const totalGames = plan.reduce((sum, h) => sum + valuesOf(h).length * h.gamesPerSlot, 0);
    const newTab: PlanTab = {
      key: `custom-${Date.now()}`,
      label: `Phase ${nextNumber}`,
      description: `${plan.length} heroes × ${nStages} stages, ${totalGames} games total.${phaseCurveEnabled ? ' Mouse acceleration ON for this phase.' : ''}`,
      plan,
      curveEnabled: phaseCurveEnabled,
    };
    await fetch('/api/custom-phases', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newTab),
    });
    revalidateAll();
    setTabKey(newTab.key);
    setShowAddPhase(false);
    setPhaseCurveEnabled(false);
  }

  // The per-tab "×" delete control was removed 2026-09-21 at Sean's request —
  // a phase is a record of work done, and a delete button sitting on every tab is
  // an accident waiting to happen. DELETE /api/custom-phases/:key still exists
  // server-side, so a phase can still be removed deliberately if one is ever
  // created by mistake.
  function setBodyFor(h: PlanHero) {
    return h.senses
      ? { senses: h.senses, batch_size: h.gamesPerSlot, hero: h.hero, phase: tabKey, curve_enabled: !!tabCurveEnabled }
      : { in_game_sens: 2.5, batch_size: h.gamesPerSlot, dpis: h.dpis, hero: h.hero, phase: tabKey, curve_enabled: !!tabCurveEnabled };
  }

  async function createSetForHero(h: PlanHero) {
    setCreating(h.hero);
    try {
      await fetch('/api/blind/sets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setBodyFor(h)),
      });
      revalidateAll();
    } finally { setCreating(null); }
  }

  const [creatingAll, setCreatingAll] = useState(false);

  // Only targets heroes with no set at all yet (status 'none') — heroes
  // already testing or completed for this phase are left alone, same as
  // clicking each "Create test set" button individually would do.
  async function createAllSets() {
    const targets = plan.filter(h => statuses.get(h.hero)?.status === 'none');
    if (targets.length === 0) return;
    setCreatingAll(true);
    try {
      await Promise.all(targets.map(h => fetch('/api/blind/sets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setBodyFor(h)),
      })));
      revalidateAll();
    } finally {
      setCreatingAll(false);
    }
  }

  async function cancelActiveSet(setId: number, hero: string, games: number) {
    if (games > 0) {
      // Real data at stake — require a deliberate typed confirmation, not a click-through.
      const typed = prompt(
        `This will permanently DELETE the ${hero.toUpperCase()} test set AND all ${games} game${games === 1 ? '' : 's'} logged against it. This cannot be undone.\n\nType ${games} to confirm:`,
      );
      if (typed?.trim() !== String(games)) return;
    } else if (!confirm(`Cancel the ${hero.toUpperCase()} test set? No games have been logged yet.`)) {
      return;
    }
    setCancelling(true);
    try {
      const url = `/api/blind/sets/${setId}${games > 0 ? '?force=1' : ''}`;
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Cancel failed: ${body.error ?? res.statusText}`);
        return;
      }
      revalidateAll();
    } finally { setCancelling(false); }
  }

  return (
    <div className="card mb-6" data-inspect-id="sl-plan-card">
      <div className="flex items-center gap-1 mb-3 border-b border-ow-border">
        {allTabs.map((t, i) => {
          return (
            <div key={t.key} className="relative flex items-center -mb-px">
              {/* Hairline between tabs. The labels are bare numbers now, so without
                  a divider "10 11" reads as one run of digits rather than two tabs. */}
              {i > 0 && <span aria-hidden="true" className="h-3.5 w-px bg-ow-border/70 mr-1" />}
              <button
                type="button" onClick={() => setTabKey(t.key)}
                data-inspect-id="sl-plan-tabs"
                className={`text-sm heading-display px-3 py-1.5 border-b-2 transition-colors ${
                  t.key === tabKey
                    ? 'text-[var(--ink)] border-[var(--ink)]'
                    : 'text-[var(--faint)] border-transparent hover:text-[var(--ink-2)]'
                }`}
              >
                {tabDisplay(t.label)}
              </button>
            </div>
          );
        })}
        <button
          type="button" onClick={openAddPhase} disabled={loadingAddPhase}
          data-inspect-id="sl-plan-add-phase-tab"
          className="text-sm heading-display ml-3 pl-3 border-l border-ow-border px-3 py-1.5 -mb-px text-[var(--faint)] hover:text-[var(--ink-2)] transition-colors disabled:opacity-40"
        >
          {loadingAddPhase ? 'Analyzing last phase…' : '+ Add new phase'}
        </button>
      </div>
      <p className="text-xs text-[var(--faint)] mb-3">
        {tabCurveEnabled && (
          <span data-inspect-id="sl-plan-curve-enabled-badge" className="inline-block mr-1.5 px-1.5 py-0.5 rounded bg-ow-accent/15 text-ow-accent text-[10px] font-semibold align-middle">
            Mouse Accel ON
          </span>
        )}
        {description}
      </p>
      {/* Fallback order. A hero gets banned or picked before you, and the question
          in the lobby is "who instead". Answer: the next name down in your own role.
          Plan order IS rank order (heroes are listed most- to least-informative), so
          this reads straight off the plan rather than being a second list to maintain.
          Sens proximity is deliberately NOT the ordering: each hero's bracket is its
          own, and changing sens between matches costs nothing measurable (accuracy
          p=0.89). Struck-through heroes have finished their block. */}
      {plan.length > 0 && (() => {
        const byRole = new Map<string, PlanHero[]>();
        for (const h of plan) {
          const role = HEROES[h.hero] ?? 'Other';
          if (!byRole.has(role)) byRole.set(role, []);
          byRole.get(role)!.push(h);
        }
        const roles = ['Tank', 'DPS', 'Support', 'Other'].filter(r => byRole.has(r));
        return (
          <div
            data-inspect-id="sl-plan-fallback-order"
            className="mb-3 rounded-lg border border-ow-border bg-ow-darker px-3 py-2"
          >
            <div className="text-[10px] uppercase tracking-wide text-[var(--faint-2)] mb-1.5">
              Banned or taken? Drop to the next name in your role
            </div>
            <div className="flex flex-col gap-1.5">
              {roles.map(role => {
                const list = byRole.get(role)!;
                const nextUp = list.find(h => statuses.get(h.hero)?.status !== 'completed');
                return (
                  <div key={role} className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] font-semibold text-white px-1.5 py-0.5 rounded shrink-0 ${ROLE_PILL_CLASS[role] ?? ROLE_PILL_CLASS.Support}`}>
                      {role}
                    </span>
                    {list.map((h, i) => {
                      const done = statuses.get(h.hero)?.status === 'completed';
                      const isNext = h.hero === nextUp?.hero;
                      return (
                        <span key={h.hero} className="flex items-center gap-2">
                          {i > 0 && <span aria-hidden="true" className="text-[var(--faint-2)] text-xs">&rsaquo;</span>}
                          <span
                            className={`text-xs hero-name ${
                              done ? 'line-through text-[var(--faint-2)]'
                                : isNext ? 'text-[var(--ink)] font-semibold'
                                : 'text-[var(--faint)]'
                            }`}
                            title={done ? `${h.hero} — block complete` : isNext ? `${h.hero} — next up for ${role}` : h.hero}
                          >
                            {h.hero}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
      {(() => {
        const pendingCount = plan.filter(h => statuses.get(h.hero)?.status === 'none').length;
        if (pendingCount === 0) return null;
        return (
          <button
            type="button" onClick={createAllSets} disabled={creatingAll}
            data-inspect-id="sl-plan-create-all-btn"
            className={`${btnSecondary} mb-3 py-1.5 px-3 text-xs disabled:opacity-40`}
          >
            {creatingAll ? 'Creating…' : `Create all ${pendingCount} test set${pendingCount === 1 ? '' : 's'}`}
          </button>
        );
      })()}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2" data-inspect-id="sl-plan-hero-grid">
        {plan.map(h => {
          const s = statuses.get(h.hero)!;
          return (
            <div key={h.hero} className="relative rounded-lg bg-ow-darker border border-ow-border p-2 overflow-hidden">
              <div className={s.status === 'completed' ? 'opacity-30 pointer-events-none' : ''}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs hero-name text-[var(--ink)] truncate">{h.hero}</span>
                  <span className="text-[9px] text-[var(--faint-2)] uppercase shrink-0">{h.archetype}</span>
                </div>
                {/* The sens values being tested are the whole point of the card —
                    lead with them, large and centered, rather than burying them
                    under the hero name as just another detail line. */}
                <div className="flex items-center justify-center gap-1 mb-0.5">
                  {valuesOf(h).map((v, i) => (
                    <span key={v} className="flex items-center gap-1">
                      {i > 0 && <span className="text-[var(--faint-2)] text-xs">/</span>}
                      <span className="text-lg num-display font-bold text-[var(--ink)]">{h.senses ? v.toFixed(2) : v}</span>
                    </span>
                  ))}
                </div>
                <p className="text-[10px] text-[var(--faint-2)] text-center mb-1">× <b className="font-bold">{h.gamesPerSlot}</b>/slot</p>
                {h.note && (
                  <p className="text-[11px] text-[var(--faint)] truncate mb-1" title={h.note}>{h.note}</p>
                )}
                {/* Single fixed-height footer, its content switching by status — replaces the old
                    top-badge + bottom-button pair (each separately reserved via `invisible`), which
                    doubled the empty space every card carried regardless of which state it was in. */}
                <div className="h-5 flex items-center" data-inspect-id="sl-plan-status-footer">
                  {s.status === 'testing' && (
                    <div className="flex items-center gap-2 w-full justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wide text-amber-500">{s.totalGames}/{s.target} games</span>
                      <button
                        type="button"
                        onClick={() => s.setId != null && cancelActiveSet(s.setId, h.hero, s.totalGames)}
                        disabled={cancelling || s.setId == null}
                        data-inspect-id="sl-plan-cancel-btn"
                        className="text-[10px] text-red-400 hover:text-red-300 underline underline-offset-2 disabled:opacity-40 shrink-0"
                      >
                        Cancel test
                      </button>
                    </div>
                  )}
                  {s.status === 'none' && (
                    <button
                      type="button" onClick={() => createSetForHero(h)} disabled={creating === h.hero}
                      data-inspect-id="sl-plan-create-btn"
                      className={`${btnSecondary} w-full py-1 text-xs`}
                    >
                      {creating === h.hero ? 'Creating…' : 'Create test set'}
                    </button>
                  )}
                </div>
              </div>

              {s.status === 'completed' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-ow-card/40 backdrop-blur-[1px]">
                  <span
                    data-inspect-id="sl-plan-status-badge"
                    className="heading-display text-2xl leading-none text-center drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)] text-emerald-500"
                  >
                    Completed
                  </span>
                  <span className="text-[10px] font-semibold num-display text-[var(--ink)] drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">{s.totalGames} / {s.target} games</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showAddPhase && createPortal(
        <div className="fixed inset-0 z-50 grid place-items-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowAddPhase(false)} />
          <div className="relative card max-w-2xl w-full mx-4 max-h-[85vh] overflow-y-auto" data-inspect-id="sl-add-phase-modal">
            <h3 className="text-sm card-title mb-1">Add new phase</h3>
            <p className="text-xs text-[var(--faint)] mb-4">
              Build the next phase's plan. Carried-over heroes' ranges are centered using each hero's full logged history (the
              curve fit on the Analysis page) — hover a hero's row for the basis, or the ⚠ badge for heroes with no reliable data
              yet. The bracket only narrows when that history both gives a confident answer and confirms the current range;
              otherwise the row recenters at the same width. Sens values are evenly spread across the stage count from each
              hero's low/high range.
            </p>

            <div className="flex items-end gap-4 mb-3">
              <label className="inline-block">
                <span className="block text-xs text-[var(--muted)] mb-1"># Stages</span>
                <input
                  type="number" step="1" min="2" value={stages}
                  onChange={e => setStages(e.target.value)}
                  data-inspect-id="sl-add-phase-stages-input" className={`${compactField} w-20`}
                />
              </label>
              <label className="inline-block">
                <span className="block text-xs text-[var(--muted)] mb-1">Mouse Acceleration <span className="text-[var(--faint-2)]">— for this whole phase</span></span>
                <div className="grid grid-cols-2 gap-1.5 w-40">
                  {([false, true] as const).map(v => (
                    <button
                      key={String(v)}
                      type="button"
                      onClick={() => setPhaseCurveEnabled(v)}
                      data-inspect-id={`sl-add-phase-curve-enabled-${v ? 'on' : 'off'}`}
                      aria-pressed={phaseCurveEnabled === v}
                      className={`py-1.5 rounded border-2 text-[10px] font-semibold transition-all ${
                        phaseCurveEnabled === v
                          ? 'is-selected text-orange-700 dark:text-ow-accent'
                          : 'border-transparent text-[var(--faint)] hover:text-[var(--ink)] bg-ow-darker'
                      }`}
                    >
                      {v ? 'On' : 'Off'}
                    </button>
                  ))}
                </div>
              </label>
            </div>

            <div className="grid grid-cols-12 gap-1.5 mb-1 px-1 text-[10px] uppercase tracking-wide text-[var(--faint-2)]">
              <span className="col-span-3">Hero</span>
              <span className="col-span-3">Archetype</span>
              <span className="col-span-2">Low sens</span>
              <span className="col-span-2">High sens</span>
              <span className="col-span-1">Games</span>
            </div>
            <div className="space-y-1 mb-2" data-inspect-id="sl-add-phase-rows">
              {rows.map((r, i) => {
                return (
                <div key={i} className="space-y-1" title={r.locked ? r.basis : undefined}>
                  <div className="grid grid-cols-12 gap-1.5 items-center">
                    <div className="col-span-3 relative">
                      <input
                        placeholder="Hero" value={r.hero} onChange={e => updateRow(i, { hero: e.target.value })}
                        className={compactField} aria-label={`Row ${i + 1} hero`}
                      />
                      {r.locked && !r.reliable && (
                        <span className="absolute -right-0.5 -top-1 text-amber-500 text-[10px]" title={r.basis}>⚠</span>
                      )}
                    </div>
                    <input
                      placeholder="Archetype" value={r.archetype} onChange={e => updateRow(i, { archetype: e.target.value })}
                      className={`${compactField} col-span-3`} aria-label={`Row ${i + 1} archetype`}
                    />
                    <input
                      type="number" step="0.01" min={0.01} placeholder="Low" value={r.low} onChange={e => updateRow(i, { low: e.target.value })}
                      disabled={r.locked}
                      className={`${compactField} col-span-2 ${r.locked ? 'opacity-60 cursor-not-allowed' : ''}`} aria-label={`Row ${i + 1} low sens`}
                    />
                    <input
                      type="number" step="0.01" placeholder="High" value={r.high} onChange={e => updateRow(i, { high: e.target.value })}
                      disabled={r.locked}
                      className={`${compactField} col-span-2 ${r.locked ? 'opacity-60 cursor-not-allowed' : ''}`} aria-label={`Row ${i + 1} high sens`}
                    />
                    <input
                      type="number" step="1" min="1" value={r.gamesPerSlot} onChange={e => updateRow(i, { gamesPerSlot: e.target.value })}
                      className={`${compactField} col-span-1`} aria-label={`Row ${i + 1} games per slot`}
                    />
                    <button
                      type="button" onClick={() => setRows(prev => prev.filter((_, ri) => ri !== i))}
                      data-inspect-id="sl-add-phase-remove-row-btn"
                      className="col-span-1 text-[var(--faint)] hover:text-red-400 text-sm font-bold leading-none"
                      title={`Exclude ${r.hero || 'hero'}`}
                    >
                      ×
                    </button>
                  </div>
                </div>
                );
              })}
              <button
                type="button" onClick={() => setRows(prev => [...prev, blankRow()])}
                data-inspect-id="sl-add-phase-add-hero-btn"
                className={`${btnSecondary} w-full py-1 text-xs border-dashed`}
              >
                + Add hero
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setShowAddPhase(false)} data-inspect-id="sl-add-phase-cancel-btn" className={`${btnSecondary} flex-1 py-2 text-sm`}>Cancel</button>
              <button type="button" onClick={saveNewPhase} data-inspect-id="sl-add-phase-save-btn" className="btn-primary flex-1 py-2 text-sm">Create phase</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── DPI stage-test panel ─────────────────────────────────────────────────────
// No hiding, no scrambling — the DPI you're testing right now is shown
// plainly on screen the whole time, so there's zero chance of playing on a
// sens you don't realize you're on. Several sets can run at once (one per
// hero via the Plan card above, plus at most one ad-hoc set here), so this
// renders one progress card per active set, alongside an always-available
// form for starting an ad-hoc one.
function TestPanel({ state }: { state: DpiTestState | null }) {
  const actives = state?.actives ?? [];
  // Ad-hoc (hero-less) sets have no role to sort by — keep them with DPS.
  const dpsActives = actives.filter(a => (a.hero ? HEROES[a.hero] : 'DPS') !== 'Support');
  const supportActives = actives.filter(a => a.hero && HEROES[a.hero] === 'Support');
  return (
    <div className="mb-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-6">
          {dpsActives.map(active => <ActiveTestCard key={active.set_id} active={active} />)}
        </div>
        <div className="space-y-6">
          {supportActives.map(active => <ActiveTestCard key={active.set_id} active={active} />)}
        </div>
      </div>
      <div className="mt-6">
        <CreateTestCard />
      </div>
    </div>
  );
}

function ActiveTestCard({ active }: { active: DpiTestActive }) {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AnswerStage[] | null>(null);

  // The server refuses to leave a stage short of its batch (stage order only
  // moves forward, so an abandoned stage can never refill). Confirm first and
  // send force when that's genuinely what's wanted — a scrapped session, a
  // stage set up wrong — same shape as restart()'s guard below.
  async function advance() {
    const onStage = active.games_on_stage ?? 0;
    const short = onStage < active.batch_size;
    if (short && !window.confirm(
      `Stage ${active.cur_stage} only has ${onStage} of ${active.batch_size} games. ` +
      `Moving on leaves it short for good — stages never go backwards, so it can't be filled in later.\n\nAdvance anyway?`,
    )) return;

    setBusy(true);
    try {
      const r = await fetch('/api/blind/advance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ set_id: active.set_id, ...(short ? { force: true } : {}) }),
      });
      if (r.ok) revalidateAll();
      else {
        const body = await r.json().catch(() => ({}));
        alert(`Advance failed: ${body.error ?? r.statusText}`);
      }
    } finally { setBusy(false); }
  }

  async function loadSummary() {
    const r = await fetch(`/api/blind/sets/${active.set_id}`);
    if (r.ok) setAnswer((await r.json()).stages);
  }

  // Scrap this set, for when a test is set up wrong. Guards logged games
  // behind a typed confirmation.
  async function restart() {
    const games = active.totalGames ?? 0;
    if (games > 0) {
      const typed = prompt(
        `Restarting DELETES the ${active.hero ?? 'active'} set and all ${games} game${games === 1 ? '' : 's'} logged against it. This cannot be undone.\n\nType ${games} to confirm:`,
      );
      if (typed?.trim() !== String(games)) return;
    } else if (!window.confirm('Restart this test from the beginning? The current set (no games logged) will be discarded.')) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/blind/sets/${active.set_id}${games > 0 ? '?force=1' : ''}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Restart failed: ${body.error ?? res.statusText}`);
        return;
      }
      revalidateAll();
    } finally { setBusy(false); }
  }

  const title = active.hero ?? `Set #${active.set_id}`;

  // Rare/transient — a completed set retires itself the moment its last game
  // lands, but this covers the brief window before that update is visible.
  if (active.completed) {
    return (
      <div className="card max-w-lg">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm card-title">{title} — complete</h2>
          <button type="button" onClick={loadSummary} data-inspect-id="sl-load-summary-btn" className={`${btnSecondary} py-1.5 px-3 text-xs`}>Load summary</button>
        </div>
        {answer ? <AnswerTable stages={answer} /> : <p className="text-xs text-[var(--faint)]">All stages hit their game target.</p>}
      </div>
    );
  }

  const gamesLeft = active.batch_size - active.games_on_stage;

  return (
    <div className="max-w-lg space-y-3">
      <div className="card text-center" data-inspect-id="sl-active-test-card">
        {active.sens != null ? (
          <>
            <div className="text-xs text-[var(--faint)] mb-1">
              {active.hero && <><span className="name-caps">{active.hero}</span>{' — '}</>}Stage <b className="font-bold">{active.cur_stage}</b> of <b className="font-bold">{active.n_stages}</b> — set your in-game sens to
            </div>
            <div className="text-5xl heading-display text-[var(--ink)] my-2 num-display">{active.sens.toFixed(2)}</div>
            <div className="text-xs text-[var(--faint)]">sens, mouse DPI locked <b className="num-display">{active.dpi}</b></div>
            {active.curveEnabled && (
              <div className="text-[10px] text-[var(--faint-2)] mt-1">mouse acceleration on — Jump curve, see the card above</div>
            )}
          </>
        ) : (
          <>
            <div className="text-xs text-[var(--faint)] mb-1">
              {active.hero && <><span className="name-caps">{active.hero}</span>{' — '}</>}Stage <b className="font-bold">{active.cur_stage}</b> of <b className="font-bold">{active.n_stages}</b> — set your mouse to
            </div>
            <div className="text-5xl heading-display text-[var(--ink)] my-2 num-display">{active.dpi ?? '—'}</div>
            <div className="text-xs text-[var(--faint)]">DPI, in-game sens <b className="num-display">{active.in_game_sens.toFixed(2)}</b></div>
          </>
        )}
        {active.needSwitch ? (
          <>
            <div className="text-xs text-amber-500 font-semibold mt-4 mb-1">Batch complete — switch stages</div>
            <button type="button" onClick={advance} disabled={busy} data-inspect-id="sl-advance-stage-btn" className={`${btnSecondary} w-full py-2 text-sm mt-2`}>Get next stage →</button>
          </>
        ) : (
          <>
            <div className="text-2xl heading-display text-[var(--ink)] mt-4">{gamesLeft}</div>
            <div className="text-xs text-[var(--faint)]">game{gamesLeft === 1 ? '' : 's'} left in this batch (of <b className="font-bold">{active.batch_size}</b>)</div>
            <p className="text-[11px] text-[var(--faint-2)] mt-3">Log each game in the <b>Match Tracker</b> — it auto-tags to this stage and lands in the queue above for its combat details.</p>
          </>
        )}
      </div>

      <div className="card">
        <button type="button" onClick={restart} disabled={busy} data-inspect-id="sl-restart-test-btn" className="w-full text-xs text-[var(--faint-2)] hover:text-red-400 py-1.5">↺ Restart test from the beginning</button>
      </div>
    </div>
  );
}

// Manual/ad-hoc test creation, separate from the per-hero Plan card above —
// e.g. for a one-off test that doesn't fit the current phase's plan. At most
// one ad-hoc (hero-less) set can be active at a time.
function CreateTestCard() {
  const [batchSize, setBatchSize] = useState('12');
  const [senses, setSenses] = useState<string[]>(['2.50', '2.65', '2.80']);
  const [curveEnabled, setCurveEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  // Resize the sens list to a new slot count, keeping existing values and
  // padding new slots off the last one so a bigger test starts from something
  // sane instead of blank.
  function setSlotCount(nStr: string) {
    const n = Math.max(2, parseInt(nStr) || 2);
    setSenses(prev => {
      const next = prev.slice(0, n);
      while (next.length < n) next.push(next[next.length - 1] ?? '2.50');
      return next;
    });
  }

  async function createSet() {
    setBusy(true);
    try {
      const res = await fetch('/api/blind/sets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch_size: parseInt(batchSize),
          senses: senses.map(s => parseFloat(s)),
          curve_enabled: curveEnabled,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Create failed: ${body.error ?? res.statusText}`);
        return;
      }
      revalidateAll();
    } finally { setBusy(false); }
  }

  return (
    <div className="card max-w-lg" data-inspect-id="sl-create-test-card">
      <h2 className="text-sm card-title mb-1">Create an ad-hoc sens test set</h2>
      <p className="text-xs text-[var(--faint)] mb-4">Mouse DPI is locked at 1600 permanently. Pick each stage's in-game sens directly — e.g. levels chosen per hero from the analysis page. Type them into your in-game sens setting in this same order; the current stage's value stays visible on screen the whole test.</p>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <label className="block">
          <span className="block text-xs text-[var(--muted)] mb-1.5">Mouse DPI (locked)</span>
          <input type="number" data-inspect-id="sl-locked-dpi-display" className={`${field} opacity-60`} value={1600} disabled />
        </label>
        <label className="block">
          <span className="block text-xs text-[var(--muted)] mb-1.5"># Stages</span>
          <input type="number" step="1" min="2" data-inspect-id="sl-num-stages-input" className={field} value={senses.length} onChange={e => setSlotCount(e.target.value)} />
        </label>
        <label className="block col-span-2">
          <span className="block text-xs text-[var(--muted)] mb-1.5">Games per stage (samples)</span>
          <input type="number" step="1" min="1" data-inspect-id="sl-games-per-stage-input" className={field} value={batchSize} onChange={e => setBatchSize(e.target.value)} />
        </label>
        <label className="block col-span-2">
          <span className="block text-xs text-[var(--muted)] mb-1.5">Mouse Acceleration <span className="text-[var(--faint-2)]">— for this whole test set</span></span>
          <div className="grid grid-cols-2 gap-2">
            {([false, true] as const).map(v => (
              <button
                key={String(v)}
                type="button"
                onClick={() => setCurveEnabled(v)}
                data-inspect-id={`sl-adhoc-curve-enabled-${v ? 'on' : 'off'}`}
                aria-pressed={curveEnabled === v}
                className={`py-2 rounded-lg border-2 text-xs font-semibold transition-all ${
                  curveEnabled === v
                    ? 'is-selected text-orange-700 dark:text-ow-accent'
                    : 'border-transparent text-[var(--faint)] hover:text-[var(--ink)] bg-ow-darker'
                }`}
              >
                {v ? 'On' : 'Off'}
              </button>
            ))}
          </div>
        </label>
      </div>
      <div className="mb-4">
        <span className="block text-xs text-[var(--muted)] mb-1.5">In-game sens per stage</span>
        <div className="grid grid-cols-3 gap-2" data-inspect-id="sl-sens-per-stage-inputs">
          {senses.map((s, i) => (
            <input
              key={i} type="number" step="0.01" min={0.01} className={field} value={s} placeholder={`Stage ${i + 1}`}
              onChange={e => setSenses(prev => prev.map((v, vi) => (vi === i ? e.target.value : v)))}
              aria-label={`Stage ${i + 1} sens`}
            />
          ))}
        </div>
      </div>
      <button type="button" onClick={createSet} disabled={busy} data-inspect-id="sl-create-adhoc-btn" className="btn-primary w-full py-2.5 text-sm">{busy ? 'Creating…' : 'Create test set'}</button>
    </div>
  );
}

function AnswerTable({ stages }: { stages: AnswerStage[] }) {
  return (
    <div className="overflow-x-auto" data-inspect-id="sl-answer-table">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[var(--faint-2)] text-left">
            {['Stage', 'DPI', 'Δ%', 'eDPI', 'Sens @1600', 'Trials', 'Feel avg', 'Feel var'].map(h => <th key={h} className="py-1.5 pr-3">{h}</th>)}
          </tr>
        </thead>
        <tbody className="num-display">
          {[...stages].sort((a, b) => (a.sens ?? a.dpi) - (b.sens ?? b.dpi)).map(s => (
            <tr key={s.stage_index} className="border-t border-ow-border">
              <td className="py-1.5 pr-3">#{s.stage_index}</td>
              <td className="py-1.5 pr-3">{s.dpi}</td>
              <td className={`py-1.5 pr-3 ${s.pct_delta > 0 ? 'text-emerald-700 dark:text-emerald-500' : s.pct_delta < 0 ? 'text-red-700 dark:text-red-400' : 'text-[var(--faint)]'}`}>{s.pct_delta > 0 ? '+' : ''}{s.pct_delta}%</td>
              <td className="py-1.5 pr-3">{s.eDPI}</td>
              <td className="py-1.5 pr-3">{(s.eDPI / MOUSE_DPI).toFixed(2)}</td>
              <td className="py-1.5 pr-3">{s.n}</td>
              <td className="py-1.5 pr-3">{s.feelMean != null ? s.feelMean.toFixed(1) : '—'}</td>
              <td className="py-1.5 pr-3">{s.feelVar != null ? s.feelVar.toFixed(2) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Non-blind backfill (matches logged elsewhere that still need stats) ───────
function BackfillPanel({ pending, loading }: {
  pending: PendingMatch[]; loading: boolean;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Keyed by hero name, not slot — every hero actually played gets its own
  // sens input (Overwatch sensitivity is a real per-hero setting, so a
  // mid-match switch can legitimately have a different value per hero; see
  // schema.ts's comment on match_heroes.sens).
  const [heroSens, setHeroSens] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<StatFieldsT>(emptyStats([]));
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [showCaughtUp, setShowCaughtUp] = useState(false);
  const selected = pending.find(m => m.id === selectedId) ?? null;
  const showHealing = selected ? selected.heroes.some(h => h.role === 'Support') : false;
  const durationRef = useRef<HTMLInputElement>(null);
  const mapCounts = useTodayMapCounts();
  const navigate = useNavigate();
  // Matches already logged today — a record of what's been entered, with the
  // same select-to-expand editing as the pending list above.
  const today = format(new Date(), 'yyyy-MM-dd');
  const { data: loggedData, loading: loggedLoading } = useApi<{ rows: LoggedMatch[] }>(`/api/aim/today?date=${today}`);
  const logged = loggedData?.rows ?? [];
  const [loggedSelectedId, setLoggedSelectedId] = useState<number | null>(null);
  const [loggedHeroSens, setLoggedHeroSens] = useState<Record<string, string>>({});
  const [loggedStats, setLoggedStats] = useState<StatFieldsT>(emptyStats([]));
  const [loggedStatus, setLoggedStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const loggedSelected = logged.find(m => m.id === loggedSelectedId) ?? null;
  const loggedShowHealing = loggedSelected ? loggedSelected.heroes.some(h => h.role === 'Support') : false;

  function toggleLogged(m: LoggedMatch) {
    if (m.id === loggedSelectedId) { setLoggedSelectedId(null); return; }
    setLoggedSelectedId(m.id);
    setLoggedHeroSens(heroSensFromMatch(m));
    setLoggedStats(statsFromLogged(m));
    setLoggedStatus('idle');
  }

  // Win/mode history for each row's hero/map, last 5 strictly before it — same
  // batched-fetch-keyed-on-id-set pattern LogMatch's Today's Matches uses,
  // backing this card's own hero/map history strips.
  const [loggedHeroHistoryByMatch, setLoggedHeroHistoryByMatch] = useState<Record<number, { win: 0 | 1; queue_mode: QueueMode }[]>>({});
  const [loggedMapHistoryByMatch, setLoggedMapHistoryByMatch] = useState<Record<number, { win: 0 | 1; queue_mode: QueueMode }[]>>({});
  const loggedIdsKey = logged.map(m => m.id).join(',');
  useEffect(() => {
    const ids = loggedIdsKey ? loggedIdsKey.split(',').map(Number) : [];
    if (ids.length === 0) { setLoggedHeroHistoryByMatch({}); setLoggedMapHistoryByMatch({}); return; }
    let cancelled = false;
    Promise.all(ids.map(id => fetch(`/api/matches/${id}/hero-history`).then(res => res.json())
      .then((data: { rows?: { win: 0 | 1; queue_mode: QueueMode }[] }) => [id, data.rows ?? []] as [number, { win: 0 | 1; queue_mode: QueueMode }[]])))
      .then(results => { if (!cancelled) setLoggedHeroHistoryByMatch(Object.fromEntries(results)); })
      .catch(() => { if (!cancelled) setLoggedHeroHistoryByMatch({}); });
    Promise.all(ids.map(id => fetch(`/api/matches/${id}/map-history`).then(res => res.json())
      .then((data: { rows?: { win: 0 | 1; queue_mode: QueueMode }[] }) => [id, data.rows ?? []] as [number, { win: 0 | 1; queue_mode: QueueMode }[]])))
      .then(results => { if (!cancelled) setLoggedMapHistoryByMatch(Object.fromEntries(results)); })
      .catch(() => { if (!cancelled) setLoggedMapHistoryByMatch({}); });
    return () => { cancelled = true; };
  }, [loggedIdsKey]);

  const loggedPrimaryAccValid = parseFloat(loggedStats.heroAcc[0]?.overall_acc ?? '') >= 0;
  const loggedDurationsValid = loggedStats.heroAcc.length > 0 && loggedStats.heroAcc.every(h => parseDurationMin(h.duration_min) != null);

  async function saveLogged() {
    if (!loggedSelected || !(loggedPrimaryAccValid && loggedDurationsValid)) return;
    setLoggedStatus('saving');
    try {
      const putRes = await fetch(`/api/matches/${loggedSelected.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(heroSensBody(loggedSelected, loggedHeroSens)) });
      if (!putRes.ok) throw new Error('sens save failed');
      const res = await fetch('/api/aim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(statsBody(loggedSelected.id, loggedStats)) });
      if (!res.ok) throw new Error('save failed');
      setLoggedStatus('success'); setLoggedSelectedId(null);
      revalidateAll();
      setTimeout(() => setLoggedStatus('idle'), 1800);
    } catch { setLoggedStatus('error'); setTimeout(() => setLoggedStatus('idle'), 3000); }
  }

  // Selecting a card should land the cursor on Duration — the required field and
  // the whole point of the backfill — so it's type-ready without a second click.
  useEffect(() => {
    if (selectedId != null) durationRef.current?.focus();
  }, [selectedId]);

  function selectMatch(m: PendingMatch) {
    setSelectedId(m.id);
    setHeroSens(heroSensFromMatch(m));
    setStats(emptyStats(m.heroes));
    setStatus('idle');
  }

  function toggleMatch(m: PendingMatch) {
    if (m.id === selectedId) { setSelectedId(null); return; }
    selectMatch(m);
  }

  const primaryAccValid = parseFloat(stats.heroAcc[0]?.overall_acc ?? '') >= 0;
  const durationsValid = stats.heroAcc.length > 0 && stats.heroAcc.every(h => parseDurationMin(h.duration_min) != null);

  async function save() {
    if (!selected || !(primaryAccValid && durationsValid)) return;
    setStatus('saving');
    try {
      const putRes = await fetch(`/api/matches/${selected.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(heroSensBody(selected, heroSens)) });
      if (!putRes.ok) throw new Error('sens save failed');
      const res = await fetch('/api/aim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(statsBody(selected.id, stats)) });
      if (!res.ok) throw new Error('save failed');
      // This was the last pending match — the backlog is about to hit zero.
      if (pending.length === 1) setShowCaughtUp(true);
      setStatus('success'); setSelectedId(null); setStats(emptyStats([])); setHeroSens({});
      revalidateAll();
      setTimeout(() => setStatus('idle'), 1800);
    } catch { setStatus('error'); setTimeout(() => setStatus('idle'), 3000); }
  }

  return (
    <div>
      <h2 data-inspect-id="sl-record-combat-header" className="text-sm card-title mb-1">Record combat details</h2>
      <p className="text-xs text-[var(--faint)] mb-4">Every match awaiting its aim stats. Matches are logged in the Match Tracker; while a stage test is running they arrive here already tagged with that stage's DPI.</p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="card" data-inspect-id="sl-awaiting-stats-card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm card-title">Awaiting Stats</h3>
          <span className="text-xs text-[var(--faint)]"><b className="font-bold">{pending.length}</b> pending</span>
        </div>
        {loading ? <p className="text-xs text-[var(--faint)]">Loading…</p>
          : pending.length === 0 ? <p className="text-xs text-[var(--faint)]">All caught up.</p>
          : (
            <div className="space-y-2" data-inspect-id="sl-awaiting-stats-list">
              {pending.map(m => {
                const c = QUEUE_MODE_COLORS[m.queue_mode]; const active = m.id === selectedId;
                return (
                  <div key={m.id} className={`relative overflow-hidden rounded-lg border ${MODE_WASH_CLASS[m.queue_mode]} transition-all ${active ? `${c.accent} ${c.glow}` : 'border-ow-border hover:border-gray-500'}`}>
                    {/* Header block (watermark + toggle + collapsed row) gets its own
                        relative/overflow-hidden box so the oversized watermark glyph is
                        clipped to just this block — otherwise, being absolutely positioned
                        against the *outer* card, it'd paint over the expanded form section
                        below (the form isn't positioned, so it can't out-stack an absolute
                        sibling) instead of disappearing behind its background like intended. */}
                    <div className="relative overflow-hidden">
                      {/* Oversized W/L watermark, same treatment as ModeWatermark. Sized
                          taller than the row so top and bottom clip on overflow-hidden too.
                          Pinned to a fixed top offset (not inset-y-0 + items-center) so it
                          stays put next to the collapsed header row instead of re-centering
                          on the whole (now taller) card once it expands — same fix as the
                          qp/comp toggle below. */}
                      <span
                        aria-hidden="true"
                        data-inspect-id="sl-awaiting-stats-watermark"
                        className={`pointer-events-none select-none absolute top-7 -translate-y-1/2 right-0 text-[7rem] font-display font-black italic leading-none tracking-[-0.07em] whitespace-nowrap opacity-15 ${m.win ? 'translate-x-[20%] text-emerald-500' : 'translate-x-[-15%] text-red-500'}`}
                      >
                        {m.win ? 'W' : 'L'}
                      </span>
                    <div className="relative z-10 flex items-stretch">
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleMatch(m)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMatch(m); } }}
                        className="flex-1 min-w-0 text-left py-2.5 pl-3 pr-1.5 cursor-pointer"
                      >
                        <div className="flex items-stretch h-6 min-w-0" title={m.heroes.length > 1 ? m.heroes.slice(1).map(h => h.hero).join(', ') : undefined}>
                          {m.heroes[0] && (
                            <span
                              className={`pill hero-name border-2 text-white relative z-10 h-full box-border shadow-[3px_3px_0_rgba(0,0,0,0.7)] w-24 justify-center truncate ${
                                ROLE_PILL_CLASS[m.heroes[0].role] ?? ROLE_PILL_CLASS.Support
                              }`}
                            >
                              {m.heroes[0].hero}
                            </span>
                          )}
                          {/* Hidden mid-match switch heroes rendered as the actual right-edge
                              slice of a pill (real chamfered corner, not an invented rectangle)
                              peeking out from behind the primary tag — a narrow overflow-hidden
                              window crops a full-width pill anchored to its right edge. */}
                          {m.heroes.slice(1).map((h, i) => (
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
                        <div className="flex items-center gap-3 mt-1 text-[11px] text-[var(--faint)]">
                          <span>{m.time ? format(new Date(m.time), 'MMM d, h:mm a') : m.date}</span><span>·</span>
                          <span>{m.stage_index != null ? <>stage <b className="font-bold">{m.stage_index}</b> · sens <b className="font-bold">{m.sens}</b></> : m.sens != null ? <>sens <b className="font-bold">{m.sens}</b></> : 'no sens'}</span>
                        </div>
                      </div>
                      <span className="block shrink-0 self-center mr-1.5 w-[7.5rem] text-xs map-name text-[var(--ink)] text-right leading-tight whitespace-normal break-words">{m.map}</span>
                    </div>
                    </div>
                    {active && (
                      <div className={`border-t border-ow-border px-3 py-3 space-y-4 stats-entry-heavy ${c.card}`} data-inspect-id="sl-inline-stats-form">
                        <StatFields
                          s={stats}
                          upd={(k, v) => setStats(s => ({ ...s, [k]: v }))}
                          updHeroAcc={(i, k, v) => setStats(s => ({ ...s, heroAcc: s.heroAcc.map((h, hi) => hi === i ? { ...h, [k]: v } : h) }))}
                          showHealing={showHealing}
                          firstDurationRef={durationRef}
                          heroSens={heroSens}
                        />
                        <button type="button" onClick={save} disabled={!(primaryAccValid && durationsValid) || status === 'saving'} data-inspect-id="sl-save-stats-btn" className="btn-primary w-full py-2.5 text-sm">
                          {status === 'saving' ? 'Saving…' : status === 'success' ? '✓ Saved' : 'Save Stats'}
                        </button>
                        {status === 'error' && <p data-inspect-id="sl-save-error-banner" className="text-red-600 text-xs text-center">Failed to save — is the server running?</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      </div>

      <div className="card" data-inspect-id="sl-logged-today-card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm card-title">Logged Today</h3>
          <span className="text-xs text-[var(--faint)]"><b className="font-bold">{logged.length}</b> logged</span>
        </div>
        {loggedLoading ? <p className="text-xs text-[var(--faint)]">Loading…</p>
          : logged.length === 0 ? <p className="text-xs text-[var(--faint)]">Nothing logged yet today.</p>
          : (
            <div className="space-y-2" data-inspect-id="sl-logged-today-list">
              {logged.map(m => {
                const c = QUEUE_MODE_COLORS[m.queue_mode]; const active = m.id === loggedSelectedId;
                return (
                  <div key={m.id} className={`relative overflow-hidden rounded-lg transition-all ${active ? `${c.accent} ${c.glow} ring-1 ring-inset` : ''}`}>
                    {/* Header block gets its own relative/overflow-hidden box so the
                        absolutely-positioned watermark stays clipped to the collapsed
                        row instead of re-centering on the whole card once the form
                        expands below — same card treatment as Today's Matches on the
                        Log Match page (no border at rest, wash+click+padding unified
                        on this one row div, ring-1 ring-inset accent when expanded). */}
                    <div
                      onClick={() => toggleLogged(m)}
                      className={`relative overflow-hidden flex items-center gap-3 min-h-16 py-2.5 px-3 rounded-lg cursor-pointer transition-colors hover:brightness-110 ${MODE_WASH_CLASS[m.queue_mode]}`}
                    >
                      {/* Oversized W/L watermark, same treatment as ModeWatermark. Sized
                          taller than the row so top and bottom clip on overflow-hidden too.
                          Pinned to a fixed top offset (not inset-y-0 + items-center) so it
                          stays put next to the collapsed header row instead of re-centering
                          on the whole (now taller) card once it expands — same fix as the
                          qp/comp toggle below. */}
                      <span
                        aria-hidden="true"
                        data-inspect-id="sl-logged-today-watermark"
                        className={`pointer-events-none select-none absolute top-7 -translate-y-1/2 right-0 text-[7rem] font-display font-black italic leading-none tracking-[-0.07em] whitespace-nowrap opacity-15 ${m.win ? 'translate-x-[20%] text-emerald-500' : 'translate-x-[-15%] text-red-500'}`}
                      >
                        {m.win ? 'W' : 'L'}
                      </span>
                      <div className="relative z-10 flex-1 min-w-0">
                        <div className="flex items-stretch h-6 min-w-0" title={m.heroes.length > 1 ? m.heroes.slice(1).map(h => h.hero).join(', ') : undefined}>
                          {m.heroes[0] && (
                            <span
                              className={`pill hero-name border-2 text-white relative z-10 h-full box-border shadow-[3px_3px_0_rgba(0,0,0,0.7)] w-24 justify-center truncate ${
                                ROLE_PILL_CLASS[m.heroes[0].role] ?? ROLE_PILL_CLASS.Support
                              }`}
                            >
                              {m.heroes[0].hero}
                            </span>
                          )}
                          {/* Hidden mid-match switch heroes rendered as the actual right-edge
                              slice of a pill (real chamfered corner, not an invented rectangle)
                              peeking out from behind the primary tag — a narrow overflow-hidden
                              window crops a full-width pill anchored to its right edge. */}
                          {m.heroes.slice(1).map((h, i) => (
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
                        {/* Last 5 matches on this hero, strictly before this one — same
                            win/loss-colored dash treatment as Today's Matches on the Log
                            Match page. */}
                        <div className="flex items-center gap-1 mt-2 w-24" data-inspect-id="sl-logged-today-hero-history">
                          {(() => {
                            const hist = [...(loggedHeroHistoryByMatch[m.id] ?? [])].reverse();
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
                      {/* Fixed to the card, not the hero column's flow — same treatment as
                          Today's Matches so it holds position regardless of how wide the
                          hero column's mid-match-switch peek slices make it. */}
                      <div
                        className="absolute inset-y-0 left-[6.75rem] right-[8.625rem] z-10 flex flex-col items-center justify-center gap-0.5 text-center pointer-events-none"
                        data-inspect-id="sl-logged-today-time-sens"
                      >
                        <span className="text-[11px] text-[var(--faint)]">{m.time ? format(new Date(m.time), 'MMM d, h:mm a') : m.date}</span>
                        <span className="text-[11px] text-[var(--faint)]">{m.stage_index != null ? <>stage <b className="font-bold">{m.stage_index}</b> · sens <b className="font-bold">{m.sens}</b></> : m.sens != null ? <>sens <b className="font-bold">{m.sens}</b></> : 'no sens'}</span>
                      </div>
                      <div className="relative z-10 flex flex-col items-end shrink-0 self-center mr-1.5 w-[7.5rem]">
                        <span className="block text-xs map-name text-[var(--ink)] text-right leading-tight whitespace-normal break-words">{m.map}</span>
                        {/* Last 5 matches on this map, strictly before this one — same dash
                            treatment as the hero history strip above. */}
                        <div className="flex items-center gap-1 mt-2 w-24" data-inspect-id="sl-logged-today-map-history">
                          {(() => {
                            const hist = [...(loggedMapHistoryByMatch[m.id] ?? [])].reverse();
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
                    {active && (
                      <div className={`border-t border-ow-border px-3 py-3 space-y-4 ${c.card}`} data-inspect-id="sl-logged-today-stats-form">
                        <StatFields
                          s={loggedStats}
                          upd={(k, v) => setLoggedStats(s => ({ ...s, [k]: v }))}
                          updHeroAcc={(i, k, v) => setLoggedStats(s => ({ ...s, heroAcc: s.heroAcc.map((h, hi) => hi === i ? { ...h, [k]: v } : h) }))}
                          showHealing={loggedShowHealing}
                          heroSens={loggedHeroSens}
                        />
                        <button type="button" onClick={saveLogged} disabled={!(loggedPrimaryAccValid && loggedDurationsValid) || loggedStatus === 'saving'} data-inspect-id="sl-logged-today-save-btn" className="btn-primary w-full py-2.5 text-sm">
                          {loggedStatus === 'saving' ? 'Saving…' : loggedStatus === 'success' ? '✓ Saved' : 'Save Changes'}
                        </button>
                        {loggedStatus === 'error' && <p className="text-red-600 text-xs text-center">Failed to save — is the server running?</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      </div>
      </div>

      {showCaughtUp && (
        <div className="fixed inset-0 z-50 grid place-items-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowCaughtUp(false)} />
          <div className="relative card max-w-sm w-full mx-4 text-center" data-inspect-id="sl-caught-up-modal">
            <h3 className="text-sm card-title mb-1.5">All caught up</h3>
            <p className="text-xs text-[var(--faint)] mb-4">No matches left awaiting combat details. Head back to the Match Tracker?</p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setShowCaughtUp(false)} data-inspect-id="sl-caught-up-stay-btn" className={`${btnSecondary} flex-1 py-2 text-sm`}>Stay</button>
              <button type="button" autoFocus onClick={() => navigate('/')} data-inspect-id="sl-caught-up-leave-btn" className="btn-primary flex-1 py-2 text-sm">Leave</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

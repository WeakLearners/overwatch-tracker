import { useEffect, useRef } from 'react';
import { RAW_STAT_FIELDS, critSlot, overallSlot, extraSlot, hasCrit } from '../lib/heroStatLabels';
import { useTilePicks } from '../hooks/useTilePicks';
import type { PickSlot, PickTile } from '../lib/scoreboardFill';
import { eDPI, MOUSE_DPI } from '../lib/aim';

// Aim-stat entry shared by the Sens page's backlog ("Record combat details")
// and Log Match's "Add aim stats now" fold-out: the per-hero fields, the
// m:ss duration format, and the validity rule live here once.

// One overall/crit accuracy + duration reading per hero actually played — a
// match with a mid-match switch gets one row per hero here instead of a
// single match-wide number (duration especially: a switch can leave one hero
// on-screen for 2 minutes and another for 15).
export interface HeroAccStat {
  hero: string; overall_acc: string; crit_acc: string; extra_acc: string;
  torpedo_damage: string; torpedo_healing: string; duration_min: string;
}
export interface StatFieldsT {
  heroAcc: HeroAccStat[];
  elims: string; deaths: string; damage: string; healing: string; assists: string;
}

export const emptyStats = (heroes: { hero: string }[]): StatFieldsT => ({
  heroAcc: heroes.map(h => ({
    hero: h.hero, overall_acc: '', crit_acc: '', extra_acc: '',
    torpedo_damage: '', torpedo_healing: '', duration_min: '',
  })),
  elims: '', deaths: '', damage: '', healing: '', assists: '',
});


export const num = (s: string) => (s.trim() === '' ? null : parseFloat(s));

// Duration is entered as m:ss (e.g. "4:32", "12:01") rather than decimal
// minutes — easier to read off the in-game match timer than converting.
export const parseDurationMin = (s: string): number | null => {
  const m = s.trim().match(/^(\d{1,3}):([0-5]\d)$/);
  return m ? parseInt(m[1], 10) + parseInt(m[2], 10) / 60 : null;
};
// Inverse of parseDurationMin, for prefilling an edit form from the decimal
// minutes stored server-side.
export const formatDurationMin = (mins: number | null): string => {
  if (mins == null) return '';
  let m = Math.floor(mins);
  let sec = Math.round((mins - m) * 60);
  if (sec === 60) { sec = 0; m += 1; }
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const field = 'w-full field px-3 py-2 text-sm num-display';

export const NONE_PICK = '__none__';
export type TileMenus = Record<string, Partial<Record<PickSlot, PickTile[]>>>;

// The "pick a tile" menu for a slot nothing fills yet. It is a plain select in the slot's own cell,
// ringed so the eye finds it; it never blocks the form. It asks the browser to open itself once when it
// appears and the page has no focus target (a refusal is fine: the ring still marks it). Options are
// "LABEL  value%", then "None for this hero". The pick is fixed once saved: there is no edit here.
function TilePickSelect({ hero, slot, options, onPick, idPrefix }: {
  hero: string; slot: PickSlot; options: PickTile[]; onPick: (hero: string, slot: PickSlot, tile: string | null) => void;
  idPrefix: string;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    try { ref.current?.showPicker?.(); } catch { /* needs a user gesture in some browsers; the ring is enough */ }
  }, []);
  return (
    <div className="mt-1.5">
      <select
        ref={ref} value="" data-inspect-id={`${idPrefix}-tile-pick-select`}
        onChange={e => { if (e.target.value) onPick(hero, slot, e.target.value === NONE_PICK ? null : e.target.value); }}
        className={`w-full field px-2 py-1.5 text-xs ring-1 ring-ow-accent/60`}
        aria-label={`${hero}: pick the tile for the ${slot} slot`}
      >
        <option value="" disabled>Pick a tile…</option>
        {options.map(o => <option key={o.label} value={o.label}>{o.label}  {o.value}</option>)}
        <option value={NONE_PICK}>None for this hero</option>
      </select>
    </div>
  );
}

// ── Shared aim-stat inputs (used by both the stage-trial loop and the backfill form) ─
export function StatFields({ s, upd, updHeroAcc, showHealing, firstDurationRef, heroSens, idPrefix, tileMenus, onPickTile }: {
  s: StatFieldsT; upd: <K extends Exclude<keyof StatFieldsT, 'heroAcc'>>(k: K, v: StatFieldsT[K]) => void;
  updHeroAcc: (i: number, k: 'overall_acc' | 'crit_acc' | 'extra_acc' | 'torpedo_damage' | 'torpedo_healing' | 'duration_min', v: string) => void;
  showHealing: boolean;
  firstDurationRef?: React.RefObject<HTMLInputElement>;
  heroSens?: Record<string, string>;
  // Every data-inspect-id this emits is `${idPrefix}-…`. The backlog form passes
  // 'sl', Log Match's fold-out passes 'logmatch-aim' — one id per surface.
  idPrefix: string;
  // Log Match only: menus from the live scoreboard fill, and the save handler (POST /api/scoreboards/tile-picks).
  tileMenus?: TileMenus; onPickTile?: (hero: string, slot: PickSlot, tile: string | null) => void;
}) {
  const picks = useTilePicks();
  const t = (k: Exclude<keyof StatFieldsT, 'heroAcc'>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => upd(k, e.target.value as never);
  const combatFields = showHealing
    ? ([['elims', 'Elims'], ['assists', 'Assists'], ['deaths', 'Deaths'], ['damage', 'Damage'], ['healing', 'Healing']] as const)
    : ([['elims', 'Elims'], ['deaths', 'Deaths'], ['damage', 'Damage']] as const);
  return (
    <>
      {/* One overall/crit accuracy + duration row per hero played — most
          matches are one row (no switch), but a mid-match switch gets a row
          per hero, since time-on-hero varies switch to switch. */}
      <div className="space-y-3" data-inspect-id={`${idPrefix}-hero-acc-inputs`}>
        {s.heroAcc.map((h, i) => {
          const menu = onPickTile ? tileMenus?.[h.hero] : undefined;
          const extraLabel = extraSlot(h.hero, picks) ?? (menu?.extra ? 'Extra %' : null);
          const showCrit = hasCrit(h.hero);
          const critLabels = critSlot(h.hero, picks);
          const rawFields = RAW_STAT_FIELDS[h.hero] ?? [];
          const cols = 2 + (showCrit ? 1 : 0) + (extraLabel ? 1 : 0) + rawFields.length;
          const pickMenu = (slot: PickSlot) => {
            const opts = menu?.[slot];
            return opts && onPickTile ? <TilePickSelect hero={h.hero} slot={slot} options={opts} onPick={onPickTile} idPrefix={idPrefix} /> : null;
          };
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
                  data-inspect-id={`${idPrefix}-hero-duration-input`}
                  className={`${field} num-display ${parseDurationMin(h.duration_min) != null ? '' : 'ring-1 ring-ow-accent/60'}`}
                  placeholder="m:ss" aria-label={`${h.hero} duration, minutes:seconds`} required
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1.5">{overallSlot(h.hero, picks).label}</label>
                <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={h.overall_acc} onChange={e => updHeroAcc(i, 'overall_acc', e.target.value)} data-inspect-id={`${idPrefix}-overall-acc-input`} className={field} placeholder="e.g. 41.2" aria-label={`${h.hero} ${overallSlot(h.hero, picks).aria} %`} />
                {pickMenu('overall')}
              </div>
              {showCrit && (
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1.5">{critLabels.label}</label>
                  <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={h.crit_acc} onChange={e => updHeroAcc(i, 'crit_acc', e.target.value)} data-inspect-id={`${idPrefix}-crit-acc-input`} className={field} placeholder="e.g. 22.5" aria-label={`${h.hero} ${critLabels.aria} %`} />
                  {pickMenu('crit')}
                </div>
              )}
              {extraLabel && (
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1.5">{extraLabel}</label>
                  <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={h.extra_acc} onChange={e => updHeroAcc(i, 'extra_acc', e.target.value)} data-inspect-id={`${idPrefix}-extra-acc-input`} className={field} placeholder="e.g. 18.0" aria-label={`${h.hero} ${extraLabel}`} />
                  {pickMenu('extra')}
                </div>
              )}
              {rawFields.map(rf => (
                <div key={rf.key}>
                  <label className="block text-xs text-[var(--muted)] mb-1.5">{rf.label}</label>
                  <input type="number" step="1" min="0" inputMode="numeric" value={h[rf.key]} onChange={e => updHeroAcc(i, rf.key, e.target.value)} data-inspect-id={`${idPrefix}-${rf.key.replace('_', '-')}-input`} className={field} placeholder="e.g. 2400" aria-label={`${h.hero} ${rf.label}`} />
                </div>
              ))}
            </div>
          </div>
          );
        })}
      </div>
      <div>
        <label className="block text-xs text-[var(--muted)] mb-1.5">Combat <span className="text-[var(--faint-2)]">— endgame scoreboard</span></label>
        <div className={`grid gap-2 ${showHealing ? 'grid-cols-5' : 'grid-cols-3'}`} data-inspect-id={`${idPrefix}-combat-stats-inputs`}>
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

export const statsBody = (match_id: number, s: StatFieldsT) => ({
  match_id,
  heroes: s.heroAcc.map(h => ({
    hero: h.hero, overall_acc: num(h.overall_acc), crit_acc: num(h.crit_acc),
    extra_acc: num(h.extra_acc), torpedo_damage: num(h.torpedo_damage),
    torpedo_healing: num(h.torpedo_healing), duration_min: parseDurationMin(h.duration_min),
  })),
  elims: num(s.elims), deaths: num(s.deaths), damage: num(s.damage), healing: num(s.healing), assists: num(s.assists),
});

// True once any field has been typed into — a fold-out left blank counts as
// closed, so the match goes to the backlog exactly as before.
export const statsTouched = (s: StatFieldsT): boolean =>
  s.elims.trim() !== '' || s.deaths.trim() !== '' || s.damage.trim() !== '' || s.healing.trim() !== '' || s.assists.trim() !== '' ||
  s.heroAcc.some(h => [h.overall_acc, h.crit_acc, h.extra_acc, h.torpedo_damage, h.torpedo_healing, h.duration_min].some(v => v.trim() !== ''));
// The one validity rule both entry points share: the first hero's overall
// accuracy is present, and every hero has a duration.
export const statsValid = (s: StatFieldsT): boolean =>
  parseFloat(s.heroAcc[0]?.overall_acc ?? '') >= 0 && s.heroAcc.length > 0 && s.heroAcc.every(h => parseDurationMin(h.duration_min) != null);

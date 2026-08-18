import { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi, revalidateAll } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { eDPI, MOUSE_DPI } from '../lib/aim';
import {
  QueueMode, QUEUE_MODES, QUEUE_MODE_COLORS, MODE_TAG, ROLE_COLORS, HEROES,
} from '../types';
import { format } from 'date-fns';
import SensNav from '../components/SensNav';

// ── Types ────────────────────────────────────────────────────────────────────
interface PendingMatch {
  id: number; date: string; time: string | null;
  hero: string; role: string; map: string; game_type: string;
  queue_mode: QueueMode; win: 0 | 1; sens: number | null;
  stage_index?: number | null;
  // Every hero actually played this match, slot order (slot 1 = hero/role
  // above) — a match with a mid-match switch has more than one.
  heroes: { hero: string; role: string }[];
}
// A match that already has aim stats saved today — /api/aim/today's shape.
// Mirrors PendingMatch (same heroes[] ordering) plus the saved combat totals
// and per-hero accuracy needed to prefill an edit.
interface LoggedHeroAcc { hero: string; overall_acc: number | null; crit_acc: number | null; extra_acc: number | null; duration_min: number | null }
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
  hero: string | null; totalGames: number; completed: boolean;
  needSwitch: boolean;
  stages: { stage_index: number; dpi: number; sens: number | null }[];
}
interface DpiTestState {
  actives: DpiTestActive[];
}
interface DpiTestSetSummary {
  set_id: number; hero: string | null; active: boolean; completed: boolean;
  batch_size: number; n_stages: number; totalGames: number; created_at: string;
  values: number[];
}
interface AnswerStage {
  stage_index: number; dpi: number; sens: number | null; pct_delta: number;
  eDPI: number; cm360: number; n: number; feelMean: number | null; feelVar: number | null;
}
// One overall/crit accuracy + duration reading per hero actually played — a
// match with a mid-match switch gets one row per hero here instead of a
// single match-wide number (duration especially: a switch can leave one hero
// on-screen for 2 minutes and another for 15).
interface HeroAccStat { hero: string; overall_acc: string; crit_acc: string; extra_acc: string; duration_min: string }
// Per-hero label for the optional 4th accuracy field (undefined = hero uses
// only the standard 3 fields).
const EXTRA_ACC_LABEL: Record<string, string> = {
  Sojourn: 'Charged Shot Crit %',
  'Soldier: 76': 'Helix Rocket %',
  Baptiste: 'Crit %',
};
// Per-hero override for the crit_acc slot's label/aria text — heroes whose
// kit doesn't map cleanly onto "Crit %" repurpose the same underlying field.
const CRIT_SLOT_LABEL: Record<string, { label: string; aria: string }> = {
  Ana: { label: 'Sleep Dart Accuracy %', aria: 'sleep dart accuracy' },
  Sojourn: { label: 'Charged Shot %', aria: 'charged shot accuracy' },
  Pharah: { label: 'Direct Hit %', aria: 'direct hit accuracy' },
  Zenyatta: { label: 'Charged Volley %', aria: 'charged volley accuracy' },
  Baptiste: { label: 'Healing %(+)', aria: 'healing accuracy' },
};
interface StatFieldsT {
  heroAcc: HeroAccStat[];
  elims: string; deaths: string; damage: string; healing: string; assists: string;
}

const emptyStats = (heroes: { hero: string }[]): StatFieldsT => ({
  heroAcc: heroes.map(h => ({ hero: h.hero, overall_acc: '', crit_acc: '', extra_acc: '', duration_min: '' })),
  elims: '', deaths: '', damage: '', healing: '', assists: '',
});

const num = (s: string) => (s.trim() === '' ? null : parseFloat(s));
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
const btnSecondary = 'border border-ow-border rounded-lg text-[var(--ink)] font-semibold hover:border-gray-500 transition-all disabled:opacity-40 disabled:cursor-not-allowed';
const HERO_LIST = Object.entries(HEROES).sort((a, b) => a[0].localeCompare(b[0]));

// ── Shared aim-stat inputs (used by both the stage-trial loop and the backfill form) ─
function StatFields({ s, upd, updHeroAcc, showHealing, firstDurationRef }: {
  s: StatFieldsT; upd: <K extends Exclude<keyof StatFieldsT, 'heroAcc'>>(k: K, v: StatFieldsT[K]) => void;
  updHeroAcc: (i: number, k: 'overall_acc' | 'crit_acc' | 'extra_acc' | 'duration_min', v: string) => void;
  showHealing: boolean;
  firstDurationRef?: React.RefObject<HTMLInputElement>;
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
          const critSlot = CRIT_SLOT_LABEL[h.hero] ?? { label: 'Crit %', aria: 'crit accuracy' };
          return (
          <div key={h.hero}>
            <div className="text-xs hero-name text-[var(--ink)] mb-1.5">{h.hero}</div>
            <div className={`grid gap-3 ${extraLabel ? 'grid-cols-4' : 'grid-cols-3'}`}>
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
                <label className="block text-xs text-[var(--muted)] mb-1.5">{h.hero === 'Ana' ? 'Scoped Accuracy %' : 'Overall %'}</label>
                <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={h.overall_acc} onChange={e => updHeroAcc(i, 'overall_acc', e.target.value)} data-inspect-id="sl-overall-acc-input" className={field} placeholder="e.g. 41.2" aria-label={`${h.hero} ${h.hero === 'Ana' ? 'scoped accuracy' : 'overall accuracy'} %`} />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1.5">{critSlot.label}</label>
                <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={h.crit_acc} onChange={e => updHeroAcc(i, 'crit_acc', e.target.value)} data-inspect-id="sl-crit-acc-input" className={field} placeholder="e.g. 22.5" aria-label={`${h.hero} ${critSlot.aria} %`} />
              </div>
              {extraLabel && (
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1.5">{extraLabel}</label>
                  <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={h.extra_acc} onChange={e => updHeroAcc(i, 'extra_acc', e.target.value)} data-inspect-id="sl-extra-acc-input" className={field} placeholder="e.g. 18.0" aria-label={`${h.hero} ${extraLabel}`} />
                </div>
              )}
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
    extra_acc: num(h.extra_acc), duration_min: parseDurationMin(h.duration_min),
  })),
  elims: num(s.elims), deaths: num(s.deaths), damage: num(s.damage), healing: num(s.healing), assists: num(s.assists),
});

export default function SensLog() {
  const { data: dpiState } = useApi<DpiTestState>('/api/blind/state');
  const { data: pendingData, loading } = useApi<{ rows: PendingMatch[] }>('/api/aim/pending?limit=40');
  const pending = pendingData?.rows ?? [];

  return (
    <div className="mt-2">
      <SensNav dataInspectId="sl-nav" />
      <div className="mb-6">
        <h1 data-inspect-id="sl-header-title" className="text-2xl heading-display text-[var(--ink)]">Sensitivity Study</h1>
        <p className="text-sm text-[var(--faint)] mt-1">Enter each match's combat details here after the game. DPI stage trials are driven from the panel below and land in the same queue.</p>
      </div>

      <BackfillPanel pending={pending} loading={loading} />

      <div className="mt-10 pt-8 border-t border-ow-border">
        <h2 data-inspect-id="sl-header-stage-trials" className="text-sm heading-display text-[var(--ink)] mb-1">Sens stage trials</h2>
        <p className="text-xs text-[var(--faint)] mb-4">Mouse DPI is locked at 1600 permanently — set your in-game sens to the value shown, play a batch, switch to the next stage. Log each game in the Match Tracker — it auto-tags to your current stage and queues up above for its combat details. Heroes can be tested in parallel — start as many as you like at once.</p>
        <PlanCard tabs={PLAN_TABS} state={dpiState} />
        <TestPanel state={dpiState} />
      </div>
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
interface PlanTab { key: string; label: string; description: string; plan: readonly PlanHero[] }

const valuesOf = (h: PlanHero): readonly number[] => h.senses ?? h.dpis ?? [];

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
function statusForHero(
  hero: string, actives: DpiTestActive[], sets: DpiTestSetSummary[], batchSize: number, values: readonly number[],
): { status: HeroTestStatus; totalGames: number; target: number; setId: number | null } {
  const nStages = values.length;
  const target = batchSize * nStages;
  const active = actives.find(a =>
    a.hero === hero && a.batch_size === batchSize && a.n_stages === nStages
    && sameValues(a.stages.map(s => s.sens ?? s.dpi), values));
  if (active) {
    return { status: active.completed ? 'completed' : 'testing', totalGames: active.totalGames, target, setId: active.set_id };
  }
  const past = [...sets]
    .filter(s => s.hero === hero && s.batch_size === batchSize && s.n_stages === nStages && sameValues(s.values, values))
    .sort((a, b) => b.set_id - a.set_id)[0];
  if (past && past.totalGames >= target) return { status: 'completed', totalGames: past.totalGames, target, setId: null };
  return { status: 'none', totalGames: 0, target, setId: null };
}

function PlanCard({ tabs, state }: { tabs: readonly PlanTab[]; state: DpiTestState | null }) {
  const { data } = useApi<{ sets: DpiTestSetSummary[] }>('/api/blind/sets');
  const sets = data?.sets ?? [];
  const actives = state?.actives ?? [];
  const [creating, setCreating] = useState<string | null>(null);
  // Default to the most recent phase — the one that's actually active.
  const [tabKey, setTabKey] = useState(tabs[tabs.length - 1].key);
  const { plan, description } = tabs.find(t => t.key === tabKey) ?? tabs[tabs.length - 1];

  const statuses = new Map(plan.map(h => [h.hero, statusForHero(h.hero, actives, sets, h.gamesPerSlot, valuesOf(h))]));
  const [cancelling, setCancelling] = useState(false);

  async function createSetForHero(h: PlanHero) {
    setCreating(h.hero);
    try {
      const body = h.senses
        ? { senses: h.senses, batch_size: h.gamesPerSlot, hero: h.hero }
        : { in_game_sens: 2.5, batch_size: h.gamesPerSlot, dpis: h.dpis, hero: h.hero };
      await fetch('/api/blind/sets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      revalidateAll();
    } finally { setCreating(null); }
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
        {tabs.map(t => (
          <button
            key={t.key} type="button" onClick={() => setTabKey(t.key)}
            data-inspect-id="sl-plan-tabs"
            className={`text-sm heading-display px-3 py-1.5 -mb-px border-b-2 transition-colors ${
              t.key === tabKey
                ? 'text-[var(--ink)] border-[var(--ink)]'
                : 'text-[var(--faint)] border-transparent hover:text-[var(--ink-2)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-[var(--faint)] mb-3">{description}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-inspect-id="sl-plan-hero-grid">
        {plan.map(h => {
          const s = statuses.get(h.hero)!;
          return (
            <div key={h.hero} className="relative rounded-lg bg-ow-darker border border-ow-border p-2.5 overflow-hidden">
              {s.status === 'testing' && (
                <div className="flex flex-col items-center gap-0.5 mb-1.5" data-inspect-id="sl-plan-status-badge">
                  <span className="text-xs font-bold uppercase tracking-wide text-amber-500">
                    In Testing · {s.totalGames}/{s.target} games
                  </span>
                  {s.setId != null && (
                    <button
                      type="button"
                      onClick={() => cancelActiveSet(s.setId!, h.hero, s.totalGames)}
                      disabled={cancelling}
                      data-inspect-id="sl-plan-cancel-btn"
                      className="text-[10px] text-red-400 hover:text-red-300 underline underline-offset-2 disabled:opacity-40"
                    >
                      Cancel test
                    </button>
                  )}
                </div>
              )}
              <div className={s.status === 'completed' ? 'opacity-30 pointer-events-none' : ''}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm hero-name text-[var(--ink)]">{h.hero}</span>
                  <span className="text-[10px] text-[var(--faint-2)] uppercase">{h.archetype}</span>
                </div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  {valuesOf(h).map(v => (
                    <span key={v} className="text-xs num-display text-[var(--ink)] bg-ow-border/40 rounded px-1.5 py-0.5">
                      {h.senses ? v.toFixed(2) : v}
                    </span>
                  ))}
                  <span className="text-[10px] text-[var(--faint-2)]">× <b className="font-bold">{h.gamesPerSlot}</b>/slot</span>
                </div>
                <p className="text-[11px] text-[var(--faint)] leading-snug mb-2">{h.note}</p>
                {s.status === 'none' && (
                  <button
                    type="button" onClick={() => createSetForHero(h)} disabled={creating === h.hero}
                    data-inspect-id="sl-plan-create-btn"
                    className={`${btnSecondary} w-full py-1.5 text-xs`}
                  >
                    {creating === h.hero ? 'Creating…' : 'Create test set'}
                  </button>
                )}
              </div>

              {s.status === 'completed' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-ow-card/40 backdrop-blur-[1px]">
                  <span
                    data-inspect-id="sl-plan-status-badge"
                    className="heading-display text-[45px] leading-none text-center drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)] text-emerald-500"
                  >
                    Completed
                  </span>
                  <span className="text-xs font-semibold num-display text-[var(--ink)] drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">{s.totalGames} / {s.target} games</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
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

  async function advance() {
    setBusy(true);
    try {
      const r = await fetch('/api/blind/advance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ set_id: active.set_id }),
      });
      if (r.ok) revalidateAll();
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
          <h2 className="text-sm heading-display text-[var(--ink)]">{title} — complete</h2>
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
      <h2 className="text-sm heading-display text-[var(--ink)] mb-1">Create an ad-hoc sens test set</h2>
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
      </div>
      <div className="mb-4">
        <span className="block text-xs text-[var(--muted)] mb-1.5">In-game sens per stage</span>
        <div className="grid grid-cols-3 gap-2" data-inspect-id="sl-sens-per-stage-inputs">
          {senses.map((s, i) => (
            <input
              key={i} type="number" step="0.01" className={field} value={s} placeholder={`Stage ${i + 1}`}
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

// Inline edit form for a pending-match card — corrects hero(es), match type
// (queue mode), and sens before stats are entered. Saved via a PUT, which
// also re-derives that match's stage-test credit server-side (a hero/mode
// edit can move it onto a different active DPI test, or off one entirely),
// so games_on_stage counters stay accurate rather than reflecting the
// pre-edit hero.
function EditMatchForm({ match, onClose }: { match: PendingMatch; onClose: () => void }) {
  const [hero, setHero] = useState(match.hero);
  const [extra, setExtra] = useState<string[]>(match.heroes.slice(1).map(h => h.hero));
  const [queueMode, setQueueMode] = useState<QueueMode>(match.queue_mode);
  const [sens, setSens] = useState(match.sens != null ? String(match.sens) : '');
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');

  function addHero() { setExtra(e => (e.length >= 2 ? e : [...e, HERO_LIST[0][0]])); }
  function updateHero(i: number, h: string) { setExtra(e => e.map((x, idx) => (idx === i ? h : x))); }
  function removeHero(i: number) { setExtra(e => e.filter((_, idx) => idx !== i)); }

  async function save() {
    setStatus('saving');
    try {
      const res = await fetch(`/api/matches/${match.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hero, role: HEROES[hero], queue_mode: queueMode, sens: num(sens),
          heroes: extra.map(h => ({ hero: h, role: HEROES[h] })),
        }),
      });
      if (!res.ok) throw new Error('save failed');
      revalidateAll();
      onClose();
    } catch { setStatus('error'); }
  }

  const heroSelect = (value: string, onChange: (h: string) => void, key: string) => (
    <select key={key} value={value} onChange={e => onChange(e.target.value)} className="flex-1 field px-2 py-1.5 text-xs">
      {(['DPS', 'Tank', 'Support'] as const).map(role => (
        <optgroup key={role} label={role}>
          {HERO_LIST.filter(([, r]) => r === role).map(([h]) => <option key={h} value={h}>{h}</option>)}
        </optgroup>
      ))}
    </select>
  );

  return (
    <div className="border-t border-ow-border px-3 py-3 space-y-3" data-inspect-id="sl-edit-match-form">
      <div>
        <label className="block text-[10px] text-[var(--faint)] mb-1">Hero</label>
        {heroSelect(hero, setHero, 'primary')}
        {extra.length > 0 && (
          <div className="mt-1.5 space-y-1.5">
            {extra.map((h, i) => (
              <div key={i} className="flex items-center gap-1.5">
                {heroSelect(h, v => updateHero(i, v), `extra-${i}`)}
                <button type="button" onClick={() => removeHero(i)} aria-label="Remove hero" className="text-[var(--faint)] hover:text-red-600 text-sm px-1">×</button>
              </div>
            ))}
          </div>
        )}
        {extra.length < 2 && (
          <button type="button" onClick={addHero} className="mt-1.5 w-full py-1 rounded border border-dashed border-ow-border text-[10px] text-[var(--faint)] hover:text-[var(--ink)] hover:border-gray-500 transition-colors">
            + Add hero switch
          </button>
        )}
      </div>
      <div>
        <label className="block text-[10px] text-[var(--faint)] mb-1">Match Type</label>
        <div className="grid grid-cols-3 gap-1.5">
          {QUEUE_MODES.map(qm => {
            const c = QUEUE_MODE_COLORS[qm.value]; const on = queueMode === qm.value;
            return (
              <button key={qm.value} type="button" onClick={() => setQueueMode(qm.value)}
                className={`py-1.5 rounded border text-[10px] font-semibold transition-all ${on ? `${c.card} ${c.accent}` : 'border-ow-border text-[var(--faint)] hover:text-[var(--ink)]'}`}>
                {MODE_TAG[qm.value]}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <label className="block text-[10px] text-[var(--faint)] mb-1">Sens</label>
        <input type="number" step="0.01" min="0" inputMode="decimal" value={sens} onChange={e => setSens(e.target.value)}
          className="w-24 field px-2 py-1.5 text-xs num-display" placeholder="—" aria-label="Sensitivity" />
      </div>
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={save} disabled={status === 'saving'} data-inspect-id="sl-edit-match-save-btn" className="flex-1 btn-primary py-1.5 text-xs">
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onClose} className="flex-1 py-1.5 rounded-lg border border-ow-border text-[var(--faint)] text-xs hover:text-[var(--ink)] transition-colors">
          Cancel
        </button>
      </div>
      {status === 'error' && <p className="text-red-600 text-[10px] text-center">Failed to save</p>}
    </div>
  );
}

// ── Non-blind backfill (matches logged elsewhere that still need stats) ───────
function BackfillPanel({ pending, loading }: {
  pending: PendingMatch[]; loading: boolean;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sens, setSens] = useState('');
  const [stats, setStats] = useState<StatFieldsT>(emptyStats([]));
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [showCaughtUp, setShowCaughtUp] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const selected = pending.find(m => m.id === selectedId) ?? null;
  const showHealing = selected ? selected.heroes.some(h => h.role === 'Support') : false;
  const durationRef = useRef<HTMLInputElement>(null);
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();
  const navigate = useNavigate();

  // Matches already logged today — a record of what's been entered, with the
  // same select-to-expand editing as the pending list above.
  const today = format(new Date(), 'yyyy-MM-dd');
  const { data: loggedData, loading: loggedLoading } = useApi<{ rows: LoggedMatch[] }>(`/api/aim/today?date=${today}`);
  const logged = loggedData?.rows ?? [];
  const [loggedSelectedId, setLoggedSelectedId] = useState<number | null>(null);
  const [loggedSens, setLoggedSens] = useState('');
  const [loggedStats, setLoggedStats] = useState<StatFieldsT>(emptyStats([]));
  const [loggedStatus, setLoggedStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [loggedEditingId, setLoggedEditingId] = useState<number | null>(null);
  const loggedSelected = logged.find(m => m.id === loggedSelectedId) ?? null;
  const loggedShowHealing = loggedSelected ? loggedSelected.heroes.some(h => h.role === 'Support') : false;

  function toggleLogged(m: LoggedMatch) {
    if (m.id === loggedSelectedId) { setLoggedSelectedId(null); return; }
    setLoggedSelectedId(m.id);
    setLoggedSens(m.sens != null ? String(m.sens) : '');
    setLoggedStats(statsFromLogged(m));
    setLoggedStatus('idle');
  }

  const loggedPrimaryAccValid = parseFloat(loggedStats.heroAcc[0]?.overall_acc ?? '') >= 0;
  const loggedDurationsValid = loggedStats.heroAcc.length > 0 && loggedStats.heroAcc.every(h => parseDurationMin(h.duration_min) != null);

  async function saveLogged() {
    if (!loggedSelected || !(loggedPrimaryAccValid && loggedDurationsValid)) return;
    setLoggedStatus('saving');
    try {
      const putRes = await fetch(`/api/matches/${loggedSelected.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sens: num(loggedSens) }) });
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
    setSens(m.sens != null ? String(m.sens) : '');
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
      const putRes = await fetch(`/api/matches/${selected.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sens: num(sens) }) });
      if (!putRes.ok) throw new Error('sens save failed');
      const res = await fetch('/api/aim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(statsBody(selected.id, stats)) });
      if (!res.ok) throw new Error('save failed');
      // This was the last pending match — the backlog is about to hit zero.
      if (pending.length === 1) setShowCaughtUp(true);
      setStatus('success'); setSelectedId(null); setStats(emptyStats([])); setSens('');
      revalidateAll();
      setTimeout(() => setStatus('idle'), 1800);
    } catch { setStatus('error'); setTimeout(() => setStatus('idle'), 3000); }
  }

  return (
    <div>
      <h2 data-inspect-id="sl-record-combat-header" className="text-sm heading-display text-[var(--ink)] mb-1">Record combat details</h2>
      <p className="text-xs text-[var(--faint)] mb-4">Every match awaiting its aim stats. Matches are logged in the Match Tracker; while a stage test is running they arrive here already tagged with that stage's DPI.</p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="card" data-inspect-id="sl-aim-stats-card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm heading-display text-[var(--ink)]">Awaiting Stats</h3>
          <span className="text-xs text-[var(--faint)]"><b className="font-bold">{pending.length}</b> pending</span>
        </div>
        {loading ? <p className="text-xs text-[var(--faint)]">Loading…</p>
          : pending.length === 0 ? <p className="text-xs text-[var(--faint)]">All caught up.</p>
          : (
            <div className="space-y-2" data-inspect-id="sl-awaiting-stats-list">
              {pending.map(m => {
                const c = QUEUE_MODE_COLORS[m.queue_mode]; const active = m.id === selectedId;
                const editing = m.id === editingId;
                return (
                  <div key={m.id} className={`rounded-lg border transition-all ${active ? `${c.card} ${c.accent} ${c.glow}` : 'border-ow-border bg-ow-darker hover:border-gray-500'}`}>
                    <div className="flex items-stretch">
                      <button type="button" onClick={() => toggleMatch(m)} className="flex-1 min-w-0 text-left py-2.5 pl-3 pr-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0 flex-wrap">
                            {m.heroes.map(h => (
                              <span key={h.hero} className={`pill hero-name ${ROLE_COLORS[h.role] ?? ''}`}>{withHeroCount(h.hero, heroCounts)}</span>
                            ))}
                            <span className="text-xs map-name text-[var(--ink)] truncate">{withMapCount(m.map, mapCounts)}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={`text-xs font-bold ${m.win ? 'text-emerald-500' : 'text-red-500'}`}>{m.win ? 'W' : 'L'}</span>
                            <span className="text-[10px] font-bold text-[var(--faint-2)]">{MODE_TAG[m.queue_mode]}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-[11px] text-[var(--faint)]">
                          <span>{m.time ? format(new Date(m.time), 'MMM d, h:mm a') : m.date}</span><span>·</span>
                          <span>{m.stage_index != null ? <>stage <b className="font-bold">{m.stage_index}</b> · sens <b className="font-bold">{m.sens}</b></> : m.sens != null ? <>sens <b className="font-bold">{m.sens}</b></> : 'no sens'}</span>
                        </div>
                      </button>
                      <button type="button" onClick={() => setEditingId(editing ? null : m.id)} aria-label="Edit match"
                        data-inspect-id="sl-awaiting-stats-edit-btn"
                        className="shrink-0 px-2.5 text-[var(--faint)] hover:text-[var(--ink)] transition-colors">
                        ✎
                      </button>
                    </div>
                    {editing && <EditMatchForm match={m} onClose={() => setEditingId(null)} />}
                    {active && (
                      <div className="border-t border-ow-border px-3 py-3 space-y-4" data-inspect-id="sl-inline-stats-form">
                        <div className="flex items-center gap-2">
                          {m.stage_index != null && <span className="text-[11px] text-ow-accent font-bold">Stage {m.stage_index}</span>}
                          <label className="text-[11px] text-[var(--faint)]">Sens</label>
                          <input type="number" step="0.01" min="0" inputMode="decimal" value={sens} onChange={e => setSens(e.target.value)} data-inspect-id="sl-sens-input" className="w-24 field px-2 py-1 text-sm num-display" placeholder="—" aria-label="Sensitivity" />
                          {parseFloat(sens) > 0 && <span className="text-[11px] text-[var(--faint)] font-bold">{Math.round(eDPI(parseFloat(sens)))} eDPI</span>}
                        </div>
                        <StatFields
                          s={stats}
                          upd={(k, v) => setStats(s => ({ ...s, [k]: v }))}
                          updHeroAcc={(i, k, v) => setStats(s => ({ ...s, heroAcc: s.heroAcc.map((h, hi) => hi === i ? { ...h, [k]: v } : h) }))}
                          showHealing={showHealing}
                          firstDurationRef={durationRef}
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
          <h3 className="text-sm heading-display text-[var(--ink)]">Logged Today</h3>
          <span className="text-xs text-[var(--faint)]"><b className="font-bold">{logged.length}</b> logged</span>
        </div>
        {loggedLoading ? <p className="text-xs text-[var(--faint)]">Loading…</p>
          : logged.length === 0 ? <p className="text-xs text-[var(--faint)]">Nothing logged yet today.</p>
          : (
            <div className="space-y-2" data-inspect-id="sl-logged-today-list">
              {logged.map(m => {
                const c = QUEUE_MODE_COLORS[m.queue_mode]; const active = m.id === loggedSelectedId;
                const editing = m.id === loggedEditingId;
                return (
                  <div key={m.id} className={`rounded-lg border transition-all ${active ? `${c.card} ${c.accent} ${c.glow}` : 'border-ow-border bg-ow-darker hover:border-gray-500'}`}>
                    <div className="flex items-stretch">
                      <button type="button" onClick={() => toggleLogged(m)} className="flex-1 min-w-0 text-left py-2.5 pl-3 pr-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0 flex-wrap">
                            {m.heroes.map(h => (
                              <span key={h.hero} className={`pill hero-name ${ROLE_COLORS[h.role] ?? ''}`}>{withHeroCount(h.hero, heroCounts)}</span>
                            ))}
                            <span className="text-xs map-name text-[var(--ink)] truncate">{withMapCount(m.map, mapCounts)}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={`text-xs font-bold ${m.win ? 'text-emerald-500' : 'text-red-500'}`}>{m.win ? 'W' : 'L'}</span>
                            <span className="text-[10px] font-bold text-[var(--faint-2)]">{MODE_TAG[m.queue_mode]}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-[11px] text-[var(--faint)]">
                          <span>{m.time ? format(new Date(m.time), 'MMM d, h:mm a') : m.date}</span><span>·</span>
                          <span>{m.stage_index != null ? <>stage <b className="font-bold">{m.stage_index}</b> · sens <b className="font-bold">{m.sens}</b></> : m.sens != null ? <>sens <b className="font-bold">{m.sens}</b></> : 'no sens'}</span>
                        </div>
                      </button>
                      <button type="button" onClick={() => setLoggedEditingId(editing ? null : m.id)} aria-label="Edit match"
                        data-inspect-id="sl-logged-today-edit-btn"
                        className="shrink-0 px-2.5 text-[var(--faint)] hover:text-[var(--ink)] transition-colors">
                        ✎
                      </button>
                    </div>
                    {editing && <EditMatchForm match={m} onClose={() => setLoggedEditingId(null)} />}
                    {active && (
                      <div className="border-t border-ow-border px-3 py-3 space-y-4" data-inspect-id="sl-logged-today-stats-form">
                        <div className="flex items-center gap-2">
                          {m.stage_index != null && <span className="text-[11px] text-ow-accent font-bold">Stage {m.stage_index}</span>}
                          <label className="text-[11px] text-[var(--faint)]">Sens</label>
                          <input type="number" step="0.01" min="0" inputMode="decimal" value={loggedSens} onChange={e => setLoggedSens(e.target.value)} className="w-24 field px-2 py-1 text-sm num-display" placeholder="—" aria-label="Sensitivity" />
                          {parseFloat(loggedSens) > 0 && <span className="text-[11px] text-[var(--faint)] font-bold">{Math.round(eDPI(parseFloat(loggedSens)))} eDPI</span>}
                        </div>
                        <StatFields
                          s={loggedStats}
                          upd={(k, v) => setLoggedStats(s => ({ ...s, [k]: v }))}
                          updHeroAcc={(i, k, v) => setLoggedStats(s => ({ ...s, heroAcc: s.heroAcc.map((h, hi) => hi === i ? { ...h, [k]: v } : h) }))}
                          showHealing={loggedShowHealing}
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
            <h3 className="text-sm heading-display text-[var(--ink)] mb-1.5">All caught up</h3>
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

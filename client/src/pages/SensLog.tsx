import { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi, revalidateAll } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { eDPI, MOUSE_DPI } from '../lib/aim';
import {
  QueueMode, QUEUE_MODE_COLORS, MODE_TAG, HEROES, ROLE_COLORS,
} from '../types';
import { format } from 'date-fns';
import SensNav from '../components/SensNav';

// ── Types ────────────────────────────────────────────────────────────────────
interface PendingMatch {
  id: number; date: string; time: string | null;
  hero: string; role: string; map: string; game_type: string;
  queue_mode: QueueMode; win: 0 | 1; sens: number | null;
  stage_index?: number | null;
}
// A stage-trial set as returned by /api/blind/state. Several can be active at
// once — one per hero, plus at most one ad-hoc (hero-less) set — so the UI
// renders a card per entry rather than assuming a single global test.
interface DpiTestActive {
  set_id: number; in_game_sens: number; base_dpi: number; created_at: string;
  batch_size: number; cur_stage: number; games_on_stage: number;
  dpi: number | null; n_stages: number;
  hero: string | null; totalGames: number; completed: boolean;
  needSwitch: boolean;
  stages: { stage_index: number; dpi: number }[];
}
interface DpiTestState {
  actives: DpiTestActive[];
}
interface DpiTestSetSummary {
  set_id: number; hero: string | null; active: boolean; completed: boolean;
  batch_size: number; n_stages: number; totalGames: number; created_at: string;
}
interface AnswerStage {
  stage_index: number; dpi: number; pct_delta: number;
  eDPI: number; cm360: number; n: number; feelMean: number | null; feelVar: number | null;
}
interface StatFieldsT {
  overall_acc: string; crit_acc: string; hero_stat_label: string; hero_stat_value: string;
  elims: string; final_blows: string; deaths: string; damage: string; duration_min: string;
}

const EMPTY_STATS: StatFieldsT = {
  overall_acc: '', crit_acc: '', hero_stat_label: '', hero_stat_value: '',
  elims: '', final_blows: '', deaths: '', damage: '', duration_min: '',
};

const HERO_STAT_DEFAULT: Record<string, string> = {
  Ashe: 'scoped crit %', Widowmaker: 'scoped crit %', Hanzo: 'scoped crit %', Ana: 'unscoped crit %',
  Cassidy: 'crit %', 'Soldier: 76': 'crit %', Sojourn: 'railgun crit %', Sombra: 'crit %',
  Reaper: 'crit %', Genji: 'crit %', Bastion: 'crit %', Zenyatta: 'crit %', Baptiste: 'crit %', Venture: 'crit %',
};

const num = (s: string) => (s.trim() === '' ? null : parseFloat(s));
const field = 'w-full field px-3 py-2 text-sm';
const btnSecondary = 'border border-ow-border rounded-lg text-[var(--ink)] font-semibold hover:border-gray-500 transition-all disabled:opacity-40 disabled:cursor-not-allowed';

// ── Shared aim-stat inputs (used by both the stage-trial loop and the backfill form) ─
function StatFields({ s, upd, knownLabels }: {
  s: StatFieldsT; upd: <K extends keyof StatFieldsT>(k: K, v: StatFieldsT[K]) => void; knownLabels: string[];
}) {
  const t = (k: keyof StatFieldsT) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => upd(k, e.target.value as never);
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-[var(--muted)] mb-1.5">Overall accuracy %</label>
          <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={s.overall_acc} onChange={t('overall_acc')} data-inspect-id="sl-overall-acc-input" className={field} placeholder="e.g. 41.2" />
        </div>
        <div>
          <label className="block text-xs text-[var(--muted)] mb-1.5">Crit accuracy % <span className="text-[var(--faint-2)]">— if it applies</span></label>
          <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={s.crit_acc} onChange={t('crit_acc')} data-inspect-id="sl-crit-acc-input" className={field} placeholder="e.g. 22.5" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-[var(--muted)] mb-1.5">Hero-specific stat <span className="text-[var(--faint-2)]">— remembered per hero</span></label>
          <input type="text" list="hero-stat-labels" value={s.hero_stat_label} onChange={t('hero_stat_label')} data-inspect-id="sl-hero-stat-input" className={field} placeholder="e.g. scoped crit %" />
          <datalist id="hero-stat-labels">{knownLabels.map(l => <option key={l} value={l} />)}</datalist>
        </div>
        <div>
          <label className="block text-xs text-[var(--muted)] mb-1.5">Value</label>
          <input type="number" step="0.1" inputMode="decimal" value={s.hero_stat_value} onChange={t('hero_stat_value')} data-inspect-id="sl-hero-stat-value-input" className={field} placeholder="e.g. 30.1" />
        </div>
      </div>
      <div>
        <label className="block text-xs text-[var(--muted)] mb-1.5">Combat <span className="text-[var(--faint-2)]">— endgame scoreboard</span></label>
        <div className="grid grid-cols-4 gap-2" data-inspect-id="sl-combat-stats-inputs">
          {([['final_blows', 'Finals'], ['elims', 'Elims'], ['deaths', 'Deaths'], ['damage', 'Damage']] as const).map(([key, lbl]) => (
            <div key={key}>
              <input type="number" min="0" step="1" inputMode="numeric" value={s[key]} onChange={t(key)} className="w-full field px-2 py-2 text-sm" placeholder="0" aria-label={lbl} />
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
  overall_acc: num(s.overall_acc), crit_acc: num(s.crit_acc),
  hero_stat_label: s.hero_stat_label.trim() || null, hero_stat_value: num(s.hero_stat_value),
  elims: num(s.elims), final_blows: num(s.final_blows), deaths: num(s.deaths), damage: num(s.damage),
  duration_min: num(s.duration_min),
});

export default function SensLog() {
  const { data: dpiState } = useApi<DpiTestState>('/api/blind/state');
  const { data: pendingData, loading } = useApi<{ rows: PendingMatch[] }>('/api/aim/pending?limit=40');
  const pending = pendingData?.rows ?? [];
  const { data: loggedData } = useApi<{ rows: { hero: string; hero_stat_label: string | null }[] }>('/api/aim');

  const heroMemory = useMemo(() => {
    const m: Record<string, string> = {};
    for (const r of loggedData?.rows ?? []) if (r.hero_stat_label && !(r.hero in m)) m[r.hero] = r.hero_stat_label;
    return m;
  }, [loggedData]);
  const labelFor = (hero: string) => heroMemory[hero] ?? HERO_STAT_DEFAULT[hero] ?? '';
  const knownLabels = useMemo(
    () => [...new Set([...Object.values(HERO_STAT_DEFAULT), ...Object.values(heroMemory)])].sort(),
    [heroMemory],
  );

  return (
    <div className="mt-2">
      <SensNav dataInspectId="sl-nav" />
      <div className="mb-6">
        <h1 data-inspect-id="sl-header-title" className="text-2xl heading-display text-[var(--ink)]">Sensitivity Study</h1>
        <p className="text-sm text-[var(--faint)] mt-1">Enter each match's combat details here after the game. DPI stage trials are driven from the panel below and land in the same queue.</p>
      </div>

      <BackfillPanel pending={pending} loading={loading} knownLabels={knownLabels} labelFor={labelFor} />

      <div className="mt-10 pt-8 border-t border-ow-border">
        <h2 data-inspect-id="sl-header-stage-trials" className="text-sm heading-display text-[var(--ink)] mb-1">DPI stage trials</h2>
        <p className="text-xs text-[var(--faint)] mb-4">Set your mouse to the DPI shown, play a batch, switch to the next stage. Log each game in the Match Tracker — it auto-tags to your current stage and queues up above for its combat details. Heroes can be tested in parallel — start as many as you like at once.</p>
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
// ±50 DPI bracket around each hero's Phase 3 leader (0.4×win% + 0.4×acc% +
// 0.2×secondary-stat weighting), 5 games/stage instead of 12 — switching to
// Competitive since QP win% proved too unreliable (bad teammates, ~30-40% of
// matches) to trust at the narrower gap. Originally spec'd as ±25, widened to
// ±50 on 2026-08-05 — the mouse software's DPI field floors at 50-unit
// increments, so 25-unit offsets (1725, 1775, etc.) aren't settable in hardware.
const PHASE4_PLAN = [
  {
    hero: 'Sojourn', archetype: 'Hitscan', dpis: [1700, 1800], gamesPerSlot: 5,
    note: 'Phase 3 leaned 1750 on win%/hero-stat, but ~half that win-rate gap turned out to be map-mix, not DPI — hold this one loosely.',
  },
  {
    hero: 'Pharah', archetype: 'Projectile', dpis: [1450, 1550], gamesPerSlot: 5,
    note: "75%-vs-42% swing toward 1500 in Phase 3 survived a map-mix check better than Sojourn's did, but acc/hero-stat still favor 1750 — the most contested pick of the four.",
  },
  {
    hero: 'Shion', archetype: 'Hitscan', dpis: [1700, 1800], gamesPerSlot: 5,
    note: 'Cleanest Phase 3 signal — win%, acc, crit%, and kills all agreed on 1750, and it held up after adjusting for map mix. Also matches the DPI you said you were hating (1850) losing decisively.',
  },
  {
    hero: 'Tracer', archetype: 'Hitscan', dpis: [1650, 1750], gamesPerSlot: 5,
    note: 'Phase 3 was a near-exact tie on the weighted score — 1700 edges it only on Pulse Bomb Attach% and elims. Basically a coin flip; this round is to break it.',
  },
] as const;

interface PlanHero { hero: string; archetype: string; dpis: readonly number[]; gamesPerSlot: number; note: string }
interface PlanTab { key: string; label: string; description: string; plan: readonly PlanHero[] }

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
    description: `In-game sens frozen at 2.50. Narrow ±50 DPI bracket around each Phase 3 leader (mouse DPI floors at 50-unit steps), now on Competitive instead of QP. ${PHASE4_PLAN.length} heroes × 2 DPI levels, ${PHASE4_PLAN.reduce((sum, h) => sum + h.dpis.length * h.gamesPerSlot, 0)} games total.`,
  },
];

type HeroTestStatus = 'none' | 'testing' | 'completed';

// A hero's status comes from whichever set is authoritative for it: an active
// set tagged to this hero (live progress — several heroes can each have one
// active at once, tested in parallel), otherwise its most recent past set (so
// "Completed" survives after that hero's active set finishes). Matches a set
// to this plan entry by hero AND shape (batch size × stage count) — not just
// hero name — so an earlier phase's completed set for the same hero doesn't
// get mistaken for this phase's progress.
function statusForHero(
  hero: string, actives: DpiTestActive[], sets: DpiTestSetSummary[], batchSize: number, nStages: number,
): { status: HeroTestStatus; totalGames: number; target: number; setId: number | null } {
  const target = batchSize * nStages;
  const active = actives.find(a => a.hero === hero && a.batch_size === batchSize && a.n_stages === nStages);
  if (active) {
    return { status: active.completed ? 'completed' : 'testing', totalGames: active.totalGames, target, setId: active.set_id };
  }
  const past = [...sets]
    .filter(s => s.hero === hero && s.batch_size === batchSize && s.n_stages === nStages)
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

  const statuses = new Map(plan.map(h => [h.hero, statusForHero(h.hero, actives, sets, h.gamesPerSlot, h.dpis.length)]));
  const [cancelling, setCancelling] = useState(false);

  async function createSetForHero(h: PlanHero) {
    setCreating(h.hero);
    try {
      await fetch('/api/blind/sets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ in_game_sens: 2.5, batch_size: h.gamesPerSlot, dpis: h.dpis, hero: h.hero }),
      });
      revalidateAll();
    } finally { setCreating(null); }
  }

  async function cancelActiveSet(setId: number, hero: string, games: number) {
    if (games > 0) {
      // Real data at stake — require a deliberate typed confirmation, not a click-through.
      const typed = prompt(
        `This will permanently DELETE the ${hero} test set AND all ${games} game${games === 1 ? '' : 's'} logged against it. This cannot be undone.\n\nType ${games} to confirm:`,
      );
      if (typed?.trim() !== String(games)) return;
    } else if (!confirm(`Cancel the ${hero} test set? No games have been logged yet.`)) {
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
              <div className={s.status !== 'none' ? 'opacity-30 pointer-events-none' : ''}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-[var(--ink)]">{h.hero}</span>
                  <span className="text-[10px] text-[var(--faint-2)] uppercase">{h.archetype}</span>
                </div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  {h.dpis.map(d => (
                    <span key={d} className="text-xs num-display text-[var(--ink)] bg-ow-border/40 rounded px-1.5 py-0.5">{d}</span>
                  ))}
                  <span className="text-[10px] text-[var(--faint-2)]">× {h.gamesPerSlot}/slot</span>
                </div>
                <p className="text-[11px] text-[var(--faint)] leading-snug mb-2">{h.note}</p>
                <button
                  type="button" onClick={() => createSetForHero(h)} disabled={creating === h.hero}
                  data-inspect-id="sl-plan-create-btn"
                  className={`${btnSecondary} w-full py-1.5 text-xs`}
                >
                  {creating === h.hero ? 'Creating…' : 'Create test set'}
                </button>
              </div>

              {s.status !== 'none' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-ow-card/40 backdrop-blur-[1px]">
                  <span
                    data-inspect-id="sl-plan-status-badge"
                    className={`heading-display text-[45px] leading-none text-center drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)] ${s.status === 'testing' ? 'text-amber-500' : 'text-emerald-500'}`}
                  >
                    {s.status === 'testing' ? 'In Testing' : 'Completed'}
                  </span>
                  <span className="text-xs font-semibold num-display text-[var(--ink)] drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">{s.totalGames} / {s.target} games</span>
                  {s.status === 'testing' && s.setId != null && (
                    <button
                      type="button"
                      onClick={() => cancelActiveSet(s.setId!, h.hero, s.totalGames)}
                      disabled={cancelling}
                      data-inspect-id="sl-plan-cancel-btn"
                      className="mt-1 text-[10px] text-red-400 hover:text-red-300 underline underline-offset-2 disabled:opacity-40"
                    >
                      Cancel test
                    </button>
                  )}
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
  return (
    <div className="space-y-6 mb-6">
      {actives.map(active => <ActiveTestCard key={active.set_id} active={active} />)}
      <CreateTestCard />
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
        <div className="text-xs text-[var(--faint)] mb-1">
          {active.hero ? `${active.hero} — ` : ''}Stage {active.cur_stage} of {active.n_stages} — set your mouse to
        </div>
        <div className="text-5xl heading-display text-[var(--ink)] my-2 num-display">{active.dpi ?? '—'}</div>
        <div className="text-xs text-[var(--faint)]">DPI, in-game sens <b className="num-display">{active.in_game_sens.toFixed(2)}</b></div>
        {active.needSwitch ? (
          <>
            <div className="text-xs text-amber-500 font-semibold mt-4 mb-1">Batch complete — switch stages</div>
            <button type="button" onClick={advance} disabled={busy} data-inspect-id="sl-advance-stage-btn" className={`${btnSecondary} w-full py-2 text-sm mt-2`}>Get next stage →</button>
          </>
        ) : (
          <>
            <div className="text-2xl heading-display text-[var(--ink)] mt-4">{gamesLeft}</div>
            <div className="text-xs text-[var(--faint)]">game{gamesLeft === 1 ? '' : 's'} left in this batch (of {active.batch_size})</div>
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
  const [inGameSens, setInGameSens] = useState('2.50');
  const [batchSize, setBatchSize] = useState('12');
  const [dpis, setDpis] = useState<string[]>(['1500', '1600', '1700']);
  const [busy, setBusy] = useState(false);

  // Resize the DPI list to a new slot count, keeping existing values and
  // padding new slots off the last one so a bigger test starts from something
  // sane instead of blank.
  function setSlotCount(nStr: string) {
    const n = Math.max(2, parseInt(nStr) || 2);
    setDpis(prev => {
      const next = prev.slice(0, n);
      while (next.length < n) next.push(next[next.length - 1] ?? '1600');
      return next;
    });
  }

  async function createSet() {
    setBusy(true);
    try {
      const res = await fetch('/api/blind/sets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          in_game_sens: parseFloat(inGameSens), batch_size: parseInt(batchSize),
          dpis: dpis.map(d => parseInt(d)),
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
      <h2 className="text-sm heading-display text-[var(--ink)] mb-1">Create an ad-hoc DPI test set</h2>
      <p className="text-xs text-[var(--faint)] mb-4">Pick each stage's DPI directly — e.g. levels chosen per hero from the analysis page. Type them into your mouse's DPI stages in this same order; the current stage's value stays visible on screen the whole test.</p>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <label className="block">
          <span className="block text-xs text-[var(--muted)] mb-1.5">In-game sens (frozen)</span>
          <input type="number" step="0.01" data-inspect-id="sl-ingame-sens-input" className={field} value={inGameSens} onChange={e => setInGameSens(e.target.value)} />
        </label>
        <label className="block">
          <span className="block text-xs text-[var(--muted)] mb-1.5"># Stages</span>
          <input type="number" step="1" min="2" data-inspect-id="sl-num-stages-input" className={field} value={dpis.length} onChange={e => setSlotCount(e.target.value)} />
        </label>
        <label className="block col-span-2">
          <span className="block text-xs text-[var(--muted)] mb-1.5">Games per stage (samples)</span>
          <input type="number" step="1" min="1" data-inspect-id="sl-games-per-stage-input" className={field} value={batchSize} onChange={e => setBatchSize(e.target.value)} />
        </label>
      </div>
      <div className="mb-4">
        <span className="block text-xs text-[var(--muted)] mb-1.5">DPI per stage</span>
        <div className="grid grid-cols-3 gap-2" data-inspect-id="sl-dpi-per-stage-inputs">
          {dpis.map((d, i) => (
            <input
              key={i} type="number" step="50" className={field} value={d} placeholder={`Stage ${i + 1}`}
              onChange={e => setDpis(prev => prev.map((v, vi) => (vi === i ? e.target.value : v)))}
              aria-label={`Stage ${i + 1} DPI`}
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
          {[...stages].sort((a, b) => a.dpi - b.dpi).map(s => (
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
function BackfillPanel({ pending, loading, knownLabels, labelFor }: {
  pending: PendingMatch[]; loading: boolean; knownLabels: string[]; labelFor: (h: string) => string;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sens, setSens] = useState('');
  const [stats, setStats] = useState<StatFieldsT>(EMPTY_STATS);
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [showCaughtUp, setShowCaughtUp] = useState(false);
  const selected = pending.find(m => m.id === selectedId) ?? null;
  const durationRef = useRef<HTMLInputElement>(null);
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();
  const navigate = useNavigate();

  // Selecting a card should land the cursor on Duration — the required field and
  // the whole point of the backfill — so it's type-ready without a second click.
  useEffect(() => {
    if (selectedId != null) durationRef.current?.focus();
  }, [selectedId]);

  function selectMatch(m: PendingMatch) {
    setSelectedId(m.id);
    setSens(m.sens != null ? String(m.sens) : '');
    setStats({ ...EMPTY_STATS, hero_stat_label: labelFor(m.hero) });
    setStatus('idle');
  }

  async function save() {
    if (!selected || !(parseFloat(stats.overall_acc) >= 0 && parseFloat(stats.duration_min) > 0)) return;
    setStatus('saving');
    try {
      const putRes = await fetch(`/api/matches/${selected.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sens: num(sens) }) });
      if (!putRes.ok) throw new Error('sens save failed');
      const res = await fetch('/api/aim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(statsBody(selected.id, stats)) });
      if (!res.ok) throw new Error('save failed');
      // This was the last pending match — the backlog is about to hit zero.
      if (pending.length === 1) setShowCaughtUp(true);
      setStatus('success'); setSelectedId(null); setStats(EMPTY_STATS); setSens('');
      revalidateAll();
      setTimeout(() => setStatus('idle'), 1800);
    } catch { setStatus('error'); setTimeout(() => setStatus('idle'), 3000); }
  }

  return (
    <div>
      <h2 data-inspect-id="sl-record-combat-header" className="text-sm heading-display text-[var(--ink)] mb-1">Record combat details</h2>
      <p className="text-xs text-[var(--faint)] mb-4">Every match awaiting its aim stats. Matches are logged in the Match Tracker; while a stage test is running they arrive here already tagged with that stage's DPI.</p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm heading-display text-[var(--ink)]">Awaiting Stats</h3>
            <span className="text-xs text-[var(--faint)]">{pending.length} pending</span>
          </div>
          {loading ? <p className="text-xs text-[var(--faint)]">Loading…</p>
            : pending.length === 0 ? <p className="text-xs text-[var(--faint)]">All caught up.</p>
            : (
              <div className="space-y-2" data-inspect-id="sl-awaiting-stats-list">
                {pending.map(m => {
                  const c = QUEUE_MODE_COLORS[m.queue_mode]; const active = m.id === selectedId;
                  return (
                    <button key={m.id} type="button" onClick={() => selectMatch(m)}
                      className={`w-full text-left py-2.5 px-3 rounded-lg border transition-all ${active ? `${c.card} ${c.accent} ${c.glow}` : 'border-ow-border bg-ow-darker hover:border-gray-500'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`pill ${ROLE_COLORS[m.role] ?? ''}`}>{withHeroCount(m.hero, heroCounts)}</span>
                          <span className="text-sm text-[var(--ink)] truncate">{withMapCount(m.map, mapCounts)}</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-xs font-bold ${m.win ? 'text-emerald-500' : 'text-red-500'}`}>{m.win ? 'W' : 'L'}</span>
                          <span className="text-[10px] font-semibold text-[var(--faint-2)]">{MODE_TAG[m.queue_mode]}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[11px] text-[var(--faint)]">
                        <span>{m.time ? format(new Date(m.time), 'MMM d, h:mm a') : m.date}</span><span>·</span>
                        <span>{m.stage_index != null ? `stage ${m.stage_index} · sens ${m.sens}` : m.sens != null ? `sens ${m.sens}` : 'no sens'}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
        </div>

        <div className="card" data-inspect-id="sl-aim-stats-card">
          <h3 className="text-sm heading-display text-[var(--ink)] mb-4">Aim Stats</h3>
          {!selected ? <p className="text-xs text-[var(--faint)]">Select a match to enter its stats.</p> : (
            <div className="space-y-4">
              <div className="rounded-lg bg-ow-darker border border-ow-border px-3 py-2.5" data-inspect-id="sl-selected-match-summary">
                <div className="flex items-center gap-2">
                  <span className={`pill ${ROLE_COLORS[HEROES[selected.hero] ?? ''] ?? ''}`}>{withHeroCount(selected.hero, heroCounts)}</span>
                  <span className="text-sm text-[var(--ink)]">@ {withMapCount(selected.map, mapCounts)}</span>
                  <span className={`text-xs font-bold ml-auto ${selected.win ? 'text-emerald-500' : 'text-red-500'}`}>{selected.win ? 'WIN' : 'LOSS'}</span>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  {selected.stage_index != null && <span className="text-[11px] text-violet-500 font-semibold">Stage {selected.stage_index}</span>}
                  <label className="text-[11px] text-[var(--faint)]">Sens</label>
                  <input type="number" step="0.01" min="0" inputMode="decimal" value={sens} onChange={e => setSens(e.target.value)} data-inspect-id="sl-sens-input" className="w-16 field px-2 py-1 text-sm num-display" placeholder="—" aria-label="Sensitivity" />
                  {parseFloat(sens) > 0 && <span className="text-[11px] text-[var(--faint)]">{Math.round(eDPI(parseFloat(sens)))} eDPI</span>}
                  <label className="text-[11px] font-semibold text-[var(--ink)] ml-auto">Duration <span className="text-violet-500">*</span></label>
                  <input ref={durationRef} type="number" min="0" step="1" inputMode="numeric" value={stats.duration_min} onChange={e => setStats(s => ({ ...s, duration_min: e.target.value }))} data-inspect-id="sl-duration-input" className={`w-16 field px-2 py-1.5 text-sm num-display ${parseFloat(stats.duration_min) > 0 ? '' : 'ring-1 ring-violet-500/60'}`} placeholder="min" aria-label="Duration in minutes" required />
                </div>
              </div>
              <StatFields s={stats} upd={(k, v) => setStats(s => ({ ...s, [k]: v }))} knownLabels={knownLabels} />
              <button type="button" onClick={save} disabled={!(parseFloat(stats.overall_acc) >= 0 && parseFloat(stats.duration_min) > 0) || status === 'saving'} data-inspect-id="sl-save-stats-btn" className="btn-primary w-full py-2.5 text-sm">
                {status === 'saving' ? 'Saving…' : status === 'success' ? '✓ Saved' : 'Save Stats'}
              </button>
              {status === 'error' && <p data-inspect-id="sl-save-error-banner" className="text-red-600 text-xs text-center">Failed to save — is the server running?</p>}
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

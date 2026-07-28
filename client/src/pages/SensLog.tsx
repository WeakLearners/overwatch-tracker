import { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi, revalidateAll } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { eDPI, MOUSE_DPI } from '../lib/aim';
import { SLOT_COLORS, startSlotKey, readStartSlot, expectedColor } from '../lib/slotColors';
import {
  QueueMode, QUEUE_MODE_COLORS, MODE_TAG, HEROES, ROLE_COLORS,
} from '../types';
import { format } from 'date-fns';
import SensNav from '../components/SensNav';
import ClickCounter from '../components/ClickCounter';

// ── Types ────────────────────────────────────────────────────────────────────
interface PendingMatch {
  id: number; date: string; time: string | null;
  hero: string; role: string; map: string; game_type: string;
  queue_mode: QueueMode; win: 0 | 1; sens: number | null;
  masked?: boolean; stage_index?: number | null;
}
interface BlindActive {
  set_id: number; in_game_sens: number; base_dpi: number; created_at: string;
  batch_size: number; cur_rel: number; games_on_stage: number;
  scramble_done: boolean; resolved: boolean; n_stages: number;
  hero: string | null; totalGames: number;
}
interface BlindState {
  active: BlindActive | null;
  needSwitch?: boolean;
  pendingReveal?: number;
  stages?: { stage_index: number; dpi: number }[];
}
interface BlindSetSummary {
  set_id: number; hero: string | null; active: boolean; resolved: boolean;
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

// ── Shared aim-stat inputs (used by both the blind loop and the backfill form) ─
function StatFields({ s, upd, knownLabels }: {
  s: StatFieldsT; upd: <K extends keyof StatFieldsT>(k: K, v: StatFieldsT[K]) => void; knownLabels: string[];
}) {
  const t = (k: keyof StatFieldsT) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => upd(k, e.target.value as never);
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-[var(--muted)] mb-1.5">Overall accuracy %</label>
          <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={s.overall_acc} onChange={t('overall_acc')} className={field} placeholder="e.g. 41.2" />
        </div>
        <div>
          <label className="block text-xs text-[var(--muted)] mb-1.5">Crit accuracy % <span className="text-[var(--faint-2)]">— if it applies</span></label>
          <input type="number" step="0.1" min="0" max="100" inputMode="decimal" value={s.crit_acc} onChange={t('crit_acc')} className={field} placeholder="e.g. 22.5" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-[var(--muted)] mb-1.5">Hero-specific stat <span className="text-[var(--faint-2)]">— remembered per hero</span></label>
          <input type="text" list="hero-stat-labels" value={s.hero_stat_label} onChange={t('hero_stat_label')} className={field} placeholder="e.g. scoped crit %" />
          <datalist id="hero-stat-labels">{knownLabels.map(l => <option key={l} value={l} />)}</datalist>
        </div>
        <div>
          <label className="block text-xs text-[var(--muted)] mb-1.5">Value</label>
          <input type="number" step="0.1" inputMode="decimal" value={s.hero_stat_value} onChange={t('hero_stat_value')} className={field} placeholder="e.g. 30.1" />
        </div>
      </div>
      <div>
        <label className="block text-xs text-[var(--muted)] mb-1.5">Combat <span className="text-[var(--faint-2)]">— endgame scoreboard</span></label>
        <div className="grid grid-cols-4 gap-2">
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
  const { data: blind } = useApi<BlindState>('/api/blind/state');
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
      <SensNav />
      <div className="mb-6">
        <h1 className="text-2xl heading-display text-[var(--ink)]">Sensitivity Study</h1>
        <p className="text-sm text-[var(--faint)] mt-1">Enter each match's combat details here after the game. Blind DPI trials are driven from the panel below and land in the same queue.</p>
      </div>

      <BackfillPanel pending={pending} loading={loading} knownLabels={knownLabels} labelFor={labelFor} />

      <div className="mt-10 pt-8 border-t border-ow-border">
        <h2 className="text-sm heading-display text-[var(--ink)] mb-1">Blind DPI trials</h2>
        <p className="text-xs text-[var(--faint)] mb-4">Shuffle DPI across your mouse stages, play blind, then reveal. Log each game in the Match Tracker — it auto-tags to your current stage and queues up above for its combat details.</p>
        <Phase2PlanCard blind={blind} />
        <BlindPanel blind={blind} />
      </div>
    </div>
  );
}

// Slot → LED color mapping, in the order the mouse config app assigns them.
// Used on the setup step so an accidental DPI-button press can be resolved to a
// slot number by LED color, without revealing that slot's DPI value.
// ── Phase 2 test plan (reference card) ──────────────────────────────────────
// Static reference for the current round of per-hero blind blocks — set up a
// blind set per hero using these exact DPIs and games/slot. Update this list
// when the plan changes; it's not derived from live data.
const PHASE2_PLAN = [
  { hero: 'Sojourn', archetype: 'Hitscan', dpis: [1500, 1600, 1700], gamesPerSlot: 12, note: 'Clean curve — drop both weak extremes.' },
  { hero: 'Shion', archetype: 'Hitscan', dpis: [1600, 1700, 1750], gamesPerSlot: 12, note: 'Nearly flat in Phase 1 — confirm/kill, not a search for a winner.' },
  { hero: 'Tracer', archetype: 'Hitscan', dpis: [1500, 1600, 1750], gamesPerSlot: 12, note: 'Noisy, bimodal on thin data — real exploration.' },
  { hero: 'Pharah', archetype: 'Projectile', dpis: [1450, 1500, 1750], gamesPerSlot: 12, note: 'Same bimodal shape, thinnest data of the four.' },
] as const;

type HeroTestStatus = 'none' | 'testing' | 'completed';

// A hero's status comes from whichever set is authoritative for it: the
// currently active set if it's tagged to this hero (live progress), otherwise
// its most recent past set (so "Completed" survives after a newer set for a
// different hero takes over as active). needsReveal marks a set that hit its
// game-count target but hasn't been revealed yet — creating any new set would
// deactivate it and stall its reveal, so callers use this to force reveal
// before moving on to the next hero.
function statusForHero(
  hero: string, blind: BlindState | null, sets: BlindSetSummary[],
): { status: HeroTestStatus; totalGames: number; target: number; needsReveal: boolean } {
  const active = blind?.active;
  if (active?.hero === hero) {
    const target = active.batch_size * active.n_stages;
    const completed = active.totalGames >= target;
    return { status: completed ? 'completed' : 'testing', totalGames: active.totalGames, target, needsReveal: completed && !active.resolved };
  }
  const past = [...sets].filter(s => s.hero === hero).sort((a, b) => b.set_id - a.set_id)[0];
  if (past) {
    const target = past.batch_size * past.n_stages;
    if (past.totalGames >= target) return { status: 'completed', totalGames: past.totalGames, target, needsReveal: !past.resolved };
  }
  return { status: 'none', totalGames: 0, target: 0, needsReveal: false };
}

function Phase2PlanCard({ blind }: { blind: BlindState | null }) {
  const { data } = useApi<{ sets: BlindSetSummary[] }>('/api/blind/sets');
  const sets = data?.sets ?? [];
  const [creating, setCreating] = useState<string | null>(null);

  const statuses = new Map(PHASE2_PLAN.map(h => [h.hero, statusForHero(h.hero, blind, sets)]));
  // Blocks starting the next hero's set while another is still testing OR
  // sitting complete-but-unrevealed — forces reveal-before-next rather than
  // letting a new set silently steal `active` from a finished one.
  const anyPendingReveal = [...statuses.values()].some(s => s.status === 'testing' || s.needsReveal);
  const totalGames = PHASE2_PLAN.reduce((sum, h) => sum + h.dpis.length * h.gamesPerSlot, 0);
  const [cancelling, setCancelling] = useState(false);

  async function createSetForHero(h: (typeof PHASE2_PLAN)[number]) {
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
        `This will permanently DELETE the ${hero} blind set AND all ${games} game${games === 1 ? '' : 's'} logged against it. This cannot be undone.\n\nType ${games} to confirm:`,
      );
      if (typed?.trim() !== String(games)) return;
    } else if (!confirm(`Cancel the ${hero} blind set? No games have been logged yet.`)) {
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
    <div className="card mb-6">
      <h2 className="text-sm heading-display text-[var(--ink)] mb-1">Phase 2 test plan</h2>
      <p className="text-xs text-[var(--faint)] mb-3">
        In-game sens frozen at 2.50. One blind set per hero — only log that hero while its set is active. {PHASE2_PLAN.length} heroes × 3 DPI levels, {totalGames} games total.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {PHASE2_PLAN.map(h => {
          const s = statuses.get(h.hero)!;
          const blockedByOther = anyPendingReveal && s.status !== 'testing';
          return (
            <div key={h.hero} className="relative rounded-lg bg-ow-darker border border-ow-border p-2.5 overflow-hidden">
              <div className={s.status !== 'none' ? 'opacity-30 pointer-events-none' : blockedByOther ? 'opacity-50' : ''}>
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
                  type="button" onClick={() => createSetForHero(h)} disabled={blockedByOther || creating === h.hero}
                  className={`${btnSecondary} w-full py-1.5 text-xs`}
                >
                  {creating === h.hero ? 'Creating…' : 'Create blind set'}
                </button>
              </div>

              {s.status !== 'none' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-ow-card/40 backdrop-blur-[1px]">
                  <span
                    className={`heading-display text-[45px] leading-none text-center drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)] ${s.status === 'testing' ? 'text-amber-500' : 'text-emerald-500'}`}
                  >
                    {s.status === 'testing' ? 'In Testing' : 'Completed'}
                  </span>
                  <span className="text-xs font-semibold num-display text-[var(--ink)] drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">{s.totalGames} / {s.target} games</span>
                  {blind?.active?.hero === h.hero && !blind.active.resolved && (
                    <button
                      type="button"
                      onClick={() => cancelActiveSet(blind.active!.set_id, h.hero, s.totalGames)}
                      disabled={cancelling}
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

// ── Blind guided-loop panel ──────────────────────────────────────────────────
function BlindPanel({ blind }: { blind: BlindState | null }) {
  const active = blind?.active ?? null;
  const [inGameSens, setInGameSens] = useState('2.50');
  const [batchSize, setBatchSize] = useState('12');
  const [dpis, setDpis] = useState<string[]>(['1500', '1600', '1700']);
  const [busy, setBusy] = useState(false);
  // The mouse LED color you land on after mashing, picked on the blind-start
  // screen. Persisted per-set so we can always show the color you should be on.
  const [startColorSlot, setStartColorSlot] = useState<number | null>(null);
  // Blank out the DPI values on the setup screen once they're typed in, so you
  // don't keep staring at them while mashing / picking your starting color.
  const [hideDpi, setHideDpi] = useState(false);

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
  // While non-null, we're mid stage-switch: the odometer counts down the DPI-
  // button presses. The server has already advanced (cur_rel moved, batch reset)
  // — this is the tactile guide, so it owns the transition back to "playing".
  const [switching, setSwitching] = useState<number | null>(null);
  const [answer, setAnswer] = useState<AnswerStage[] | null>(null);
  const [revealSlot, setRevealSlot] = useState('');

  async function createSet() {
    setBusy(true);
    try {
      await fetch('/api/blind/sets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          in_game_sens: parseFloat(inGameSens), batch_size: parseInt(batchSize),
          dpis: dpis.map(d => parseInt(d)),
        }),
      });
      setAnswer(null); setSwitching(null); revalidateAll();
    } finally { setBusy(false); }
  }

  async function scramble() {
    if (startColorSlot == null) return; // must record the landed-on LED color first
    setBusy(true);
    try {
      await fetch('/api/blind/scramble', { method: 'POST' });
      if (active) localStorage.setItem(startSlotKey(active.set_id), String(startColorSlot));
      setSwitching(null); revalidateAll();
    }
    finally { setBusy(false); }
  }

  async function advance() {
    const r = await fetch('/api/blind/advance', { method: 'POST' });
    // Hand the click count to the odometer; it counts the presses down and calls
    // back when you've landed, at which point we resync to the fresh stage.
    if (r.ok) { const d = await r.json(); setSwitching(d.click_count); }
  }

  async function reveal() {
    if (!active) return;
    const slot = parseInt(revealSlot);
    if (!(slot >= 1 && slot <= active.n_stages)) return;
    if (!window.confirm(`Reveal all trials using current slot ${slot}? This un-blinds every DPI and can't be undone.`)) return;
    setBusy(true);
    try {
      await fetch('/api/blind/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current_slot: slot }) });
      const r = await fetch(`/api/blind/sets/${active.set_id}`);
      if (r.ok) setAnswer((await r.json()).stages);
      revalidateAll();
    } finally { setBusy(false); }
  }

  // Scrap the active set and go back to the create screen (the very beginning),
  // for when a test is set up wrong. Your typed DPIs stay in the form so it's a
  // quick re-create. Guards logged games behind a typed confirmation.
  async function restart() {
    if (!active) return;
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
      localStorage.removeItem(startSlotKey(active.set_id));
      setStartColorSlot(null); setHideDpi(false); setAnswer(null); setSwitching(null);
      revalidateAll();
    } finally { setBusy(false); }
  }

  const card = 'card mb-6';

  // 1) No set → create.
  if (!active) {
    return (
      <div className={`${card} max-w-lg`}>
        <h2 className="text-sm heading-display text-[var(--ink)] mb-1">Blind trials — create a set</h2>
        <p className="text-xs text-[var(--faint)] mb-4">Pick each slot's DPI directly — e.g. levels chosen per hero from the analysis page. They'll be shuffled before you type them into your mouse's DPI stages.</p>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="block">
            <span className="block text-xs text-[var(--muted)] mb-1.5">In-game sens (frozen)</span>
            <input type="number" step="0.01" className={field} value={inGameSens} onChange={e => setInGameSens(e.target.value)} />
          </label>
          <label className="block">
            <span className="block text-xs text-[var(--muted)] mb-1.5"># Slots</span>
            <input type="number" step="1" min="2" className={field} value={dpis.length} onChange={e => setSlotCount(e.target.value)} />
          </label>
          <label className="block col-span-2">
            <span className="block text-xs text-[var(--muted)] mb-1.5">Games per slot (samples)</span>
            <input type="number" step="1" min="1" className={field} value={batchSize} onChange={e => setBatchSize(e.target.value)} />
          </label>
        </div>
        <div className="mb-4">
          <span className="block text-xs text-[var(--muted)] mb-1.5">DPI per slot</span>
          <div className="grid grid-cols-3 gap-2">
            {dpis.map((d, i) => (
              <input
                key={i} type="number" step="50" className={field} value={d} placeholder={`Slot ${i + 1}`}
                onChange={e => setDpis(prev => prev.map((v, vi) => (vi === i ? e.target.value : v)))}
                aria-label={`Slot ${i + 1} DPI`}
              />
            ))}
          </div>
        </div>
        <button type="button" onClick={createSet} disabled={busy} className="btn-primary w-full py-2.5 text-sm">{busy ? 'Creating…' : 'Create blind set'}</button>
      </div>
    );
  }

  // 2) Set exists but not scrambled → setup (show values to type) + blind-start.
  if (!active.scramble_done) {
    return (
      <div className={`${card} max-w-lg`}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm heading-display text-[var(--ink)]">Set up your mouse</h2>
          <button type="button" onClick={() => setHideDpi(v => !v)} className={`${btnSecondary} py-1 px-2.5 text-xs`}>{hideDpi ? 'Show DPI' : 'Hide DPI'}</button>
        </div>
        <p className="text-xs text-[var(--faint)] mb-3">Type these into your mouse's DPI stages (in-game sens stays <b className="num-display">{active.in_game_sens.toFixed(2)}</b>), then hit <b>Hide DPI</b> before you mash so the numbers are out of sight:</p>
        <div className="grid grid-cols-5 gap-2 mb-3">
          {(blind?.stages ?? []).map(s => {
            // Match each slot to the LED color your mouse config app assigns in
            // this order (red → blue → green → …). If you later press the DPI
            // button by accident, you can read the LED color and know which slot
            // you're on without un-blinding the DPI number.
            const c = SLOT_COLORS[(s.stage_index - 1) % SLOT_COLORS.length];
            return (
              <div key={s.stage_index} className={`rounded-lg bg-ow-darker border-2 p-2 text-center ${c.border}`}>
                <div className={`text-[10px] font-semibold ${c.text}`}>{c.name}</div>
                <div className="text-[10px] text-[var(--faint-2)]">Slot {s.stage_index}</div>
                <div className="text-sm num-display text-[var(--ink)]">{hideDpi ? '••••' : s.dpi}</div>
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-[var(--faint-2)] mb-3">Colors mirror your mouse's DPI-stage LEDs — if you bump the DPI button later, match the LED color here to know your slot without revealing its DPI.</p>
        <p className="text-xs text-[var(--faint)] mb-3">Then <b>mash the DPI button</b> an uncounted number of times (look away / watch a video) so you don't know which stage you're on. That's your blind start.</p>
        <div className="rounded-lg bg-ow-darker border border-ow-border p-3 mb-4">
          <p className="text-xs text-[var(--faint)] mb-2">Done mashing? Read your mouse's <b>current LED color</b> and select it — that's the only anchor we keep, so if you bump the DPI button mid-test we can point you back to the right color (never the DPI).</p>
          <div className="grid grid-cols-3 gap-2">
            {SLOT_COLORS.map((c, i) => {
              const sel = startColorSlot === i + 1;
              return (
                <button
                  key={c.name} type="button" onClick={() => setStartColorSlot(i + 1)}
                  className={`flex items-center justify-center gap-2 rounded-lg border-2 py-2 text-xs font-semibold transition ${sel ? `${c.border} ${c.text} bg-ow-darker` : 'border-ow-border text-[var(--faint-2)]'}`}
                >
                  <span className={`inline-block w-3 h-3 rounded-full ${c.dot}`} />{c.name}
                </button>
              );
            })}
          </div>
        </div>
        <button type="button" onClick={scramble} disabled={busy || startColorSlot == null} className="btn-primary w-full py-2.5 text-sm">{busy ? '…' : startColorSlot == null ? 'Select your current LED color first' : "I've mashed the button — blind-start"}</button>
        <button type="button" onClick={restart} disabled={busy} className="mt-2 w-full text-xs text-[var(--faint-2)] hover:text-[var(--ink)] py-1.5">↺ Restart test from the beginning</button>
      </div>
    );
  }

  // 4) Resolved → answer key.
  if (active.resolved) {
    return (
      <div className={card}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm heading-display text-[var(--ink)]">Set #{active.set_id} — revealed</h2>
          <button type="button" onClick={() => revalidateAll()} className={`${btnSecondary} py-1.5 px-3 text-xs`}>Refresh</button>
        </div>
        {answer ? <AnswerTable stages={answer} /> : <p className="text-xs text-[var(--faint)]">Revealed. Reload to see the answer key, or create a new set below.</p>}
        <div className="mt-4">
          <button type="button" onClick={createSet} disabled={busy} className="btn-primary py-2 px-4 text-sm">Start a fresh set (re-shuffle)</button>
        </div>
      </div>
    );
  }

  // 3a) Mid-switch → the repurposed odometer counts down the DPI-button presses.
  if (switching != null) {
    return (
      <div className="card max-w-md mb-6 text-center">
        <div className="text-xs text-amber-500 font-semibold mb-1">Switch stages</div>
        <h2 className="text-sm heading-display text-[var(--ink)] mb-3">Advance the DPI button</h2>
        <ClickCounter count={switching} onDone={() => { setSwitching(null); revalidateAll(); }} />
      </div>
    );
  }

  // 3b) Scrambled, in-loop. Games are logged in the Match Tracker (blind-aware);
  // this panel only drives the stage loop and reveal.
  const gamesLeft = active.batch_size - active.games_on_stage;
  const needSwitch = blind?.needSwitch;
  // The LED color you should currently be on, derived from the recorded start
  // color + how far the app has advanced. If you misclicked the DPI button,
  // press it until the mouse LED matches this — no DPI number revealed.
  const startSlot = readStartSlot(active.set_id);
  const nowColor = startSlot != null ? expectedColor(active.cur_rel, startSlot, active.n_stages) : null;

  return (
    <div className="max-w-lg space-y-6 mb-6">
      <div className="card text-center">
        {needSwitch ? (
          <>
            <div className="text-xs text-amber-500 font-semibold mb-1">Batch complete — switch stages</div>
            <p className="text-xs text-[var(--faint)] my-3">Get your next stage — the odometer will count the DPI-button presses for you.</p>
            <button type="button" onClick={advance} className={`${btnSecondary} w-full py-2 text-sm mt-2`}>Get next stage →</button>
          </>
        ) : (
          <>
            <div className="text-xs text-[var(--faint)] mb-1">Playing your current stage</div>
            <div className="text-4xl heading-display text-[var(--ink)] my-2">{gamesLeft}</div>
            <div className="text-xs text-[var(--faint)]">game{gamesLeft === 1 ? '' : 's'} left in this batch (of {active.batch_size})</div>
            {nowColor && (
              <div className="mt-3 inline-flex items-center gap-2 rounded-lg bg-ow-darker border border-ow-border px-3 py-1.5">
                <span className="text-[11px] text-[var(--faint-2)]">Mouse LED should be</span>
                <span className={`inline-block w-3 h-3 rounded-full ${nowColor.dot}`} />
                <span className={`text-xs font-semibold ${nowColor.text}`}>{nowColor.name}</span>
              </div>
            )}
            <p className="text-[11px] text-[var(--faint-2)] mt-3">Log each game in the <b>Match Tracker</b> — it auto-tags as a blind trial and lands in the queue above for its combat details.</p>
          </>
        )}
      </div>

      <div className="card">
        <h2 className="text-sm heading-display text-[var(--ink)] mb-2">Reveal</h2>
        <p className="text-xs text-[var(--faint)] mb-3">Done for now? Open your mouse software, read the <b>currently active slot number</b>, and enter it to un-blind every trial and unlock analysis.</p>
        <div className="flex items-center gap-2">
          <input type="number" min="1" max={active.n_stages} value={revealSlot} onChange={e => setRevealSlot(e.target.value)} className="w-24 field px-3 py-2 text-sm" placeholder={`1–${active.n_stages}`} aria-label="Current active slot" />
          <button type="button" onClick={reveal} disabled={busy || !revealSlot} className={`${btnSecondary} py-2 px-4 text-sm`}>{busy ? 'Revealing…' : 'Reveal all'}</button>
        </div>
        <button type="button" onClick={restart} disabled={busy} className="mt-4 w-full text-xs text-[var(--faint-2)] hover:text-red-400 py-1.5">↺ Restart test from the beginning</button>
      </div>
    </div>
  );
}

function AnswerTable({ stages }: { stages: AnswerStage[] }) {
  return (
    <div className="overflow-x-auto">
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
      if (!selected.masked) {
        const putRes = await fetch(`/api/matches/${selected.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sens: num(sens) }) });
        if (!putRes.ok) throw new Error('sens save failed');
      }
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
      <h2 className="text-sm heading-display text-[var(--ink)] mb-1">Record combat details</h2>
      <p className="text-xs text-[var(--faint)] mb-4">Every match awaiting its aim stats. Matches are logged in the Match Tracker; while a blind set is running they arrive here with their DPI hidden until you reveal.</p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm heading-display text-[var(--ink)]">Awaiting Stats</h3>
            <span className="text-xs text-[var(--faint)]">{pending.length} pending</span>
          </div>
          {loading ? <p className="text-xs text-[var(--faint)]">Loading…</p>
            : pending.length === 0 ? <p className="text-xs text-[var(--faint)]">All caught up.</p>
            : (
              <div className="space-y-2">
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
                        <span>{m.masked ? `🔒 blind · stage ${m.stage_index}` : m.sens != null ? `sens ${m.sens}` : 'no sens'}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
        </div>

        <div className="card">
          <h3 className="text-sm heading-display text-[var(--ink)] mb-4">Aim Stats</h3>
          {!selected ? <p className="text-xs text-[var(--faint)]">Select a match to enter its stats.</p> : (
            <div className="space-y-4">
              <div className="rounded-lg bg-ow-darker border border-ow-border px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className={`pill ${ROLE_COLORS[HEROES[selected.hero] ?? ''] ?? ''}`}>{withHeroCount(selected.hero, heroCounts)}</span>
                  <span className="text-sm text-[var(--ink)]">@ {withMapCount(selected.map, mapCounts)}</span>
                  <span className={`text-xs font-bold ml-auto ${selected.win ? 'text-emerald-500' : 'text-red-500'}`}>{selected.win ? 'WIN' : 'LOSS'}</span>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  {selected.masked ? (
                    <span className="text-[11px] text-violet-500 font-semibold">🔒 Blind — Stage {selected.stage_index} · sensitivity hidden until reveal</span>
                  ) : (
                    <>
                      <label className="text-[11px] text-[var(--faint)]">Sens</label>
                      <input type="number" step="0.01" min="0" inputMode="decimal" value={sens} onChange={e => setSens(e.target.value)} className="w-16 field px-2 py-1 text-sm num-display" placeholder="—" aria-label="Sensitivity" />
                      {parseFloat(sens) > 0 && <span className="text-[11px] text-[var(--faint)]">{Math.round(eDPI(parseFloat(sens)))} eDPI</span>}
                    </>
                  )}
                  <label className="text-[11px] font-semibold text-[var(--ink)] ml-auto">Duration <span className="text-violet-500">*</span></label>
                  <input ref={durationRef} type="number" min="0" step="1" inputMode="numeric" value={stats.duration_min} onChange={e => setStats(s => ({ ...s, duration_min: e.target.value }))} className={`w-16 field px-2 py-1.5 text-sm num-display ${parseFloat(stats.duration_min) > 0 ? '' : 'ring-1 ring-violet-500/60'}`} placeholder="min" aria-label="Duration in minutes" required />
                </div>
              </div>
              <StatFields s={stats} upd={(k, v) => setStats(s => ({ ...s, [k]: v }))} knownLabels={knownLabels} />
              <button type="button" onClick={save} disabled={!(parseFloat(stats.overall_acc) >= 0 && parseFloat(stats.duration_min) > 0) || status === 'saving'} className="btn-primary w-full py-2.5 text-sm">
                {status === 'saving' ? 'Saving…' : status === 'success' ? '✓ Saved' : 'Save Stats'}
              </button>
              {status === 'error' && <p className="text-red-600 text-xs text-center">Failed to save — is the server running?</p>}
            </div>
          )}
        </div>
      </div>

      {showCaughtUp && (
        <div className="fixed inset-0 z-50 grid place-items-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowCaughtUp(false)} />
          <div className="relative card max-w-sm w-full mx-4 text-center">
            <h3 className="text-sm heading-display text-[var(--ink)] mb-1.5">All caught up</h3>
            <p className="text-xs text-[var(--faint)] mb-4">No matches left awaiting combat details. Head back to the Match Tracker?</p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setShowCaughtUp(false)} className={`${btnSecondary} flex-1 py-2 text-sm`}>Stay</button>
              <button type="button" autoFocus onClick={() => navigate('/')} className="btn-primary flex-1 py-2 text-sm">Leave</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

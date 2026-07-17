import { useState, useMemo, useRef, useEffect } from 'react';
import { useApi, revalidateAll } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { eDPI, MOUSE_DPI } from '../lib/aim';
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
}
interface BlindState {
  active: BlindActive | null;
  needSwitch?: boolean;
  pendingReveal?: number;
  stages?: { stage_index: number; dpi: number }[];
}
interface AnswerStage {
  stage_index: number; dpi: number; pct_delta: number;
  eDPI: number; cm360: number; n: number; feelMean: number | null; feelVar: number | null;
}
interface StatFieldsT {
  overall_acc: string; crit_acc: string; hero_stat_label: string; hero_stat_value: string;
  elims: string; final_blows: string; deaths: string; damage: string; duration_min: string;
  notes: string;
}

const EMPTY_STATS: StatFieldsT = {
  overall_acc: '', crit_acc: '', hero_stat_label: '', hero_stat_value: '',
  elims: '', final_blows: '', deaths: '', damage: '', duration_min: '', notes: '',
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
      <div>
        <label className="block text-xs text-[var(--muted)] mb-1.5">Notes</label>
        <textarea value={s.notes} onChange={t('notes')} rows={2} className="w-full field px-3 py-2 text-sm resize-none" placeholder="fatigue, warmup, just switched stage…" />
      </div>
    </>
  );
}

const statsBody = (match_id: number, s: StatFieldsT) => ({
  match_id,
  overall_acc: num(s.overall_acc), crit_acc: num(s.crit_acc),
  hero_stat_label: s.hero_stat_label.trim() || null, hero_stat_value: num(s.hero_stat_value),
  elims: num(s.elims), final_blows: num(s.final_blows), deaths: num(s.deaths), damage: num(s.damage),
  duration_min: num(s.duration_min), notes: s.notes.trim() || null,
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
        <BlindPanel blind={blind} />
      </div>
    </div>
  );
}

// ── Blind guided-loop panel ──────────────────────────────────────────────────
function BlindPanel({ blind }: { blind: BlindState | null }) {
  const active = blind?.active ?? null;
  const [createForm, setCreateForm] = useState({ in_game_sens: '2.50', base_dpi: '1600', pct_range: '10', n_stages: '5', batch_size: '5' });
  const [busy, setBusy] = useState(false);
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
          in_game_sens: parseFloat(createForm.in_game_sens), base_dpi: parseInt(createForm.base_dpi),
          pct_range: parseFloat(createForm.pct_range), n_stages: parseInt(createForm.n_stages), batch_size: parseInt(createForm.batch_size),
        }),
      });
      setAnswer(null); setSwitching(null); revalidateAll();
    } finally { setBusy(false); }
  }

  async function scramble() {
    setBusy(true);
    try { await fetch('/api/blind/scramble', { method: 'POST' }); setSwitching(null); revalidateAll(); }
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

  const card = 'card mb-6';

  // 1) No set → create.
  if (!active) {
    return (
      <div className={`${card} max-w-lg`}>
        <h2 className="text-sm heading-display text-[var(--ink)] mb-1">Blind trials — create a set</h2>
        <p className="text-xs text-[var(--faint)] mb-4">Generates {createForm.n_stages} shuffled DPI values across ±{createForm.pct_range}% of base. You'll type them into your mouse's DPI stages once.</p>
        <div className="grid grid-cols-2 gap-3 mb-4">
          {([['in_game_sens', 'In-game sens (frozen)', '0.01'], ['base_dpi', 'Base DPI', '50'], ['pct_range', '± Range %', '1'], ['n_stages', '# Stages', '1'], ['batch_size', 'Games per stage', '1']] as const).map(([k, lbl, step]) => (
            <label key={k} className="block">
              <span className="block text-xs text-[var(--muted)] mb-1.5">{lbl}</span>
              <input type="number" step={step} className={field} value={createForm[k]} onChange={e => setCreateForm(f => ({ ...f, [k]: e.target.value }))} />
            </label>
          ))}
        </div>
        <button type="button" onClick={createSet} disabled={busy} className="btn-primary w-full py-2.5 text-sm">{busy ? 'Creating…' : 'Create blind set'}</button>
      </div>
    );
  }

  // 2) Set exists but not scrambled → setup (show values to type) + blind-start.
  if (!active.scramble_done) {
    return (
      <div className={`${card} max-w-lg`}>
        <h2 className="text-sm heading-display text-[var(--ink)] mb-1">Set up your mouse</h2>
        <p className="text-xs text-[var(--faint)] mb-3">Type these into your mouse's DPI stages (in-game sens stays <b className="num-display">{active.in_game_sens.toFixed(2)}</b>):</p>
        <div className="grid grid-cols-5 gap-2 mb-4">
          {(blind?.stages ?? []).map(s => (
            <div key={s.stage_index} className="rounded-lg bg-ow-darker border border-ow-border p-2 text-center">
              <div className="text-[10px] text-[var(--faint-2)]">Slot {s.stage_index}</div>
              <div className="text-sm num-display text-[var(--ink)]">{s.dpi}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-[var(--faint)] mb-3">Then <b>mash the DPI button</b> an uncounted number of times (look away / watch a video) so you don't know which stage you're on. That's your blind start.</p>
        <button type="button" onClick={scramble} disabled={busy} className="btn-primary w-full py-2.5 text-sm">{busy ? '…' : "I've mashed the button — blind-start"}</button>
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
          <button type="button" onClick={() => { setCreateForm(f => ({ ...f })); createSet(); }} disabled={busy} className="btn-primary py-2 px-4 text-sm">Start a fresh set (re-shuffle)</button>
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
  const selected = pending.find(m => m.id === selectedId) ?? null;
  const durationRef = useRef<HTMLInputElement>(null);
  const mapCounts = useTodayMapCounts();

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
                          <span className={`pill ${ROLE_COLORS[m.role] ?? ''}`}>{m.hero}</span>
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
                  <span className={`pill ${ROLE_COLORS[HEROES[selected.hero] ?? ''] ?? ''}`}>{selected.hero}</span>
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
    </div>
  );
}

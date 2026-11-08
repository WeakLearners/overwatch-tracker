import { useState } from 'react';
import { useApi, revalidateAll } from '../../hooks/useApi';
import { useMatch } from '../../contexts/MatchContext';
import { refreshRec } from '../../contexts/AdvisorContext';

export interface FocusRosterEntry { role: string; hero: string; rank: number; basis: 'rank' | 'fill'; n: number; winRate: number | null; shrunkWr: number | null }
export interface FocusTrial {
  id: number; status: 'active' | 'ended' | 'complete'; startedAt: string; endedAt: string | null; endReason: string | null;
  target: number; blockMinutes: number; blocks: number; minutes: number; waiting: number; offRoster: number;
  roles: Record<string, { closedBlocks: number; openMinutes: number; block: number }>;
  roster: FocusRosterEntry[]; picks: Record<string, string | null>;
}
export interface HeroFocusState {
  rule: { text: string };
  trial: FocusTrial | null;
  preview: { overallWr: number | null; roster: FocusRosterEntry[] } | null;
}

const ROLE_ORDER = ['Tank', 'DPS', 'Support'] as const;
const pct = (x: number | null) => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);

// Hero focus trial (Dashboard). The server picks 2 heroes per role at start and locks them for
// 2160 comp play minutes; this card starts the trial, shows progress, and ends it early (with a
// reason). It cannot edit the roster. Rules and compute: server/src/lib/heroFocus.ts.
export default function HeroFocusCard() {
  const { matchLoggedSignal } = useMatch();
  const { data, refetch } = useApi<HeroFocusState>('/api/hero-focus', [matchLoggedSignal]);
  const [ending, setEnding] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(path: string, body: unknown) {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/hero-focus/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setEnding(false); setReason('');
      // The Prematch advisor card is a plain fetch (AdvisorContext), which revalidateAll() does not reach.
      refetch(); revalidateAll(); refreshRec();
    } catch (e: any) { setError(e.message ?? 'Failed'); } finally { setBusy(false); }
  }

  if (!data) return null;
  const t = data.trial;
  const active = t?.status === 'active';
  const roster = active ? t!.roster : data.preview?.roster ?? [];
  const pctDone = t ? Math.min(100, Math.round((t.minutes / t.target) * 100)) : 0;

  return (
    <div className="card" data-inspect-id="dash-hero-focus-card">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
        <h2 className="text-sm card-title shrink-0">Hero focus trial</h2>
        <p className="text-xs text-[var(--faint)] min-w-0">
          The app picks 2 heroes per role and holds you to them for 2160 comp play minutes (36 hours). Minutes count after you save Aim Stats. You cannot change the roster. QP is not limited.
        </p>
      </div>

      {active && t && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-3" data-inspect-id="dash-hero-focus-progress">
          <span className="text-xs num-display whitespace-nowrap"><b className="font-bold">{t.minutes}</b> of {t.target} min ({(t.minutes / 60).toFixed(1)} of {(t.target / 60).toFixed(0)} h)</span>
          <span className="text-xs num-display whitespace-nowrap" data-inspect-id="dash-hero-focus-block">
            {ROLE_ORDER.map(r => `${r} block ${t.roles[r]?.block ?? 1}: ${t.roles[r]?.openMinutes ?? 0} of ${t.blockMinutes} min`).join(' · ')}
          </span>
          <span className="text-xs num-display whitespace-nowrap" data-inspect-id="dash-hero-focus-offroster">off-roster matches: <b className="font-bold">{t.offRoster}</b></span>
          {t.waiting > 0 && <span className="text-xs text-[var(--faint)] whitespace-nowrap" data-inspect-id="dash-hero-focus-waiting">{t.waiting} match{t.waiting === 1 ? '' : 'es'} waiting for Aim Stats (no minutes yet, not counted)</span>}
          <div className="h-1.5 flex-1 min-w-[8rem] rounded-full bg-ow-border/40 overflow-hidden" aria-hidden="true">
            <div className="h-full bg-ow-accent" style={{ width: `${pctDone}%` }} />
          </div>
        </div>
      )}
      {t && !active && (
        <p className="text-xs text-[var(--muted)] mb-3" data-inspect-id="dash-hero-focus-last">
          {t.status === 'complete'
            ? `Last trial complete: ${t.minutes} of ${t.target} comp min, ${t.offRoster} off-roster matches.`
            : `Last trial ended early at ${t.minutes} of ${t.target} comp min (${t.offRoster} off-roster matches). Reason: ${t.endReason}`}
          {' '}Next roster below.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-inspect-id="dash-hero-focus-roster">
        {ROLE_ORDER.map(role => (
          <div key={role} className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-1">{role}</div>
            {roster.filter(r => r.role === role).map(r => {
              const isPick = active && t!.picks[role] === r.hero;
              return (
                <div key={r.hero} className="flex items-baseline gap-2 text-xs py-0.5">
                  <span className={`hero-name truncate ${isPick ? 'text-ow-accent' : ''}`}>{r.hero}</span>
                  {isPick && <span className="text-[9px] font-bold uppercase tracking-wide text-ow-accent">this block</span>}
                  <span className="ml-auto num-display text-[var(--faint)] whitespace-nowrap">
                    n {r.n} · {pct(r.shrunkWr)}{r.basis === 'fill' ? ' · most played' : ''}
                  </span>
                </div>
              );
            })}
            {roster.every(r => r.role !== role) && <div className="text-xs text-[var(--faint)]">no comp history</div>}
          </div>
        ))}
      </div>
      <p className="text-[10px] text-[var(--faint-2)] mt-2" data-inspect-id="dash-hero-focus-rule">
        Rule: {data.rule.text} Shown: matches (n) and the adjusted win rate. Blocks are 60 play minutes of the role's roster heroes.
      </p>

      <div className="flex flex-wrap items-center gap-3 mt-3">
        {!active && (
          <button
            type="button" data-inspect-id="dash-hero-focus-start-btn" disabled={busy || roster.length < 2}
            onClick={() => post('start', {})}
            className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
          >Start hero focus trial (2160 comp min)</button>
        )}
        {active && !ending && (
          <button
            type="button" data-inspect-id="dash-hero-focus-end-btn" onClick={() => setEnding(true)}
            className="border border-ow-border rounded-md px-3 py-1 text-xs text-[var(--muted)] hover:text-[var(--ink)] hover:border-gray-500"
          >End trial early</button>
        )}
        {active && ending && (
          <div className="flex flex-wrap items-center gap-2 flex-1" data-inspect-id="dash-hero-focus-end-confirm">
            <input
              value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (required)" aria-label="Reason for ending the trial early"
              className="field px-2 py-1 text-xs flex-1 min-w-[12rem]" maxLength={500}
            />
            <button
              type="button" disabled={busy || reason.trim().length < 3} onClick={() => post('end', { reason })}
              className="border border-red-500/60 text-red-500 rounded-md px-3 py-1 text-xs font-semibold disabled:opacity-40"
            >Confirm end</button>
            <button type="button" onClick={() => { setEnding(false); setReason(''); }} className="text-xs text-[var(--faint)] hover:text-[var(--ink)]">Keep going</button>
          </div>
        )}
        {error && <span className="text-xs text-red-400" data-inspect-id="dash-hero-focus-error">{error}</span>}
      </div>
    </div>
  );
}

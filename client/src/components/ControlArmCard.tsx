import { useEffect, useState } from 'react';
import { useApi, revalidateAll } from '../hooks/useApi';

interface ControlArm { on: boolean; sens: number | null; dpi: number; n: number; target: number }

// Comp control arm (Sens page). While on, comp matches are played and saved at one
// home sens and count toward "n of 150"; the blind trial moves to QP. Rules live in
// server/src/lib/controlArm.ts.
export default function ControlArmCard() {
  const { data, refetch } = useApi<ControlArm>('/api/control-arm');
  const [sens, setSens] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data?.sens != null) setSens(String(data.sens)); }, [data?.sens]);

  async function save(on: boolean) {
    setSaving(true);
    setError(null);
    try {
      const v = parseFloat(sens);
      const res = await fetch('/api/control-arm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v > 0 ? { on, sens: v } : { on }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      refetch();
      revalidateAll();
    } catch (e: any) {
      setError(e.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (!data) return null;
  const pct = Math.min(100, Math.round((data.n / data.target) * 100));
  return (
    <div className="card mb-6" data-inspect-id="sl-control-arm-card">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
        <h2 className="text-sm card-title shrink-0">Comp control arm</h2>
        <p className="text-xs text-[var(--faint)] min-w-0">
          While on, comp matches are played and saved at one home sens for every hero and do not count as trials. Sens trials run in Quick Play only.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2" data-inspect-id="sl-control-arm-sens-field">
          <label className="text-[10px] uppercase tracking-wider text-[var(--muted)]" htmlFor="control-arm-sens">Home sens (in-game, DPI {data.dpi})</label>
          <input
            id="control-arm-sens" type="number" step="0.01" min="0" inputMode="decimal"
            value={sens} onChange={e => setSens(e.target.value)}
            className="field px-2 py-1 text-xs num-display w-20"
          />
        </div>
        <button
          type="button" data-inspect-id="sl-control-arm-toggle-btn"
          disabled={saving || (!data.on && !(parseFloat(sens) > 0))}
          onClick={() => save(!data.on)}
          className={`border rounded-md px-3 py-1 text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${data.on ? 'border-ow-accent text-ow-accent' : 'border-ow-border text-[var(--ink)] hover:border-gray-500'}`}
        >
          {data.on ? 'On, click to turn off' : 'Off, click to turn on'}
        </button>
        {data.on && parseFloat(sens) > 0 && parseFloat(sens) !== data.sens && (
          <button
            type="button" data-inspect-id="sl-control-arm-update-btn" disabled={saving} onClick={() => save(true)}
            className="border border-ow-border rounded-md px-3 py-1 text-xs font-semibold hover:border-gray-500 disabled:opacity-40"
          >
            Update sens
          </button>
        )}
        <div className="flex items-center gap-2 flex-1 min-w-[12rem]" data-inspect-id="sl-control-arm-progress">
          <span className="text-xs num-display whitespace-nowrap"><b className="font-bold">{data.n}</b> of {data.target} comp matches</span>
          <div className="h-1.5 flex-1 rounded-full bg-ow-border/40 overflow-hidden" aria-hidden="true">
            <div className="h-full bg-ow-accent" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-red-400 mt-2" data-inspect-id="sl-control-arm-error">{error}</p>}
    </div>
  );
}

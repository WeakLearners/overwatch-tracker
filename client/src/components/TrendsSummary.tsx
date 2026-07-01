import { useApi } from '../hooks/useApi';
import { ROLE_COLORS } from '../types';
import { useHeroDrawer } from '../contexts/HeroDrawerContext';

interface MomentumRow {
  recent_wr: number | null;
  prev_wr: number | null;
  recent_games: number;
  prev_games: number;
}
interface HeroMomentum extends MomentumRow { hero: string; role: string; is_new: number }
interface MomentumData {
  overall: MomentumRow;
  byHero: HeroMomentum[];
}

// Delta pill: green for positive, red for negative, gray for flat.
function Delta({ recent, prev }: { recent: number | null; prev: number | null }) {
  if (recent === null || prev === null) return <span className="text-xs text-[var(--faint-2)]">—</span>;
  const d = Math.round((recent - prev) * 10) / 10;
  if (d > 0) return <span className="text-xs font-semibold text-emerald-600">↑ +{d}%</span>;
  if (d < 0) return <span className="text-xs font-semibold text-red-600">↓ {d}%</span>;
  return <span className="text-xs text-[var(--faint)]">→ flat</span>;
}

// Mini two-bar comparison: prior (gray) vs recent (colored).
function CompareBar({ recent, prev }: { recent: number | null; prev: number | null }) {
  if (recent === null || prev === null) return null;
  return (
    <div className="flex items-center gap-1.5 mt-1">
      <div className="flex-1 h-1.5 bg-ow-border rounded-full overflow-hidden">
        <div className="h-full bg-gray-500 rounded-full" style={{ width: `${prev}%` }} />
      </div>
      <div className="flex-1 h-1.5 bg-ow-border rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${recent >= prev ? 'bg-emerald-400' : 'bg-red-400'}`}
          style={{ width: `${recent}%` }}
        />
      </div>
    </div>
  );
}

// Culled trends for the single-page Dashboard: form momentum (overall + rising /
// declining hero) and the session-fatigue curve. The deeper trajectory/death
// breakdowns from the old Trends page were dropped on purpose.
export default function TrendsSummary() {
  const { data: momentum } = useApi<MomentumData>('/api/stats/momentum');
  const { openHero } = useHeroDrawer();

  const { overall, byHero = [] } = momentum ?? {};
  // Rising/declining need a real before/after, so only established heroes qualify.
  // Label honestly by the actual direction: best positive swing is "rising",
  // worst negative swing is "declining" — never show a falling hero as rising.
  const delta = (h: HeroMomentum) => (h.recent_wr ?? 0) - (h.prev_wr ?? 0);
  const byDelta = [...byHero.filter(h => !h.is_new)].sort((a, b) => delta(b) - delta(a));
  const rising = byDelta.find(h => delta(h) > 0) ?? null;
  const declining = byDelta.reverse().find(h => delta(h) < 0 && h !== rising) ?? null;

  const overallDelta = overall && overall.recent_wr !== null && overall.prev_wr !== null
    ? Math.round((overall.recent_wr - overall.prev_wr) * 10) / 10
    : null;

  return (
    <div>
      {/* Form row: overall momentum + rising / declining hero */}
      {overall && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className={`card border ${overallDelta !== null && overallDelta > 0 ? 'border-emerald-500/30 bg-emerald-500/5' : overallDelta !== null && overallDelta < 0 ? 'border-red-500/30 bg-red-500/5' : 'border-ow-border'}`}>
            <div className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2">Overall momentum</div>
            <div className="flex items-end gap-2">
              <span className={`text-4xl font-black tracking-tight num-display ${(overall.recent_wr ?? 0) >= 50 ? 'grad-win' : 'grad-loss'}`}>
                {overall.recent_wr ?? '—'}%
              </span>
              <Delta recent={overall.recent_wr} prev={overall.prev_wr} />
            </div>
            <CompareBar recent={overall.recent_wr} prev={overall.prev_wr} />
            <div className="text-xs text-[var(--faint-2)] mt-1.5">
              Last 30 days ({overall.recent_games}g) vs prior 90 days ({overall.prev_games}g)
            </div>
          </div>

          {rising && (
            <div className="card">
              <div className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2">Rising hero</div>
              <div className="flex items-center gap-2 mb-1">
                <button onClick={() => openHero(rising.hero)} className="text-base font-bold text-[var(--ink)] hover:text-ow-accent transition-colors">{rising.hero}</button>
                <span className={`pill ${ROLE_COLORS[rising.role]}`}>{rising.role}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xl font-bold ${(rising.recent_wr ?? 0) >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {rising.recent_wr}%
                </span>
                <Delta recent={rising.recent_wr} prev={rising.prev_wr} />
              </div>
              <CompareBar recent={rising.recent_wr} prev={rising.prev_wr} />
              <div className="text-xs text-[var(--faint-2)] mt-1.5">{rising.recent_games}g recent · {rising.prev_games}g prior</div>
            </div>
          )}

          {declining && (
            <div className="card">
              <div className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2">Declining hero</div>
              <div className="flex items-center gap-2 mb-1">
                <button onClick={() => openHero(declining.hero)} className="text-base font-bold text-[var(--ink)] hover:text-ow-accent transition-colors">{declining.hero}</button>
                <span className={`pill ${ROLE_COLORS[declining.role]}`}>{declining.role}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-xl font-bold ${(declining.recent_wr ?? 0) >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {declining.recent_wr}%
                </span>
                <Delta recent={declining.recent_wr} prev={declining.prev_wr} />
              </div>
              <CompareBar recent={declining.recent_wr} prev={declining.prev_wr} />
              <div className="text-xs text-[var(--faint-2)] mt-1.5">{declining.recent_games}g recent · {declining.prev_games}g prior</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

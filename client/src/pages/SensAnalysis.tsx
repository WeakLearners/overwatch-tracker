import {
  ResponsiveContainer, ComposedChart, LineChart, Bar, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { useApi } from '../hooks/useApi';
import SensNav from '../components/SensNav';

interface ScaleRow {
  cm360: number; eDPI: number; sens: number; n: number;
  avgOverall: number | null; avgCrit: number | null;
  avgFeel: number | null; avgDelta: number | null;
}
interface Bucket {
  bucket: string; n: number;
  avgOverall: number | null; avgDelta: number | null; avgFeel: number | null;
}
interface HeroRow {
  hero: string; archetype: string; n: number;
  avgOverall: number | null; avgCrit: number | null;
}
interface Analysis {
  summary: { n: number; distinctScale: number; maskedPending: number };
  byScale: ScaleRow[];
  byArchetype: { hitscan: ScaleRow[]; projectile: ScaleRow[] };
  coldWarm: Bucket[];
  adaptation: Bucket[];
  heroes: HeroRow[];
}

const HITSCAN = '#3b82f6';
const PROJECTILE = '#ec4899';
const FEEL = '#8b5cf6';
const ACCURACY = '#10b981';

const f1 = (x: number | null | undefined) => (x == null ? '—' : x.toFixed(1));
const signed = (x: number | null | undefined) =>
  x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(1)}`;

// Card wrapper with a title and one-line explanation of how to read it.
function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h2 className="text-sm heading-display text-[var(--ink)]">{title}</h2>
      <p className="text-xs text-[var(--faint)] mt-1 mb-4">{hint}</p>
      {children}
    </div>
  );
}

const axisStyle = { fontSize: 11, fill: 'var(--faint)' };

export default function SensAnalysis() {
  const { data, loading } = useApi<Analysis>('/api/aim/analysis');

  const wrap = (children: React.ReactNode) => (
    <div className="mt-2">
      <SensNav />
      <div className="mb-6">
        <h1 className="text-2xl heading-display text-[var(--ink)]">Sensitivity Analysis</h1>
        <p className="text-sm text-[var(--faint)] mt-1">
          What the numbers say — and where they agree or disagree with how it felt.
        </p>
      </div>
      {children}
    </div>
  );

  if (loading || !data) return wrap(<p className="text-xs text-[var(--faint)]">Loading…</p>);

  if (data.summary.n === 0) {
    return wrap(
      <div className="card">
        <p className="text-sm text-[var(--ink)]">No aim data yet.</p>
        <p className="text-xs text-[var(--faint)] mt-1.5">
          Log matches with their sensitivity, then record each one's stats on the{' '}
          <span className="text-violet-500">Enter Stats</span> tab. Once a few sens values
          are on the board, this page fills in — the sens→performance curve, the
          feel-vs-data comparison, and the hitscan/projectile split.
        </p>
      </div>,
    );
  }

  const { byScale, byArchetype, coldWarm, adaptation, heroes, summary } = data;

  // Merge the two archetype series onto a shared cm/360 axis for a single chart.
  const archCm = [...new Set([
    ...byArchetype.hitscan.map(r => r.cm360),
    ...byArchetype.projectile.map(r => r.cm360),
  ])].sort((a, b) => a - b);
  const archData = archCm.map(cm => ({
    cm360: cm,
    hitscan: byArchetype.hitscan.find(r => r.cm360 === cm)?.avgDelta ?? null,
    projectile: byArchetype.projectile.find(r => r.cm360 === cm)?.avgDelta ?? null,
  }));
  const hasArch = byArchetype.hitscan.length > 0 || byArchetype.projectile.length > 0;

  return wrap(
    <div className="space-y-6">
      <p className="text-xs text-[var(--faint)]">
        <span className="text-[var(--ink)] font-semibold">{summary.n}</span> logged matches across{' '}
        <span className="text-[var(--ink)] font-semibold">{summary.distinctScale}</span> distinct cm/360 scales.
        Accuracy is shown as a delta vs. your own average on each hero, so heroes mix fairly.
        {summary.maskedPending > 0 && (
          <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-violet-500/15 text-violet-500 px-2 py-0.5 text-[11px] font-semibold">
            🔒 {summary.maskedPending} blind trial{summary.maskedPending === 1 ? '' : 's'} held out until revealed
          </span>
        )}
      </p>

      {/* Feel vs Data — the headline */}
      <Section
        title="Feel vs. Data"
        hint="X-axis = cm/360 (physical mouse travel per turn — lower = faster). Bars = how it felt (1–9). Line = accuracy vs. your hero average. Where a tall bar sits over a dip in the line, your gut is over-rating that scale (and vice versa)."
      >
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={byScale} margin={{ top: 8, right: 8, bottom: 4, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--ow-border)" />
            <XAxis dataKey="cm360" tick={axisStyle} tickLine={false} unit="cm" />
            <YAxis yAxisId="feel" domain={[1, 9]} tick={axisStyle} tickLine={false} axisLine={false} width={28} />
            <YAxis yAxisId="delta" orientation="right" tick={axisStyle} tickLine={false} axisLine={false} width={36} />
            <Tooltip
              contentStyle={{ background: 'var(--ow-card)', border: '1px solid var(--ow-border)', borderRadius: 8, fontSize: 12 }}
              formatter={(v: number, name: string) => [name === 'Feel' ? f1(v) : signed(v), name]}
              labelFormatter={(l) => `${l} cm/360`}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="feel" dataKey="avgFeel" name="Feel" fill={FEEL} radius={[4, 4, 0, 0]} maxBarSize={48} />
            <Line yAxisId="delta" type="monotone" dataKey="avgDelta" name="Accuracy Δ" stroke={ACCURACY} strokeWidth={2} dot={{ r: 3 }} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </Section>

      {/* Hitscan vs Projectile */}
      {hasArch && (
        <Section
          title="Hitscan vs. Projectile"
          hint="Accuracy delta by cm/360, split by aim type. If both peak at the same scale, one setting serves everything. If the peaks are far apart, a split may be worth it."
        >
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={archData} margin={{ top: 8, right: 8, bottom: 4, left: -8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--ow-border)" />
              <XAxis dataKey="cm360" tick={axisStyle} tickLine={false} unit="cm" />
              <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={36} />
              <Tooltip
                contentStyle={{ background: 'var(--ow-card)', border: '1px solid var(--ow-border)', borderRadius: 8, fontSize: 12 }}
                formatter={(v: number, name: string) => [signed(v), name]}
                labelFormatter={(l) => `${l} cm/360`}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="hitscan" name="Hitscan" stroke={HITSCAN} strokeWidth={2} dot={{ r: 3 }} connectNulls />
              <Line type="monotone" dataKey="projectile" name="Projectile" stroke={PROJECTILE} strokeWidth={2} dot={{ r: 3 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </Section>
      )}

      {/* Cold vs Warm + Adaptation */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Cold vs. Warm" hint="First game of a session vs. later ones — is a sens good from the jump, or only once warmed up?">
          <div className="grid grid-cols-2 gap-3">
            {coldWarm.map(b => (
              <div key={b.bucket} className="rounded-lg bg-ow-darker border border-ow-border p-3">
                <div className="text-[11px] text-[var(--faint)] mb-1">{b.bucket}</div>
                <div className="text-2xl num-display text-[var(--ink)]">{f1(b.avgOverall)}<span className="text-xs text-[var(--faint)] ml-0.5">%</span></div>
                <div className="text-[11px] text-[var(--faint-2)] mt-1">Δ {signed(b.avgDelta)} · feel {f1(b.avgFeel)} · n={b.n}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Adaptation" hint="Just after a sens change vs. once settled — separates a genuinely worse sens from one you hadn't adjusted to yet.">
          <div className="grid grid-cols-2 gap-3">
            {adaptation.map(b => (
              <div key={b.bucket} className="rounded-lg bg-ow-darker border border-ow-border p-3">
                <div className="text-[11px] text-[var(--faint)] mb-1">{b.bucket}</div>
                <div className="text-2xl num-display text-[var(--ink)]">{f1(b.avgOverall)}<span className="text-xs text-[var(--faint)] ml-0.5">%</span></div>
                <div className="text-[11px] text-[var(--faint-2)] mt-1">Δ {signed(b.avgDelta)} · feel {f1(b.avgFeel)} · n={b.n}</div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* Per-scale table */}
      <Section title="By Scale (cm/360)" hint="Every recorded cm/360 scale with its eDPI and averages. Δ is accuracy vs. your hero baseline. Sens is the in-game value behind that scale (constant across blind trials).">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                <th className="py-1.5 pr-3">cm/360</th><th className="py-1.5 pr-3">eDPI</th><th className="py-1.5 pr-3">Sens</th><th className="py-1.5 pr-3">n</th>
                <th className="py-1.5 pr-3">Overall</th><th className="py-1.5 pr-3">Crit</th><th className="py-1.5 pr-3">Feel</th><th className="py-1.5">Δ</th>
              </tr>
            </thead>
            <tbody>
              {byScale.map(r => (
                <tr key={r.cm360} className="border-t border-ow-border text-[var(--ink-2)]">
                  <td className="py-1.5 pr-3 font-semibold text-[var(--ink)]">{f1(r.cm360)}</td>
                  <td className="py-1.5 pr-3">{r.eDPI}</td>
                  <td className="py-1.5 pr-3">{r.sens}</td>
                  <td className="py-1.5 pr-3">{r.n}</td>
                  <td className="py-1.5 pr-3">{f1(r.avgOverall)}%</td>
                  <td className="py-1.5 pr-3">{f1(r.avgCrit)}%</td>
                  <td className="py-1.5 pr-3">{f1(r.avgFeel)}</td>
                  <td className={`py-1.5 ${r.avgDelta != null && r.avgDelta > 0 ? 'text-emerald-500' : r.avgDelta != null && r.avgDelta < 0 ? 'text-red-500' : ''}`}>{signed(r.avgDelta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* By hero */}
      <Section title="By Hero" hint="Sample size per hero — thin rows are noise until they build up.">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                <th className="py-1.5 pr-3">Hero</th><th className="py-1.5 pr-3">Type</th><th className="py-1.5 pr-3">n</th>
                <th className="py-1.5 pr-3">Overall</th><th className="py-1.5">Crit</th>
              </tr>
            </thead>
            <tbody>
              {heroes.map(h => (
                <tr key={h.hero} className="border-t border-ow-border text-[var(--ink-2)]">
                  <td className="py-1.5 pr-3 font-semibold text-[var(--ink)]">{h.hero}</td>
                  <td className="py-1.5 pr-3 capitalize text-[var(--faint)]">{h.archetype}</td>
                  <td className="py-1.5 pr-3">{h.n}</td>
                  <td className="py-1.5 pr-3">{f1(h.avgOverall)}%</td>
                  <td className="py-1.5">{f1(h.avgCrit)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>,
  );
}

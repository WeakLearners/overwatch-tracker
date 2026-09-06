import { useMemo } from 'react';
import { useApi } from '../hooks/useApi';

interface FactoidPart {
  text: string;
  color?: 'good' | 'bad';
}
interface Factoid {
  id: string;
  category: string;
  parts: FactoidPart[];
}
interface InsightsData {
  factoids: Factoid[];
}

// Matches the Career section's Wins/Losses StatCards exactly (grad-win /
// grad-loss gradient-text classes, defined in index.css).
const PART_COLOR: Record<'good' | 'bad', string> = {
  good: 'grad-win font-bold',
  bad: 'grad-loss font-bold',
};

// Fisher-Yates, so every factoid in the pool has an equal shot at being drawn.
function shuffled<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Factoid length varies a lot (70–200 chars) — scale the font so a short
// one-liner actually fills the square instead of sitting tiny in the middle,
// while a long one still fits without overflowing. Sized down at the mobile
// 2-column width (roughly half the desktop 4-column card width) so the same
// character count doesn't need more lines than an aspect-square card has
// room for.
function fontSizeClass(len: number): string {
  if (len <= 90) return 'text-lg sm:text-2xl leading-snug sm:leading-tight';
  if (len <= 130) return 'text-base sm:text-lg leading-snug';
  if (len <= 170) return 'text-sm sm:text-base leading-snug';
  return 'text-xs sm:text-sm leading-snug';
}

function FactoidCard({ f }: { f: Factoid }) {
  const len = f.parts.reduce((n, p) => n + p.text.length, 0);
  return (
    // Square only from sm: up. No-scroll-in-cards rule: overflow is solved by
    // compression, never a scroll region. Mobile stays aspect-auto (the
    // square constraint used to clip long factoids mid-sentence with no
    // ellipsis, since flex's `my-auto` collapses to 0 on overflow). The sm:+
    // square is kept scroll-free via tighter padding, a smaller category
    // label, and a longer tail of font-size tiers for the longest factoids.
    <div className="card !p-3 aspect-auto sm:aspect-square flex flex-col overflow-visible">
      <div className="text-[9px] text-[var(--muted)] uppercase tracking-wider mb-1 shrink-0">{f.category}</div>
      <p className={`font-medium text-[var(--ink)] my-auto ${fontSizeClass(len)}`}>
        {f.parts.map((p, i) => p.color
          ? <span key={i} className={PART_COLOR[p.color]}>{p.text}</span>
          : <span key={i}>{p.text}</span>,
        )}
      </p>
    </div>
  );
}

// Four square cards, each a random one-sentence data insight drawn from the
// backend's pool of reliable factoids (death-axis outcomes, hot hand, and
// performance-vs-outcome splits). Re-drawn once per page load — no tables,
// no charts, just the plain-English finding.
export default function TrendsSummary() {
  const { data } = useApi<InsightsData>('/api/stats/insights');
  const factoids = data?.factoids ?? [];

  // Drawn once per fresh page load (data identity changes once the fetch
  // resolves), not on every re-render.
  const shown = useMemo(() => shuffled(factoids).slice(0, 4), [data]);

  if (shown.length === 0) return null;

  return (
    <div data-inspect-id="trendssummary-factoid-grid dash-trends-summary-section" className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      {shown.map(f => (
        <FactoidCard key={f.id} f={f} />
      ))}
    </div>
  );
}

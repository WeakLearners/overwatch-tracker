import PageHeader from '../PageHeader';
import TrendsSummary from '../TrendsSummary';

/** Dashboard's Trends section wrapper. Pure move out of Dashboard.tsx
 * (modularization plan step 3, 2026-09-27) — no props needed, since
 * TrendsSummary fetches its own data; no new fetches, no behavior change. */
export default function TrendsSection() {
  return (
    <div id="sec-trends" className="mt-8 border-t border-ow-border pt-6 reveal scroll-mt-32" style={{ '--reveal-delay': '180ms' } as React.CSSProperties}>
      <PageHeader dataInspectId="dash-trends-section-header" title="Trends" sub="Recent form and momentum." />
      <TrendsSummary />
    </div>
  );
}

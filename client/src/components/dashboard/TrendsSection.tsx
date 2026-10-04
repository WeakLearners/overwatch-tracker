import { memo } from 'react';
import PageHeader from '../PageHeader';
import TrendsSummary from '../TrendsSummary';
import SessionWindowCard from './SessionWindowCard';

/** Dashboard's Trends section wrapper. Pure move out of Dashboard.tsx
 * (modularization plan step 3, 2026-09-27) — no props needed, since
 * TrendsSummary fetches its own data; no new fetches, no behavior change.
 *
 * Optimization pass (2026-09-27): wrapped in memo. This component takes no
 * props, so without memo it re-rendered (and re-ran TrendsSummary's own
 * factoid computation) on every one of Dashboard's scroll-driven
 * activeSection re-renders for no reason — memo(no-props) skips all of
 * those; TrendsSummary's own internal state/fetch still updates it
 * normally. */
function TrendsSection() {
  return (
    <div id="sec-trends" className="mt-8 border-t border-ow-border pt-6 reveal scroll-mt-32" style={{ '--reveal-delay': '180ms' } as React.CSSProperties}>
      <PageHeader dataInspectId="dash-trends-section-header" title="Trends" sub="Recent form and momentum." />
      <TrendsSummary />
      <div className="mt-4"><SessionWindowCard /></div>
    </div>
  );
}

export default memo(TrendsSection);

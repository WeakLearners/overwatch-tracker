import { Link, useLocation, useNavigate } from 'react-router-dom';
import SegmentedPills from './SegmentedPills';
import AppTools from './AppTools';

// Nav strip shared by the two sens-study pages (entry + analysis). Same card,
// same three slots and same SegmentedPills as the tracker's dash-section-nav
// (Dashboard.tsx): back link left (where the tracker has its season badge),
// tabs on the true centre, app tools right. HeaderTools in App.tsx hides the
// header copy of the tools on these routes, so there is one inspector slot.
const TABS = ['/sens', '/sens/analysis'] as const;
const LABEL: Record<string, string> = { '/sens': 'Study', '/sens/analysis': 'Analysis' };
const TAB_ID: Record<string, string> = { '/sens': 'sensNav-study-tab', '/sens/analysis': 'sensNav-analysis-tab' };

export default function SensNav({ dataInspectId }: { dataInspectId?: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const value = (TABS as readonly string[]).includes(pathname) ? (pathname as typeof TABS[number]) : null;
  return (
    <nav
      data-inspect-id={dataInspectId}
      aria-label="Sens study pages"
      className="card !py-0 sticky top-16 z-20 mb-6 flex items-stretch gap-2.5 min-h-[42px]"
    >
      <div className="flex flex-1 basis-0 min-w-0 items-center self-center">
        {/* Lands on the dashboard's Match section rather than the top of the
            page. Coming back from the sens study, the next thing wanted is
            almost always prep-or-log, which is what that section holds. */}
        <Link
          to="/match"
          data-inspect-id="sensNav-back-link"
          className="text-sm heading-display text-[var(--faint)] hover:text-[var(--ink)] whitespace-nowrap transition-colors"
        >
          ← Match Tracker
        </Link>
      </div>
      <SegmentedPills
        options={TABS}
        value={value}
        onPick={to => navigate(to)}
        labelFor={to => LABEL[to]}
        size="lg"
        strong
        inspectId="sensNav-pills"
        idFor={to => TAB_ID[to]}
        titleFor={to => `Go to ${LABEL[to]}`}
      />
      <div className="flex-1 basis-0 min-w-0 flex justify-end">
        <AppTools />
      </div>
    </nav>
  );
}

import { Link, useLocation } from 'react-router-dom';

// Tab strip shared by the two sens-study pages (entry + analysis). The study
// lives on its own /sens routes, unlinked from the main Dashboard.
export default function SensNav({ dataInspectId }: { dataInspectId?: string }) {
  const { pathname } = useLocation();
  const tab = (to: string, label: string, inspectId: string) => {
    const active = pathname === to;
    return (
      <Link
        to={to}
        data-inspect-id={inspectId}
        className={`pill heading-display tracking-[0.08em] border transition-all ${
          active
            ? 'is-selected text-orange-700 dark:text-ow-accent'
            : 'text-[var(--faint)] border-ow-border hover:text-[var(--ink)] hover:border-gray-500'
        }`}
      >
        {label}
      </Link>
    );
  };
  return (
    <div className="flex items-center gap-2 mb-5" data-inspect-id={dataInspectId}>
      {tab('/sens', 'Study', 'sensNav-study-tab')}
      {tab('/sens/analysis', 'Analysis', 'sensNav-analysis-tab')}
      {/* Lands on the dashboard's Match section rather than the top of the
          page. Coming back from the sens study, the next thing wanted is
          almost always prep-or-log, which is what that section holds. */}
      <Link
        to="/#sec-match"
        data-inspect-id="sensNav-back-link"
        className="pill heading-display tracking-[0.08em] ml-auto border border-ow-border text-[var(--faint)] hover:text-[var(--ink)] hover:border-gray-500 transition-all"
      >
        ← Match Tracker
      </Link>
    </div>
  );
}

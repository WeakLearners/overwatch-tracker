import { Link, useLocation } from 'react-router-dom';

// Tab strip shared by the two sens-study pages (entry + analysis). The study
// lives on its own /sens routes, unlinked from the main Dashboard.
export default function SensNav() {
  const { pathname } = useLocation();
  const tab = (to: string, label: string) => {
    const active = pathname === to;
    return (
      <Link
        to={to}
        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
          active
            ? 'bg-violet-500/20 text-violet-500 border-violet-500'
            : 'text-[var(--faint)] hover:text-[var(--ink)] border-transparent'
        }`}
      >
        {label}
      </Link>
    );
  };
  return (
    <div className="flex items-center gap-2 mb-5">
      {tab('/sens', 'Study')}
      {tab('/sens/analysis', 'Analysis')}
      <Link
        to="/"
        className="ml-auto px-3 py-1.5 rounded-lg text-xs font-semibold border border-ow-border text-[var(--faint)] hover:text-[var(--ink)] hover:border-gray-500 transition-all"
      >
        ← Match Tracker
      </Link>
    </div>
  );
}

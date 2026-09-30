import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts } from '../hooks/useHeroCounts';
import { Overview, Streaks, TrendPoint, ModeComparison } from '../types';
import PageHeader from '../components/PageHeader';
import SegmentedPills from '../components/SegmentedPills';
import AppTools from '../components/AppTools';
import Prematch from './Prematch';
import LogMatch from './LogMatch';
import KillerFrequencyCard from '../components/KillerFrequencyCard';
import CareerStrip from '../components/dashboard/CareerStrip';
import TrendsSection from '../components/dashboard/TrendsSection';
import ModeComparisonCard from '../components/dashboard/ModeComparisonCard';
import RecentMatchesCard from '../components/dashboard/RecentMatchesCard';
import { useFieldConfig } from '../contexts/FieldConfigContext';

export default function Dashboard() {
  const { isFieldEnabled } = useFieldConfig();
  const { data: overview } = useApi<Overview>('/api/stats/overview');
  const { data: streaks } = useApi<Streaks>('/api/stats/streaks');
  const { data: trends } = useApi<TrendPoint[]>('/api/stats/trends?window=20');
  const { data: modeComparison } = useApi<ModeComparison[]>('/api/stats/mode-comparison');
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();
  // Session tilt is map-independent, so a no-arg prematch fetch gives it to us.
  const { data: prematch } = useApi<{ session: { on_tilt: boolean; tilt_win_rate: number | null; tilt_games: number } | null }>('/api/stats/prematch');
  const tilt = prematch?.session;

  // The candle/volume/rank-strip derivation and its JSX now live entirely
  // inside RecentMatchesCard (components/dashboard/RecentMatchesCard.tsx,
  // memo-wrapped, fed only `trends` and `tilt`) — Dashboard itself no
  // longer needs any of computeTrendsDerived's output, so it isn't called
  // here at all.

  const sections = [
    { id: 'sec-form', label: 'Form' },
    { id: 'sec-mode', label: 'Mode' },
    { id: 'sec-match', label: 'Match' },
    { id: 'sec-trends', label: 'Trends' },
    { id: 'sec-career', label: 'Career' },
  ];

  // Tracks which section is currently in view so the quick-nav pill can get
  // the same solid-fill active treatment SensNav already uses, instead of
  // every pill sitting at the same neutral gray forever. The negative
  // top margin clears both sticky bars (header + this nav) before a section
  // counts as "current".
  const [activeSection, setActiveSection] = useState(sections[0].id);

  // A link may name a section in the URL (SensNav's "← Match Tracker" asks for
  // #sec-match). The browser cannot honour that on its own here: this is a
  // single-page app, so arriving is a re-render, not a page load, and the
  // section is still empty at that moment. Wait for the panels above it to
  // have their data — otherwise the scroll aims at a target that the arriving
  // chart immediately pushes further down the page. Fires once; a later
  // refetch must not yank the page back.
  const { hash } = useLocation();
  const landed = useRef(false);
  const aboveLoaded = Boolean(overview && trends && modeComparison);
  useEffect(() => {
    if (!hash || landed.current || !aboveLoaded) return;
    const el = document.getElementById(hash.slice(1));
    if (!el) return;
    landed.current = true;
    // One frame, so the just-rendered panels are laid out before measuring.
    requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  }, [hash, aboveLoaded]);
  // A clicked pill lights at once and holds while the smooth scroll passes
  // the sections in between (they would otherwise flicker through).
  const pinnedUntil = useRef(0);
  const jumpTo = (id: string) => {
    setActiveSection(id);
    pinnedUntil.current = Date.now() + 1200;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    history.replaceState(null, '', `#${id}`);
  };
  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        if (Date.now() < pinnedUntil.current) return;
        const visible = entries.find(e => e.isIntersecting);
        if (visible) setActiveSection(visible.target.id);
      },
      { rootMargin: '-140px 0px -70% 0px', threshold: 0 },
    );
    sections.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    // The last sections are too short to ever reach the band above, so at
    // the bottom of the page the last one is current (2026-09-26: Career
    // never lit).
    const onScroll = () => {
      if (Date.now() < pinnedUntil.current) return;
      const el = document.documentElement;
      if (el.scrollTop + window.innerHeight >= el.scrollHeight - 4) setActiveSection(sections[sections.length - 1].id);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { observer.disconnect(); window.removeEventListener('scroll', onScroll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {/* Wayfinding rail: the page is one long scroll of readout panels, so a
          sticky jump-strip stands in for the section tabs a multi-page app
          would use. Styled as the "Playing as" strip (2026-09-26): same thin
          card, same sliding lit pill row (SegmentedPills), and the app tools
          (inspector / settings / theme) moved in from the header on the right.
          The label and the tools both take flex-1 basis-0, so the section
          pills sit on the strip's true centre, as the identity pills do. */}
      <nav
        data-inspect-id="dash-section-nav"
        aria-label="Jump to section"
        className="card !py-0 sticky top-16 z-20 mb-6 flex items-stretch gap-2.5 min-h-[42px]"
      >
        <span className="hidden sm:block text-sm card-title shrink-0 flex-1 basis-0 min-w-0 self-center">Jump to</span>
        <SegmentedPills
          options={sections.map(s => s.id)}
          value={activeSection}
          onPick={jumpTo}
          labelFor={id => sections.find(s => s.id === id)!.label}
          size="lg"
          strong
          inspectId="dash-section-nav-pills"
          idFor={id => `dash-section-nav-${id.replace('sec-', '')}`}
          titleFor={id => `Jump to ${sections.find(s => s.id === id)!.label}`}
        />
        <div className="flex-1 basis-0 min-w-0 flex justify-end">
          <AppTools />
        </div>
      </nav>

      {/* Form & Rank leads the page (Sean, 2026-09-30): the long view of how
          play is going comes first. Its own jump target, first in the nav;
          "Mode" still lands on the tiles below it. */}
      <div id="sec-form" className="mb-6 scroll-mt-32"><RecentMatchesCard trends={trends} tilt={tilt} /></div>

      <div id="sec-mode" className="scroll-mt-32">
        {modeComparison && (
          <div className="reveal mb-6" style={{ '--reveal-delay': '0ms' } as React.CSSProperties}>
            <ModeComparisonCard data={modeComparison} />
          </div>
        )}
      </div>

      <div id="sec-match" className="mt-8 border-t border-ow-border pt-6 reveal scroll-mt-32" style={{ '--reveal-delay': '120ms' } as React.CSSProperties}>
        <PageHeader dataInspectId="dash-match-section-header" title="Match" sub="Prep with the advisor, then log the result.">
          {/* Links to the (otherwise unlinked) sensitivity-study pages, on the
              right of the section header. Open in a new tab so the dashboard
              stays put while stats are logged. */}
          <a
            href="/sens" target="_blank" rel="noreferrer"
            data-inspect-id="dash-log-sens-stats-link"
            className="shrink-0 bg-ow-card border border-ow-border px-4 py-2 text-sm heading-display text-[var(--ink)] hover:text-ow-accent transition-colors shadow-[var(--card-shadow)]"
            style={{ clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)' }}
          >
            Log sens stats
          </a>
        </PageHeader>
        <div className="contents" data-inspect-id="dash-prematch-section"><Prematch /></div>
        <div className="contents" data-inspect-id="dash-logmatch-section"><LogMatch /></div>
      </div>

      <TrendsSection />

      {isFieldEnabled('deaths') && (
      <div id="sec-killer-frequency" className="mt-8 border-t border-ow-border pt-6 reveal scroll-mt-32" data-inspect-id="dash-killer-frequency-section" style={{ '--reveal-delay': '200ms' } as React.CSSProperties}>
        <KillerFrequencyCard />
      </div>
      )}

      <CareerStrip overview={overview} streaks={streaks} />
    </div>
  );
}

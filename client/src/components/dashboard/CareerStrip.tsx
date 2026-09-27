import { memo } from 'react';
import { Overview, Streaks } from '../../types';
import StatCard from '../StatCard';
import PageHeader from '../PageHeader';

interface Props {
  overview: Overview | null;
  streaks: Streaks | null;
}

/** All-time totals strip on the Dashboard's Career section. Pure move out
 * of Dashboard.tsx (modularization plan step 2) — takes already-fetched
 * overview/streaks as props, no new fetches, no behavior change.
 *
 * Optimization pass (2026-09-27): wrapped in memo. Dashboard re-renders on
 * every scroll tick (activeSection state, driven by an IntersectionObserver
 * + a window scroll listener), and this card's props (overview/streaks) are
 * stable useApi state that only change on an actual refetch — so those
 * scroll-driven re-renders were re-rendering all 8 StatCards here for no
 * reason. memo skips that; it still re-renders whenever overview/streaks
 * actually change. */
function CareerStrip({ overview, streaks }: Props) {
  return (
    <div id="sec-career" className="mt-8 border-t border-ow-border pt-6 reveal scroll-mt-32" style={{ '--reveal-delay': '240ms' } as React.CSSProperties}>
      <PageHeader dataInspectId="dash-career-section-header" title="Career" sub="All-time totals across every mode." />
      {/* One continuous readout strip rather than two stacked 4-tile grids —
          all eight career totals scan as a single row on wide screens. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <StatCard compact dataInspectId="dash-stat-total-games" label="Total Games" value={overview?.total ?? '—'} />
        <StatCard
          compact
          dataInspectId="dash-stat-win-rate"
          label="Win Rate"
          value={overview ? overview.win_rate : '—'}
          decimals={1}
          suffix="%"
          color={overview && overview.win_rate >= 50 ? 'win' : 'loss'}
        />
        <StatCard compact dataInspectId="dash-stat-wins" label="Wins" value={overview?.wins ?? '—'} color="win" />
        <StatCard compact dataInspectId="dash-stat-losses" label="Losses" value={overview ? overview.total - overview.wins : '—'} color="loss" />
        <StatCard compact dataInspectId="dash-stat-heroes-played" label="Heroes Played" value={overview?.heroes_played ?? '—'} />
        <StatCard
          compact
          dataInspectId="dash-stat-current-streak"
          label="Current Streak"
          value={streaks ? `${streaks.currentStreak} ${streaks.currentStreakType === 1 ? 'W' : 'L'}` : '—'}
          color={streaks?.currentStreakType === 1 ? 'win' : 'loss'}
        />
        <StatCard compact dataInspectId="dash-stat-longest-win-streak" label="Longest Win Streak" value={streaks?.longestWin ?? '—'} color="win" />
        {/* Counted only over matches where the question was asked, which is
            why the sub-line prints the denominator instead of a bare
            percentage. The old rows are silent here, not zero. */}
        <StatCard
          compact
          dataInspectId="dash-stat-leavers"
          label="Leavers"
          value={overview?.leaver_games ?? '—'}
          sub={
            overview && overview.leaver_logged > 0
              ? `of ${overview.leaver_logged} asked · ${overview.win_rate_no_leaver ?? '—'}% WR without${
                  overview.leaver_mine + overview.leaver_theirs > 0
                    ? ` · ${overview.leaver_mine} mine / ${overview.leaver_theirs} theirs`
                    : ''
                }`
              : 'not logged yet'
          }
          color="loss"
        />
      </div>
    </div>
  );
}

export default memo(CareerStrip);

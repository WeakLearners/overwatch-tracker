import { useApi } from '../../hooks/useApi';
import EmptyState from '../EmptyState';
import FindingChip, { type Finding } from '../FindingChip';

// Scoreboard trend card (2026-10-30): the first card that reads the
// scoreboard screenshot data. One server call (GET /api/stats/scoreboard-trends,
// lab side, lib/scoreboardTrends.ts) returns all four blocks. Only the death
// bins and the week rows carry a corrected verdict; the rest is descriptive.
interface Bin { label: string; n: number; wins: number; win_rate: number | null; finding: Finding }
interface Side {
  n: number; per10_n: number;
  elims10: number | null; deaths10: number | null; damage10: number | null; healing10: number | null;
  death_share: number | null; damage_share: number | null;
}
interface Week { week: string; role: string; n: number; win_rate: number; per10_n: number; deaths10: number | null; elims10: number | null; finding: Finding }
interface Trends {
  scope: { matches: number; first_date: string | null; last_date: string | null; win_rate: number | null; per10_covered: number };
  death_bins: Bin[];
  win_loss: { wins: Side; losses: Side };
  rank: {
    rows: number; excluded: number; no_delta: number; used: number;
    victory: { n: number; mean_delta: number | null }; defeat: { n: number; mean_delta: number | null };
    break_even_wr: number | null; actual_wr: number | null;
  };
  weeks: Week[];
}

const WEEKS_SHOWN = 8;
const THIN_N = 10;

const num = (v: number | null, digits = 1) => (v === null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const int = (v: number | null) => (v === null ? '—' : Math.round(v).toLocaleString('en-US'));
const signed = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`);

function Block({ title, note, dataInspectId, children }: { title: string; note: string; dataInspectId: string; children: React.ReactNode }) {
  return (
    <div data-inspect-id={dataInspectId} className="min-w-0">
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className="text-xs font-semibold text-[var(--ink)] whitespace-nowrap">{title}</h3>
        <span className="text-[10px] text-[var(--faint-2)] truncate">{note}</span>
      </div>
      {children}
    </div>
  );
}

export default function ScoreboardTrendsCard() {
  const { data, loading } = useApi<Trends>('/api/stats/scoreboard-trends');

  return (
    <div className="card" data-inspect-id="dash-scoreboard-trends-card">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-sm card-title whitespace-nowrap">Scoreboard Trends</h2>
        <span className="text-xs text-[var(--faint-2)] truncate">
          {data
            ? `comp only · ${data.scope.matches} games with a board · per-10 figures use the ${data.scope.per10_covered} with play time · grey under ${THIN_N} games`
            : 'from the scoreboard screenshots'}
        </span>
      </div>
      {loading && !data ? (
        <div className="text-xs text-[var(--muted)]">Loading…</div>
      ) : !data || data.scope.matches === 0 ? (
        <EmptyState
          dataInspectId="dash-scoreboard-trends-empty"
          title="No scoreboard screenshots matched yet"
          hint="Matched Teams boards appear here."
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-5">
          <DeathBins bins={data.death_bins} overall={data.scope.win_rate} />
          <WinLoss wl={data.win_loss} covered={data.scope.per10_covered} />
          <RankBreakEven rank={data.rank} />
          <WeekTable weeks={data.weeks} />
        </div>
      )}
    </div>
  );
}

function DeathBins({ bins, overall }: { bins: Bin[]; overall: number | null }) {
  return (
    <Block dataInspectId="dash-scoreboard-trends-deaths" title="Win rate by your deaths" note={`all games ${overall === null ? '—' : overall.toFixed(1) + '%'}`}>
      <div className="grid grid-cols-[3rem_1fr_auto] gap-x-3 gap-y-1 items-center text-xs">
        {bins.map(b => {
          const thin = b.n < THIN_N;
          return (
            <div key={b.label} className="contents">
              <div className="text-[var(--muted)]">{b.label}</div>
              <div className="flex items-baseline gap-2">
                <span className={`font-bold ${thin ? 'text-[var(--muted)]' : b.win_rate !== null && b.win_rate >= 50 ? 'grad-win' : 'grad-loss'}`}>
                  {b.win_rate === null ? '—' : `${b.win_rate.toFixed(1)}%`}
                </span>
                <span className="text-[10px] text-[var(--faint)]">{b.wins}–{b.n - b.wins} · {b.n} games</span>
              </div>
              <FindingChip finding={b.finding} against="all other death bins" />
            </div>
          );
        })}
      </div>
    </Block>
  );
}

function WinLoss({ wl, covered }: { wl: { wins: Side; losses: Side }; covered: number }) {
  const rows: { label: string; w: string; l: string }[] = [
    { label: 'Elims / 10 min', w: num(wl.wins.elims10), l: num(wl.losses.elims10) },
    { label: 'Deaths / 10 min', w: num(wl.wins.deaths10), l: num(wl.losses.deaths10) },
    { label: 'Damage / 10 min', w: int(wl.wins.damage10), l: int(wl.losses.damage10) },
    { label: 'Healing / 10 min', w: int(wl.wins.healing10), l: int(wl.losses.healing10) },
    { label: 'Share of team deaths', w: wl.wins.death_share === null ? '—' : `${num(wl.wins.death_share)}%`, l: wl.losses.death_share === null ? '—' : `${num(wl.losses.death_share)}%` },
    { label: 'Share of team damage', w: wl.wins.damage_share === null ? '—' : `${num(wl.wins.damage_share)}%`, l: wl.losses.damage_share === null ? '—' : `${num(wl.losses.damage_share)}%` },
  ];
  return (
    <Block dataInspectId="dash-scoreboard-trends-winloss" title="Wins vs losses" note={`per-10 rows: ${wl.wins.per10_n} wins, ${wl.losses.per10_n} losses of ${covered} · description only`}>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 text-xs">
        <div />
        <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] text-right">Wins {wl.wins.n}</div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--muted)] text-right">Losses {wl.losses.n}</div>
        {rows.map(r => (
          <div key={r.label} className="contents">
            <div className="text-[var(--muted)]">{r.label}</div>
            <div className="text-right tabular-nums text-[var(--ink)]">{r.w}</div>
            <div className="text-right tabular-nums text-[var(--ink)]">{r.l}</div>
          </div>
        ))}
      </div>
    </Block>
  );
}

function RankBreakEven({ rank }: { rank: Trends['rank'] }) {
  const gap = rank.actual_wr !== null && rank.break_even_wr !== null ? rank.actual_wr - rank.break_even_wr : null;
  return (
    <Block dataInspectId="dash-scoreboard-trends-rank" title="Rank break-even" note={`${rank.used} rank pages with a change bar · description only`}>
      <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
        <div className="text-[var(--muted)]">Mean change on a win ({rank.victory.n})</div>
        <div className="text-right tabular-nums grad-win font-bold">{signed(rank.victory.mean_delta)}%</div>
        <div className="text-[var(--muted)]">Mean change on a loss ({rank.defeat.n})</div>
        <div className="text-right tabular-nums grad-loss font-bold">{signed(rank.defeat.mean_delta)}%</div>
        <div className="text-[var(--muted)]">Break-even win rate</div>
        <div className="text-right tabular-nums text-[var(--ink)]">{rank.break_even_wr === null ? '—' : `${rank.break_even_wr.toFixed(1)}%`}</div>
        <div className="text-[var(--muted)]">Actual win rate on these pages</div>
        <div className="text-right tabular-nums text-[var(--ink)]">
          {rank.actual_wr === null ? '—' : `${rank.actual_wr.toFixed(1)}%`}
          {gap !== null && <span className="text-[10px] text-[var(--faint)]"> ({gap >= 0 ? '+' : ''}{gap.toFixed(1)}pp)</span>}
        </div>
      </div>
      <div className="mt-1 text-[10px] text-[var(--faint)]">
        {rank.excluded} misread {rank.excluded === 1 ? 'row' : 'rows'} left out · {rank.no_delta} with no change bar (Open Queue)
      </div>
    </Block>
  );
}

function WeekTable({ weeks }: { weeks: Week[] }) {
  const labels = [...new Set(weeks.map(w => w.week))].sort().slice(-WEEKS_SHOWN);
  const roles = [...new Set(weeks.map(w => w.role))].sort();
  const cell = (week: string, role: string) => weeks.find(w => w.week === week && w.role === role);
  return (
    <Block dataInspectId="dash-scoreboard-trends-weeks" title="Week by week" note={`win rate · deaths / elims per 10 min · games, by role · last ${WEEKS_SHOWN} weeks`}>
      <div className="grid gap-x-3 gap-y-1 text-xs items-baseline" style={{ gridTemplateColumns: `auto repeat(${roles.length}, minmax(0, 1fr))` }}>
        <div />
        {roles.map(r => <div key={r} className="text-[10px] uppercase tracking-wider text-[var(--muted)]">{r}</div>)}
        {labels.map(wk => (
          <div key={wk} className="contents">
            <div className="text-[var(--muted)] whitespace-nowrap">{wk.slice(5)}</div>
            {roles.map(role => {
              const c = cell(wk, role);
              if (!c) return <div key={role} className="text-[var(--faint-2)]">—</div>;
              const thin = c.n < THIN_N;
              return (
                <div key={role} className="flex flex-wrap items-baseline gap-x-1.5 leading-tight" title={`${wk} ${role}: ${c.n} games, ${c.per10_n} with play time`}>
                  <span className={`font-bold ${thin ? 'text-[var(--muted)]' : 'text-[var(--ink)]'}`}>{c.win_rate.toFixed(0)}%</span>
                  <span className={thin ? 'text-[var(--faint)]' : 'text-[var(--muted)]'}>{num(c.deaths10)} / {num(c.elims10)}</span>
                  <span className="text-[10px] text-[var(--faint)]">{c.n}</span>
                  <FindingChip finding={c.finding} against={`all other ${role} games`} />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Block>
  );
}

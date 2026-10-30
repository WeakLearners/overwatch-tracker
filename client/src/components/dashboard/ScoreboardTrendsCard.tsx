import { useApi } from '../../hooks/useApi';
import EmptyState from '../EmptyState';
import FindingChip, { type Finding } from '../FindingChip';

// Scoreboard trend card (2026-10-30, redesigned per design-lead spec
// scoreboard-trends-card-2026-10-30). One server call (GET /api/stats/scoreboard-trends,
// lab side, lib/scoreboardTrends.ts). Only death bins and week rows carry a
// corrected verdict. A rate here is never coloured by a W/L test (design-language 3).
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

const THIN_N = 10;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const num = (v: number | null, digits = 1) => (v === null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const int = (v: number | null) => (v === null ? '—' : Math.round(v).toLocaleString('en-US'));
const signed = (v: number | null) => (v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);
const dash = (label: string) => label.replace('-', '–');
const shortDate = (iso: string | null) => {
  const m = iso ? /^\d{4}-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}` : '—';
};
const roleName = (r: string) => (r === 'dps' ? 'DPS' : r.charAt(0).toUpperCase() + r.slice(1));
const MICRO = 'text-[10px] uppercase tracking-wider text-[var(--muted)] font-semibold';

function Block({ title, note, noteTitle, dataInspectId, children }: { title: string; note?: string; noteTitle?: string; dataInspectId: string; children: React.ReactNode }) {
  return (
    <div data-inspect-id={dataInspectId} className="min-w-0">
      <div className="flex items-baseline gap-2 mb-2">
        <h3 className={`${MICRO} whitespace-nowrap`}>{title}</h3>
        {note && <span className="text-xs text-[var(--faint-2)] truncate" title={noteTitle}>{note}</span>}
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
            ? `comp only · ${data.scope.matches} games with a scoreboard · ${shortDate(data.scope.first_date)} – ${shortDate(data.scope.last_date)}`
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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-6">
          <DeathBins bins={data.death_bins} overall={data.scope.win_rate} matches={data.scope.matches} />
          <div className="space-y-6 min-w-0">
            <RankBreakEven rank={data.rank} />
            <WinLoss wl={data.win_loss} covered={data.scope.per10_covered} />
          </div>
          <WeekLine weeks={data.weeks} />
        </div>
      )}
    </div>
  );
}

function DeathBins({ bins, overall, matches }: { bins: Bin[]; overall: number | null; matches: number }) {
  const holding = bins.filter(b => b.finding.verdict === 'holds').sort((a, b) => b.n - a.n)[0];
  return (
    <Block dataInspectId="dash-scoreboard-trends-deaths" title="Win rate by your deaths in a game">
      <div data-inspect-id="dash-scoreboard-trends-headline" className="mb-3">
        {holding ? (
          <>
            <div className="text-4xl num-display text-[var(--ink)]">{pct(holding.win_rate)}</div>
            <div className="text-sm text-[var(--ink-2)]">
              when you die {holding.label.endsWith('+') ? `${holding.label.slice(0, -1)} or more` : dash(holding.label)} times
            </div>
            <div className="text-xs text-[var(--faint)]">
              ({Math.round(holding.finding.lo)}–{Math.round(holding.finding.hi)}%) · {holding.n} games · <FindingChip finding={holding.finding} against="all other death bins" />
            </div>
          </>
        ) : (
          <div className="text-sm text-[var(--ink-2)]">No death range holds up after correction.</div>
        )}
      </div>
      <div className="grid grid-cols-[4rem_auto_auto_auto_1fr] gap-x-4 gap-y-1 text-xs items-baseline">
        <div className={MICRO}>Deaths</div>
        <div className={`${MICRO} text-right`}>Win rate</div>
        <div className={`${MICRO} text-right`}>95% range</div>
        <div className={`${MICRO} text-right`}>Games</div>
        <div />
        {bins.map(b => {
          const thin = b.n < THIN_N;
          return (
            <div key={b.label} className="contents">
              <div className="text-[var(--muted)]">{dash(b.label)}</div>
              <div className={`text-right tabular-nums ${thin ? 'text-[var(--muted)]' : 'text-[var(--ink)]'}`}>{pct(b.win_rate)}</div>
              <div className="text-right tabular-nums text-[var(--faint)]">{Math.round(b.finding.lo)}–{Math.round(b.finding.hi)}%</div>
              <div className="text-right tabular-nums text-[var(--ink)]">{b.n}</div>
              <div><FindingChip finding={b.finding} against="all other death bins" /></div>
            </div>
          );
        })}
        <div className="col-span-5 border-t border-ow-border" />
        <div className="text-[var(--muted)] whitespace-nowrap">All games</div>
        <div className="text-right tabular-nums text-[var(--ink)]">{pct(overall)}</div>
        <div />
        <div className="text-right tabular-nums text-[var(--ink)]">{matches}</div>
        <div />
      </div>
      <div className="mt-2 text-[10px] text-[var(--faint)]">A count per game. Short wins have fewer deaths, so this is a link, not a cause.</div>
    </Block>
  );
}

function RankBreakEven({ rank }: { rank: Trends['rank'] }) {
  const w = rank.victory.mean_delta, l = rank.defeat.mean_delta, a = rank.actual_wr, be = rank.break_even_wr;
  const expected = a !== null && w !== null && l !== null ? (a / 100) * w + (1 - a / 100) * l : null;
  const takeaway = a === null || be === null || a === be ? null
    : a > be ? `${a.toFixed(1)}% is above the ${be.toFixed(1)}% break-even.`
    : `${a.toFixed(1)}% is below the ${be.toFixed(1)}% needed to hold rank.`;
  const div = (v: number | null) => (v === null ? '—' : `${signed(v)}% of a division`);
  return (
    <Block
      dataInspectId="dash-scoreboard-trends-rank"
      title="Rank break-even"
      note={`${rank.used} games with a rank bar`}
      noteTitle={`${rank.excluded} misread ${rank.excluded === 1 ? 'row' : 'rows'} left out · ${rank.no_delta} with no change bar (Open Queue)`}
    >
      {rank.used === 0 ? (
        <div className="text-xs text-[var(--muted)]">No rank pages with a change bar yet.</div>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            <div className="text-[var(--muted)]">Rank change on a win</div>
            <div className="text-right tabular-nums text-[var(--ink)]">{div(w)}</div>
            <div className="text-[var(--muted)]">Rank change on a loss</div>
            <div className="text-right tabular-nums text-[var(--ink)]">{div(l)}</div>
            <div className="text-[var(--muted)]">Win rate to break even</div>
            <div className="text-right tabular-nums text-[var(--ink)]">{pct(be)}</div>
            <div className="text-[var(--muted)]">Win rate on these {rank.used} games</div>
            <div className="text-right tabular-nums text-[var(--ink)]">{pct(a)}</div>
            <div className="text-[var(--muted)]">Expected change per game at this win rate</div>
            <div className="text-right tabular-nums text-[var(--ink)] font-bold">{div(expected)}</div>
          </div>
          {takeaway && <div className="mt-2 text-xs text-[var(--ink-2)]">{takeaway}</div>}
        </>
      )}
    </Block>
  );
}

function WinLoss({ wl, covered }: { wl: { wins: Side; losses: Side }; covered: number }) {
  const rel = (w: number | null, l: number | null) => (w === null || l === null || w === 0 ? '—' : `${l - w < 0 ? '−' : '+'}${Math.abs(Math.round(((l - w) / w) * 100))}%`);
  const rows: { label: string; w: string; l: string; d: string }[] = [
    { label: 'Elims', w: num(wl.wins.elims10), l: num(wl.losses.elims10), d: rel(wl.wins.elims10, wl.losses.elims10) },
    { label: 'Deaths', w: num(wl.wins.deaths10), l: num(wl.losses.deaths10), d: rel(wl.wins.deaths10, wl.losses.deaths10) },
    { label: 'Damage', w: int(wl.wins.damage10), l: int(wl.losses.damage10), d: rel(wl.wins.damage10, wl.losses.damage10) },
  ];
  const ws = wl.wins.death_share, ls = wl.losses.death_share;
  const shareDiff = ws !== null && ls !== null ? ls - ws : null;
  const shareStr = (v: number | null) => (v === null ? '—' : `${num(v)}%`);
  const pts = shareDiff === null ? '—' : `${shareDiff < 0 ? '−' : '+'}${Math.abs(shareDiff).toFixed(1)} pts`;
  return (
    <Block dataInspectId="dash-scoreboard-trends-winloss" title="Wins vs losses" note={`per 10 min · ${covered} games with play time`}>
      {covered === 0 ? (
        <div className="text-xs text-[var(--muted)]">No games with play time yet.</div>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 gap-y-1 text-sm">
            <div />
            <div className={`${MICRO} text-right`}>Wins {wl.wins.n}</div>
            <div className={`${MICRO} text-right`}>Losses {wl.losses.n}</div>
            <div className={`${MICRO} text-right`}>Loss vs win</div>
            {rows.map(r => (
              <div key={r.label} className="contents">
                <div className="text-[var(--muted)]">{r.label}</div>
                <div className="text-right tabular-nums text-[var(--ink)]">{r.w}</div>
                <div className="text-right tabular-nums text-[var(--ink)]">{r.l}</div>
                <div className="text-right tabular-nums text-[var(--ink-2)]">{r.d}</div>
              </div>
            ))}
            <div className="text-[var(--muted)]">Your share of team deaths</div>
            <div className="text-right tabular-nums text-[var(--ink)]">{shareStr(ws)}</div>
            <div className="text-right tabular-nums text-[var(--ink)]">{shareStr(ls)}</div>
            <div className="text-right tabular-nums text-[var(--ink-2)]">{pts}</div>
          </div>
          {shareDiff !== null && Math.abs(shareDiff) < 2 && (
            <div className="mt-2 text-xs text-[var(--ink-2)]">Your share of team deaths barely changes, so the whole team dies more in a loss.</div>
          )}
        </>
      )}
    </Block>
  );
}

function WeekLine({ weeks }: { weeks: Week[] }) {
  const tested = weeks.filter(w => w.finding.verdict !== 'thin').length;
  const holding = weeks.filter(w => w.finding.verdict === 'holds');
  const unreliable = weeks.filter(w => w.finding.verdict === 'unreliable').length;
  return (
    <div data-inspect-id="dash-scoreboard-trends-weeks" className="lg:col-span-2 border-t border-ow-border pt-3 text-xs text-[var(--muted)]">
      By week and role: {tested} of {weeks.length} groups tested
      {holding.length === 0 ? ' · none holds up after correction' : holding.map(w => (
        <span key={`${w.week}-${w.role}`}>
          {' · '}{w.week.slice(5)} {roleName(w.role)} {w.win_rate.toFixed(1)}% · {w.n} games <FindingChip finding={w.finding} against={`all other ${w.role} games`} />
        </span>
      ))}
      {unreliable > 0 && <span className="text-amber-500 font-bold"> · {unreliable} ~ not reliable</span>}
    </div>
  );
}

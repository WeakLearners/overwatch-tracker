import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { Overview, Streaks, TrendPoint, ModeComparison, QueueMode, QUEUE_MODES, QUEUE_MODE_COLORS, QUEUE_MODE_SEL_RGB, RANK_TIER_RGB, rankTier, rankLabel } from '../types';
import StatCard from '../components/StatCard';
import AnimatedNumber from '../components/AnimatedNumber';
import EmptyState from '../components/EmptyState';
import ModeWatermark from '../components/ModeWatermark';
import PageHeader from '../components/PageHeader';
import { useHeroDrawer } from '../contexts/HeroDrawerContext';
import { useMatch } from '../contexts/MatchContext';
import { format, parseISO } from 'date-fns';
import Prematch from './Prematch';
import LogMatch from './LogMatch';
import TrendsSummary from '../components/TrendsSummary';


type ModeMeta = typeof QUEUE_MODES[number];
type LastLog = { mode: QueueMode; win: boolean; seq: number } | null;

// A single mode tile. Doubles as the queue-mode selector and plays the win/loss
// flash overlay when a match is logged under its mode.
function ModeTile({ meta, m, selected, onSelect, openHero, lastLog }: {
  meta: ModeMeta;
  m: ModeComparison | undefined;
  selected: boolean;
  onSelect: () => void;
  openHero: (h: string) => void;
  lastLog: LastLog;
}) {
  const [flash, setFlash] = useState<null | 'win' | 'loss'>(null);
  const heroCounts = useTodayHeroCounts();
  const c = QUEUE_MODE_COLORS[meta.value];

  // Trigger the sweep when the latest log was under this mode (skip on reduced
  // motion). `seq` is the dep so a repeat result still re-fires.
  useEffect(() => {
    if (!lastLog || lastLog.mode !== meta.value) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setFlash(lastLog.win ? 'win' : 'loss');
    const t = setTimeout(() => setFlash(null), 1050);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLog?.seq]);

  return (
    <button
      type="button"
      onClick={onSelect}
      data-inspect-id="dash-mode-tiles"
      // Same arrangement as LogMatch's selector: the shared class draws the
      // bottom-lit selected state, --sel decides its hue. A border width is
      // added here because the tile had none and .is-selected sets a colour,
      // which paints nothing without one.
      style={selected ? ({ '--sel': QUEUE_MODE_SEL_RGB[meta.value] } as React.CSSProperties) : undefined}
      className={`relative overflow-hidden text-left rounded-lg p-4 border-2 transition-all duration-200 mode-tile hover:-translate-x-1 hover:-translate-y-1 ${selected ? `is-selected ${c.glow}` : `border-transparent ${c.tileDim}`}`}
    >
      {/* 10% larger than the other (selector) watermarks — these tiles are bigger.
          Opacity is left at the component default (15%) even when selected —
          a forced full-opacity override here used to wash out the stat text
          drawn on top of it. */}
      <ModeWatermark
        mode={meta.value}
        variant="tile"
        className="scale-[3] translate-x-[19.0%] translate-y-[-7%]"
        color={selected ? undefined : 'text-ow-card'}
      />
      {flash && (
        <div
          className={`absolute inset-0 z-20 flex items-center justify-center mode-flash ${flash === 'win' ? 'bg-emerald-500/55' : 'bg-rose-500/55'}`}
          aria-hidden="true"
        >
          <span className={`text-6xl font-black text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.35)] ${flash === 'win' ? 'mode-arrow-up' : 'mode-arrow-down'}`}>
            {flash === 'win' ? '▲' : '▼'}
          </span>
        </div>
      )}
      <div className="relative z-10">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className={`pill min-w-0 truncate ${c.selected}`}>{meta.short}</span>
        {selected && <span className="shrink-0 whitespace-nowrap text-[11px] uppercase tracking-widest font-bold text-white/90">Selected</span>}
      </div>
      {m && m.games > 0 ? (
        <>
          {(() => {
            // Headline = recent form (last N games) so a single match visibly
            // moves it; the all-time rate sits below, smaller.
            const big = m.recent_win_rate ?? m.win_rate;
            return (
              <div className={`text-4xl font-black tracking-tight num-display ${big >= 50 ? 'grad-win' : 'grad-loss'}`}>
                <AnimatedNumber value={big} decimals={1} suffix="%" />
              </div>
            );
          })()}
          <div className="text-xs text-[var(--muted)] mt-0.5">
            last <b className="font-bold">{m.recent_window}</b>d · <span className="text-emerald-500 font-bold">{m.recent_wins}W</span> <span className="text-red-400 font-bold">{m.recent_games - m.recent_wins}L</span>
          </div>
          <div className="text-[11px] text-[var(--faint)] mt-0.5">
            <b className="font-bold">{m.win_rate}</b>% all-time · <b className="font-bold">{m.games}</b>g
          </div>
          <div className="mt-3">
            <div className="text-[10px] text-[var(--muted)] uppercase tracking-wider mb-1">Most played</div>
            {m.top_hero ? (
              <div className="flex items-center justify-between">
                <span
                  onClick={e => { e.stopPropagation(); openHero(m.top_hero!.hero); }}
                  title={m.top_hero.hero.toUpperCase()}
                  className="min-w-0 text-xs hero-name text-[var(--ink)] hover:text-ow-accent transition-colors truncate cursor-pointer"
                >
                  {withHeroCount(m.top_hero.hero, heroCounts)}
                </span>
                <span className="text-xs text-[var(--muted)] shrink-0 ml-2 font-bold">
                  {m.top_hero.win_rate}% · {m.top_hero.games}g
                </span>
              </div>
            ) : (
              <div className="text-sm text-[var(--faint)]">—</div>
            )}
          </div>
        </>
      ) : (
        <div className="text-sm text-[var(--faint)] mt-1">No games yet</div>
      )}
      </div>
    </button>
  );
}

// Per-mode summary that doubles as the queue-mode selector: tap a card to set
// the active mode that drives the advisor and the logged match.
function ModeComparisonCard({ data }: { data: ModeComparison[] }) {
  const { openHero } = useHeroDrawer();
  const { queueMode, setQueueMode, lastLog } = useMatch();
  const byMode = Object.fromEntries(data.map(m => [m.queue_mode, m]));

  return (
    <div className="card" data-inspect-id="dash-mode-card">
      <h2 className="text-sm card-title mb-4">Mode</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {QUEUE_MODES.map(meta => (
          <ModeTile
            key={meta.value}
            meta={meta}
            m={byMode[meta.value]}
            selected={meta.value === queueMode}
            onSelect={() => {
              setQueueMode(meta.value);
              // Hand focus straight to Map Voting so the next match's prep
              // continues without a manual scroll/click.
              const mapInput = document.getElementById('map-search') as HTMLInputElement | null;
              mapInput?.focus({ preventScroll: true });
            }}
            openHero={openHero}
            lastLog={lastLog}
          />
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { data: overview } = useApi<Overview>('/api/stats/overview');
  const { data: streaks } = useApi<Streaks>('/api/stats/streaks');
  const { data: trends } = useApi<TrendPoint[]>('/api/stats/trends?window=20');
  const { data: modeComparison } = useApi<ModeComparison[]>('/api/stats/mode-comparison');
  const mapCounts = useTodayMapCounts();
  const heroCounts = useTodayHeroCounts();
  // Session tilt is map-independent, so a no-arg prematch fetch gives it to us.
  const { data: prematch } = useApi<{ session: { on_tilt: boolean; tilt_win_rate: number | null; tilt_games: number } | null }>('/api/stats/prematch');
  const tilt = prematch?.session;

  // /api/stats/trends returns every logged match (its `window` param only sizes
  // the rolling-average column), so both slices below are backed by real rows.
  const last100 = trends?.slice(-100) ?? [];
  const last500 = trends?.slice(-500) ?? [];
  const winRate = (games: TrendPoint[]) =>
    games.length ? Math.round((games.filter(g => g.win).length / games.length) * 100) : null;
  const wr100 = winRate(last100);
  const wr500 = winRate(last500);
  const wrDelta = wr100 !== null && wr500 !== null ? wr100 - wr500 : null;
  // Recent form as a candlestick chart, one candle per calendar day.
  //
  // The idea is borrowed from a stock chart, and the borrowing is honest: a
  // trading day opens where yesterday closed, moves around, and closes
  // somewhere. A day of Overwatch has exactly that shape.
  //
  // Height stays a plain running win/loss total. Every competitive win is +1
  // and every loss -1, so one unit of height is still exactly one match — the
  // property the streak line had, and the day-tile strip before it did not.
  //
  //   open   = wherever yesterday's candle finished drawing
  //   close  = open plus that day's net competitive record
  //   body   = open to close. Green when the day broke even or better, red below
  //   wicks  = quickplay. Wins reach up from the body's top edge, losses down
  //            from the bottom. Total wick length is the day's quickplay count,
  //            split by how it went.
  //
  // Quickplay deliberately does not move the close. Only ranked play carries the
  // total forward; the wick says what else the day held. That is also why the
  // two never gap apart — each candle starts on the last one's closing edge,
  // which is the connected look Heikin-Ashi is after, without HA's averaging.
  // A hundred days played, reaching back about three and a half months and
  // holding roughly 1,200 matches. Data is nowhere near the limit — 503 days
  // are logged — but drawing space is. At a hundred, each day gets 10 units of
  // the chart's 1000-wide space and the body takes 6, so candles are thin.
  // Push much past this and a light day stops being a shape at all.
  const CANDLE_DAYS = 100;
  const candles = (() => {
    const byDay = new Map<string, TrendPoint[]>();
    for (const g of trends ?? []) {
      const d = g.date.slice(0, 10);
      const arr = byDay.get(d);
      if (arr) arr.push(g);
      else byDay.set(d, [g]);
    }
    const days = [...byDay.keys()].sort().slice(-CANDLE_DAYS);
    let carry = 0;
    let played = 0;
    return days.map(date => {
      const games = byDay.get(date)!;
      // Both competitive queues (role and open) count toward the total; only
      // qp_role is practice.
      const comp = games.filter(g => g.queue_mode !== 'qp_role');
      const qp = games.filter(g => g.queue_mode === 'qp_role');
      // `win` arrives from the API as 0/1, not a boolean — compare to 1 rather
      // than leaning on truthiness, the same trap the old run-grouping hit.
      const compW = comp.filter(g => g.win === 1).length;
      const compL = comp.length - compW;
      const qpW = qp.filter(g => g.win === 1).length;
      const qpL = qp.length - qpW;
      // Where the ladder stood when the day ended. Matches arrive already
      // ordered by date then time, so the last reading of the day is the
      // latest one. Most days have none at all: the rank drum is new, and
      // every match logged before it carries null.
      const withRank = games.filter(g => g.player_rank != null);
      const rank = withRank.length ? withRank[withRank.length - 1].player_rank! : null;
      const open = carry;
      const close = open + compW - compL;
      carry = close;
      // How many ranked matches have been played by the end of this day. The
      // pace line and its band are functions of match count, not of date — a
      // day with fourteen games moves them further than a day with two.
      const nOpen = played;
      played += comp.length;
      const nClose = played;
      const top = Math.max(open, close);
      const bottom = Math.min(open, close);
      return {
        date, open, close, compW, compL, qpW, qpL, top, bottom, nOpen, nClose, rank,
        volume: games.length,
        // Which way the day went, as hue. Normally that is the competitive
        // running total: close above open means a winning day.
        //
        // A quickplay-only day never moves that total, so close === open and
        // the >= test called every one of them green — 13 of the 27 such days
        // in the current window were actually losing days showing green. When
        // there is no competitive match to judge, fall back to the only record
        // the day has: its quickplay win-loss. A tied day stays green, which
        // matches how an even competitive day already renders.
        up: comp.length ? close >= open : qpW >= qpL,
        high: top + qpW,
        low: bottom - qpL,
      };
    });
  })();

  // Chart is drawn in its own coordinate space and stretched to the card width,
  // so these numbers are aspect ratio, not pixels.
  // What a match is worth on average, measured over the whole logged history
  // rather than this window. A ranked match is a coin that comes up heads 48.03%
  // of the time, so on average every game played costs about 0.04 of a point.
  // That is the pace line: not a target, just where an ordinary run drifts to.
  const careerComp = (trends ?? []).filter(g => g.queue_mode !== 'qp_role');
  const careerEdge = careerComp.length
    ? (2 * careerComp.filter(g => g.win === 1).length) / careerComp.length - 1
    : 0;
  // How far an ordinary run wanders off that pace. Each match moves the total by
  // exactly one, up or down, so the spread after n matches is the square root of
  // n — the same reason a hundred coin flips land near fifty heads but almost
  // never on exactly fifty. One standard deviation is drawn as a band: roughly
  // two runs in three stay inside it, and being outside is what a real slump
  // looks like.
  const perMatchSd = Math.sqrt(1 - careerEdge * careerEdge);
  const paceAt = (n: number) => n * careerEdge;
  const sdAt = (n: number) => perMatchSd * Math.sqrt(n);

  const CH_W = 1000;
  // Taller than the streak line was, and it has to be. A longer window drifts
  // further from break-even: thirty days spanned 24 matches top to bottom,
  // fifty spanned 39, a hundred spans 45. Height buys back the squeeze — at 280
  // one match is about 6px of the chart, so a 1-0 day is still a visible block
  // rather than a hairline.
  const CH_H = 320;
  const CH_PAD = 14;
  // A lane along the bottom for the volume bars, so they get their own strip
  // instead of sitting under the candles and fighting them for the same pixels.
  const VOL_H = 44;
  const PLOT_BOTTOM = CH_H - CH_PAD - VOL_H;
  // The band can reach further than the candles do, so it has to be part of the
  // axis. At 505 matches it runs from -42 to +2 while the candles stop at -37.
  const bandLo = Math.min(...candles.map(c => paceAt(c.nClose) - sdAt(c.nClose)), 0);
  const bandHi = Math.max(...candles.map(c => paceAt(c.nClose) + sdAt(c.nClose)), 0);
  const lowV = Math.min(0, bandLo, ...candles.map(c => c.low));
  const highV = Math.max(0, bandHi, ...candles.map(c => c.high));
  // Guard the degenerate case: a window with no swing at all divides by zero.
  const vSpan = Math.max(1, highV - lowV);
  const slotW = candles.length ? CH_W / candles.length : CH_W;
  // Bodies keep a gap between them so 30 days read as 30 candles, not a block.
  const bodyW = Math.max(2, slotW * 0.6);
  const slotX = (j: number) => slotW * (j + 0.5);
  const chartY = (v: number) =>
    CH_PAD + (1 - (v - lowV) / vSpan) * (PLOT_BOTTOM - CH_PAD);
  // Volume has its own scale and its own strip. Bars hang down from the top of
  // that strip so the busiest day fills it and a two-game day is a stub.
  const maxVol = Math.max(1, ...candles.map(c => c.volume));
  const volY = (n: number) => CH_H - (n / maxVol) * VOL_H;
  // Points for the pace line and the two edges of its band, one per day.
  const pacePts = candles.map((c, j) => `${slotX(j)},${chartY(paceAt(c.nClose))}`).join(' ');
  const bandUpper = candles.map((c, j) => `${slotX(j)},${chartY(paceAt(c.nClose) + sdAt(c.nClose))}`);
  const bandLower = candles.map((c, j) => `${slotX(j)},${chartY(paceAt(c.nClose) - sdAt(c.nClose))}`);
  const bandPoly = [...bandUpper, ...bandLower.reverse()].join(' ');
  // Promotions and demotions, read off the rank drum rather than logged as
  // their own event. Nothing in the app records "I hit Platinum" — but every
  // competitive match carries the rank Sean had when he played it, so a tier
  // boundary being crossed is visible as a change between one day's closing
  // rank and the next day's. A day with no ranked match logged simply holds
  // the previous reading, so a gap in play never invents a crossing.
  //
  // Only the boundary matters, not every division. Gold 3 to Gold 2 is a good
  // night; Gold 1 to Platinum 5 is the thing you remember, and it is the only
  // one that gets a mark.
  const tierMarks = (() => {
    const out: { j: number; date: string; up: boolean; tier: string; from: string; rank: number; prev: number }[] = [];
    let prev: number | null = null;
    candles.forEach((c, j) => {
      if (c.rank == null) return;
      if (prev != null && rankTier(c.rank) !== rankTier(prev)) {
        out.push({
          j,
          date: c.date,
          up: c.rank > prev,
          tier: rankTier(c.rank),
          from: rankTier(prev),
          rank: c.rank,
          prev,
        });
      }
      prev = c.rank;
    });
    return out;
  })();
  // Index by day so the day's hover tooltip can name the crossing too. The
  // triangle says a tier changed; only the tooltip can say which two.
  const tierMarkByDay = new Map(tierMarks.map(m => [m.date, m]));

  const zeroY = chartY(0);
  const lastCandle = candles.length ? candles[candles.length - 1] : null;
  const lastClose = lastCandle ? lastCandle.close : 0;
  // Where today stands against the pace, in standard deviations. Inside one is
  // ordinary; past two is the number worth reacting to.
  const lastN = lastCandle ? lastCandle.nClose : 0;
  const lastZ = lastN > 0 ? (lastClose - paceAt(lastN)) / sdAt(lastN) : 0;
  // Colour ramp, carried over from the streak line this chart replaced.
  //
  // Hue says which way the day went: green for a day that broke even or better,
  // red for a losing one. Saturation says something else entirely — how far from
  // break-even the running total has got. Right at the zero line a candle is
  // nearly grey. Twelve matches down it is vivid.
  //
  // So the chart reads at two distances. Up close each candle's hue tells you
  // whether that day was won or lost. From across the room the whole field
  // drains to grey near even and floods with color when a run goes somewhere.
  //
  // Draining color out near zero is also what lets green meet red gradually.
  // Two saturated colors side by side clash; two nearly-grey ones do not, which
  // reads correctly as "no strong result either way" — exactly what a total near
  // zero means.
  const BLEND_THRESHOLD = 1.0;
  // Floor and ceiling of the saturation ramp.
  //
  // Saturation says how far the running total has wandered from break-even;
  // hue says which way a single day went. A candle sitting near zero is pale,
  // and a pale enough candle loses its hue — a won day and a lost day start to
  // look alike. The floor is how pale a candle is allowed to get.
  //
  // History: 4 on the streak line, raised to 22 against the old 30-day window,
  // where 17 of 30 candles sat between -2 and +1 and came out as identical
  // greys. The 100-day window spreads them out. Measured 2026-09-18, only 7 of
  // 100 land in the palest tenth of the ramp, against 55 in the middle — so 22
  // was protecting 7% of the chart and costing the other 93% a fifth of the
  // available range.
  //
  // Back to 4, Sean's call on 2026-09-18 after seeing 12 in the app. The thing
  // to watch if this is revisited: the chart re-zeroes at its left edge every
  // day, so the leftmost candles are always near zero. A low floor washes out
  // the left edge permanently, not just on today's data.
  const SAT_FLOOR = 4;
  const SAT_CEIL = 95;
  // Where the ramp reaches full color, in games rather than in screen space.
  //
  // This used to be maxAbsV — the chart's own furthest extent — which made the
  // scale float. The same green meant -12 on a calm window and -40 on a wild
  // one, and every new day could restretch the whole ramp. A fixed anchor means
  // a color always stands for the same number of games, which is the same
  // reason the gradient is measured in chart coordinates rather than per candle.
  //
  // 10 games is the transition zone: inside it the running total is close enough
  // to break-even to call the day ordinary, and color fades toward grey to say
  // so. Past 10 the candle is simply at full color and stays there. Measured
  // 2026-09-18, that pins 87 of 100 candles — saturation stops grading distance
  // and becomes a near-break-even flag instead. Hue still carries each day's
  // direction.
  const SAT_FULL_AT = 10;
  const GRAD_STOPS = 21;
  // Measured in chart coordinates rather than as a percentage of each candle's
  // own box, so a given color always means the same running total. A per-shape
  // gradient would re-anchor to each candle's height, and the same green would
  // mean +11 on one day and +2 on the next.
  const gradStops = (up: boolean) =>
    Array.from({ length: GRAD_STOPS }, (_, k) => {
      // Walk from the top of the axis down, so offsets come out ascending — SVG
      // requires stop offsets in increasing order.
      const v = highV - (k / (GRAD_STOPS - 1)) * (highV - lowV);
      const t = Math.min(1, Math.abs(v) / SAT_FULL_AT);
      // BLEND_THRESHOLD sets how far from break-even the grey band reaches
      // before real color arrives. Raise it and the near-grey zone widens; at
      // 1.0 color climbs in a straight line from zero. Settled there on the
      // streak line after trying 1.6, 1.3 and 1.2 against real data — the plain
      // version read no worse, so the plain version won. Filled bodies have far
      // more color headroom than the 2px line did, so if this is ever revisited
      // it has more room to move here than it did there.
      const shaped = Math.pow(t, BLEND_THRESHOLD);
      // Lightness deliberately stays in a narrow band: the dark theme puts this
      // chart on a near-black card, so buying contrast by darkening would sink
      // the candle into the background. Saturation reads on both themes.
      const sat = SAT_FLOOR + (SAT_CEIL - SAT_FLOOR) * shaped;
      // Base lightness is identical on both sides so the two ramps meet
      // seamlessly at zero, where both are grey enough that hue is invisible.
      const light = 57 - (up ? 13 : 11) * shaped;
      return {
        offset: chartY(v) / CH_H,
        color: `hsl(${up ? 160 : 350} ${sat.toFixed(1)}% ${light.toFixed(1)}%)`,
      };
    });
  const UP_COLOR = 'url(#candleUp)';
  const DOWN_COLOR = 'url(#candleDown)';
  // Flat versions for the legend. The chart's own colors are gradients defined
  // inside its <defs>, and a url(#...) reference is meaningless in the legend's
  // separate SVG and in plain CSS backgrounds. These are the ramp's full-
  // saturation ends, so the legend swatch matches a candle at the extremes.
  const UP_SWATCH = `hsl(160 ${SAT_CEIL}% 44%)`;
  const DOWN_SWATCH = `hsl(350 ${SAT_CEIL}% 46%)`;

  // Gridlines. Y every 5 matches, since the height is a match count — a line
  // every 5 gives the eye something to measure a day against without drawing
  // one per match. Zero is excluded: it already has its own dashed break-even
  // line and would otherwise be drawn twice.
  const yTicks: number[] = [];
  for (let v = Math.ceil(lowV / 5) * 5; v <= highV; v += 5) {
    if (v !== 0) yTicks.push(v);
  }
  // Roughly eight date labels whatever the window holds; thirty would collide.
  const labelEvery = Math.max(1, Math.ceil(candles.length / 8));
  const dayTicks = candles
    .map((c, j) => ({ j, date: c.date }))
    .filter(t => t.j % labelEvery === 0);
  const dayNets = candles.map(c => c.compW - c.compL);
  const bestDay = dayNets.length ? Math.max(...dayNets) : 0;
  const worstDay = dayNets.length ? Math.min(...dayNets) : 0;

  const sections = [
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
  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.find(e => e.isIntersecting);
        if (visible) setActiveSection(visible.target.id);
      },
      { rootMargin: '-140px 0px -70% 0px', threshold: 0 },
    );
    sections.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {/* Wayfinding rail: the page is one long scroll of readout panels, so a
          sticky jump-strip stands in for the section tabs a multi-page app
          would use. Sits flush under the sticky header. */}
      <nav
        data-inspect-id="dash-section-nav"
        aria-label="Jump to section"
        className="sticky top-16 z-20 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2 mb-6 flex items-center gap-1.5 overflow-x-auto backdrop-blur border-b border-ow-border"
        style={{ backgroundColor: 'color-mix(in srgb, var(--surface) 88%, transparent)' }}
      >
        {sections.map(s => (
          <a
            key={s.id}
            href={`#${s.id}`}
            aria-current={activeSection === s.id ? 'true' : undefined}
            className={`pill shrink-0 border transition-colors heading-display tracking-[0.08em] ${
              activeSection === s.id
                ? 'is-selected text-orange-700 dark:text-ow-accent'
                : 'border-ow-border text-[var(--muted)] hover:text-ow-accent hover:border-ow-accent/60'
            }`}
          >
            {s.label}
          </a>
        ))}
      </nav>

      <div id="sec-mode" className="scroll-mt-32">
        {modeComparison && (
          <div className="reveal mb-6" style={{ '--reveal-delay': '0ms' } as React.CSSProperties}>
            <ModeComparisonCard data={modeComparison} />
          </div>
        )}

        <div className="card reveal" style={{ '--reveal-delay': '60ms' } as React.CSSProperties} data-inspect-id="dash-recent-matches-card">
          <div className="flex items-center justify-between flex-wrap gap-y-1 mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm card-title">Recent Matches</h2>
            </div>
            {wr100 !== null && (
              <div className="flex items-baseline gap-2 text-xs" data-inspect-id="dash-recent-form-stat">
                <span className="text-[var(--faint)]">last <b className="font-bold">{last100.length}</b></span>
                <span className={`text-4xl font-black tracking-tight num-display ${wr100 >= 50 ? 'grad-win' : 'grad-loss'}`}><AnimatedNumber value={wr100} suffix="%" /></span>
                {wrDelta !== null && (
                  <span className={`font-bold ${wrDelta > 0 ? 'text-emerald-600' : wrDelta < 0 ? 'text-red-600' : 'text-[var(--faint)]'}`}>
                    {wrDelta > 0 ? '▲' : wrDelta < 0 ? '▼' : '±'} {wrDelta > 0 ? '+' : ''}{wrDelta} vs last {last500.length} ({wr500}%)
                  </span>
                )}
              </div>
            )}
          </div>
          {/* Recent form as a running win/loss total — one point per match, no
              day grouping. Replaced the day-grouped tile strip: 100 tiles cannot
              fit a card width, and even 60 showed only whether each individual
              game was won, never whether the run as a whole was going anywhere.
              Hand-drawn SVG rather than a charting library — one polyline and a
              fill do not justify a dependency. */}
          <div data-inspect-id="dash-recent-form-chart">
            {candles.length >= 1 ? (
              // Labels live in an HTML layer over the chart rather than inside the
              // SVG. The SVG is stretched to the card width with
              // preserveAspectRatio="none", which would squash any <text> drawn in
              // it horizontally. Positioning the labels outside that stretch keeps
              // them the right shape at every card width.
              <div className="relative pl-7">
                <svg
                  viewBox={`0 0 ${CH_W} ${CH_H}`}
                  preserveAspectRatio="none"
                  className="w-full h-[320px] overflow-visible"
                  role="img"
                  aria-label={`Daily win-loss candles across the last ${candles.length} days played. Each candle body is that day's net competitive record, stacked on the previous day's close; wicks are quickplay wins above and losses below. A dashed pace line shows where a run at the career win rate would drift to, shaded one standard deviation either side. Currently ${lastClose > 0 ? '+' : ''}${lastClose}, which is ${Math.abs(lastZ).toFixed(1)} standard deviations ${lastZ < 0 ? 'below' : 'above'} that pace. Volume bars along the bottom show matches played per day.`}
                >
                  <defs>
                    {/* One shared gradient per direction, spanning the whole
                        chart in its own coordinates. Every candle samples the
                        same ramp, so two candles at the same height are the
                        same color no matter how tall their bodies are. */}
                    {([true, false] as const).map(up => (
                      <linearGradient
                        key={up ? 'up' : 'down'}
                        id={up ? 'candleUp' : 'candleDown'}
                        gradientUnits="userSpaceOnUse"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2={CH_H}
                      >
                        {gradStops(up).map((st, k) => (
                          <stop key={k} offset={st.offset} stopColor={st.color} />
                        ))}
                      </linearGradient>
                    ))}
                    {/* The floor light. A vertical ramp from nothing at the top
                        of the volume strip to the accent at the chart's bottom
                        edge, where the bars stand. The colour rides on
                        currentColor set by the class on the gradient itself, so
                        the same def is warm orange in light theme and the
                        lighter tint in dark — a stop cannot carry a theme
                        query, but the element holding it can.

                        A gradient, not a blur filter. The chart is stretched
                        horizontally with preserveAspectRatio="none", and a
                        feGaussianBlur would be stretched with it — wider on a
                        wide card, which is exactly the distortion the axis
                        labels were moved out of the SVG to avoid. */}
                    <linearGradient
                      id="volumeGlow"
                      gradientUnits="userSpaceOnUse"
                      x1="0"
                      y1={CH_H - VOL_H}
                      x2="0"
                      y2={CH_H}
                      className="text-ow-accent dark:text-ow-accentLight"
                    >
                      <stop offset="0" stopColor="currentColor" stopOpacity="0" />
                      <stop offset="0.55" stopColor="currentColor" stopOpacity="0.08" />
                      <stop offset="1" stopColor="currentColor" stopOpacity="0.32" />
                    </linearGradient>
                  </defs>
                  {/* The band of ordinary luck, drawn first and furthest back.
                      Its edges are one standard deviation either side of the
                      pace line, so it widens as the window accumulates matches —
                      narrow at the left where only a few games have been played,
                      wide at the right. Inside it means nothing unusual has
                      happened yet. */}
                  <polygon
                    points={bandPoly}
                    fill="currentColor"
                    className="text-ow-accent dark:text-ow-accentLight opacity-[0.05]"
                  />
                  {/* The pace line itself: where an ordinary run drifts to at the
                      career win rate. Not a target — a reference.

                      Drawn in the app's own accent rather than a neutral grey,
                      which keeps it off the green/red axis entirely. The candles
                      own win and loss; the pace line is a third kind of thing and
                      should not look like a faint one of the first two. Orange on
                      the light theme, the lighter gold on dark, since the dark
                      card is near-black and the base accent goes muddy on it. */}
                  <polyline
                    points={pacePts}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray="6 5"
                    vectorEffect="non-scaling-stroke"
                    className="text-ow-accent dark:text-ow-accentLight opacity-90"
                  />

                  {/* Grid, drawn first so the candles sit on top of it. */}
                  {yTicks.map(v => (
                    <line
                      key={`y${v}`}
                      x1="0"
                      y1={chartY(v)}
                      x2={CH_W}
                      y2={chartY(v)}
                      stroke="currentColor"
                      strokeWidth="1"
                      vectorEffect="non-scaling-stroke"
                      className="text-[var(--faint)] opacity-[0.18]"
                    />
                  ))}

                  {/* Break-even. Above it the window is up on the run, below it down. */}
                  <line
                    x1="0"
                    y1={zeroY}
                    x2={CH_W}
                    y2={zeroY}
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeDasharray="4 4"
                    vectorEffect="non-scaling-stroke"
                    className="text-[var(--faint)] opacity-50"
                  />

                  {candles.map((c, j) => {
                    const cx = slotX(j);
                    const color = c.up ? UP_COLOR : DOWN_COLOR;
                    const yTop = chartY(c.top);
                    const yBottom = chartY(c.bottom);
                    return (
                      <g key={c.date}>
                        {/* Quickplay wins reach up from the body's top edge. */}
                        {c.qpW > 0 && (
                          <line
                            x1={cx}
                            y1={yTop}
                            x2={cx}
                            y2={chartY(c.high)}
                            stroke={color}
                            strokeWidth="2"
                            strokeOpacity="0.9"
                            vectorEffect="non-scaling-stroke"
                          />
                        )}
                        {/* Quickplay losses hang below the bottom edge. */}
                        {c.qpL > 0 && (
                          <line
                            x1={cx}
                            y1={yBottom}
                            x2={cx}
                            y2={chartY(c.low)}
                            stroke={color}
                            strokeWidth="2"
                            strokeOpacity="0.9"
                            vectorEffect="non-scaling-stroke"
                          />
                        )}
                        {/* An even day has no body to draw, so it gets a bar
                            instead of a zero-height rectangle that renders as
                            nothing. Same idea as a doji on a price chart. */}
                        {yBottom - yTop < 0.5 ? (
                          <line
                            x1={cx - bodyW / 2}
                            y1={yTop}
                            x2={cx + bodyW / 2}
                            y2={yTop}
                            stroke={color}
                            strokeWidth="2"
                            vectorEffect="non-scaling-stroke"
                          />
                        ) : (
                          <rect
                            x={cx - bodyW / 2}
                            y={yTop}
                            width={bodyW}
                            height={yBottom - yTop}
                            fill={color}
                            fillOpacity="0.85"
                            stroke={color}
                            strokeWidth="1.5"
                            vectorEffect="non-scaling-stroke"
                          />
                        )}
                      </g>
                    );
                  })}

                  {/* Volume: how many matches that day actually held, in its own
                      strip along the bottom. The candle body is a NET, so a
                      1W-1L day and a 7W-7L day are both flat — this is the only
                      place the chart says how much was played. Every queue counts
                      here, ranked and quickplay together: the bar answers "how
                      much did I play", which is a different question from the two
                      the candle already answers.

                      Drawn as a skyline: near-solid dark blocks standing in
                      front of the glow, so the light reads as sky between the
                      buildings rather than a wash across them. One literal
                      colour serves both themes — #14161c is the light theme's
                      own ink and the dark theme's page base, which is darker
                      than the card the chart sits on. So the bars are the
                      darkest thing in the strip either way, which is what
                      makes them silhouettes.

                      They were low-contrast grey until 2026-09-19, on the
                      reasoning that volume is context and not a signal. That
                      reasoning still holds — long days do not reliably go
                      better than short ones in this window — but contrast is
                      not what was carrying it. The bars sit in their own strip
                      under a divider, well away from the candles, and nothing
                      about a dark block claims the day went well. The legend
                      states what the bar IS; the reason it exists lives here,
                      not on screen. */}
                  <line
                    x1="0"
                    y1={CH_H - VOL_H}
                    x2={CH_W}
                    y2={CH_H - VOL_H}
                    stroke="currentColor"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                    className="text-[var(--faint)] opacity-[0.15]"
                  />
                  {/* The light the bars stand in, drawn BEHIND them. The bars
                      are 40% opaque, so the ramp reads through their lower
                      half and the bottom of every bar picks up the glow —
                      lit from within rather than washed over. Non-interactive,
                      so it never steals a hover from the day columns. */}
                  <rect
                    x="0"
                    y={CH_H - VOL_H}
                    width={CH_W}
                    height={VOL_H}
                    fill="url(#volumeGlow)"
                    pointerEvents="none"
                  />
                  {candles.map((c, j) => (
                    <rect
                      key={`vol-${c.date}`}
                      x={slotX(j) - bodyW / 2}
                      y={volY(c.volume)}
                      width={bodyW}
                      height={CH_H - volY(c.volume)}
                      fill="#14161c"
                      fillOpacity="0.88"
                    />
                  ))}

                  {/* The source of that light: a hairline along the bottom
                      edge, where the bars are rooted. Non-scaling so it stays
                      one pixel at every card width. */}
                  <line
                    x1="0"
                    y1={CH_H}
                    x2={CH_W}
                    y2={CH_H}
                    stroke="currentColor"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                    className="text-ow-accent dark:text-ow-accentLight opacity-70"
                    pointerEvents="none"
                  />

                  {/* One invisible column per day carrying a native tooltip, so
                      hovering names the day's record the way the old run
                      tooltips named the streak. Cheaper than per-point JS hover
                      state, and it keeps the chart working with no event
                      handlers at all. */}
                  {candles.map((c, j) => (
                    <rect
                      key={`hit-${c.date}`}
                      x={slotX(j) - slotW / 2}
                      y="0"
                      width={slotW}
                      height={CH_H}
                      fill="transparent"
                    >
                      <title>
                        {`${format(parseISO(c.date), 'MMM d')} · ${c.volume} played · comp ${c.compW}W ${c.compL}L${c.qpW + c.qpL > 0 ? ` · qp ${c.qpW}W ${c.qpL}L` : ''} · ${c.open > 0 ? '+' : ''}${c.open} → ${c.close > 0 ? '+' : ''}${c.close} · pace ${paceAt(c.nClose) >= 0 ? '+' : ''}${paceAt(c.nClose).toFixed(1)}${tierMarkByDay.has(c.date) ? ` · ${tierMarkByDay.get(c.date)!.up ? 'promoted' : 'demoted'} ${rankLabel(tierMarkByDay.get(c.date)!.prev)} → ${rankLabel(tierMarkByDay.get(c.date)!.rank)}` : ''}`}
                      </title>
                    </rect>
                  ))}
                </svg>

                {/* Y scale, one label per gridline, sitting in the pl-7 gutter. */}
                {yTicks.map(v => (
                  <span
                    key={`yl${v}`}
                    className="absolute left-0 -translate-y-1/2 text-[9px] leading-none tabular-nums text-[var(--faint)] w-6 text-right pr-1"
                    style={{ top: `${(chartY(v) / CH_H) * 100}%` }}
                  >
                    {v > 0 ? `+${v}` : v}
                  </span>
                ))}

                {/* Date labels. The first one is left-aligned to its candle and
                    the rest are centred, so the leftmost cannot hang off the card. */}
                {dayTicks.map((t, i) => (
                  <span
                    key={`xl${t.date}`}
                    className={`absolute top-full mt-0.5 text-[9px] leading-none whitespace-nowrap text-[var(--faint)] ${i === 0 ? '' : '-translate-x-1/2'}`}
                    style={{ left: `calc(1.75rem + ${(slotX(t.j) / CH_W) * 100}% - ${(slotX(t.j) / CH_W) * 1.75}rem)` }}
                  >
                    {format(parseISO(t.date), 'M/d')}
                  </span>
                ))}

                {/* Tier crossings. These are HTML, not SVG, for the same
                    reason the axis labels are: the chart is stretched to the
                    card width with preserveAspectRatio="none", and a triangle
                    drawn inside it would be stretched with it — a promotion
                    marker would come out a different shape on a wide card than
                    on a narrow one.

                    A promotion sits just under the day's low pointing up, and
                    a demotion just over its high pointing down, so neither
                    lands on top of the candle it belongs to. The colour is the
                    tier being ENTERED, which is the thing worth reading off a
                    glance — the mark answers "where am I now", not "where was
                    I". */}
                {tierMarks.map(m => {
                  const c = candles[m.j];
                  const y = m.up ? chartY(c.low) : chartY(c.high);
                  return (
                    <span
                      key={`tier-${m.date}`}
                      data-inspect-id="dash-recent-form-tier-mark"
                      title={`${m.up ? 'Promoted' : 'Demoted'} ${m.from} → ${m.tier} · ${rankLabel(m.prev)} → ${rankLabel(m.rank)} · ${format(parseISO(m.date), 'MMM d')}`}
                      aria-label={`${m.up ? 'Promoted to' : 'Demoted to'} ${m.tier} on ${format(parseISO(m.date), 'MMMM d')}`}
                      className="absolute text-[11px] leading-none pointer-events-none select-none"
                      style={{
                        left: `calc(1.75rem + ${(slotX(m.j) / CH_W) * 100}% - ${(slotX(m.j) / CH_W) * 1.75}rem)`,
                        top: `${(y / CH_H) * 100}%`,
                        transform: m.up ? 'translate(-50%, 2px)' : 'translate(-50%, -100%) translateY(-2px)',
                        color: `rgb(${RANK_TIER_RGB[m.tier as keyof typeof RANK_TIER_RGB]})`,
                        // A tier colour chosen to read on a rank badge is not
                        // guaranteed to read on the chart's own background,
                        // and Bronze against a dark card is the worst case. A
                        // thin outline in the page's surface colour keeps the
                        // shape legible in both themes without touching the
                        // hue, which is the part carrying the meaning.
                        textShadow: '0 0 2px var(--surface), 0 0 2px var(--surface)',
                      }}
                    >
                      {m.up ? '▲' : '▼'}
                    </span>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                dataInspectId="dash-empty-state-banner"
                icon="◴"
                title="No matches logged yet"
                hint="Log your first result below and your recent form will track here."
                className="w-full"
              />
            )}
            {candles.length >= 1 && (
              <>
                <div className="flex items-center justify-between text-[10px] text-[var(--faint)] mt-5">
                    <span>{candles.length} days</span>
                    <span>
                      best day <b className="font-bold text-emerald-600">{bestDay > 0 ? '+' : ''}{bestDay}</b>
                      {' · '}worst <b className="font-bold text-rose-600">{worstDay}</b>
                      {' · '}now{' '}
                      <b className={`font-bold ${lastClose >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {lastClose > 0 ? '+' : ''}{lastClose}
                      </b>
                    </span>
                  <span>latest</span>
                </div>
                {/* What the underlay is saying, in words. The band is only useful
                    if the number that goes with it is on screen — "inside one
                    standard deviation" is the difference between a slump and an
                    ordinary stretch, and the candles alone cannot tell you which
                    this is. */}
                <div className="flex items-center justify-between flex-wrap gap-y-1 text-[10px] text-[var(--faint)] mt-1.5" data-inspect-id="dash-recent-form-pace-note">
                  <span />
                  <span>
                    {lastN} ranked · pace <b className="font-bold">{paceAt(lastN) >= 0 ? '+' : ''}{paceAt(lastN).toFixed(0)}</b>
                    {' · '}you{' '}
                    <b className={`font-bold ${lastClose >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {lastClose > 0 ? '+' : ''}{lastClose}
                    </b>
                    {' · '}
                    <b className={`font-bold ${Math.abs(lastZ) >= 2 ? 'text-amber-600' : ''}`}>
                      {lastZ >= 0 ? '+' : '−'}{Math.abs(lastZ).toFixed(2)} SD
                    </b>
                    {Math.abs(lastZ) < 1 ? ' — ordinary' : Math.abs(lastZ) < 2 ? ' — notable' : ' — real'}
                  </span>
                </div>
                {/* Legend. The candle is the part no one can guess: the body is
                    a NET, not a count, and the wick has been repurposed from
                    intraday range to a second series. Drawing a miniature one is
                    shorter than the sentence it would take to say that. */}
                <div
                  data-inspect-id="dash-recent-form-legend"
                  className="flex flex-wrap items-start gap-x-6 gap-y-3 text-[10px] leading-[1.6] text-[var(--faint)] mt-4 pt-3 border-t border-ow-border"
                >
                  <div className="flex items-start gap-2">
                    <svg width="24" height="44" viewBox="0 0 24 44" aria-hidden="true" className="shrink-0 mt-0.5">
                      <line x1="12" y1="1" x2="12" y2="12" stroke={UP_SWATCH} strokeWidth="2" strokeOpacity="0.9" />
                      <rect x="3" y="12" width="18" height="19" fill={UP_SWATCH} fillOpacity="0.85" stroke={UP_SWATCH} strokeWidth="1.5" />
                      <line x1="12" y1="31" x2="12" y2="43" stroke={UP_SWATCH} strokeWidth="2" strokeOpacity="0.9" />
                    </svg>
                    <span>
                      <b className="font-bold text-[var(--muted)]">one candle = one day</b>
                      <br />body: ranked wins minus losses, from where yesterday ended
                      <br />wick: quickplay — wins above, losses below
                    </span>
                  </div>

                  <div className="flex items-start gap-2">
                    <span className="shrink-0 mt-[3px] inline-flex gap-1" aria-hidden="true">
                      <span className="inline-block w-2.5 h-3 rounded-[1px]" style={{ background: UP_SWATCH, opacity: 0.85 }} />
                      <span className="inline-block w-2.5 h-3 rounded-[1px]" style={{ background: DOWN_SWATCH, opacity: 0.85 }} />
                    </span>
                    <span>
                      <b className="font-bold text-[var(--muted)]">color</b>
                      <br />green: the day broke even or better
                      <br />stronger color = further from break-even
                    </span>
                  </div>

                  <div className="flex items-start gap-2">
                    <span className="shrink-0 mt-[3px] relative inline-block w-5 h-3" aria-hidden="true">
                      <span className="absolute inset-0 rounded-[1px] bg-ow-accent dark:bg-ow-accentLight opacity-[0.14]" />
                      <span className="absolute left-0 right-0 top-1/2 border-t border-dashed border-ow-accent dark:border-ow-accentLight opacity-90" />
                    </span>
                    <span>
                      <b className="font-bold text-[var(--muted)]">pace &amp; ±1 SD</b>
                      <br />where a run at your career <b className="font-bold">{((careerEdge + 1) * 50).toFixed(1)}</b>% would drift
                      <br />shading is the room an ordinary run has to wander
                    </span>
                  </div>

                  <div className="flex items-start gap-2">
                    <span className="shrink-0 mt-[3px] inline-flex items-end gap-[2px] h-3" aria-hidden="true">
                      <span className="inline-block w-1 h-1.5 bg-[#14161c] opacity-[0.88]" />
                      <span className="inline-block w-1 h-3 bg-[#14161c] opacity-[0.88]" />
                      <span className="inline-block w-1 h-2 bg-[#14161c] opacity-[0.88]" />
                    </span>
                    <span>
                      <b className="font-bold text-[var(--muted)]">bars below</b>
                      <br />total games that day, ranked and quickplay
                      <br />tallest bar = your busiest day, <b className="font-bold">{maxVol}</b>
                    </span>
                  </div>

                  {/* Only drawn once a crossing exists. An entry explaining a
                      symbol that is nowhere on the chart is just clutter, and
                      until enough ranked matches carry a rank there will be
                      none. */}
                  {tierMarks.length > 0 && (
                    <div className="flex items-start gap-2">
                      <span className="shrink-0 mt-[3px] inline-flex flex-col leading-[0.6] text-[9px]" aria-hidden="true">
                        <span style={{ color: `rgb(${RANK_TIER_RGB.Platinum})` }}>▲</span>
                        <span style={{ color: `rgb(${RANK_TIER_RGB.Gold})` }}>▼</span>
                      </span>
                      <span>
                        <b className="font-bold text-[var(--muted)]">tier change</b>
                        <br />up under the candle, down above it
                        <br />colored for the tier you moved <i>into</i>
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {tilt?.on_tilt && (
            <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 mt-4" data-inspect-id="dash-tilt-warning-banner">
              <span className="text-amber-600 text-lg shrink-0">⚠</span>
              <div>
                <div className="text-sm font-semibold text-amber-700">You've lost <b className="font-bold">2</b> in a row today</div>
                {tilt.tilt_win_rate !== null && tilt.tilt_games >= 10 && (
                  <div className="text-xs text-amber-600/80 mt-0.5">
                    Historically your win rate in this situation is <b className="font-bold">{tilt.tilt_win_rate}</b>% — a short break often helps.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
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

      <div id="sec-trends" className="mt-8 border-t border-ow-border pt-6 reveal scroll-mt-32" style={{ '--reveal-delay': '180ms' } as React.CSSProperties}>
        <PageHeader dataInspectId="dash-trends-section-header" title="Trends" sub="Recent form and momentum." />
        <TrendsSummary />
      </div>

      <div id="sec-career" className="mt-8 border-t border-ow-border pt-6 reveal scroll-mt-32" style={{ '--reveal-delay': '240ms' } as React.CSSProperties}>
        <PageHeader dataInspectId="dash-career-section-header" title="Career" sub="All-time totals across every mode." />
        {/* One continuous readout strip rather than two stacked 4-tile grids —
            all seven career totals scan as a single row on wide screens. */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
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
        </div>
      </div>
    </div>
  );
}

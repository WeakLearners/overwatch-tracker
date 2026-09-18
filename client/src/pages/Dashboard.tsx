import { useState, useEffect } from 'react';
import { useApi } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { Overview, Streaks, TrendPoint, ModeComparison, QueueMode, QUEUE_MODES, QUEUE_MODE_COLORS } from '../types';
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
      className={`relative overflow-hidden text-left rounded-lg p-4 transition-all duration-200 mode-tile hover:-translate-x-1 hover:-translate-y-1 ${selected ? `${c.card} ${c.glow}` : c.tileDim}`}
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
      <h2 className="text-sm heading-display text-[var(--ink-2)] mb-4">Mode</h2>
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
      const open = carry;
      const close = open + compW - compL;
      carry = close;
      const top = Math.max(open, close);
      const bottom = Math.min(open, close);
      return {
        date, open, close, compW, compL, qpW, qpL, top, bottom,
        up: close >= open,
        high: top + qpW,
        low: bottom - qpL,
      };
    });
  })();

  // Chart is drawn in its own coordinate space and stretched to the card width,
  // so these numbers are aspect ratio, not pixels.
  const CH_W = 1000;
  // Taller than the streak line was, and it has to be. A longer window drifts
  // further from break-even: thirty days spanned 24 matches top to bottom,
  // fifty spanned 39, a hundred spans 45. Height buys back the squeeze — at 280
  // one match is about 6px of the chart, so a 1-0 day is still a visible block
  // rather than a hairline.
  const CH_H = 280;
  const CH_PAD = 14;
  const lowV = Math.min(0, ...candles.map(c => c.low));
  const highV = Math.max(0, ...candles.map(c => c.high));
  // Guard the degenerate case: a window with no swing at all divides by zero.
  const vSpan = Math.max(1, highV - lowV);
  const slotW = candles.length ? CH_W / candles.length : CH_W;
  // Bodies keep a gap between them so 30 days read as 30 candles, not a block.
  const bodyW = Math.max(2, slotW * 0.6);
  const slotX = (j: number) => slotW * (j + 0.5);
  const chartY = (v: number) =>
    CH_PAD + (1 - (v - lowV) / vSpan) * (CH_H - CH_PAD * 2);
  const zeroY = chartY(0);
  const lastCandle = candles.length ? candles[candles.length - 1] : null;
  const lastClose = lastCandle ? lastCandle.close : 0;
  // Colour ramp, carried over from the streak line this chart replaced.
  //
  // Hue says which way the day went: green for a day that broke even or better,
  // red for a losing one. Saturation says something else entirely — how far from
  // break-even the running total has got. Right at the zero line a candle is
  // nearly grey. Twelve matches down it is vivid.
  //
  // So the chart reads at two distances. Up close each candle's hue tells you
  // whether that day was won or lost. From across the room the whole field
  // drains to grey near even and floods with colour when a run goes somewhere.
  //
  // Draining colour out near zero is also what lets green meet red gradually.
  // Two saturated colours side by side clash; two nearly-grey ones do not, which
  // reads correctly as "no strong result either way" — exactly what a total near
  // zero means.
  const BLEND_THRESHOLD = 1.0;
  const maxAbsV = Math.max(Math.abs(lowV), Math.abs(highV), 1);
  const GRAD_STOPS = 21;
  // Measured in chart coordinates rather than as a percentage of each candle's
  // own box, so a given colour always means the same running total. A per-shape
  // gradient would re-anchor to each candle's height, and the same green would
  // mean +11 on one day and +2 on the next.
  const gradStops = (up: boolean) =>
    Array.from({ length: GRAD_STOPS }, (_, k) => {
      // Walk from the top of the axis down, so offsets come out ascending — SVG
      // requires stop offsets in increasing order.
      const v = highV - (k / (GRAD_STOPS - 1)) * (highV - lowV);
      const t = Math.min(1, Math.abs(v) / maxAbsV);
      // BLEND_THRESHOLD sets how far from break-even the grey band reaches
      // before real colour arrives. Raise it and the near-grey zone widens; at
      // 1.0 colour climbs in a straight line from zero. Settled there on the
      // streak line after trying 1.6, 1.3 and 1.2 against real data — the plain
      // version read no worse, so the plain version won. Filled bodies have far
      // more colour headroom than the 2px line did, so if this is ever revisited
      // it has more room to move here than it did there.
      const shaped = Math.pow(t, BLEND_THRESHOLD);
      // Lightness deliberately stays in a narrow band: the dark theme puts this
      // chart on a near-black card, so buying contrast by darkening would sink
      // the candle into the background. Saturation reads on both themes.
      // Floor and ceiling of the saturation ramp.
      //
      // The streak line floored this at 4% — flat grey at break-even. That was
      // right for a 2px line, where hue carried no information and grey simply
      // meant "nothing much happening". It is wrong here, because a candle's
      // hue says which way the day went, and a grey candle has lost that.
      //
      // The numbers say the same thing. Measured across the current window,
      // 17 of 30 candles sit between -2 and +1. At a 4% floor all seventeen
      // come out the same near-grey, and a won day is indistinguishable from a
      // lost one — the exact complaint that killed the line's first ramp.
      //
      // So the floor rises to where green and red are still telling apart, and
      // the ceiling gives the far candles somewhere to go. Distance from
      // break-even is still what drives it; the scale just no longer starts at
      // invisible.
      const SAT_FLOOR = 22;
      const SAT_CEIL = 95;
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
                ? 'bg-ow-accent/15 text-ow-accent border-ow-accent'
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
              <h2 className="text-sm heading-display text-[var(--ink-2)]">Recent Matches</h2>
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
                  className="w-full h-[280px] overflow-visible"
                  role="img"
                  aria-label={`Daily win-loss candles across the last ${candles.length} days played. Each candle body is that day's net competitive record, stacked on the previous day's close; wicks are quickplay wins above and losses below. Currently ${lastClose > 0 ? '+' : ''}${lastClose}.`}
                >
                  <defs>
                    {/* One shared gradient per direction, spanning the whole
                        chart in its own coordinates. Every candle samples the
                        same ramp, so two candles at the same height are the
                        same colour no matter how tall their bodies are. */}
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
                  </defs>
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
                        {`${format(parseISO(c.date), 'MMM d')} · comp ${c.compW}W ${c.compL}L${c.qpW + c.qpL > 0 ? ` · qp ${c.qpW}W ${c.qpL}L` : ''} · ${c.open > 0 ? '+' : ''}${c.open} → ${c.close > 0 ? '+' : ''}${c.close}`}
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

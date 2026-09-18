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
  // Recent-form chart: a running win/loss total, but drawn one RUN at a time
  // rather than one match at a time.
  //
  // Height is the plain total — each win is +1, each loss -1, starting from 0 at
  // the window's left edge. Horizontal movement happens only when the run changes
  // direction. So four straight wins are a single vertical line four units tall,
  // not four separate stairs, and the length of every vertical line IS the streak
  // that produced it.
  //
  // That is what the earlier per-match version could not show. Compressing x by
  // run keeps "one unit of height = one match" exactly true, while making streaks
  // the most visible thing on the chart. Sean's window holds a 16-loss run; here
  // it is one 16-unit cliff instead of sixteen indistinguishable steps.
  const formRuns = (() => {
    const runs: { win: boolean; games: TrendPoint[] }[] = [];
    for (const g of last100) {
      const w = !!g.win;
      // `win` arrives from the API as 0/1, not a boolean — normalise before
      // comparing, since `0 === false` is false in TypeScript and would start a
      // fresh run on every single match.
      const cur = runs[runs.length - 1];
      if (cur && cur.win === w) cur.games.push(g);
      else runs.push({ win: w, games: [g] });
    }
    let net = 0;
    return runs.map(r => {
      net += r.games.length * (r.win ? 1 : -1);
      return { ...r, len: r.games.length, net };
    });
  })();
  const netMin = Math.min(0, ...formRuns.map(r => r.net));
  const netMax = Math.max(0, ...formRuns.map(r => r.net));
  // Chart is drawn in its own coordinate space and stretched to the card width,
  // so these numbers are aspect ratio, not pixels.
  const CH_W = 1000;
  const CH_H = 150;
  const CH_PAD = 10;
  // Guard the degenerate case: a window with no swing at all would divide by zero.
  const netSpan = Math.max(1, netMax - netMin);
  const runX = (j: number) =>
    formRuns.length <= 1 ? 0 : (j / (formRuns.length - 1)) * CH_W;
  const chartY = (v: number) =>
    CH_PAD + (1 - (v - netMin) / netSpan) * (CH_H - CH_PAD * 2);
  // Path: start on the zero line, then for each run draw the vertical first and
  // the horizontal after it. The horizontal carries the current total across to
  // where the next run begins; it never changes height, because nothing happened
  // between two runs — the next match simply went the other way.
  const formPoints = (() => {
    const pts: string[] = [`${runX(0)},${chartY(0)}`];
    formRuns.forEach((r, j) => {
      pts.push(`${runX(j)},${chartY(r.net)}`);
      if (j < formRuns.length - 1) pts.push(`${runX(j + 1)},${chartY(r.net)}`);
    });
    return pts.join(' ');
  })();
  const zeroY = chartY(0);
  const lastRun = formRuns.length ? formRuns[formRuns.length - 1] : null;
  const lastNet = lastRun ? lastRun.net : 0;
  // Colour ramp for the plot line. Saturation carries the meaning: right at
  // break-even the line is nearly grey, and it saturates toward full green going
  // up and full red going down. So how strongly the line is coloured says how far
  // from even the run has got, independently of where it sits on the card.
  //
  // Draining the colour out near zero is also what lets green meet red gradually.
  // Two saturated colours blended directly pass through brown; two nearly-grey
  // ones pass through grey, which reads as "no strong result either way" — which
  // is exactly what a total near zero means.
  const BLEND_THRESHOLD = 1.0;
  const maxAbsNet = Math.max(Math.abs(netMin), Math.abs(netMax), 1);
  const STROKE_STOPS = 21;
  const strokeStops = Array.from({ length: STROKE_STOPS }, (_, k) => {
    // Walk from the top of the axis down, so offsets come out ascending — SVG
    // requires stop offsets in increasing order.
    const v = netMax - (k / (STROKE_STOPS - 1)) * (netMax - netMin);
    const t = Math.min(1, Math.abs(v) / maxAbsNet);
    const up = v >= 0;
    // The two sides need different curves to look like the same ramp. A washed-out
    // green sits near the eye's peak brightness sensitivity, so it collapses to
    // plain grey while a washed-out red still reads as pink. Feeding the green
    // side through a lower exponent makes its colour arrive faster off zero; the
    // red side stays close to linear. Same intent both ways, corrected for the
    // fact that the eye does not treat the two hues alike.
    // BLEND_THRESHOLD sets how far from break-even the grey band reaches before
    // real colour arrives. Raise it and the near-grey zone widens; drop it to 1
    // and colour climbs in a straight line from zero.
    //
    // Settled at 1.0 — a straight line — after trying 1.6, 1.3 and 1.2 against the
    // real chart. The argument for pushing it higher was that the line spends most
    // of its time within a few matches of even, so a wider grey band would give
    // that range more room. On screen the difference between those values turned
    // out to be smaller than it looks in a table, and the plain version reads no
    // worse, so the plain version wins.
    //
    // Worth knowing if this is revisited: saturation on a 2px line has limited
    // headroom whatever curve is applied. The untried lever is stroke width
    // growing with distance from even.
    const shaped = Math.pow(t, BLEND_THRESHOLD);
    const hue = up ? 160 : 350;
    // Saturation runs nearly the full range. Lightness deliberately stays in a
    // narrow band: the dark theme puts this chart on a near-black card (#101216),
    // so buying contrast by darkening the line would sink it into the background
    // there. Saturation reads on both themes.
    const sat = 4 + 91 * shaped;
    // Base lightness is identical on both sides so the two ramps meet seamlessly
    // at zero, where both are grey enough that the hue difference is invisible.
    const light = 57 - (up ? 13 : 11) * shaped;
    return {
      offset: chartY(v) / CH_H,
      color: `hsl(${hue} ${sat.toFixed(1)}% ${light.toFixed(1)}%)`,
    };
  });
  // Gridlines. Y every 5 matches, since the height is a match count — a line
  // every 5 gives the eye something to measure a streak against without drawing
  // 21 of them. Zero is excluded here because it already has its own dashed
  // break-even line and would otherwise be drawn twice.
  const yTicks: number[] = [];
  for (let v = Math.ceil(netMin / 5) * 5; v <= netMax; v += 5) {
    if (v !== 0) yTicks.push(v);
  }
  // X wherever the calendar day changes. Runs do not align to days, so the tick
  // sits at the first run that opened on a new date.
  const dayTicks = formRuns.reduce<{ j: number; date: string }[]>((acc, r, j) => {
    const day = r.games[0].date.slice(0, 10);
    if (acc.length === 0 || acc[acc.length - 1].date !== day) acc.push({ j, date: day });
    return acc;
  }, []);
  const bestWinRun = Math.max(0, ...formRuns.filter(r => r.win).map(r => r.len));
  const worstLossRun = Math.max(0, ...formRuns.filter(r => !r.win).map(r => r.len));

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
            {formRuns.length >= 1 ? (
              // Labels live in an HTML layer over the chart rather than inside the
              // SVG. The SVG is stretched to the card width with
              // preserveAspectRatio="none", which would squash any <text> drawn in
              // it horizontally. Positioning the labels outside that stretch keeps
              // them the right shape at every card width.
              <div className="relative pl-7">
                <svg
                  viewBox={`0 0 ${CH_W} ${CH_H}`}
                  preserveAspectRatio="none"
                  className="w-full h-[150px] overflow-visible"
                  role="img"
                  aria-label={`Running win-loss total across the last ${last100.length} matches, drawn one streak at a time. Currently ${lastNet > 0 ? '+' : ''}${lastNet}, on a ${lastRun?.len ?? 0} game ${lastRun?.win ? 'win' : 'loss'} run.`}
                >
                  <defs>
                    {/* Area under the line, fading out downward so the fill reads
                        as shading rather than a solid block competing with it. */}
                    <linearGradient id="formFillUp" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.28" />
                      <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="formFillDown" x1="0" y1="1" x2="0" y2="0">
                      <stop offset="0%" stopColor="rgb(244 63 94)" stopOpacity="0.28" />
                      <stop offset="100%" stopColor="rgb(244 63 94)" stopOpacity="0" />
                    </linearGradient>
                    {/* The plot line's own colour, from strokeStops above.
                        Measured in the chart's coordinates rather than in
                        percentages of the shape's bounding box, so a given colour
                        always means the same running total — a percentage
                        gradient would re-anchor to wherever the line happened to
                        reach that day. */}
                    <linearGradient
                      id="formStroke"
                      gradientUnits="userSpaceOnUse"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2={CH_H}
                    >
                      {strokeStops.map((st, k) => (
                        <stop key={k} offset={st.offset} stopColor={st.color} />
                      ))}
                    </linearGradient>
                    {/* Split the fill at the zero line so time spent above even is
                        green and time below is red, without cutting the line. */}
                    <clipPath id="formClipUp">
                      <rect x="0" y="0" width={CH_W} height={zeroY} />
                    </clipPath>
                    <clipPath id="formClipDown">
                      <rect x="0" y={zeroY} width={CH_W} height={CH_H - zeroY} />
                    </clipPath>
                  </defs>

                  {/* Grid, drawn first so the line and fill sit on top of it. */}
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
                  {dayTicks.map(t => (
                    <line
                      key={t.date}
                      x1={runX(t.j)}
                      y1="0"
                      x2={runX(t.j)}
                      y2={CH_H}
                      stroke="currentColor"
                      strokeWidth="1"
                      vectorEffect="non-scaling-stroke"
                      className="text-[var(--faint)] opacity-[0.18]"
                    />
                  ))}

                  <polygon
                    points={`0,${zeroY} ${formPoints} ${CH_W},${zeroY}`}
                    fill="url(#formFillUp)"
                    clipPath="url(#formClipUp)"
                  />
                  <polygon
                    points={`0,${zeroY} ${formPoints} ${CH_W},${zeroY}`}
                    fill="url(#formFillDown)"
                    clipPath="url(#formClipDown)"
                  />

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

                  <polyline
                    points={formPoints}
                    fill="none"
                    stroke="url(#formStroke)"
                    strokeWidth="2"
                    strokeLinejoin="miter"
                    strokeLinecap="butt"
                    vectorEffect="non-scaling-stroke"
                  />

                  {/* Where the run stands right now. */}
                  <circle
                    cx={runX(formRuns.length - 1)}
                    cy={chartY(lastNet)}
                    r="3.5"
                    fill={lastNet >= 0 ? 'rgb(16 185 129)' : 'rgb(244 63 94)'}
                    vectorEffect="non-scaling-stroke"
                  />

                  {/* One invisible column per match carrying a native tooltip, so
                      hovering still names the hero and map the way the old tiles
                      did. Cheaper than per-point JS hover state, and it keeps the
                      whole chart working with no event handlers at all. */}
                  {formRuns.map((r, j) => (
                    <rect
                      key={r.games[0].id}
                      x={runX(j) - (formRuns.length > 1 ? CH_W / (formRuns.length - 1) : CH_W) / 2}
                      y="0"
                      width={formRuns.length > 1 ? CH_W / (formRuns.length - 1) : CH_W}
                      height={CH_H}
                      fill="transparent"
                    >
                      <title>
                        {`${r.len} ${r.win ? 'win' : 'loss'}${r.len === 1 ? '' : 'es'} in a row · ${format(parseISO(r.games[0].date), 'MMM d')} · now ${r.net > 0 ? '+' : ''}${r.net}`}
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

                {/* Date labels. The first one is left-aligned to its line and the
                    rest are centred, so the leftmost cannot hang off the card. */}
                {dayTicks.map((t, i) => (
                  <span
                    key={`xl${t.date}`}
                    className={`absolute top-full mt-0.5 text-[9px] leading-none whitespace-nowrap text-[var(--faint)] ${i === 0 ? '' : '-translate-x-1/2'}`}
                    style={{ left: `calc(1.75rem + ${(runX(t.j) / CH_W) * 100}% - ${(runX(t.j) / CH_W) * 1.75}rem)` }}
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
            {formRuns.length >= 1 && (
              <div className="flex items-center justify-between text-[10px] text-[var(--faint)] mt-5">
                  <span>{last100.length} matches ago</span>
                  <span>
                    best run <b className="font-bold text-emerald-600">{bestWinRun}W</b>
                    {' · '}worst <b className="font-bold text-rose-600">{worstLossRun}L</b>
                    {' · '}now{' '}
                    <b className={`font-bold ${lastNet >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {lastNet > 0 ? '+' : ''}{lastNet}
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

import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useTodayMapCounts, withMapCount } from '../hooks/useMapCounts';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
import { Overview, Streaks, TrendPoint, ModeComparison, QueueMode, QUEUE_MODES, QUEUE_MODE_COLORS, QUEUE_MODE_SEL_RGB, RANK_TIER_RGB, rankTier, rankLabel, rankDivision, RANK_TIERS, ACCOUNTS, Account, RANK_MIN, RANK_MAX } from '../types';
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
import KillerFrequencyCard from '../components/KillerFrequencyCard';
import { useFieldConfig } from '../contexts/FieldConfigContext';


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
      className={`relative overflow-hidden text-left rounded-lg p-4 border-2 transition-all duration-200 mode-tile hover:-translate-x-1 hover:-translate-y-1 ${selected ? `is-selected mode-fill` : `border-transparent ${c.tileDim}`}`}
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
        lit={selected}
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
        {selected && <span className="shrink-0 whitespace-nowrap text-[11px] uppercase tracking-widest font-bold lit-text lit-strong">Selected</span>}
      </div>
      {m && m.games > 0 ? (
        <>
          {(() => {
            // Headline = recent form (last N games) so a single match visibly
            // moves it; the all-time rate sits below, smaller.
            const big = m.recent_win_rate ?? m.win_rate;
            // Selected tile: lit from the bottom glow, but ramped in the
            // win/loss hue (emerald-500 / rose-500), not the mode colour.
            return (
              <div
                className={`text-4xl font-black tracking-tight num-display ${selected ? `lit-text lit-hue ${big >= 50 ? '' : 'lit-loss'}` : big >= 50 ? 'grad-win' : 'grad-loss'}`}
                style={selected ? ({ '--sel': big >= 50 ? '16 185 129' : '244 63 94' } as unknown as React.CSSProperties) : undefined}
              >
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
      // Same "last reading of the day" idea as `rank` above, but split by
      // account+role. Overwatch ranks each role separately on each account,
      // so "the rank at end of day" isn't one number — it's one number PER
      // ladder Sean actually played that day. Games arrive ordered by date
      // then time, so a forward pass leaves each key on its latest reading.
      const drums = new Map<string, { rank: number; account: string | null; role: string }>();
      for (const g of withRank) {
        drums.set(`${g.account ?? ''}|${g.role}`, { rank: g.player_rank!, account: g.account, role: g.role });
      }
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
        date, open, close, compW, compL, qpW, qpL, top, bottom, nOpen, nClose, rank, drums,
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
  // The volume bars get their own, wider measure. The candles want air around
  // them so 100 days read as 100 separate readings. The skyline wants the
  // opposite: buildings crowd together, and a wide even gap between every
  // block reads as a comb rather than a city. Sharing bodyW would have fattened
  // the candles too.
  const volW = Math.max(2, slotW * 0.82);
  const slotX = (j: number) => slotW * (j + 0.5);
  const chartY = (v: number) =>
    CH_PAD + (1 - (v - lowV) / vSpan) * (PLOT_BOTTOM - CH_PAD);
  // Volume has its own scale and its own strip. Bars hang down from the top of
  // that strip so the busiest day fills it and a two-game day is a stub.
  const maxVol = Math.max(1, ...candles.map(c => c.volume));
  // The tallest bar stops short of the strip's ceiling, leaving a sliver of
  // lit sky above the whole skyline. Without it the tallest roofline runs into
  // the divider, and a bar top with nothing behind it has no edge to read
  // against — which is what made the tops look soft and spread.
  const ROOFLINE = 0.86;
  const volY = (n: number) => CH_H - (n / maxVol) * VOL_H * ROOFLINE;
  // The skyline's ramp, as a falloff rather than a straight line. Real light
  // drops off fast near its source and slowly further out, and that shape is
  // worth copying here for a reason beyond looks: a straight line spends half
  // its colour range on the top half of the tallest bar, which almost no day
  // reaches. The busiest day in the window is 40 matches against a typical
  // 12.3, so an ordinary bar lives entirely in the bottom third. Squaring the
  // curve moves the colour travel down into that third — an ordinary bar now
  // sweeps about half the range instead of a fifth of it.
  //
  // color-mix does the blending, so the two ends stay CSS variables and stay
  // theme-aware. Eleven stops, since a steeper curve packs more change into
  // the bottom of the ramp and nine started to step rather than blend.
  // How sharply the light drops off. 1 would be a straight line; higher
  // numbers crowd the colour change nearer the ground. This is the dial to
  // turn when the ramp reads too soft or too abrupt.
  const FALLOFF = 3;
  const VOL_STOPS = Array.from({ length: 11 }, (_, i) => {
    const o = i / 10; // 0 at the tallest roof, 1 at the ground
    return { offset: o, mix: Math.round(Math.pow(o, FALLOFF) * 100) };
  });
  const volStopColor = (mix: number) =>
    `color-mix(in srgb, var(--vol-base) ${mix}%, var(--vol-roof))`;
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
  // Each account+role pair is its own ladder ("drum"), tracked independently
  // — a drum missing from a given day keeps whatever it read last, so a gap
  // in play never invents a crossing for that drum. Sorting keys before
  // comparing keeps the output order (and so the stacking order below)
  // stable across renders regardless of Map insertion order.
  type TierMark = { j: number; date: string; up: boolean; tier: string; from: string; rank: number; prev: number; account: string | null; role: string };

  // Where each drawn day sits on the chart, so a mark found in the match list
  // can be placed. A move older than the window has no candle and is dropped.
  const candleIdxByDate = new Map(candles.map((c, j) => [c.date, j]));

  // Rank moves, read off the match that caused them.
  //
  // A match now records both ends: player_rank_start going in, player_rank
  // coming out. If they differ, that match moved the ladder, and the mark
  // goes on its day. Nothing is compared against any other row.
  //
  // Sean's call on 2026-09-20, and it retires three bugs at once rather than
  // patching them. Comparing rows meant the answer depended on which earlier
  // row the walk happened to land on, so a gap in play, an edited row, or a
  // match logged before the account column existed all changed it silently.
  // It also could not tell a real move from the drum being dialled in. Two
  // columns on one row are decided at log time, by the person who knows, and
  // an edit to that row corrects the mark instead of shifting every mark
  // after it.
  const tierMarks: TierMark[] = (() => {
    const out: TierMark[] = [];
    for (const g of trends ?? []) {
      const from = g.player_rank_start;
      const to = g.player_rank;
      if (from == null || to == null || from === to) continue;
      const date = g.date.slice(0, 10);
      const j = candleIdxByDate.get(date);
      if (j == null) continue;
      out.push({
        j, date, up: to > from,
        tier: rankTier(to), from: rankTier(from),
        rank: to, prev: from, account: g.account, role: g.role,
      });
    }
    return out;
  })();
  // Index by day so the day's hover tooltip can name every crossing on it —
  // a day can now hold more than one, one per drum that changed tier.
  const tierMarkByDay = new Map<string, TierMark[]>();
  for (const m of tierMarks) {
    const list = tierMarkByDay.get(m.date) ?? [];
    list.push(m);
    tierMarkByDay.set(m.date, list);
  }
  // Two-letter tag for a mark's label: account initial + role initial, both
  // uppercase (Jinx+Support -> "JS"). No account on record (the 7 ranked
  // rows logged before this column existed) falls back to the role initial
  // alone, since that's all there is to say.
  const drumLabel = (account: string | null, role: string) =>
    (account ? account[0].toUpperCase() : '') + role[0].toUpperCase();
  // A day can now carry several crossings. Marks pointing the same way on
  // the same day would land on top of each other, so each successive one
  // (in the same stable sorted-key order used to build tierMarks) is pushed
  // a further 21px outward from the candle — up-marks stack down from the
  // day's low, down-marks stack up from the day's high.
  const tierStackIdx = new Map<TierMark, number>();
  {
    const counters = new Map<string, number>();
    for (const m of tierMarks) {
      const key = `${m.date}|${m.up}`;
      const idx = counters.get(key) ?? 0;
      tierStackIdx.set(m, idx);
      counters.set(key, idx + 1);
    }
  }

  // Ladder strip: one stepped line per (account × role), drawn in its own
  // <svg> directly under the volume bars rather than folded into the candle
  // chart's own coordinate space. The candle chart's gradients are keyed to
  // its own fixed height (CH_H) — stretching that space to fit a second
  // series in would mean re-deriving every gradient stop above it. A
  // separate svg sharing slotX/slotW/CH_W (none of which depend on CH_H)
  // keeps the day columns lined up between the two without touching either.
  //
  // Only DPS and Support are ranked ladders Sean tracks here; Tank is out of
  // scope for this strip by the same brief that scoped the account pills.
  const RANK_ROLES = ['DPS', 'Support'] as const;
  type RankRole = typeof RANK_ROLES[number];

  // One hue per account, borrowed from the existing rank-tier palette
  // (RANK_TIER_RGB) rather than a new one — the standing rule is no
  // off-palette hues. Support is the same hue at lower opacity, so the two
  // lines for one account read as two weights of the same color instead of
  // an unrelated pair.
  const RANK_SERIES_RGB: Record<Account, string> = {
    Pinx: RANK_TIER_RGB.Diamond,
    Jinx: RANK_TIER_RGB.Grandmaster,
    Winx: RANK_TIER_RGB.Master,
    Linx: RANK_TIER_RGB.Bronze,
  };
  const RANK_SERIES_OPACITY: Record<RankRole, number> = { DPS: 1, Support: 0.5 };

  type RankStep = { x: number; y: number };
  type RankMarker = { x: number; y: number; date: string };
  type RankSeries = { account: Account; role: RankRole; color: string; opacity: number; steps: RankStep[]; markers: RankMarker[] };

  // Rows with a rank reading but no account on file (7 matches, logged
  // 2026-09-19/20 before the account column existed) are excluded from every
  // line below by construction: `g.account === account` never matches null.
  const rankSeries: RankSeries[] = ACCOUNTS.flatMap(account =>
    RANK_ROLES.map((role): RankSeries => {
      const matches = (trends ?? []).filter(
        g => g.account === account && g.role === role && (g.player_rank_start != null || g.player_rank != null),
      );
      // Grouped by day so several matches on the same day can be spaced
      // evenly across that day's column instead of stacking on one x.
      const byDate = new Map<string, TrendPoint[]>();
      for (const m of matches) {
        const d = m.date.slice(0, 10);
        const arr = byDate.get(d);
        if (arr) arr.push(m); else byDate.set(d, [m]);
      }
      const steps: RankStep[] = [];
      const markers: RankMarker[] = [];
      let current: number | null = null;
      for (const m of matches) {
        const d = m.date.slice(0, 10);
        const j = candleIdxByDate.get(d);
        if (j == null) continue; // outside the currently visible window
        const dayMatches = byDate.get(d)!;
        const idx = dayMatches.indexOf(m);
        const x = slotX(j) - slotW / 2 + (slotW * (idx + 0.5)) / dayMatches.length;
        const start = m.player_rank_start ?? m.player_rank!;
        const end = m.player_rank ?? m.player_rank_start!;
        if (current == null) {
          // First ranked match of the series: the line starts here, at the
          // rank it began at, not before.
          steps.push({ x, y: start });
        } else {
          // Hold flat from the previous reading up to this match's x — this
          // is what carries a series across days with no games — then jump
          // to this match's own start if it differs (a gap or edit).
          steps.push({ x, y: current });
          if (start !== current) steps.push({ x, y: start });
        }
        // The crossing itself: a vertical step at this match's x from its
        // start rank to its end rank, so a mid-match promotion is a visible
        // jump rather than being averaged away.
        if (end !== start) steps.push({ x, y: end });
        current = end;
        markers.push({ x, y: end, date: d });
      }
      // Carry the last reading flat to the right edge of the visible chart —
      // the line for an account that hasn't played since should still reach
      // "now" instead of stopping mid-chart.
      if (current != null) steps.push({ x: CH_W, y: current });
      return {
        account, role,
        color: `rgb(${RANK_SERIES_RGB[account]})`,
        opacity: RANK_SERIES_OPACITY[role],
        steps, markers,
      };
    }),
  );
  const rankValuesSeen = rankSeries.flatMap(s => s.steps.map(p => p.y));
  const rankHasData = rankValuesSeen.length > 0;
  const rankMinRaw = rankHasData ? Math.min(...rankValuesSeen) : RANK_MIN;
  const rankMaxRaw = rankHasData ? Math.max(...rankValuesSeen) : RANK_MAX;
  const rankPad = Math.max(1, Math.round((rankMaxRaw - rankMinRaw) * 0.15));
  const rankLo = Math.max(RANK_MIN, rankMinRaw - rankPad);
  const rankHi = Math.min(RANK_MAX, rankMaxRaw + rankPad);
  const rankSpan = Math.max(1, rankHi - rankLo);
  const RANK_H = 90;
  const rankY = (v: number) => RANK_H - ((v - rankLo) / rankSpan) * RANK_H;
  const rankTierBands = Array.from(new Set(
    Array.from({ length: rankHi - rankLo + 1 }, (_, i) => rankTier(rankLo + i)),
  )).map(tier => {
    const k = RANK_TIERS.indexOf(tier);
    return { tier, lo: Math.max(rankLo, k * 5 + 0.5), hi: Math.min(rankHi, k * 5 + 5.5) };
  });

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
  // One box for every legend swatch. The five symbols are different shapes
  // and cannot be the same drawing, but they can occupy the same square and
  // sit on the same baseline — which is what makes the row read as one key
  // rather than five diagrams that happen to be adjacent.
  const LEGEND_SWATCH = 'shrink-0 w-5 h-5 mt-px flex items-center justify-center';
  const LEGEND_TITLE = 'font-bold text-[var(--muted)]';

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
            {activeSection === s.id ? <span className="lit-text">{s.label}</span> : s.label}
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
                  aria-label={`Daily win-loss candles across the last ${candles.length} days played. Each candle body is that day's net competitive record, stacked on the previous day's close; wicks are quickplay wins above and losses below. A dashed pace line shows where a run at the career win rate would drift to, shaded one standard deviation either side. Currently ${lastClose > 0 ? '+' : ''}${lastClose}, which is ${Math.abs(lastZ).toFixed(1)} standard deviations ${lastZ < 0 ? 'below' : 'above'} that pace. Volume bars along the bottom show matches played per day. Below that, a separate strip shows competitive rank over time as a stepped line per account and role.`}
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
                    {/* The light is IN the buildings, not behind them. One
                        ramp spanning the whole volume strip in its own
                        coordinates, so every bar samples the same gradient and
                        two bars of the same height come out identical — the
                        same rule the candle gradients follow.

                        The ramp spans the TALLEST BAR, not the strip. That
                        is the whole trick, and it is why there are no hand-
                        tuned hold stops here any more. Keyed to the strip,
                        the top fifth of the ramp sat above every building and
                        was never drawn — so the visible part was a squashed
                        fraction of the colours, and the fix was a magic
                        number moving the stops down. Keyed to the busiest
                        day, every colour in the ramp lands on something.

                        It also self-tunes. Log a 60-match day and the ramp
                        stretches to it on its own; no constant to revisit.

                        The light is still one thing shared by every bar, not
                        a per-bar effect. So height reads as colour: the
                        busiest day fades all the way out at its roof, an
                        ordinary day is lit most of the way up, a two-match
                        day is solid glow.

                        The stops themselves are a falloff curve, not a
                        straight line — see VOL_STOPS above for why.

                        Both ends are CSS variables (index.css), because a
                        stop cannot carry a theme query. --vol-roof sits a
                        short step off the card rather than on it: close
                        enough that a tall bar reads as receding into the
                        page, far enough that its roofline is still there. */}
                    <linearGradient
                      id="volumeGlow"
                      gradientUnits="userSpaceOnUse"
                      x1="0"
                      y1={volY(maxVol)}
                      x2="0"
                      y2={CH_H}
                    >
                      {VOL_STOPS.map(st => (
                        <stop key={st.offset} offset={st.offset} style={{ stopColor: volStopColor(st.mix) }} />
                      ))}
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

                      Drawn as a skyline, lit from the ground up. The glow
                      lives in the bars themselves (see #volumeGlow in the
                      defs) rather than on a backdrop behind them, which was
                      the earlier version — a lit panel behind near-solid
                      blocks meant the brightest part of the light sat where
                      the buildings covered it.

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
                  {candles.map((c, j) => (
                    <rect
                      key={`vol-${c.date}`}
                      x={slotX(j) - volW / 2}
                      y={volY(c.volume)}
                      width={volW}
                      height={CH_H - volY(c.volume)}
                      fill="url(#volumeGlow)"
                    />
                  ))}

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
                        {`${format(parseISO(c.date), 'MMM d')} · ${c.volume} played · comp ${c.compW}W ${c.compL}L${c.qpW + c.qpL > 0 ? ` · qp ${c.qpW}W ${c.qpL}L` : ''} · ${c.open > 0 ? '+' : ''}${c.open} → ${c.close > 0 ? '+' : ''}${c.close} · pace ${paceAt(c.nClose) >= 0 ? '+' : ''}${paceAt(c.nClose).toFixed(1)}${(tierMarkByDay.get(c.date) ?? []).map(m => ` · [${drumLabel(m.account, m.role)}] ${m.up ? 'promoted' : 'demoted'} ${rankLabel(m.prev)} → ${rankLabel(m.rank)}`).join('')}`}
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
                  const stack = tierStackIdx.get(m)!;
                  const outward = stack * 29; // px: the 19px triangle plus its 8px tag, plus a hair
                  const label = drumLabel(m.account, m.role);
                  // The triangle says which way, and the number inside says
                  // which division he landed in. Both halves of "demoted to
                  // Gold 2" in one 15px mark, which is what a bare arrow
                  // could never carry.
                  //
                  // The digit sits off-centre on purpose. A triangle's width
                  // is all at one end, so a vertically centred number crowds
                  // the point and clips. It rides in the wide half: high in a
                  // down-triangle, low in an up-triangle.
                  const div = rankDivision(m.rank);
                  const glyph = (
                    <svg key="g" width="20" height="19" viewBox="0 0 20 19" className="overflow-visible">
                      <polygon
                        points={m.up ? '10,0.75 19.25,18.25 0.75,18.25' : '0.75,0.75 19.25,0.75 10,18.25'}
                        fill="currentColor" stroke="var(--surface)" strokeWidth="1.5" strokeLinejoin="round"
                        paintOrder="stroke"
                      />
                      <text
                        x="10" y={m.up ? 15.4 : 11.6} textAnchor="middle"
                        fontSize="11" fontWeight="800" fill="var(--surface)"
                        className="tabular-nums select-none"
                        style={{ textShadow: 'none' }}
                      >{div}</text>
                    </svg>
                  );
                  const tag = (
                    <span
                      key="l" className="text-[8px] leading-none font-bold tracking-tight tabular-nums"
                      style={{ textShadow: '0 0 2px var(--surface), 0 0 2px var(--surface)' }}
                    >{label}</span>
                  );
                  return (
                    <span
                      key={`tier-${m.date}-${label}-${m.up}`}
                      data-inspect-id="dash-recent-form-tier-mark"
                      title={`[${label}] ${rankLabel(m.prev)} → ${rankLabel(m.rank)}${m.from !== m.tier ? ` · ${m.up ? 'promoted' : 'demoted'} out of ${m.from}` : ''} · ${format(parseISO(m.date), 'MMM d')}`}
                      aria-label={`${m.account ?? ''} ${m.role} ${m.up ? 'up' : 'down'} from ${rankLabel(m.prev)} to ${rankLabel(m.rank)} on ${format(parseISO(m.date), 'MMMM d')}`}
                      className="absolute flex flex-col items-center text-[11px] leading-none pointer-events-none select-none"
                      style={{
                        left: `calc(1.75rem + ${(slotX(m.j) / CH_W) * 100}% - ${(slotX(m.j) / CH_W) * 1.75}rem)`,
                        top: `${(y / CH_H) * 100}%`,
                        transform: m.up
                          ? `translate(-50%, ${2 + outward}px)`
                          : `translate(-50%, -100%) translateY(${-2 - outward}px)`,
                        color: `rgb(${RANK_TIER_RGB[m.tier as keyof typeof RANK_TIER_RGB]})`,
                        // A tier colour chosen to read on a rank badge is not
                        // guaranteed to read on the chart's own background,
                        // and Bronze against a dark card is the worst case. A
                        // thin outline in the page's surface colour keeps the
                        // shape legible in both themes without touching the
                        // hue, which is the part carrying the meaning.
                        // No text-shadow here. It used to sit on this wrapper and
                        // reached the SVG's digit, which is filled in the surface
                        // colour — a surface-coloured halo around a surface-coloured
                        // number, softening the one edge that had to stay sharp. The
                        // triangle has its own outline via paintOrder, and the tag
                        // carries the glow itself.
                      }}
                    >
                      {m.up ? [glyph, tag] : [tag, glyph]}
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

            {/* Ladder strip: rank over time, one stepped line per account and
                role, directly under the volume bars. A separate relative/pl-7
                block rather than a taller version of the chart above — see
                the rankSeries comment for why sharing that svg's own height
                would have meant re-deriving its gradient math. It shares
                slotX/slotW/CH_W with the chart above it, so the day columns
                line up between the two even though the two <svg>s are
                independent. */}
            {candles.length >= 1 && (
              <div className="relative pl-7 mt-6 pt-3 border-t border-ow-border/60" data-inspect-id="dash-rank-strip">
                <div className="relative">
                <svg
                  viewBox={`0 0 ${CH_W} ${RANK_H}`}
                  preserveAspectRatio="none"
                  className="w-full h-[90px] overflow-visible"
                  role="img"
                  aria-label={
                    rankHasData
                      ? `Competitive rank over time, one stepped line per account and role: ${rankSeries.filter(s => s.steps.length > 0).map(s => `${s.account} ${s.role}`).join(', ')}.`
                      : 'Competitive rank over time. No ranked matches with a known account fall inside the currently visible window.'
                  }
                >
                  {/* One band per rank tier inside the visible range, in that
                      tier's own colour, so a line's height reads as a tier at a
                      glance. Tiers are 5 ranks wide (1–5 Bronze, 6–10 Silver…);
                      each band runs half a rank past its ends so boundaries fall
                      between ranks, never on one. */}
                  {rankTierBands.map(b => (
                    <rect
                      key={`rank-band-${b.tier}`}
                      x="0"
                      y={rankY(b.hi)}
                      width={CH_W}
                      height={rankY(b.lo) - rankY(b.hi)}
                      fill={`rgb(${RANK_TIER_RGB[b.tier]})`}
                      fillOpacity="0.1"
                    >
                      <title>{b.tier}</title>
                    </rect>
                  ))}
                  {rankSeries.map(s => s.steps.length > 0 && (
                    <polyline
                      key={`rank-line-${s.account}-${s.role}`}
                      points={s.steps.map(p => `${p.x},${rankY(p.y)}`).join(' ')}
                      fill="none"
                      stroke={s.color}
                      strokeOpacity={s.opacity}
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  {rankSeries.flatMap(s => s.markers.map((m, i) => (
                    <circle
                      key={`rank-pt-${s.account}-${s.role}-${i}`}
                      cx={m.x}
                      cy={rankY(m.y)}
                      r="2.5"
                      fill={s.color}
                      fillOpacity={s.opacity}
                    >
                      <title>{`${s.account} · ${s.role} · ${rankLabel(m.y)} · ${format(parseISO(m.date), 'MMM d')}`}</title>
                    </circle>
                  )))}
                </svg>
                {/* Tier names as a watermark inside their own bands, flush to
                    the chart's left edge. HTML rather than svg <text>: the svg
                    stretches (preserveAspectRatio="none") and would squash
                    the letters. */}
                {rankTierBands.map(b => (
                  <span
                    key={`rank-band-label-${b.tier}`}
                    className="absolute left-0 -translate-y-1/2 pl-1 text-[22px] font-black uppercase tracking-[0.12em] leading-none pointer-events-none select-none"
                    style={{
                      top: `${((rankY(b.hi) + rankY(b.lo)) / 2 / RANK_H) * 100}%`,
                      color: `rgb(${RANK_TIER_RGB[b.tier]})`,
                      opacity: 0.45,
                    }}
                  >
                    {b.tier}
                  </span>
                ))}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] leading-none text-[var(--faint)] mt-2" data-inspect-id="dash-rank-strip-legend">
                  {rankSeries.map(s => {
                    const has = s.steps.length > 0;
                    return (
                      <span key={`rank-legend-${s.account}-${s.role}`} className="inline-flex items-center gap-1">
                        <span
                          className="inline-block w-2 h-2 rounded-full shrink-0"
                          style={{ background: s.color, opacity: has ? s.opacity : 0.25 }}
                        />
                        <span className={has ? '' : 'italic opacity-60'}>
                          {s.account} · {s.role}{has ? '' : ' (no data)'}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
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
                  className="flex flex-wrap lg:flex-nowrap items-start gap-x-6 lg:gap-x-4 gap-y-3 text-[10px] leading-[1.6] text-[var(--faint)] mt-4 pt-3 border-t border-ow-border"
                >
                  {/* Two rules hold this row together.

                      Every swatch lives in the same 20x20 box (LEGEND_SWATCH)
                      and every entry is a bold title over exactly one line.
                      The candle used to be drawn 44px tall against 12px
                      neighbours, which read as five unrelated diagrams rather
                      than one key.

                      And every item carries min-w-0, so that at lg — where the
                      row is told not to wrap — a long line breaks INSIDE its
                      own item instead of pushing past the card edge. A flex
                      child otherwise refuses to shrink below its longest word
                      run, and five of them overflow. */}
                  <div className="flex items-start gap-2 min-w-0">
                    <span className={LEGEND_SWATCH} aria-hidden="true">
                      <svg width="20" height="20" viewBox="0 0 20 20">
                        <line x1="10" y1="1" x2="10" y2="6" stroke={UP_SWATCH} strokeWidth="2" strokeOpacity="0.9" />
                        <rect x="4" y="6" width="12" height="8" fill={UP_SWATCH} fillOpacity="0.85" stroke={UP_SWATCH} strokeWidth="1.5" />
                        <line x1="10" y1="14" x2="10" y2="19" stroke={UP_SWATCH} strokeWidth="2" strokeOpacity="0.9" />
                      </svg>
                    </span>
                    <span>
                      <b className={LEGEND_TITLE}>one candle = one day</b>
                      <br />body: ranked net · wick: quickplay, wins up / losses down
                    </span>
                  </div>

                  <div className="flex items-start gap-2 min-w-0">
                    <span className={LEGEND_SWATCH} aria-hidden="true">
                      <span className="inline-flex gap-1">
                        <span className="inline-block w-2 h-3.5 rounded-[1px]" style={{ background: UP_SWATCH, opacity: 0.85 }} />
                        <span className="inline-block w-2 h-3.5 rounded-[1px]" style={{ background: DOWN_SWATCH, opacity: 0.85 }} />
                      </span>
                    </span>
                    <span>
                      <b className={LEGEND_TITLE}>color</b>
                      <br />green: broke even or better · stronger: further out
                    </span>
                  </div>

                  <div className="flex items-start gap-2 min-w-0">
                    <span className={LEGEND_SWATCH} aria-hidden="true">
                      <span className="relative inline-block w-[18px] h-3.5">
                        <span className="absolute inset-0 rounded-[1px] bg-ow-accent dark:bg-ow-accentLight opacity-[0.14]" />
                        <span className="absolute left-0 right-0 top-1/2 border-t border-dashed border-ow-accent dark:border-ow-accentLight opacity-90" />
                      </span>
                    </span>
                    <span>
                      <b className={LEGEND_TITLE}>pace &amp; ±1 SD</b>
                      <br />where a run at your career <b className="font-bold">{((careerEdge + 1) * 50).toFixed(1)}</b>% would drift
                    </span>
                  </div>

                  <div className="flex items-start gap-2 min-w-0">
                    <span className={LEGEND_SWATCH} aria-hidden="true">
                      {/* All three share one ramp sized to the TALLEST of them
                          and anchored to the bottom, the same rule the chart
                          follows — so the short swatches show a slice of the
                          gradient rather than their own squashed copy. */}
                      <span className="inline-flex items-end gap-[2px] h-5">
                        {['0.625rem', '1.25rem', '0.875rem'].map((h, i) => (
                          <span
                            key={i}
                            className="inline-block w-1"
                            style={{
                              height: h,
                              backgroundImage: `linear-gradient(to top, ${VOL_STOPS.map(
                                st => `${volStopColor(st.mix)} ${Math.round((1 - st.offset) * 100)}%`,
                              ).reverse().join(', ')})`,
                              backgroundSize: '100% 1.25rem',
                              backgroundPosition: 'bottom',
                              backgroundRepeat: 'no-repeat',
                            }}
                          />
                        ))}
                      </span>
                    </span>
                    <span>
                      <b className={LEGEND_TITLE}>bars below</b>
                      <br />games that day, ranked and quickplay · busiest <b className="font-bold">{maxVol}</b>
                    </span>
                  </div>

                  {/* A fixture, not conditional on a crossing existing. It was
                      drawn only when tierMarks was non-empty, which made the
                      legend five items wide on some days and four on others —
                      so the row it fits in changed from day to day. A legend
                      that reflows depending on the data is harder to read than
                      one entry explaining a symbol you have not hit yet. */}
                  <div className="flex items-start gap-2 min-w-0">
                    <span className={LEGEND_SWATCH} aria-hidden="true">
                      <span className="inline-flex flex-col leading-[0.75] text-[11px]">
                        <span style={{ color: `rgb(${RANK_TIER_RGB.Platinum})` }}>▲</span>
                        <span style={{ color: `rgb(${RANK_TIER_RGB.Gold})` }}>▼</span>
                      </span>
                    </span>
                    <span>
                      <b className={LEGEND_TITLE}>tier change</b>
                      <br />▲ under the candle, ▼ over · colored for the tier entered
                    </span>
                  </div>
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

      {isFieldEnabled('deaths') && (
      <div id="sec-killer-frequency" className="mt-8 border-t border-ow-border pt-6 reveal scroll-mt-32" data-inspect-id="dash-killer-frequency-section" style={{ '--reveal-delay': '200ms' } as React.CSSProperties}>
        <KillerFrequencyCard />
      </div>
      )}

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
    </div>
  );
}

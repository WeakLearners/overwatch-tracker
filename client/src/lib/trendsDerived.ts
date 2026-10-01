import { TrendPoint, rankTier, RANK_TIERS, ACCOUNTS, Account, RANK_MIN, RANK_MAX } from '../types';

// Extracted 2026-09-26 (perf pass): this entire derivation used to run inline
// in Dashboard's render body, recomputing candles/tierMarks/rankSeries from the
// full trends array (one row per logged match, 3600+ and growing) on EVERY
// render of Dashboard -- including renders caused by state that has nothing to
// do with trends (a death tap, a lobby-range drag, a queue-mode toggle), because
// all of those live in MatchContext and Dashboard is one of several consumers
// that re-render whenever that context's value object changes identity. Moved
// to a plain function called through useMemo(..., [trends]) below so it only
// re-runs when trends itself actually changes (a refetch), not on every render.
//
// Moved again 2026-09-27 (modularization plan step 4, piece 2) from
// Dashboard.tsx into its own module — pure move, no logic change. The
// memoization risk this move raises is whether the call site still derives
// this only from `trends`: RecentMatchesCard.tsx calls it as
// `useMemo(() => computeTrendsDerived(trends), [trends])`, unchanged by this
// move, so that guarantee holds.
export function computeTrendsDerived(trends: TrendPoint[] | null) {
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
      const placements = comp.filter(g => g.placement === 1).length;
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
        date, open, close, compW, compL, qpW, qpL, placements, top, bottom, nOpen, nClose, rank, drums,
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
  // a further step outward from the candle — "+" marks stack up from the
  // day's high, "−" marks stack down from its low.
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

  // Eight hues spread evenly around the wheel, one per account x role, at
  // matched lightness and chroma. Deliberately NOT from the tier palette:
  // Sean, 2026-09-26, rejected that palette twice here because it is mostly
  // golds, browns and teals, so lines read alike. Each account's two roles
  // sit roughly opposite each other on the wheel so they never look related.
  const hue = (h: number, l = 0.72) => `oklch(${l} 0.19 ${h})`;
  const RANK_SERIES_COLOR: Record<Account, Record<RankRole, string>> = {
    Pinx: { DPS: hue(255),  Support: hue(100, 0.86) }, // blue / yellow
    Jinx: { DPS: hue(340),  Support: hue(145, 0.78) }, // magenta / green
    Winx: { DPS: hue(60),   Support: hue(295) },       // orange / violet
    Linx: { DPS: hue(200, 0.78), Support: hue(25, 0.66) }, // cyan / red
  };

  type RankStep = { x: number; y: number };
  type RankSeries = { account: Account; role: RankRole; color: string; steps: RankStep[]; current: boolean };

  // "Current" = the account and role of the most recent match with an account
  // on file (trends run oldest → newest). That line gets the glow.
  const lastWithAccount = [...(trends ?? [])].reverse().find(g => g.account != null);

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
      }
      // Carry the last reading flat to the right edge of the visible chart —
      // the line for an account that hasn't played since should still reach
      // "now" instead of stopping mid-chart.
      if (current != null) steps.push({ x: CH_W, y: current });
      return {
        account, role,
        // Same hue, chroma boosted 1.5x (the oklch relative-colour move the
        // lit-text glows use), so the lines read over the lit tier bands.
        color: RANK_SERIES_COLOR[account][role],
        steps,
        current: lastWithAccount?.account === account && lastWithAccount?.role === role,
      };
    }),
  );
  const rankValuesSeen = rankSeries.flatMap(s => s.steps.map(p => p.y));
  const rankHasData = rankValuesSeen.length > 0;
  const rankMinRaw = rankHasData ? Math.min(...rankValuesSeen) : RANK_MIN;
  const rankMaxRaw = rankHasData ? Math.max(...rankValuesSeen) : RANK_MAX;
  // The range is exactly the tiers the data sits in, whole: no padding into
  // an empty tier (a 2-rank pad above Emerald 24 used to show a Diamond sliver
  // with nothing in it). Tiers are 5 ranks wide; edges sit half a rank past.
  const rankTierLoIdx = Math.floor((rankMinRaw - 1) / 5);
  const rankTierHiIdx = Math.floor((rankMaxRaw - 1) / 5);
  const rankLo = rankTierLoIdx * 5 + 0.5;
  const rankHi = rankTierHiIdx * 5 + 5.5;
  const rankSpan = rankHi - rankLo;
  const RANK_H = 120;
  const rankY = (v: number) => RANK_H - ((v - rankLo) / rankSpan) * RANK_H;
  const rankTierBands = RANK_TIERS
    .slice(rankTierLoIdx, rankTierHiIdx + 1)
    .map((tier, i) => {
      const k = rankTierLoIdx + i;
      return { tier, lo: k * 5 + 0.5, hi: k * 5 + 5.5 };
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

  return { last100, last500, winRate, wr100, wr500, wrDelta, CANDLE_DAYS, candles, careerComp, careerEdge, perMatchSd, paceAt, sdAt, CH_W, CH_H, CH_PAD, VOL_H, PLOT_BOTTOM, bandLo, bandHi, lowV, highV, vSpan, slotW, bodyW, volW, slotX, chartY, maxVol, ROOFLINE, volY, FALLOFF, VOL_STOPS, volStopColor, pacePts, bandUpper, bandLower, bandPoly, candleIdxByDate, tierMarks, tierMarkByDay, drumLabel, tierStackIdx, RANK_ROLES, RANK_SERIES_COLOR, rankSeries, rankValuesSeen, rankHasData, rankMinRaw, rankMaxRaw, rankTierLoIdx, rankTierHiIdx, rankLo, rankHi, rankSpan, RANK_H, rankY, rankTierBands, zeroY, lastCandle, lastClose, lastN, lastZ, BLEND_THRESHOLD, SAT_FLOOR, SAT_CEIL, SAT_FULL_AT, GRAD_STOPS, gradStops, UP_COLOR, DOWN_COLOR, UP_SWATCH, DOWN_SWATCH, LEGEND_SWATCH, LEGEND_TITLE, yTicks, labelEvery, dayTicks, dayNets, bestDay, worstDay };
}

import { memo, useMemo } from 'react';
import { format, parseISO } from 'date-fns';
import { TrendPoint, RANK_TIER_RGB, rankLabel, isAccount } from '../../types';
import AnimatedNumber from '../AnimatedNumber';
import EmptyState from '../EmptyState';
import { computeTrendsDerived } from '../../lib/trendsDerived';

// Extracted 2026-09-26 (perf pass, round 2): this card (the candle/volume/
// rank-strip chart) is the single heaviest subtree Dashboard renders --
// hundreds of SVG nodes built from computeTrendsDerived's output. Dashboard
// itself is a direct MatchContext consumer (reads queueMode/setQueueMode/
// lastLog), so it re-renders on every context change: a map pick, a lobby-
// slider drag, a queue-mode toggle, a rank change, an advisor fetch settling
// -- none of which this card's own inputs (trends, tilt) care about. Pulling
// it out to its own component with only those two things as props, wrapped in
// React.memo, means Dashboard re-rendering no longer implies THIS re-rendering:
// React bails out on the unchanged-props check before this component's own
// function body (and computeTrendsDerived, and the SVG JSX) ever runs again.
//
// Moved again 2026-09-27 (modularization plan step 4, piece 3) from
// Dashboard.tsx into its own file — pure move, no logic change. The memo
// guard above only holds if `trends`/`tilt` stay referentially stable
// across Dashboard's own re-renders; both are still passed straight
// through from Dashboard's own useApi state, unwrapped, with no inline
// object or closure at the call site.
interface RecentMatchesCardProps {
  trends: TrendPoint[] | null;
  tilt: { on_tilt: boolean; tilt_win_rate: number | null; tilt_games: number } | null | undefined;
}
const RecentMatchesCard = memo(function RecentMatchesCard({ trends, tilt }: RecentMatchesCardProps) {
  const { last100, last500, winRate, wr100, wr500, wrDelta, CANDLE_DAYS, candles, careerComp, careerEdge, perMatchSd, paceAt, sdAt, CH_W, CH_H, CH_PAD, VOL_H, PLOT_BOTTOM, bandLo, bandHi, lowV, highV, vSpan, slotW, bodyW, volW, slotX, chartY, maxVol, ROOFLINE, volY, FALLOFF, VOL_STOPS, volStopColor, pacePts, bandUpper, bandLower, bandPoly, candleIdxByDate, tierMarks, tierMarkByDay, drumLabel, tierStackIdx, RANK_ROLES, RANK_SERIES_COLOR, rankSeries, rankValuesSeen, rankHasData, rankMinRaw, rankMaxRaw, rankTierLoIdx, rankTierHiIdx, rankLo, rankHi, rankSpan, RANK_H, rankY, rankTierBands, zeroY, lastCandle, lastClose, lastN, lastZ, BLEND_THRESHOLD, SAT_FLOOR, SAT_CEIL, SAT_FULL_AT, GRAD_STOPS, gradStops, UP_COLOR, DOWN_COLOR, UP_SWATCH, DOWN_SWATCH, LEGEND_SWATCH, LEGEND_TITLE, yTicks, labelEvery, dayTicks, dayNets, bestDay, worstDay } = useMemo(() => computeTrendsDerived(trends), [trends]);
  return (
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

                {/* Tier crossings, as a small "+" (promotion, stacked above the
                    day's high) or "−" (demotion, stacked below its low), so
                    neither lands on the candle it belongs to. No account/role
                    letters on the chart; the hover title carries them. HTML, not SVG: the chart
                    is stretched with preserveAspectRatio="none" and a glyph
                    inside it would stretch too.

                    Coloured by ACCOUNT, the same colour as that account's line
                    in the rank strip below (Support at its line's 70%), so a
                    mark points at the line it moved. The sign already says the
                    direction; green/red would only repeat it. Replaced the
                    tier-coloured triangles 2026-09-25. */}
                {tierMarks.map((m, mi) => {
                  const c = candles[m.j];
                  const y = m.up ? chartY(c.high) : chartY(c.low);
                  const stack = tierStackIdx.get(m)!;
                  const outward = stack * 5; // px: the signs' strokes sit mid-glyph, so 5 stacks them tight without the strokes colliding
                  const label = drumLabel(m.account, m.role);
                  const glyph = (
                    <span
                      key="g" className="text-[13px] font-black leading-[0.7]"
                      style={{ textShadow: '0 0 2px var(--surface), 0 0 2px var(--surface)' }}
                    >{m.up ? '+' : '−'}</span>
                  );
                  return (
                    <span
                      key={`tier-${m.date}-${label}-${m.up}-${mi}`}
                      data-inspect-id="dash-recent-form-tier-mark"
                      title={`[${label}] ${rankLabel(m.prev)} → ${rankLabel(m.rank)}${m.from !== m.tier ? ` · ${m.up ? 'promoted' : 'demoted'} out of ${m.from}` : ''} · ${format(parseISO(m.date), 'MMM d')}`}
                      aria-label={`${m.account ?? ''} ${m.role} ${m.up ? 'up' : 'down'} from ${rankLabel(m.prev)} to ${rankLabel(m.rank)} on ${format(parseISO(m.date), 'MMMM d')}`}
                      className="absolute flex flex-col items-center text-[11px] leading-none pointer-events-none select-none"
                      style={{
                        left: `calc(1.75rem + ${(slotX(m.j) / CH_W) * 100}% - ${(slotX(m.j) / CH_W) * 1.75}rem)`,
                        top: `${(y / CH_H) * 100}%`,
                        transform: m.up
                          ? `translate(-50%, -100%) translateY(${-1 - outward}px)`
                          : `translate(-50%, ${1 + outward}px)`,
                        color: m.account && isAccount(m.account) && (m.role === 'DPS' || m.role === 'Support')
                          ? RANK_SERIES_COLOR[m.account][m.role]
                          : 'var(--faint)',
                        // The sign carries a surface-coloured halo, so it stays
                        // legible over a candle in either theme.
                      }}
                    >
                      {glyph}
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
                  className="relative z-10 w-full h-[120px] overflow-visible"
                  role="img"
                  aria-label={
                    rankHasData
                      ? `Competitive rank over time, one stepped line per account and role: ${rankSeries.filter(s => s.steps.length > 0).map(s => `${s.account} ${s.role}`).join(', ')}.`
                      : 'Competitive rank over time. No ranked matches with a known account fall inside the currently visible window.'
                  }
                >
                  {rankSeries.map(s => s.steps.length > 0 && !s.current && (
                    <polyline
                      key={`rank-line-${s.account}-${s.role}`}
                      points={s.steps.map(p => `${p.x},${rankY(p.y)}`).join(' ')}
                      fill="none"
                      stroke={s.color}
                                            strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    >
                      <title>{`${s.account} · ${s.role}`}</title>
                    </polyline>
                  ))}
                </svg>
                {/* The current account/role's line, in its own svg so the glow (.rank-glow,
                    a pulsing CSS drop-shadow) sits on the html box: a filter inside the stretched
                    svg (preserveAspectRatio="none") would smear sideways. */}
                <svg
                  viewBox={`0 0 ${CH_W} ${RANK_H}`}
                  preserveAspectRatio="none"
                  className="rank-glow absolute inset-0 z-20 w-full h-[120px] overflow-visible pointer-events-none"
                  aria-hidden="true"
                  style={{ '--glow': rankSeries.find(s => s.current)?.color } as React.CSSProperties}
                >
                  {rankSeries.filter(s => s.current && s.steps.length > 0).map(s => (
                    <polyline
                      key={`rank-line-${s.account}-${s.role}`}
                      points={s.steps.map(p => `${p.x},${rankY(p.y)}`).join(' ')}
                      fill="none"
                      stroke={s.color}
                                            strokeWidth="2.5"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </svg>
                {/* Each band is lit like a selected mode tile (.is-selected
                    .mode-fill in the tier's hue): the threshold at its bottom
                    edge is the light source, fading upward.
                    Tier names as watermarks, styled like the mode watermarks:
                    the band is a clipping box and the name is drawn larger than
                    it, so the letters bleed off its edges; the glyphs carry the
                    same bottom-lit glow (.lit-text.lit-strong) in the tier's own
                    hue via --sel. HTML rather than svg <text>: the svg stretches
                    (preserveAspectRatio="none") and would squash the letters. */}
                {rankTierBands.map(b => {
                  const bandPx = (RANK_H * (b.hi - b.lo)) / rankSpan;
                  return (
                    <div
                      key={`rank-band-label-${b.tier}`}
                      aria-hidden="true"
                      className="absolute left-0 right-0 overflow-hidden pointer-events-none select-none is-selected mode-fill"
                      style={{ top: `${(rankY(b.hi) / RANK_H) * 100}%`, height: `${(bandPx / RANK_H) * 100}%`, '--sel': RANK_TIER_RGB[b.tier],
                        // A notch thinner than .mode-fill's 3px edge + 10px glow: these
                        // bands are ~30px tall, a third of a mode tile.
                        boxShadow: 'inset 0 -2px 0 0 rgb(var(--sel)), inset 0 -6px 8px -5px rgb(var(--sel) / 0.95)',
                      } as React.CSSProperties}
                    >
                      <span
                        className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-[0.3em] num-display italic font-black uppercase leading-none tracking-[-0.07em] whitespace-nowrap opacity-[0.225]"
                        style={{ fontSize: `${bandPx * 1.6}px` }}
                      >
                        <span className="lit-text lit-strong pr-[0.3em]">{b.tier}</span>
                      </span>
                    </div>
                  );
                })}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] leading-none text-[var(--faint)] mt-2" data-inspect-id="dash-rank-strip-legend">
                  {rankSeries.map(s => {
                    const has = s.steps.length > 0;
                    return (
                      <span key={`rank-legend-${s.account}-${s.role}`} className="inline-flex items-center gap-1">
                        <span
                          className="inline-block w-2 h-2 rounded-full shrink-0"
                          style={{ background: s.color, opacity: has ? 1 : 0.25 }}
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
                {/* One line of fine print: what the chart covers on the left,
                    where you stand on the right. This used to be two rows that
                    printed the current total twice ("now" and "you"). The pace
                    figures stay: the band is only useful if the number that goes
                    with it is on screen, since "inside one SD" is the difference
                    between a slump and an ordinary stretch. */}
                <div className="flex items-center justify-between flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--faint)] mt-3" data-inspect-id="dash-recent-form-pace-note">
                  <span>{candles.length} days · {lastN} ranked</span>
                  <span>
                    best <b className="font-bold text-emerald-600">{bestDay > 0 ? '+' : ''}{bestDay}</b>
                    {' · '}worst <b className="font-bold text-rose-600">{worstDay}</b>
                    {' · '}now{' '}
                    <b className={`font-bold ${lastClose >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {lastClose > 0 ? '+' : ''}{lastClose}
                    </b>
                    {' vs pace '}<b className="font-bold">{paceAt(lastN) >= 0 ? '+' : ''}{paceAt(lastN).toFixed(0)}</b>
                    {' · '}
                    <b className={`font-bold ${Math.abs(lastZ) >= 2 ? 'text-amber-600' : ''}`}>
                      {lastZ >= 0 ? '+' : '−'}{Math.abs(lastZ).toFixed(2)} SD
                    </b>
                    {Math.abs(lastZ) < 1 ? ', ordinary' : Math.abs(lastZ) < 2 ? ', notable' : ', real'}
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
                        <span className="font-black" style={{ color: RANK_SERIES_COLOR.Pinx.DPS }}>+</span>
                        <span className="font-black" style={{ color: RANK_SERIES_COLOR.Jinx.DPS }}>−</span>
                      </span>
                    </span>
                    <span>
                      <b className={LEGEND_TITLE}>tier change</b>
                      <br />+ above the candle, − below · colored by account, like its rank line
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

  );
});

export default RecentMatchesCard;

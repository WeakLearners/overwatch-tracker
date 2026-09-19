import { useCallback, useMemo, useRef } from 'react';
import { RANK_MIN, RANK_MAX, RANK_TIER_COLOR, RANK_TIER_RGB, rankLabel, rankTier, rankDivision, clampRank } from '../types';

// How far either side of Sean's own rank the row reaches. Ten divisions is two
// full tiers each way — comfortably wider than the +/-5 that ~99% of lobbies
// fall inside, so the standard case never sits against an edge.
const WINDOW = 10;

// The lamp's colours live in index.css, on .lobby-slider as --lamp-core and
// --lamp-deep. They have to: the lamp is near-white on a dark card and
// saturated cyan on a white one, and an inline style cannot carry a theme
// query. That inversion is the whole reason this component's visuals are
// classes rather than style objects.

type Props = {
  /** Sean's own rank; the row is built around it. */
  playerRank: number;
  low: number | null;
  high: number | null;
  /** Bar width in divisions, sticky across matches. */
  width: number;
  onChange: (low: number, high: number) => void;
  /**
   * Record a new remembered width WITHOUT moving the bar. Called once when a
   * handle drag finishes. Keeping this separate from onResize is the whole
   * fix for the drag fighting itself: the old code called one setter that both
   * stored the width AND re-centred the bar, so every pixel of a handle drag
   * yanked the bar back to its old centre.
   */
  onRememberWidth: (w: number) => void;
  /** Resize the bar in place, around where it already sits. The header buttons. */
  onResize: (w: number) => void;
  onClear: () => void;
};

type DragMode = 'move' | 'low' | 'high';

/**
 * The lobby's rank range: a row of one box per division, and a separate bar in
 * a lane beneath it.
 *
 * The boxes are the scale — each one a real rank, tinted by its tier, with the
 * division number printed on it. The bar underneath is the reading: it sits
 * under the boxes the lobby actually spanned. Slide it to move it, drag either
 * end to stretch it.
 *
 * Both rows share one CSS grid, so the bar's ends line up with box edges
 * exactly, gaps included, rather than being positioned by arithmetic that
 * drifts a pixel at a time.
 *
 * The lane starts empty and stays empty until Sean puts the bar somewhere. A
 * bar that appeared on its own would be a guess wearing the costume of an
 * observation — the same trap the old per-death axis sliders fell into.
 */
export default function LobbyRangeSlider({ playerRank, low, high, width, onChange, onRememberWidth, onResize, onClear }: Props) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ mode: DragMode; grabOffset: number } | null>(null);

  // Clamped at both ends of the real ladder, so a Bronze or Champion player
  // gets a shorter row rather than boxes for ranks that don't exist.
  const slots = useMemo(() => {
    const arr: number[] = [];
    for (let r = playerRank - WINDOW; r <= playerRank + WINDOW; r++) {
      if (r >= RANK_MIN && r <= RANK_MAX) arr.push(r);
    }
    return arr;
  }, [playerRank]);

  const first = slots[0];
  const last = slots[slots.length - 1];
  const cols = `repeat(${slots.length}, minmax(0, 1fr))`;

  // Consecutive runs of one tier, for the label row above the boxes.
  const tierRuns = useMemo(() => {
    const runs: { tier: ReturnType<typeof rankTier>; start: number; span: number }[] = [];
    slots.forEach((r, i) => {
      const t = rankTier(r);
      const prev = runs[runs.length - 1];
      if (prev && prev.tier === t) prev.span += 1;
      else runs.push({ tier: t, start: i, span: 1 });
    });
    return runs;
  }, [slots]);

  const rankAtClientX = useCallback((clientX: number): number => {
    const el = laneRef.current;
    if (!el) return playerRank;
    const box = el.getBoundingClientRect();
    const frac = (clientX - box.left) / box.width;
    const i = Math.floor(frac * slots.length);
    return slots[Math.max(0, Math.min(slots.length - 1, i))];
  }, [slots, playerRank]);

  const place = useCallback((centerRank: number, w: number) => {
    const half = Math.floor((w - 1) / 2);
    let lo = centerRank - half;
    let hi = lo + w - 1;
    if (lo < first) { lo = first; hi = Math.min(last, lo + w - 1); }
    if (hi > last) { hi = last; lo = Math.max(first, hi - w + 1); }
    onChange(clampRank(lo), clampRank(hi));
  }, [first, last, onChange]);

  // The lane owns the whole gesture. The bar and its two end handles only
  // declare what they are via data-drag-role; they have no pointer handlers of
  // their own. One capture, one mover, no competing listeners.
  const onLanePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const r = rankAtClientX(e.clientX);
    const role = (e.target as HTMLElement).closest('[data-drag-role]')?.getAttribute('data-drag-role');

    if (low == null || high == null) {
      place(r, width);
      dragRef.current = { mode: 'move', grabOffset: Math.floor((width - 1) / 2) };
      return;
    }
    if (role === 'low' || role === 'high') {
      dragRef.current = { mode: role, grabOffset: 0 };
      return;
    }
    if (role === 'bar') {
      // Grab-and-carry: the bar keeps its offset under the cursor.
      dragRef.current = { mode: 'move', grabOffset: r - low };
      return;
    }
    // Pressed bare lane. The bar moves HERE, centred, and is then carried.
    // The old code grabbed it with the offset to wherever it already sat, so
    // pressing well to its right made it leap off in the opposite direction.
    const w = high - low + 1;
    place(r, w);
    dragRef.current = { mode: 'move', grabOffset: Math.floor((w - 1) / 2) };
  }, [low, high, width, place, rankAtClientX]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || low == null || high == null) return;
    const r = rankAtClientX(e.clientX);
    if (drag.mode === 'move') {
      const w = high - low + 1;
      const lo = Math.max(first, Math.min(last - w + 1, r - drag.grabOffset));
      if (lo !== low) onChange(lo, lo + w - 1);
    } else if (drag.mode === 'low') {
      const lo = Math.max(first, Math.min(r, high));
      if (lo !== low) onChange(lo, high);
    } else {
      const hi = Math.min(last, Math.max(r, low));
      if (hi !== high) onChange(low, hi);
    }
  }, [low, high, first, last, onChange, rankAtClientX]);

  // The new width is recorded once, here, when the gesture ends — not on every
  // pixel of it.
  const endDrag = useCallback((e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && (drag.mode === 'low' || drag.mode === 'high') && low != null && high != null) {
      onRememberWidth(high - low + 1);
    }
  }, [low, high, onRememberWidth]);

  // Arrow keys slide the bar; shift+arrow stretches its right end.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (low == null || high == null) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const d = e.key === 'ArrowRight' ? 1 : -1;
    if (e.shiftKey) {
      const hi = Math.min(last, Math.max(low, high + d));
      onChange(low, hi);
      onRememberWidth(hi - low + 1);
    } else {
      const w = high - low + 1;
      const lo = Math.max(first, Math.min(last - w + 1, low + d));
      onChange(lo, lo + w - 1);
    }
  };

  const set = low != null && high != null;
  const loIdx = set ? slots.indexOf(low!) : -1;
  const hiIdx = set ? slots.indexOf(high!) : -1;

  return (
    <div className="lobby-slider" data-inspect-id="lobby-range-slider">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-[var(--muted)]">
          Lobby range{' '}
          {set
            ? <span className="text-[var(--faint-2)]">— {rankLabel(low!)} → {rankLabel(high!)} · {high! - low! + 1} divisions</span>
            : <span className="text-[var(--faint-2)]">— press the lane to place the bar</span>}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onResize(Math.max(1, width - 1))}
            data-inspect-id="lobby-range-slider-narrow"
            aria-label="Narrow the range by one division"
            className="w-5 h-5 rounded border border-ow-border text-[var(--faint)] hover:text-[var(--ink)] leading-none text-xs"
          >−</button>
          <span className="text-xs num-display text-[var(--ink-2)] w-4 text-center" data-inspect-id="lobby-range-slider-width">{width}</span>
          <button
            type="button"
            onClick={() => onResize(Math.min(slots.length, width + 1))}
            data-inspect-id="lobby-range-slider-widen"
            aria-label="Widen the range by one division"
            className="w-5 h-5 rounded border border-ow-border text-[var(--faint)] hover:text-[var(--ink)] leading-none text-xs"
          >+</button>
          {set && (
            <button
              type="button"
              onClick={onClear}
              data-inspect-id="lobby-range-slider-clear"
              className="ml-1 text-xs text-[var(--faint-2)] hover:text-red-600"
            >clear</button>
          )}
        </div>
      </div>

      {/* Tier names, each spanning its own run of boxes. */}
      <div className="relative z-10 grid gap-1 mb-1" style={{ gridTemplateColumns: cols }} data-inspect-id="lobby-range-slider-tier-labels">
        {tierRuns.map(run => (
          <div
            key={run.tier}
            className="text-[9px] uppercase tracking-wider font-bold text-center truncate rounded-sm"
            style={{
              gridColumn: `${run.start + 1} / span ${run.span}`,
              color: RANK_TIER_COLOR[run.tier],
              backgroundImage: `linear-gradient(to right, transparent, ${RANK_TIER_COLOR[run.tier]}1f, transparent)`,
            }}
          >
            {run.span >= 3 ? run.tier : run.tier[0]}
          </div>
        ))}
      </div>

      {/* One box per division. Boxes the bar covers light up. */}
      <div className="relative">
        {/* Light that made it through the glass and kept going. It sits ABOVE
            the row, spanning only the lit columns, blurred and fading upward —
            the halo you see over a backlit pane rather than a hard edge where
            the light politely stops. Purely decorative, so it takes no
            pointer events and no place in the accessibility tree. */}
        {set && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-full h-4 grid gap-1"
            style={{ gridTemplateColumns: cols }}
          >
            {slots.slice(loIdx, hiIdx + 1).map((r, k) => (
              <span
                key={r}
                className="rank-halo"
                data-inspect-id="lobby-range-slider-halo"
                style={{
                  gridColumn: `${loIdx + 1 + k} / span 1`,
                  '--tier': RANK_TIER_RGB[rankTier(r)],
                } as React.CSSProperties}
              />
            ))}
          </div>
        )}
      <div className="grid gap-1" style={{ gridTemplateColumns: cols }} data-inspect-id="lobby-range-slider-boxes">
        {slots.map((r, i) => {
          const inRange = set && i >= loIdx && i <= hiIdx;
          const isMine = r === playerRank;
          return (
            <button
              key={r}
              type="button"
              onClick={() => place(r, width)}
              data-inspect-id="lobby-range-slider-box"
              title={rankLabel(r)}
              aria-label={`${rankLabel(r)}${inRange ? ' — in range' : ''}`}
              aria-pressed={inRange}
              // --tier is the pane's own colour. Everything else about how a
              // lit pane looks lives in .rank-pane in index.css, because it has
              // to say opposite things in the two themes and an inline style
              // cannot carry a media or class query.
              style={{ '--tier': RANK_TIER_RGB[rankTier(r)] } as React.CSSProperties}
              className={`rank-pane h-7 rounded text-[11px] num-display font-bold transition-colors ${
                isMine ? 'ring-1 ring-[var(--ink)] ring-inset' : ''
              } ${inRange ? 'is-lit' : 'text-[var(--faint-2)]'}`}
            >
              {rankDivision(r)}
            </button>
          );
        })}
      </div>
      </div>

      {/* The lane, and the bar in it. Same grid as the boxes above, so the
          bar's ends land on box edges exactly rather than near them. */}
      <div
        ref={laneRef}
        onPointerDown={onLanePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-inspect-id="lobby-range-slider-lane"
        className="grid gap-1 mt-1 h-4 items-center rounded bg-gradient-to-b from-black/25 to-transparent dark:from-black/60 cursor-pointer touch-none select-none"
        style={{ gridTemplateColumns: cols }}
        role="group"
        aria-label="Lobby range bar"
      >
        {set ? (
          <div
            role="slider"
            tabIndex={0}
            aria-label="Lobby range bar — drag to move, shift+arrow to resize"
            aria-valuemin={first}
            aria-valuemax={last}
            aria-valuenow={low!}
            aria-valuetext={`${rankLabel(low!)} to ${rankLabel(high!)}`}
            onKeyDown={onKeyDown}
            data-drag-role="bar"
            data-inspect-id="lobby-range-slider-bar"
            className="rank-lamp relative h-2.5 rounded-full cursor-grab active:cursor-grabbing focus:outline-none focus:ring-2 focus:ring-ow-blue/70"
            style={{ gridColumn: `${loIdx + 1} / span ${hiIdx - loIdx + 1}` }}
          >
            {/* Triangles pointing outward, away from the bar: the shape says
                which way to pull. The grab targets are deliberately larger
                than the triangles they draw — a 10px arrowhead is a miss on a
                trackpad. The outer span is what the pointer has to hit; the
                inner one is only the picture. */}
            {/* The spill: light leaving the lamp upward, into the gap below
                the glass. Without it the bar and the boxes read as two
                separate things that happen to share a colour. */}
            <span
              aria-hidden="true"
              className="rank-spill pointer-events-none absolute -top-2 left-0 right-0 h-2"
            />
            <span
              data-drag-role="low"
              data-inspect-id="lobby-range-slider-handle-low"
              className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-[70%] w-6 h-6 grid place-items-center cursor-ew-resize"
              aria-hidden="true"
            >
              <span
                className="rank-handle w-2.5 h-3.5"
                style={{ clipPath: 'polygon(100% 0, 100% 100%, 0 50%)' }}
              />
            </span>
            <span
              data-drag-role="high"
              data-inspect-id="lobby-range-slider-handle-high"
              className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-[70%] w-6 h-6 grid place-items-center cursor-ew-resize"
              aria-hidden="true"
            >
              <span
                className="rank-handle w-2.5 h-3.5"
                style={{ clipPath: 'polygon(0 0, 0 100%, 100% 50%)' }}
              />
            </span>
          </div>
        ) : (
          <span
            className="col-span-full text-center text-[10px] text-[var(--faint-2)] pointer-events-none"
          >
            press here to place the bar
          </span>
        )}
      </div>
    </div>
  );
}

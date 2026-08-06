import { useEffect, useRef, useState } from 'react';

interface Props {
  value: number;
  decimals?: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  /** Count up from 0 on first mount (decorative load-in). Default false so the
   *  page doesn't animate wholesale on load — animation is reserved for the
   *  value changing (e.g. a win rate updating after a match is logged). */
  animateOnMount?: boolean;
}

const reduceMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A number that tweens to its target instead of snapping. The key use is win
 * rates: after a match is logged the data refetches in place, the value prop
 * changes, and the figure rolls from its old value to the new one.
 *
 * Renders a bare inline span with tabular figures (so the width doesn't jitter
 * while counting) and adds NO color/transform/filter of its own — these usually
 * sit inside a `bg-clip-text` gradient parent, and an inner element with its own
 * background or transform would break that clip and blank the number out.
 */
export default function AnimatedNumber({
  value,
  decimals = 0,
  duration = 750,
  prefix = '',
  suffix = '',
  animateOnMount = false,
}: Props) {
  const [display, setDisplay] = useState(animateOnMount ? 0 : value);
  const fromRef = useRef(animateOnMount ? 0 : value);
  const rafRef = useRef<number>();

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;

    if (reduceMotion()) {
      setDisplay(to);
      fromRef.current = to;
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(from + (to - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [value, duration]);

  const factor = Math.pow(10, decimals);
  const shown = (Math.round(display * factor) / factor).toFixed(decimals);

  return <span data-inspect-id="animatedNumber-span" style={{ fontVariantNumeric: 'tabular-nums' }}>{prefix}{shown}{suffix}</span>;
}

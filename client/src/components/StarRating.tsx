import { useId } from 'react';

interface Props {
  value: number; // 0–5, in 0.5 steps
  onChange: (v: number) => void;
  dataInspectId?: string;
}

const STAR_COUNT = 5;
const STAR_PATH = 'M12 2l2.9 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 7.1-1.01L12 2z';

// Each star is two stacked half-width buttons over one SVG, so a click on the
// left/right half rates X.5/X stars respectively — no drag or keyboard-only
// fallback needed since the whole star surface is clickable.
export default function StarRating({ value, onChange, dataInspectId }: Props) {
  const uid = useId();
  return (
    <div className="flex w-full justify-between" data-inspect-id={dataInspectId} role="radiogroup" aria-label="Star rating">
      {Array.from({ length: STAR_COUNT }, (_, i) => {
        const starIndex = i + 1;
        const fillPct = value >= starIndex ? 100 : value >= starIndex - 0.5 ? 50 : 0;
        const gradientId = `star-fill-${uid}-${i}`;
        return (
          <div key={i} className="relative w-7 h-7">
            <button
              type="button"
              aria-label={`${starIndex - 0.5} stars`}
              onClick={() => onChange(starIndex - 0.5)}
              className="absolute inset-y-0 left-0 w-1/2 z-10"
            />
            <button
              type="button"
              aria-label={`${starIndex} stars`}
              onClick={() => onChange(starIndex)}
              className="absolute inset-y-0 right-0 w-1/2 z-10"
            />
            <svg viewBox="0 0 24 24" className="w-7 h-7 pointer-events-none text-ow-accent">
              <defs>
                <linearGradient id={gradientId}>
                  <stop offset={`${fillPct}%`} stopColor="currentColor" />
                  <stop offset={`${fillPct}%`} stopColor="transparent" />
                </linearGradient>
              </defs>
              <path d={STAR_PATH} fill={`url(#${gradientId})`} stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
            </svg>
          </div>
        );
      })}
    </div>
  );
}

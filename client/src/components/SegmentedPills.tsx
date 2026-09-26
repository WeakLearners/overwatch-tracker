import type { ReactNode } from 'react';

// The "Playing as" segmented pill row, shared (2026-09-26) so the Dashboard's
// section nav can wear the same style. Originally inline in Prematch.tsx as
// identityGroup; the comments below travelled with it.
//
// Three things make the slide exact rather than approximate:
//   - auto-cols-fr gives every option the same width, so step N is always
//     N x 100% of the indicator's own width. No measuring, no refs, nothing
//     to re-read on resize.
//   - no gap between options. A gap is not part of that 100%, so the
//     indicator would drift further out of register with each step.
//   - the indicator carries the border and .is-selected; the buttons carry
//     only text. Two elements painting a border would double it mid-slide.
export const NOTCH = 'polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px)';

export default function SegmentedPills<T extends string>({
  options, value, onPick, sel, inspectId, idFor, titleFor, labelFor, sizeLabels,
}: {
  options: readonly T[];
  /** null lights nothing (the indicator hides). */
  value: T | null;
  onPick: (v: T) => void;
  /** "r g b" for the lit block's --sel; undefined keeps the default accent. */
  sel?: string;
  inspectId: string;
  idFor: (v: T) => string;
  titleFor: (v: T) => string;
  labelFor?: (v: T) => string;
  /** Every label stacked invisibly in each button, so every button is as wide
   *  as the widest of these. Defaults to this group's own labels. */
  sizeLabels?: readonly string[];
}) {
  const label = labelFor ?? ((v: T) => v);
  const sizes = sizeLabels ?? options.map(label);
  const i = value == null ? -1 : options.indexOf(value);
  return (
    // The group sits 3px inboard of the strip, and the lit block reaches back
    // out to the strip's own edge. Net effect: the selected option stands 6px
    // taller than its neighbours and meets the card border, which is what
    // reads as raised. It CANNOT overhang the border: .card carries a
    // clip-path for its notched corner, and a clip-path cuts its descendants,
    // so anything past the edge is silently sliced off.
    <div className="relative grid grid-flow-col auto-cols-fr my-[3px]" data-inspect-id={inspectId}>
      {i >= 0 && (
        <span
          aria-hidden="true"
          className="is-selected mode-fill absolute -inset-y-[3px] left-0 border-2 pointer-events-none transition-[transform,background-color,border-color,box-shadow] duration-200 ease-out motion-reduce:transition-none"
          style={{
            width: `${100 / options.length}%`,
            transform: `translateX(${i * 100}%)`,
            clipPath: NOTCH,
            ...(sel ? ({ '--sel': sel } as React.CSSProperties) : {}),
          }}
        />
      )}
      {options.map(o => (
        <button
          key={o}
          type="button"
          onClick={() => onPick(o)}
          aria-pressed={value === o}
          title={titleFor(o)}
          data-inspect-id={idFor(o)}
          style={value === o && sel ? ({ '--sel': sel } as React.CSSProperties) : undefined}
          className={`relative z-10 px-3 flex items-center justify-center text-xs leading-none font-semibold tracking-wide transition-colors ${
            value === o ? 'text-[var(--ink)]' : 'text-[var(--faint)] hover:text-[var(--ink)]'
          }`}
        >
          <SizedLabel sizes={sizes}>
            {value === o ? <span className="lit-text">{label(o)}</span> : label(o)}
          </SizedLabel>
        </button>
      ))}
    </div>
  );
}

function SizedLabel({ sizes, children }: { sizes: readonly string[]; children: ReactNode }) {
  return (
    <span className="grid justify-items-center">
      {sizes.map(l => (
        <span key={l} aria-hidden="true" className="invisible col-start-1 row-start-1">{l}</span>
      ))}
      <span className="col-start-1 row-start-1">{children}</span>
    </span>
  );
}

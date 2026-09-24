import React from 'react';
import { QueueMode, ModeWatermarkVariant, QUEUE_MODE_COLORS, MODE_TAG, MODE_TAG_CLS } from '../types';

// Big centred italic mode tag (QP / V5 / V6) used as faint background lettering
// behind logged-match strips and the mode selectors. The parent must be
// `relative overflow-hidden`, and foreground content should sit on `relative z-10`
// so it paints above this absolutely-positioned (and thus higher-painting) span.
// `variant` picks the size/position config (see MODE_TAG_CLS) so each context tunes
// independently; `className` adds per-call extras (e.g. the dashboard's scale).
// Weight is also set per variant/mode in MODE_TAG_CLS (not hardcoded here) so a
// single mode's boldness can be dialed differently per context without a second
// font-weight utility landing on the same element and racing this one for
// cascade order.
// `lit` gives the tag .lit-text (brightest at the tile's glowing bottom edge,
// falling off upward) for a selected mode tile, at 1.5x the usual 15%
// opacity so the gradient reads. The colour class is dropped
// when lit, because a Tailwind text colour would paint over the gradient.
export default function ModeWatermark({ mode, variant, className = '', color, style, lit = false }: { mode: QueueMode; variant: ModeWatermarkVariant; className?: string; color?: string; style?: React.CSSProperties; lit?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={style}
      data-inspect-id="modeWatermark-tag"
      className={`pointer-events-none select-none absolute inset-0 flex items-center justify-center num-display italic leading-none tracking-[-0.07em] ${lit ? 'opacity-[0.225]' : 'opacity-15'} ${MODE_TAG_CLS[variant][mode]} ${lit ? 'lit-text' : (color ?? QUEUE_MODE_COLORS[mode].accent)} ${className}`}
    >
      {MODE_TAG[mode]}
    </span>
  );
}

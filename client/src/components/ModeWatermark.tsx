import React from 'react';
import { QueueMode, ModeWatermarkVariant, QUEUE_MODE_COLORS, MODE_TAG, MODE_TAG_CLS } from '../types';

// Big centred italic mode tag (QP / V5 / V6) used as faint background lettering
// behind logged-match strips and the mode selectors. The parent must be
// `relative overflow-hidden`, and foreground content should sit on `relative z-10`
// so it paints above this absolutely-positioned (and thus higher-painting) span.
// `variant` picks the size/position config (see MODE_TAG_CLS) so each context tunes
// independently; `className` adds per-call extras (e.g. the dashboard's scale).
export default function ModeWatermark({ mode, variant, className = '', color, style }: { mode: QueueMode; variant: ModeWatermarkVariant; className?: string; color?: string; style?: React.CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      style={style}
      data-inspect-id="modeWatermark-tag"
      className={`pointer-events-none select-none absolute inset-0 flex items-center justify-center font-display font-black italic leading-none tracking-[-0.07em] opacity-15 ${MODE_TAG_CLS[variant][mode]} ${color ?? QUEUE_MODE_COLORS[mode].accent} ${className}`}
    >
      {MODE_TAG[mode]}
    </span>
  );
}

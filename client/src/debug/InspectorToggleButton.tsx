import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type Props = { enabled: boolean; onToggle: () => void };

// Renders into the header's #header-inspector-slot (App.tsx), beside the
// settings and theme buttons, with their chamfered tile look. The slot is
// looked up after mount because the header and the overlay commit together.
export default function InspectorToggleButton({ enabled, onToggle }: Props) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setSlot(document.getElementById('header-inspector-slot')); }, []);
  if (!slot) return null;
  return createPortal(
    <button
      type="button"
      onClick={onToggle}
      aria-label="Toggle inspector mode"
      title="Toggle inspector mode — hover a UI element, click to compose a Claude prompt for it"
      className={`w-9 h-9 shrink-0 grid place-items-center border transition-all ${
        enabled
          ? 'bg-ow-accent border-ow-accent text-white'
          : 'bg-ow-card border-ow-border text-[var(--ink-2)] hover:text-ow-accent'
      }`}
      style={{ clipPath: 'polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)' }}
    >
      ⌖
    </button>,
    slot,
  );
}

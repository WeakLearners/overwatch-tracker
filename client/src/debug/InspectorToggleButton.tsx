import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { INSPECTOR_SLOT_EVENT, ToolLit } from '../components/AppTools';
import { ACCENT_SEL } from '../components/SegmentedPills';

type Props = { enabled: boolean; onToggle: () => void };

// Renders into #header-inspector-slot inside AppTools, beside the settings
// and theme buttons. AppTools lives in the Dashboard's section nav on the
// Dashboard and in the header elsewhere (2026-09-26), so the slot moves with
// the route; AppTools fires INSPECTOR_SLOT_EVENT on mount/unmount and this
// re-finds it.
export default function InspectorToggleButton({ enabled, onToggle }: Props) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => setSlot(document.getElementById('header-inspector-slot'));
    find();
    // Unmount fires before the next AppTools mounts, so defer one tick.
    const onChange = () => setTimeout(find, 0);
    window.addEventListener(INSPECTOR_SLOT_EVENT, onChange);
    return () => window.removeEventListener(INSPECTOR_SLOT_EVENT, onChange);
  }, []);
  if (!slot) return null;
  return createPortal(
    <button
      type="button"
      onClick={onToggle}
      aria-label="Toggle inspector mode"
      data-inspector-toggle=""
      aria-pressed={enabled}
      title="Toggle inspector mode — hover a UI element, click to compose a Claude prompt for it"
      className={`relative px-4 flex items-center justify-center text-base leading-none transition-colors ${
        enabled ? 'text-[var(--ink)]' : 'text-[var(--faint)] hover:text-[var(--ink)]'
      }`}
    >
      {enabled && <ToolLit />}
      <span className={`relative z-10 ${enabled ? 'lit-text' : ''}`} style={{ '--sel': ACCENT_SEL } as React.CSSProperties}>⌖</span>
    </button>,
    slot,
  );
}

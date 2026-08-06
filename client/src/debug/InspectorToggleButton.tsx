type Props = { enabled: boolean; onToggle: () => void };

export default function InspectorToggleButton({ enabled, onToggle }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label="Toggle inspector mode"
      title="Toggle inspector mode — hover a UI element, click to compose a Claude prompt for it"
      className={`fixed bottom-3 left-3 z-[9998] w-9 h-9 rounded-full grid place-items-center border shadow-sm transition-all ${
        enabled
          ? 'bg-ow-accent border-ow-accent text-white'
          : 'bg-ow-card border-ow-border text-[var(--ink-2)] hover:text-ow-accent hover:-translate-y-0.5'
      }`}
    >
      ⌖
    </button>
  );
}

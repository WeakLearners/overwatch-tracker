// Fixed strip on the static demo build only. `import.meta.env.VITE_DEMO` is a
// build-time constant, so the normal build drops this component entirely.
export default function DemoBanner() {
  if (import.meta.env.VITE_DEMO !== '1') return null;
  return (
    <div className="fixed bottom-0 inset-x-0 z-50 text-center text-xs py-1 pointer-events-none select-none border-t border-ow-border"
      style={{ backgroundColor: 'var(--surface)' }}>
      Read-only demo with made-up matches. Nothing here is saved.
    </div>
  );
}

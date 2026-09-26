// Tells Sean at a glance which server he's looking at (2026-09-26): the Vite
// dev server (5173, for editing) now looks visually different from the
// always-on production build (3001, for daily use) so a stray tab never gets
// mistaken for the other. `import.meta.env.DEV` is a build-time constant —
// Vite's production build (`vite build`, what scripts/build-client.sh runs)
// replaces it with the literal `false` and dead-code-eliminates this
// component's body entirely, so port 3001 can never render it no matter what
// runs there.
//
// Styled to match ModeWatermark.tsx's existing "big faint background
// lettering" convention exactly (same face, same italic, same opacity family)
// rather than inventing a second watermark look. Unlike ModeWatermark, this
// one is viewport-fixed (not absolute inside one card) since it has to read
// as a whole-app state, not a per-card tag — mounted once at the App root, in
// front of the page background but behind every card via z-index, pointer-
// events and text selection both switched off so it never intercepts a click
// or a drag-select.
export default function DevWatermark() {
  if (!import.meta.env.DEV) return null;
  return (
    <div
      aria-hidden="true"
      data-inspect-id="dev-watermark"
      className="fixed inset-0 z-0 flex items-center justify-center overflow-hidden pointer-events-none select-none"
    >
      <span
        className="num-display italic leading-none tracking-[-0.07em] opacity-[0.07]"
        style={{ color: 'var(--ink)', fontSize: '22vw' }}
      >
        DEV
      </span>
    </div>
  );
}

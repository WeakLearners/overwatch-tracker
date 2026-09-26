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
      {/* An svg whose text is stretched to the viewBox width (textLength), then
          scaled uniformly (default preserveAspectRatio, never "none") to the
          viewport width — so the word spans edge to edge at any window size
          without distorting the letters, and shows in the gaps between cards. */}
      <svg viewBox="0 0 1000 160" className="w-full opacity-[0.07]">
        <text
          x="0"
          y="145"
          textLength="1000"
          lengthAdjust="spacingAndGlyphs"
          className="num-display italic"
          style={{ fill: 'var(--ink)', fontSize: 180 }}
        >
          DEVELOPMENT
        </text>
      </svg>
    </div>
  );
}

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
const WORD = 'DEVELOPMENT';
// Row r is WORD rotated left by r letters, so every row reads DEVELOPMENT
// wrapped around and every column does too, top to bottom. The left edge
// column reads it exactly; that's the gutter between the viewport edge and
// the cards, where the watermark is actually visible. One letter per grid
// cell (not a text run) so the columns line up regardless of glyph widths.
const ROWS = Array.from({ length: WORD.length }, (_, r) => WORD.slice(r) + WORD.slice(0, r));

export default function DevWatermark() {
  if (!import.meta.env.DEV) return null;
  return (
    <div
      aria-hidden="true"
      data-inspect-id="dev-watermark"
      className="fixed inset-0 z-0 grid overflow-hidden pointer-events-none select-none opacity-[0.12]"
      style={{ gridTemplateColumns: `repeat(${WORD.length}, 1fr)`, gridTemplateRows: `repeat(${WORD.length}, 1fr)` }}
    >
      {ROWS.flatMap((row, r) => [...row].map((ch, c) => (
        <span
          key={`${r}-${c}`}
          className="num-display italic font-black leading-none flex items-center justify-center"
          style={{ color: 'var(--gauge-empty)', fontSize: 'min(13vh, 14vw)' }}
        >
          {ch}
        </span>
      )))}
    </div>
  );
}

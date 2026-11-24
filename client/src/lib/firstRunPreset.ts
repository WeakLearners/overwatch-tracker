// When the first-run preset screen shows. Kept apart from the component so a
// test can check the rule without a browser. The screen shows only while the
// owner has no saved setup (the server says so with `needsPreset`), only when
// the server sent presets to pick from, and never in the static demo build.
export function showFirstRunPreset(s: {
  demo: boolean;
  loading: boolean;
  needsPreset: boolean;
  presetCount: number;
}): boolean {
  if (s.demo || s.loading) return false;
  return s.needsPreset && s.presetCount > 0;
}

// One URL path per Dashboard section. '/' is the top of the page.
export const SECTION_PATHS: Record<string, string> = {
  'sec-form': '/form',
  'sec-mode': '/mode',
  'sec-match': '/match',
  'sec-trends': '/trends',
  'sec-career': '/career',
};
// Older aliases that land on a section.
const ALIASES: Record<string, string> = { '/prematch': 'sec-match', '/log': 'sec-match' };
export const DASHBOARD_PATHS = ['/', ...Object.values(SECTION_PATHS), ...Object.keys(ALIASES)];

/** The element id to scroll to for a location. Path first, then an old #sec-* hash. */
export function sectionFor(pathname: string, hash: string): string | null {
  const byPath = Object.keys(SECTION_PATHS).find(id => SECTION_PATHS[id] === pathname) ?? ALIASES[pathname];
  if (byPath) return byPath;
  return hash.startsWith('#sec-') ? hash.slice(1) : null;
}

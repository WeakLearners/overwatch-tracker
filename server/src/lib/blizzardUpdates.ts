// "Check for game updates": read Blizzard's public pages and diff them against
// server/data/roster.json and seasons.json. Called only from the button's
// route (routes/roster.ts) — nothing in the app polls Blizzard. This file
// never writes; applying a diff is a separate, confirmed request.
import { Roster, RosterHero, RosterMap, MAP_MODES } from './roster';
import { Season } from './seasons';

export const BLIZZARD_URLS = {
  heroes: 'https://overwatch.blizzard.com/en-us/heroes/',
  rates: 'https://overwatch.blizzard.com/en-us/rates/',
  maps: 'https://overwatch.blizzard.com/en-us/maps/',
};

export class LayoutChangedError extends Error {
  constructor(public page: string, detail: string) {
    super(`Blizzard page layout changed — no updates read (${page}: ${detail})`);
  }
}

const decode = (s: string) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// Compare names ignoring case, accents and punctuation ("Esperança" = "Esperanca").
export const nameKey = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const ROLE_FROM_PAGE: Record<string, string> = { damage: 'DPS', tank: 'Tank', support: 'Support' };

export interface ParsedHero { name: string; role: string | null }
export interface ParsedMap { name: string; mode: string | null }

// Hero cards: <a class="hero-card" data-role="damage" ...> ... <h2 slot="heading">Name</h2>
export function parseHeroes(html: string): ParsedHero[] {
  const out: ParsedHero[] = [];
  const re = /<a\s[^>]*class="hero-card"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const name = /<h2[^>]*slot="heading"[^>]*>([^<]+)<\/h2>/.exec(m[1])?.[1];
    if (!name) continue;
    const role = /data-role="([^"]+)"/.exec(tag)?.[1] ?? '';
    out.push({ name: decode(name).trim(), role: ROLE_FROM_PAGE[role] ?? null });
  }
  if (out.length < 20) throw new LayoutChangedError('heroes', `found ${out.length} hero cards`);
  return out;
}

// Portrait URL for each hero card (the card's <blz-image class="heroCardPortrait" src=...>).
// Decoration images on the page (role icons, card backgrounds) are never read.
export function parsePortraits(html: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  const re = /<a\s[^>]*class="hero-card"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = /<h2[^>]*slot="heading"[^>]*>([^<]+)<\/h2>/.exec(m[1])?.[1];
    const url = /class="heroCardPortrait"[^>]*\ssrc="([^"]+)"/.exec(m[1])?.[1];
    if (name && url) out.push({ name: decode(name).trim(), url: decode(url) });
  }
  return out;
}

// Rates page: <select id="filter-map-select"> with an <optgroup label="Mode"> per mode.
export function parseMaps(html: string): ParsedMap[] {
  const sel = /id="filter-map-select"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
  if (!sel) throw new LayoutChangedError('rates', 'no map select');
  const out: ParsedMap[] = [];
  const groupRe = /<optgroup[^>]*label="([^"]+)"[^>]*>([\s\S]*?)<\/optgroup>/g;
  let g: RegExpExecArray | null;
  while ((g = groupRe.exec(sel))) {
    const mode = decode(g[1]);
    const optRe = /<option[^>]*data-title="([^"]+)"[^>]*>/g;
    let o: RegExpExecArray | null;
    while ((o = optRe.exec(g[2]))) out.push({ name: decode(o[1]), mode: MAP_MODES.includes(mode) ? mode : null });
  }
  if (out.length < 10) throw new LayoutChangedError('rates', `found ${out.length} maps`);
  return out;
}

// The home page (the maps URL redirects there) names the live season in its
// news cards and season banner: "Season 5: A Grim Doctrine". Highest number wins.
export function parseSeason(html: string): { number: number; name: string } | null {
  let best: { number: number; name: string } | null = null;
  const re = /Season (\d{1,2}): ([^<"]{2,60})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const number = parseInt(m[1], 10);
    if (!best || number > best.number) best = { number, name: decode(m[2]).trim() };
  }
  return best;
}

export interface UpdateDiff {
  checkedAt: string;
  counts: { heroesOnPage: number; mapsOnPage: number; heroesKnown: number; mapsKnown: number };
  newHeroes: { name: string; role: string | null }[];   // role from the page's data-role; null if unreadable
  newMaps: { name: string; mode: string | null }[];
  absentMaps: string[];                                  // in roster.json (not retired), not in Blizzard's rates list
  newSeason: { label: string; name: string; start: string } | null;
  season: { onPage: string | null; known: string | null };
  /** Roster heroes with no cached portrait; null when Blizzard images are off. */
  imagesMissing: number | null;
}

export function buildDiff(
  roster: Roster, seasons: Season[],
  page: { heroes: ParsedHero[]; maps: ParsedMap[]; season: { number: number; name: string } | null },
  today: string,
  imagesMissing: number | null = null,
): UpdateDiff {
  const knownHeroes = new Set(roster.heroes.map(h => nameKey(h.name)));
  const knownMaps = new Set(roster.maps.map(m => nameKey(m.name)));
  const mapsOnPage = new Set(page.maps.map(m => nameKey(m.name)));

  const latest = seasons[seasons.length - 1];
  const known = latest ? /S(\d+)$/.exec(latest.label) : null;
  const knownNumber = known ? parseInt(known[1], 10) : null;
  let newSeason: UpdateDiff['newSeason'] = null;
  if (page.season && page.season.number !== knownNumber) {
    const label = `${today.slice(0, 4)} S${page.season.number}`;
    if (!seasons.some(s => s.label === label)) newSeason = { label, name: page.season.name, start: today };
  }
  return {
    checkedAt: new Date().toISOString(),
    counts: { heroesOnPage: page.heroes.length, mapsOnPage: page.maps.length, heroesKnown: roster.heroes.length, mapsKnown: roster.maps.length },
    newHeroes: page.heroes.filter(h => !knownHeroes.has(nameKey(h.name))),
    newMaps: page.maps.filter(m => !knownMaps.has(nameKey(m.name))),
    absentMaps: roster.maps.filter(m => !m.retired && !mapsOnPage.has(nameKey(m.name))).map(m => m.name),
    newSeason,
    imagesMissing,
    season: { onPage: page.season ? `Season ${page.season.number}: ${page.season.name}` : null, known: latest?.label ?? null },
  };
}

export type Fetcher = (url: string) => Promise<string>;

export const defaultFetcher: Fetcher = async url => {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (overwatch-tracker roster check)' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.text();
};

// Reads all three pages before returning anything; any parse failure throws
// and the caller reports it — a partial result is never produced.
export async function checkForUpdates(roster: Roster, seasons: Season[], today: string, fetcher: Fetcher = defaultFetcher, imagesMissing: number | null = null): Promise<UpdateDiff> {
  const [heroesHtml, ratesHtml, mapsHtml] = await Promise.all([
    fetcher(BLIZZARD_URLS.heroes), fetcher(BLIZZARD_URLS.rates), fetcher(BLIZZARD_URLS.maps),
  ]);
  return buildDiff(roster, seasons, { heroes: parseHeroes(heroesHtml), maps: parseMaps(ratesHtml), season: parseSeason(mapsHtml) }, today, imagesMissing);
}

export type { RosterHero, RosterMap };

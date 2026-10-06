import { Router, Request, Response } from 'express';
import { readRoster, writeRoster, ROLES, MAP_MODES } from '../lib/roster';
import { SEASONS, appendSeason } from '../lib/seasons';
import { checkForUpdates, LayoutChangedError, nameKey, Fetcher, parsePortraits, BLIZZARD_URLS, defaultFetcher } from '../lib/blizzardUpdates';
import { imagesEnabled, cachedHeroKeys, missingHeroImages, downloadHeroImages, BinaryFetcher, defaultBinaryFetcher } from '../lib/assets';

// Roster and season reference data, plus the "Check for game updates" button.
// GET / is what the client loads at startup. POST /check is the ONLY code path
// that calls Blizzard, and it never writes. POST /apply writes the JSON files,
// from exactly the items the user ticked.
const router = Router();

// Test seam: tests swap the fetcher so no test touches the network.
let fetcher: Fetcher | undefined;
let binaryFetcher: BinaryFetcher | undefined;
export function setRosterFetcher(f: Fetcher | undefined, b?: BinaryFetcher) { fetcher = f; binaryFetcher = b; }

// What the client needs to show portraits: whether images are on, and which
// heroes have a cached file (keys are nameKey of the hero name).
const imageInfo = () => ({ enabled: imagesEnabled(), heroes: imagesEnabled() ? cachedHeroKeys() : [] });

const today = () => new Date().toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/', (_req: Request, res: Response) => {
  res.json({ ...readRoster(), seasons: SEASONS, images: imageInfo() });
});

router.post('/check', async (_req: Request, res: Response) => {
  try {
    const roster = readRoster();
    res.json(await checkForUpdates(roster, SEASONS, today(), fetcher, imagesEnabled() ? missingHeroImages(roster).length : null));
  } catch (e) {
    if (e instanceof LayoutChangedError) {
      res.status(502).json({ error: 'Blizzard page layout changed — no updates read', detail: e.message });
    } else {
      res.status(502).json({ error: `Could not reach Blizzard — no updates read`, detail: (e as Error).message });
    }
  }
});

// Body: { heroes?: [{name, role}], maps?: [{name, mode}], retireMaps?: string[],
//         season?: {label, start}, images?: boolean }. images:true also downloads
//         the missing hero portraits (the only other Blizzard call, same button). All-or-nothing: any invalid item rejects the
// whole request before anything is written.
router.post('/apply', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, any>;
  const roster = readRoster();
  const bad = (msg: string) => res.status(400).json({ error: msg });

  const heroKeys = new Set(roster.heroes.map(h => nameKey(h.name)));
  const mapKeys = new Set(roster.maps.map(m => nameKey(m.name)));
  const season = body.season as { label?: string; start?: string } | undefined;

  const newHeroes = [];
  for (const h of body.heroes ?? []) {
    const name = typeof h?.name === 'string' ? h.name.trim() : '';
    if (!name) return bad('A new hero needs a name.');
    if (!ROLES.includes(h.role)) return bad(`Pick a role for ${name}.`);
    if (heroKeys.has(nameKey(name))) return bad(`${name} is already in the roster.`);
    heroKeys.add(nameKey(name));
    newHeroes.push({ name, role: h.role as string, addedSeason: (season?.label ?? SEASONS[SEASONS.length - 1]?.label) ?? null });
  }
  const newMaps = [];
  for (const m of body.maps ?? []) {
    const name = typeof m?.name === 'string' ? m.name.trim() : '';
    if (!name) return bad('A new map needs a name.');
    if (!MAP_MODES.includes(m.mode)) return bad(`Pick a mode for ${name}.`);
    if (mapKeys.has(nameKey(name))) return bad(`${name} is already in the roster.`);
    mapKeys.add(nameKey(name));
    newMaps.push({ name, short: name, mode: m.mode as string, retired: false });
  }
  const retire = new Set<string>(body.retireMaps ?? []);
  for (const n of retire) if (!roster.maps.some(m => m.name === n)) return bad(`${n} is not a known map.`);
  if (season) {
    if (!season.label || !DATE.test(season.start ?? '')) return bad('A new season needs a label and a start date (YYYY-MM-DD).');
    const last = SEASONS[SEASONS.length - 1];
    if (SEASONS.some(s => s.label === season.label)) return bad(`${season.label} already exists.`);
    if (last && season.start! <= last.start) return bad(`The start date must be after ${last.label} starts (${last.start}).`);
  }

  roster.heroes.push(...newHeroes);
  roster.maps = [...roster.maps.map(m => (retire.has(m.name) ? { ...m, retired: true } : m)), ...newMaps];
  if (newHeroes.length || newMaps.length || retire.size) writeRoster(roster);
  if (season) appendSeason(season.label!, season.start!);
  let images = null;
  if (body.images === true && imagesEnabled()) {
    try {
      const html = await (fetcher ?? defaultFetcher)(BLIZZARD_URLS.heroes);
      images = await downloadHeroImages(readRoster(), parsePortraits(html), binaryFetcher ?? defaultBinaryFetcher);
    } catch (e) {
      images = { error: `Could not read portraits: ${(e as Error).message}` };
    }
  }
  res.json({ applied: { heroes: newHeroes.length, maps: newMaps.length, retired: retire.size, season: season?.label ?? null }, images, ...readRoster(), seasons: SEASONS, imageInfo: imageInfo() });
});

export default router;

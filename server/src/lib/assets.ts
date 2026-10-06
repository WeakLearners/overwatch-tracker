// Local cache of Blizzard hero portraits, filled only by the update button's
// apply step. Files live in server/data/assets/ — gitignored, because this repo
// is public and Blizzard art must never be committed. The client loads these
// from /assets/heroes/<key>.png on this server, never from Blizzard's CDN.
// A missing file or the off switch means "no image": the UI shows its text name.
import fs from 'fs';
import path from 'path';
import { dataDir } from './dataFiles';
import { nameKey } from './blizzardUpdates';
import type { Roster } from './roster';

// OW_BLIZZARD_IMAGES=off (or 0/false) turns every Blizzard image off: nothing is
// downloaded, listed or served, and the app shows text only.
export function imagesEnabled(): boolean {
  return !/^(off|0|false|no)$/i.test((process.env.OW_BLIZZARD_IMAGES ?? '').trim());
}

export const heroesAssetDir = () => path.join(dataDir(), 'assets', 'heroes');

export function cachedHeroKeys(): string[] {
  try {
    return fs.readdirSync(heroesAssetDir()).filter(f => f.endsWith('.png')).map(f => f.slice(0, -4));
  } catch { return []; }
}

export function missingHeroImages(roster: Roster): string[] {
  const have = new Set(cachedHeroKeys());
  return roster.heroes.filter(h => !have.has(nameKey(h.name))).map(h => h.name);
}

// Only Blizzard's own image hosts, over https.
const HOSTS = new Set(['d15f34w2p8l1cc.cloudfront.net', 'blz-contentstack-images.akamaized.net', 'images.blz-contentstack.com']);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const MAX_BYTES = 3_000_000;

export type BinaryFetcher = (url: string) => Promise<Buffer>;
export const defaultBinaryFetcher: BinaryFetcher = async url => {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (overwatch-tracker roster check)' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!(res.headers.get('content-type') ?? '').startsWith('image/')) throw new Error('not an image');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('too large');
  return buf;
};

export interface ImageResult { matched: number; total: number; downloaded: number; failed: string[]; unmatched: string[] }

// Download a portrait for each roster hero that has none yet. `portraits` is
// the page's own list (key = nameKey of the card's name). Never throws for one
// bad image; the failures are reported and the rest are kept.
export async function downloadHeroImages(
  roster: Roster, portraits: { name: string; url: string }[], fetcher: BinaryFetcher = defaultBinaryFetcher,
): Promise<ImageResult> {
  if (!imagesEnabled()) return { matched: 0, total: roster.heroes.length, downloaded: 0, failed: [], unmatched: [] };
  const byKey = new Map(portraits.map(p => [nameKey(p.name), p.url]));
  const dir = heroesAssetDir();
  fs.mkdirSync(dir, { recursive: true });
  const have = new Set(cachedHeroKeys());
  const result: ImageResult = { matched: 0, total: roster.heroes.length, downloaded: 0, failed: [], unmatched: [] };
  const todo: { name: string; key: string; url: string }[] = [];
  for (const h of roster.heroes) {
    const key = nameKey(h.name);
    const url = byKey.get(key);
    if (!url) { if (!have.has(key)) result.unmatched.push(h.name); else result.matched++; continue; }
    result.matched++;
    if (!have.has(key)) todo.push({ name: h.name, key, url });
  }
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const t = todo[i++];
      try {
        const u = new URL(t.url);
        if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) throw new Error('host not allowed');
        const buf = await fetcher(t.url);
        if (!buf.subarray(0, 4).equals(PNG)) throw new Error('not a PNG');
        const file = path.join(dir, `${t.key}.png`);
        fs.writeFileSync(file + '.tmp', buf);
        fs.renameSync(file + '.tmp', file);
        result.downloaded++;
      } catch { result.failed.push(t.name); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return result;
}

import { useState } from 'react';
import { heroImageUrl } from '../lib/roster';

/** A hero portrait beside a hero's name. Renders nothing when images are off,
 * the file is not cached, or it fails to load — the text name next to it is
 * always the real label, so a fresh clone looks exactly as it did before. The
 * image is served by this app's own /assets route, never by Blizzard's CDN. */
export default function HeroIcon({ hero, size = 20, inspectId }: { hero: string; size?: number; inspectId?: string }) {
  const url = heroImageUrl(hero);
  const [failed, setFailed] = useState(false);
  if (!url || failed) return null;
  return (
    <img
      src={url} alt="" width={size} height={size} loading="lazy"
      data-inspect-id={inspectId}
      onError={() => setFailed(true)}
      className="shrink-0 rounded-sm object-cover bg-ow-card"
      style={{ width: size, height: size }}
    />
  );
}

import { useState } from 'react';
import { heroImageUrl } from '../lib/roster';

/** Hero portrait as a card background. Put it as the first child of a card that
 * has `relative isolate`. It sits behind the content (z -1), fades to nothing on
 * the text side (left), and renders NOTHING when images are off, the file is not
 * cached, or it fails to load, so the card looks exactly as it did before. */
export default function HeroPortraitBg({ hero, opacity = 0.32, inspectId, position = '50% 20%' }: { hero: string | null | undefined; opacity?: number; inspectId?: string; position?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = hero ? heroImageUrl(hero) : null;
  if (!url || failed === url) return null;
  return (
    <div aria-hidden data-inspect-id={inspectId} className="absolute inset-0 -z-10 pointer-events-none overflow-hidden rounded-[inherit]">
      <img
        src={url} alt="" loading="lazy" onError={() => setFailed(url)}
        className="absolute right-0 top-0 h-full w-3/5 object-cover"
        style={{
          opacity,
          objectPosition: position,
          WebkitMaskImage: 'linear-gradient(to right, transparent, #000 70%)',
          maskImage: 'linear-gradient(to right, transparent, #000 70%)',
        }}
      />
    </div>
  );
}

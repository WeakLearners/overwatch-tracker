import { useSyncExternalStore, type ReactNode } from 'react';
import { heroImageUrl } from '../lib/roster';

/** Hero portrait as a card background. Put it as the first child of a card that
 * has `relative isolate`. It sits behind the content (z -1), fades to nothing on
 * the text side (left), and renders NOTHING when images are off, the file is not
 * cached, or it fails to load, so the card looks exactly as it did before. */
// Failed portrait URLs, shared so the watermark fallback and the image agree.
const failedUrls = new Set<string>();
const subs = new Set<() => void>();
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/** `url` is set while a portrait shows or loads; null when none can show. */
export function useHeroPortrait(hero: string | null | undefined) {
  const url = hero ? heroImageUrl(hero) : null;
  const failed = useSyncExternalStore(subscribe, () => (url ? failedUrls.has(url) : false));
  const onError = () => { if (url && !failedUrls.has(url)) { failedUrls.add(url); subs.forEach((f) => f()); } };
  return { url: failed ? null : url, onError };
}

/** Renders children (the A1/B1 watermark) only when no portrait shows or loads. */
export function PortraitFallback({ hero, children }: { hero: string | null | undefined; children: ReactNode }) {
  return useHeroPortrait(hero).url ? null : <>{children}</>;
}

export default function HeroPortraitBg({ hero, opacity = 0.32, inspectId, position = '50% 20%' }: { hero: string | null | undefined; opacity?: number; inspectId?: string; position?: string }) {
  const { url, onError } = useHeroPortrait(hero);
  if (!url) return null;
  return (
    <div aria-hidden data-inspect-id={inspectId} className="absolute inset-0 -z-10 pointer-events-none overflow-hidden rounded-[inherit]">
      <img
        src={url} alt="" loading="lazy" onError={onError}
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

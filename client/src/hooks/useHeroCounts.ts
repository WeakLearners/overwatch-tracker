import { format } from 'date-fns';
import { useApi } from './useApi';

// Today's per-hero match counts, keyed by hero name. Backs the "(N)" suffix
// shown next to every hero name in the UI.
export function useTodayHeroCounts(): Record<string, number> {
  const today = format(new Date(), 'yyyy-MM-dd');
  const { data } = useApi<{ counts: Record<string, number> }>(`/api/stats/hero-counts?date=${today}`);
  return data?.counts ?? {};
}

export function withHeroCount(hero: string, counts: Record<string, number>): string {
  const n = counts[hero] ?? 0;
  return n >= 1 ? `${hero} (${n})` : hero;
}

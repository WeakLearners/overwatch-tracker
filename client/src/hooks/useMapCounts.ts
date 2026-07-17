import { format } from 'date-fns';
import { useApi } from './useApi';

// Today's per-map match counts, keyed by map name. Backs the "(N)" suffix
// shown next to every map name in the UI.
export function useTodayMapCounts(): Record<string, number> {
  const today = format(new Date(), 'yyyy-MM-dd');
  const { data } = useApi<{ counts: Record<string, number> }>(`/api/stats/map-counts?date=${today}`);
  return data?.counts ?? {};
}

export function withMapCount(map: string, counts: Record<string, number>): string {
  const n = counts[map] ?? 0;
  return n >= 1 ? `${map} (${n})` : map;
}

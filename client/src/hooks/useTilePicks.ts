import { useMemo } from 'react';
import { useApi } from './useApi';
import { picksToLabels, type SlotKey } from '../lib/heroStatLabels';

/** Picked-tile labels per hero and slot, from the API. Goes through useApi, so revalidateAll() refreshes it. */
export function useTilePicks() {
  const { data } = useApi<{ picks: { hero: string; slot: SlotKey; label: string | null }[] }>('/api/scoreboards/tile-picks');
  return useMemo(() => picksToLabels(data?.picks ?? []), [data]);
}

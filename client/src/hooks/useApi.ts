import { useState, useEffect, useCallback } from 'react';

// Every mounted useApi subscribes here; revalidateAll() refetches them all.
// Call it after a mutation (e.g. logging a match) to refresh the whole page
// in place instead of reloading.
const listeners = new Set<() => void>();
export function revalidateAll() {
  listeners.forEach(fn => fn());
}

export function useApi<T>(url: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);

  useEffect(() => { refetch(); }, [refetch]);

  // Subscribe to global revalidation while mounted.
  useEffect(() => {
    listeners.add(refetch);
    return () => { listeners.delete(refetch); };
  }, [refetch]);

  return { data, loading, error, refetch };
}

import { createContext, useContext, useCallback, useState, useEffect, ReactNode } from 'react';

// Field registry Phase 1 (see projects/overwatch-analysis/modular-tracking-
// roadmap.md in the vault). This context never imports the server's
// registry — GET /config already denormalizes everything a settings page
// or a gated card needs (per-field `enabled`, per-category `locked`
// reasons) into its response, so the client has no registry logic of its
// own to keep in sync. The server is the enforcer; this context only
// displays what it says and calls PUT /config to request a change.

export interface CategoryMeta {
  id: string;
  label: string;
  description: string;
  alwaysOn?: boolean;
  hardDependsOn: string[];
}

export type FieldControl =
  | { kind: 'death-logger' }
  | { kind: 'star-rating'; max: number }
  | { kind: 'number'; min?: number; max?: number }
  | { kind: 'slider'; min: number; max: number }
  | { kind: 'select'; options: string[] }
  | { kind: 'toggle-pair'; options: string[] }
  | { kind: 'rank-outcome' }
  | { kind: 'text' };

// Mirrors server/src/lib/fieldRegistry.ts's `appliesTo` — mode/role tags
// added at Phase 2 kickoff (2026-09-24). Denormalized straight through by
// GET /api/config (buildConfigPayload spreads the whole FieldEntry), so
// this client type just needs to carry the shape; nothing reads it yet —
// the filter-settings screen that will is a later phase.
export interface FieldAppliesTo {
  modes?: ('qp_role' | 'comp_role' | 'comp_open')[];
  roles?: ('Tank' | 'DPS' | 'Support')[];
}

export interface FieldMeta {
  id: string;
  label: string;
  category: string;
  control: FieldControl;
  enabled: boolean;
  appliesTo?: FieldAppliesTo;
}

export interface LockedCategory {
  id: string;
  reason: string;
}

interface ConfigPayload {
  enabledCategories: string[];
  lockedCategories: LockedCategory[];
  categories: CategoryMeta[];
  fields: FieldMeta[];
}

interface FieldConfigCtx {
  loading: boolean;
  error: string | null;
  categories: CategoryMeta[];
  fields: FieldMeta[];
  enabledCategories: string[];
  lockedCategories: LockedCategory[];
  isCategoryEnabled: (id: string) => boolean;
  isCategoryLocked: (id: string) => LockedCategory | undefined;
  isFieldEnabled: (id: string) => boolean;
  // Sends the full desired non-core set. Throws with the server's message
  // on a 400/409 refusal so the settings page can show it inline.
  setCategoryEnabled: (id: string, on: boolean) => Promise<void>;
}

const EMPTY: ConfigPayload = { enabledCategories: ['core'], lockedCategories: [], categories: [], fields: [] };

const FieldConfigContext = createContext<FieldConfigCtx>({
  loading: true,
  error: null,
  categories: [],
  fields: [],
  enabledCategories: ['core'],
  lockedCategories: [],
  isCategoryEnabled: () => false,
  isCategoryLocked: () => undefined,
  isFieldEnabled: () => false,
  setCategoryEnabled: async () => {},
});

export function FieldConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ConfigPayload>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    return fetch('/api/config')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: ConfigPayload) => setConfig(data))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  const setCategoryEnabled = useCallback(async (id: string, on: boolean) => {
    const next = new Set(config.enabledCategories.filter(c => c !== 'core'));
    if (on) next.add(id); else next.delete(id);
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabledCategories: [...next] }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    setConfig(body);
  }, [config.enabledCategories]);

  const value: FieldConfigCtx = {
    loading,
    error,
    categories: config.categories,
    fields: config.fields,
    enabledCategories: config.enabledCategories,
    lockedCategories: config.lockedCategories,
    isCategoryEnabled: (id) => config.enabledCategories.includes(id),
    isCategoryLocked: (id) => config.lockedCategories.find(l => l.id === id),
    isFieldEnabled: (id) => config.fields.find(f => f.id === id)?.enabled ?? false,
    setCategoryEnabled,
  };

  return <FieldConfigContext.Provider value={value}>{children}</FieldConfigContext.Provider>;
}

export const useFieldConfig = () => useContext(FieldConfigContext);

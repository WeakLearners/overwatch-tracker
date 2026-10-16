import { useState } from 'react';
import { useFieldConfig } from '../contexts/FieldConfigContext';

// Phase 3 first-run screen. Shows only while the owner has no saved setup, so a
// user who already has a row never sees it. Each preset is a list of categories
// (server/src/lib/fieldRegistry.ts); Settings still changes them one by one.
// Never shown in the static demo, which has no server to save the choice.
export default function FirstRunPreset() {
  const { loading, needsPreset, presets, categories, choosePreset } = useFieldConfig();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (import.meta.env.VITE_DEMO === '1' || loading || !needsPreset || presets.length === 0) return null;

  const pick = async (id: string) => {
    setSaving(true);
    setError(null);
    try { await choosePreset(id); } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <div className="card mb-6 py-4 px-4" data-inspect-id="first-run-preset">
      <div className="text-sm text-[var(--ink)] font-bold">How much do you want to track?</div>
      <div className="text-xs text-[var(--faint)] mb-3">Pick a starting point. You can change it any time in Settings.</div>
      <div className="grid gap-2 sm:grid-cols-3">
        {presets.map(p => (
          <button
            key={p.id}
            type="button"
            disabled={saving}
            onClick={() => pick(p.id)}
            data-inspect-id="first-run-preset-option"
            className="chamfer-sm match-card-bg text-left px-3 py-3 border border-ow-border rounded-md hover:border-ow-accent disabled:opacity-60"
          >
            <div className="text-sm text-[var(--ink)] font-bold">{p.label}</div>
            <div className="text-xs text-[var(--faint)] mt-0.5">{p.description}</div>
            <div className="text-[10px] text-[var(--muted)] uppercase tracking-wider mt-2">
              {p.categories.map(id => categories.find(c => c.id === id)?.label ?? id).join(' · ')}
            </div>
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-red-500 mt-2" data-inspect-id="first-run-preset-error">{error}</p>}
    </div>
  );
}

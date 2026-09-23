import { useFieldConfig } from '../contexts/FieldConfigContext';
import PageHeader from '../components/PageHeader';

// Field registry Phase 1's settings page — one toggle per category (not per
// field; Sean's 2026-09-23 decision is that a category is the toggle unit).
// Deliberately plain: a checkbox list, no onboarding-preset polish — that's
// Phase 3. The server is the enforcer (dependency auto-enable, refused
// disable, the sens-study lock); this page only renders what GET /config
// says and reports back whatever PUT /config refuses with.
export default function Settings() {
  const { loading, error, categories, enabledCategories, lockedCategories, setCategoryEnabled } = useFieldConfig();

  if (loading) return <div className="max-w-2xl mx-auto px-4 pt-6" data-inspect-id="settings-loading">Loading…</div>;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-6 pb-10" data-inspect-id="settings-page">
      <PageHeader dataInspectId="settings-header" title="Settings" sub="Turn tracking categories on or off." />
      {error && (
        <p className="text-xs text-red-500 mb-3" data-inspect-id="settings-refusal-message">{error}</p>
      )}
      <div className="space-y-2" data-inspect-id="settings-category-list">
        {categories.map(cat => {
          const enabled = enabledCategories.includes(cat.id);
          const locked = lockedCategories.find(l => l.id === cat.id);
          const disabled = cat.alwaysOn || !!locked;
          return (
            <label
              key={cat.id}
              data-inspect-id="settings-category-row"
              className="card flex items-start gap-3 py-3 px-3 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={enabled}
                disabled={disabled}
                data-inspect-id="settings-category-checkbox"
                onChange={async (e) => {
                  try {
                    await setCategoryEnabled(cat.id, e.target.checked);
                  } catch {
                    // useFieldConfig already surfaced `error` from the failed
                    // PUT; nothing else to do here — the checkbox just stays
                    // at its last known-good state on the next render.
                  }
                }}
              />
              <div className="min-w-0">
                <div className="text-sm text-[var(--ink)] font-bold">{cat.label}</div>
                <div className="text-xs text-[var(--faint)]">{cat.description}</div>
                {cat.alwaysOn && (
                  <div className="text-xs text-[var(--faint-2)] mt-0.5" data-inspect-id="settings-always-on-note">Always on</div>
                )}
                {locked && (
                  <div className="text-xs text-ow-accent mt-0.5" data-inspect-id="settings-locked-reason">{locked.reason}</div>
                )}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

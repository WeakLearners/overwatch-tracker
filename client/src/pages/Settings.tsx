import { useFieldConfig } from '../contexts/FieldConfigContext';
import PageHeader from '../components/PageHeader';
import GameUpdateCheck from '../components/GameUpdateCheck';
import ScoreboardInbox from '../components/ScoreboardInbox';

// Field registry Phase 1's settings page — one toggle per category (not per
// field; Sean's 2026-09-23 decision is that a category is the toggle unit).
// Deliberately plain: a checkbox list, no onboarding-preset polish — that's
// Phase 3. The server is the enforcer (dependency auto-enable, refused
// disable, the sens-study lock); this page only renders what GET /config
// says and reports back whatever PUT /config refuses with.
export default function Settings() {
  const { loading, error, categories, fields, enabledCategories, lockedCategories, setCategoryEnabled, setFieldEnabled } = useFieldConfig();

  if (loading) return <div className="max-w-2xl mx-auto px-4 pt-6" data-inspect-id="settings-loading">Loading…</div>;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-6 pb-10" data-inspect-id="settings-page">
      <PageHeader dataInspectId="settings-header" title="Settings" sub="Turn tracking categories on or off, then pick the items to track in each." />
      {error && (
        <p className="text-xs text-red-500 mb-3" data-inspect-id="settings-refusal-message">{error}</p>
      )}
      <div className="space-y-2" data-inspect-id="settings-category-list">
        {categories.map(cat => {
          const enabled = enabledCategories.includes(cat.id);
          const locked = lockedCategories.find(l => l.id === cat.id);
          const disabled = cat.alwaysOn || !!locked;
          const subItems = fields.filter(f => f.category === cat.id && f.subItem);
          return (
            <div
              key={cat.id}
              data-inspect-id="settings-category-row"
              className="card grid grid-cols-[16px_1fr] items-start gap-x-3 py-3 px-3"
            >
              <input
                id={`settings-cat-${cat.id}`}
                type="checkbox"
                className="mt-0.5"
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
              <label htmlFor={`settings-cat-${cat.id}`} className="min-w-0 cursor-pointer">
                <div className="text-sm text-[var(--ink)] font-bold">{cat.label}</div>
                <div className="text-xs text-[var(--faint)]">{cat.description}</div>
                {cat.alwaysOn && (
                  <div className="text-xs text-[var(--faint-2)] mt-0.5" data-inspect-id="settings-always-on-note">Always on</div>
                )}
                {locked && (
                  <div className="text-xs text-ow-accent mt-0.5" data-inspect-id="settings-locked-reason">{locked.reason}</div>
                )}
              </label>
              {enabled && subItems.length > 0 && (
                <ul
                  className="col-start-2 mt-2 pt-2 border-t border-[var(--ow-border)] space-y-1"
                  data-inspect-id="settings-subitem-list"
                >
                  {subItems.map(f => (
                    <li key={f.id}>
                      <label className="flex items-center gap-2 text-xs text-[var(--ink)] cursor-pointer" data-inspect-id="settings-subitem-row">
                        <input
                          type="checkbox"
                          checked={f.enabled}
                          data-inspect-id="settings-subitem-checkbox"
                          onChange={async (e) => {
                            try {
                              await setFieldEnabled(f.id, e.target.checked);
                            } catch {
                              // The context already surfaced `error`; the box
                              // keeps its last known-good state.
                            }
                          }}
                        />
                        {f.label}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <GameUpdateCheck />
      <ScoreboardInbox />
    </div>
  );
}

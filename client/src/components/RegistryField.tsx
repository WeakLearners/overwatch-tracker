import DeathLogger from './DeathLogger';
import StarRating from './StarRating';
import { useFieldConfig, FieldMeta } from '../contexts/FieldConfigContext';

// The generic field renderer the field registry was built for (see
// projects/overwatch-analysis/modular-tracking-roadmap.md in the vault,
// "How the form renders from it"). Frozen 2026-09-23 against three real
// fields — `deaths` (bespoke), `team_rating` (bespoke), `notes` (generic)
// — so Phase 2 has a working pattern to copy for the remaining ~20 field
// groups instead of inventing one per field.
//
// Gating lives here, once, instead of at every call site: a disabled
// field's control renders nothing. `deaths` manages its own state via
// MatchContext's deathBuffer and takes no value/onChange — everything
// else is controlled from the caller's own state (however that state is
// held; RegistryField doesn't care whether it's a local useState or a
// keyed form object) via `value`/`onChange`.

interface Props {
  field: FieldMeta;
  value?: unknown;
  onChange?: (v: unknown) => void;
  placeholder?: string;
}

export default function RegistryField({ field, value, onChange, placeholder }: Props) {
  const { isFieldEnabled } = useFieldConfig();
  if (!isFieldEnabled(field.id)) return null;

  switch (field.control.kind) {
    case 'death-logger':
      return <DeathLogger />;

    case 'star-rating':
      return (
        <StarRating
          value={(value as number) ?? 0}
          onChange={(v) => onChange?.(v)}
          dataInspectId={`logmatch-${field.id}-stars`}
        />
      );

    case 'text':
      return (
        <textarea
          value={(value as string) ?? ''}
          onChange={(e) => onChange?.(e.target.value)}
          rows={2}
          data-inspect-id={`logmatch-${field.id}-textarea`}
          className="w-full field px-3 py-2 text-sm resize-none"
          placeholder={placeholder}
        />
      );

    case 'number':
      return (
        <input
          type="number"
          min={field.control.min}
          max={field.control.max}
          value={(value as number | string) ?? ''}
          onChange={(e) => onChange?.(e.target.value === '' ? null : Number(e.target.value))}
          data-inspect-id={`logmatch-${field.id}-number`}
          className="w-full field px-3 py-2 text-sm"
        />
      );

    case 'slider':
      return (
        <input
          type="range"
          min={field.control.min}
          max={field.control.max}
          value={(value as number) ?? field.control.min}
          onChange={(e) => onChange?.(Number(e.target.value))}
          data-inspect-id={`logmatch-${field.id}-slider`}
          className="w-full accent-ow-accent"
        />
      );

    case 'select':
      return (
        <select
          value={(value as string) ?? ''}
          onChange={(e) => onChange?.(e.target.value || null)}
          data-inspect-id={`logmatch-${field.id}-select`}
          className="w-full field px-3 py-2 text-sm"
        >
          <option value="">—</option>
          {field.control.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      );

    default:
      return null;
  }
}

import { ReactNode } from 'react';

interface Props {
  icon?: ReactNode;
  title: string;
  hint?: string;
  className?: string;
}

/**
 * Centered, intentional empty state — replaces bare one-liners like
 * "No data yet" so unpopulated cards read as designed rather than broken.
 */
export default function EmptyState({ icon, title, hint, className = '' }: Props) {
  return (
    <div className={`flex flex-col items-center justify-center text-center py-8 px-4 ${className}`}>
      {icon && (
        <div className="w-10 h-10 mb-2.5 rounded-full grid place-items-center bg-ow-darker/70 border border-ow-border text-lg text-[var(--faint)]">
          {icon}
        </div>
      )}
      <div className="text-sm font-medium text-[var(--muted)]">{title}</div>
      {hint && <div className="text-xs text-[var(--faint-2)] mt-1 max-w-[18rem] leading-relaxed">{hint}</div>}
    </div>
  );
}

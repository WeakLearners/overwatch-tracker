interface Props {
  title: string;
  sub?: string;
  children?: React.ReactNode;
}

export default function PageHeader({ title, sub, children }: Props) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div className="flex items-stretch gap-3">
        <div className="w-1 rounded-full bg-gradient-to-b from-ow-accent to-ow-accentLight shadow-[0_0_12px_-2px_rgba(139,92,246,0.7)]" />
        <div>
          <h1 className="text-2xl heading-display text-[var(--ink)]">{title}</h1>
          {sub && <p className="text-sm text-[var(--muted)] mt-0.5">{sub}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

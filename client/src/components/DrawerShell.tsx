import type { ReactNode } from 'react';

interface DrawerShellProps {
  open: boolean;
  onClose: () => void;
  /** Inspector ids for the three shell elements; each drawer passes its own. */
  ids: { backdrop: string; panel: string; close: string };
  /** Extra classes for the header row (the hero drawer adds `relative isolate` for its portrait). */
  headerClassName?: string;
  /** Left side of the header: title, badge, portrait background. */
  header: ReactNode;
  children: ReactNode;
}

/** Right-side slide-in drawer: backdrop, panel, header row with the close button, then the body. */
export default function DrawerShell({ open, onClose, ids, headerClassName = '', header, children }: DrawerShellProps) {
  return (
    <>
      <div
        data-inspect-id={ids.backdrop}
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
      />
      <div data-inspect-id={ids.panel} className={`fixed inset-y-0 right-0 w-96 bg-ow-dark border-l border-ow-border z-50 flex flex-col transition-transform duration-300 ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className={`flex items-start justify-between p-5 border-b border-ow-border shrink-0 ${headerClassName}`}>
          {header}
          <button onClick={onClose} data-inspect-id={ids.close} className="text-[var(--faint)] hover:text-[var(--ink)] transition-colors text-2xl leading-none ml-4">
            ×
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import InspectorToggleButton from './InspectorToggleButton';
import './inspector-kit.js';

// The overlay itself (hover box, bubble, prompt, tickets) is the shared
// inspector-kit; this wrapper only configures it and feeds the app-owned
// toggle button. Mounted under import.meta.env.DEV in App.tsx, so none of it
// ships to prod. Do not edit inspector-kit.js here: it is a byte-identical
// copy of the canonical file in the vault.

type Kit = { enable(on: boolean): void; toggle(): void; isOn(): boolean; destroy(): void };
declare global {
  interface Window {
    InspectorKit: { create(config: Record<string, unknown>): Kit };
  }
}

const STORAGE_KEY = 'ow-inspector-mode';

export default function InspectorOverlay() {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });
  const kitRef = useRef<Kit | null>(null);

  useEffect(() => {
    const kit = window.InspectorKit.create({
      loadMap: () => import('../../../docs/overwatch-frontend-map.json'),
      storageKey: STORAGE_KEY,
      repo: 'the overwatch repo',
      button: false,
      featureRequests: true,  // dev build only (overlay is mounted under import.meta.env.DEV)
      lazy: true,
      tickets: { url: 'https://seans-mac-mini.tail4b4f99.ts.net:8793/api/tickets', app: 'overwatch' },
      // CSS var() strings so the bubble follows the class-based dark mode.
      theme: {
        accent: 'var(--vol-base)',
        bg: 'rgb(var(--ow-card))',
        fg: 'var(--ink)',
        muted: 'var(--faint)',
        border: 'rgb(var(--ow-border))',
      },
      onChange: setEnabled,
    });
    kitRef.current = kit;
    return () => { kit.destroy(); kitRef.current = null; };
  }, []);

  return <InspectorToggleButton enabled={enabled} onToggle={() => kitRef.current?.toggle()} />;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import InspectorToggleButton from './InspectorToggleButton';

type UiElement = {
  id: string;
  label: string;
  kind: string;
  description: string;
  locate: { path: string; grep: string };
};
type MapNode = { id: string; label: string; uiElements?: UiElement[] };
type FrontendMap = { nodes: MapNode[] };

const STORAGE_KEY = 'ow-inspector-mode';
const BUBBLE_WIDTH = 300;
const BUBBLE_EST_HEIGHT = 210;

let cachedIndex: Map<string, UiElement> | null = null;

// A data-inspect-id value may hold multiple space-separated ids when two map
// entries describe the exact same JSX tag (e.g. a duplicate "header"/"title"
// pair) — resolve to the first id that has an index entry.
function resolveElement(idsAttr: string): UiElement | null {
  if (!cachedIndex) return null;
  for (const id of idsAttr.split(/\s+/)) {
    const found = cachedIndex.get(id);
    if (found) return found;
  }
  return null;
}
async function loadIndex(): Promise<Map<string, UiElement>> {
  if (cachedIndex) return cachedIndex;
  const mod = (await import('../../../docs/overwatch-frontend-map.json')) as unknown as
    | { default: FrontendMap }
    | FrontendMap;
  const data: FrontendMap = 'default' in mod ? mod.default : mod;
  const index = new Map<string, UiElement>();
  data.nodes.forEach(node => {
    (node.uiElements || []).forEach(el => index.set(el.id, el));
  });
  cachedIndex = index;
  return index;
}

function buildPrompt(el: UiElement, note: string): string {
  const lines = [
    `UI element: ${el.label} (${el.kind})`,
    `File: ${el.locate.path}`,
    `Locate: ${el.locate.grep}`,
    `Description: ${el.description}`,
  ];
  if (note.trim()) lines.push('', `Requested change: ${note.trim()}`);
  return lines.join('\n');
}

type Bubble = { el: UiElement; rect: DOMRect };

export default function InspectorOverlay() {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(STORAGE_KEY) === '1');
  const [index, setIndex] = useState<Map<string, UiElement> | null>(cachedIndex);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [hoveredEl, setHoveredEl] = useState<UiElement | null>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [toast, setToast] = useState<string | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [note, setNote] = useState('');
  const rafRef = useRef<number | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubbleRef = useRef<Bubble | null>(null);
  const bubbleElRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    bubbleRef.current = bubble;
  }, [bubble]);

  useEffect(() => {
    if (bubble) textareaRef.current?.focus();
  }, [bubble]);

  useEffect(() => {
    if (enabled && !index) {
      loadIndex().then(setIndex);
    }
  }, [enabled, index]);

  const toggle = useCallback(() => {
    setEnabled(prev => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 1400);
  }, []);

  const closeBubble = useCallback(() => {
    setBubble(null);
    setNote('');
  }, []);

  const copyPrompt = useCallback(() => {
    if (!bubble) return;
    navigator.clipboard.writeText(buildPrompt(bubble.el, note)).then(() => {
      showToast('Prompt copied');
      closeBubble();
    });
  }, [bubble, note, showToast, closeBubble]);

  const copyLocateOnly = useCallback(() => {
    if (!bubble) return;
    navigator.clipboard.writeText(bubble.el.locate.grep).then(() => {
      showToast('Locate copied');
      closeBubble();
    });
  }, [bubble, showToast, closeBubble]);

  useEffect(() => {
    if (!enabled) {
      setRect(null);
      setHoveredEl(null);
      setBubble(null);
      setNote('');
      return;
    }

    function onMouseMove(ev: MouseEvent) {
      setCursor({ x: ev.clientX, y: ev.clientY });
      if (bubbleRef.current) return;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const target = ev.target as HTMLElement | null;
        const match = target?.closest<HTMLElement>('[data-inspect-id]') ?? null;
        if (!match) {
          setRect(null);
          setHoveredEl(null);
          return;
        }
        setRect(match.getBoundingClientRect());
        setHoveredEl(resolveElement(match.getAttribute('data-inspect-id')!));
      });
    }

    function onClick(ev: MouseEvent) {
      const target = ev.target as HTMLElement | null;
      if (bubbleRef.current && bubbleElRef.current?.contains(target)) return;

      const match = target?.closest<HTMLElement>('[data-inspect-id]') ?? null;
      if (!match) {
        if (bubbleRef.current) {
          ev.preventDefault();
          ev.stopPropagation();
          setBubble(null);
          setNote('');
        }
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      const el = resolveElement(match.getAttribute('data-inspect-id')!);
      if (!el) return;
      setRect(match.getBoundingClientRect());
      setHoveredEl(el);
      setBubble({ el, rect: match.getBoundingClientRect() });
      setNote('');
    }

    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key !== 'Escape') return;
      if (bubbleRef.current) {
        setBubble(null);
        setNote('');
      } else {
        toggle();
      }
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [enabled, toggle]);

  let bubbleLeft = 0;
  let bubbleTop = 0;
  if (bubble) {
    bubbleLeft = Math.min(Math.max(bubble.rect.left, 8), window.innerWidth - BUBBLE_WIDTH - 8);
    bubbleTop = bubble.rect.bottom + 8;
    if (bubbleTop + BUBBLE_EST_HEIGHT > window.innerHeight) {
      bubbleTop = Math.max(8, bubble.rect.top - BUBBLE_EST_HEIGHT - 8);
    }
  }

  return (
    <>
      <InspectorToggleButton enabled={enabled} onToggle={toggle} />
      {enabled && rect && (
        <div
          style={{
            position: 'fixed',
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            border: '2px solid #8B5CF6',
            borderRadius: 6,
            background: 'rgba(139, 92, 246, 0.08)',
            pointerEvents: 'none',
            zIndex: 9999,
          }}
        />
      )}
      {enabled && hoveredEl && rect && !bubble && (
        <div
          style={{
            position: 'fixed',
            left: cursor.x + 14,
            top: cursor.y + 14,
            maxWidth: 260,
            zIndex: 10000,
            pointerEvents: 'none',
          }}
          className="bg-ow-card border border-ow-border rounded-lg shadow-lg px-3 py-2 text-xs"
        >
          <div className="font-semibold text-[var(--ink)]">{hoveredEl.label}</div>
          <div className="text-[var(--faint)] mt-0.5">{hoveredEl.kind} · click to ask Claude</div>
        </div>
      )}
      {enabled && bubble && (
        <div
          ref={bubbleElRef}
          style={{
            position: 'fixed',
            left: bubbleLeft,
            top: bubbleTop,
            width: BUBBLE_WIDTH,
            zIndex: 10002,
          }}
          className="bg-ow-card border border-ow-accent rounded-lg shadow-xl p-3 text-xs space-y-2"
        >
          <div>
            <div className="font-semibold text-[var(--ink)]">{bubble.el.label}</div>
            <div className="text-[var(--faint)] mt-0.5">{bubble.el.kind} · {bubble.el.locate.path}</div>
          </div>
          <textarea
            ref={textareaRef}
            value={note}
            onChange={ev => setNote(ev.target.value)}
            onKeyDown={ev => {
              if (ev.key === 'Enter' && !ev.shiftKey) {
                ev.preventDefault();
                copyPrompt();
              }
            }}
            placeholder="What should Claude fix here? (optional)"
            rows={3}
            className="w-full resize-none rounded-md border border-ow-border bg-ow-darker px-2 py-1.5 text-[var(--ink)] placeholder:text-[var(--faint-2)] focus:outline-none focus:ring-1 focus:ring-ow-accent"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => { setBubble(null); setNote(''); }}
              className="px-2 py-1 rounded-md text-[var(--faint)] hover:text-[var(--ink)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={copyLocateOnly}
              className="px-2 py-1 rounded-md border border-ow-border text-[var(--ink-2)] hover:text-ow-accent"
            >
              Copy locate
            </button>
            <button
              type="button"
              onClick={copyPrompt}
              className="px-2.5 py-1 rounded-md bg-ow-accent text-white font-semibold hover:opacity-90"
            >
              Copy prompt
            </button>
          </div>
        </div>
      )}
      {toast && (
        <div
          style={{
            position: 'fixed',
            left: cursor.x + 14,
            top: cursor.y + 40,
            zIndex: 10001,
            pointerEvents: 'none',
          }}
          className="bg-ow-accent text-white text-xs font-semibold rounded-md px-2 py-1 shadow-lg"
        >
          {toast}
        </div>
      )}
    </>
  );
}

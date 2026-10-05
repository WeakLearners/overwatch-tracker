import { useRef, useState } from 'react';

// A second view of the Rawaccel table rows, not a second copy. The rows (text,
// as typed) stay owned by LutEditor; this draws them and hands back a whole new
// rows array on every edit. It never saves anything and never invents a point:
// every point on the plot came from a row Sean typed, dragged, or clicked in.
//
// How the line is drawn follows Rawaccel's lookup (common/accel-lookup.hpp,
// struct lookup::operator()): binary search for the segment, then a straight
// lerp between its two points. At or below the first point the first y holds
// flat. Past the last point the code lerps with t > 1, which continues the last
// segment's slope rather than holding flat; that part is drawn dashed.
type Row = { x: string; y: string };

const W = 360, H = 150, ML = 34, MR = 8, MT = 8, MB = 20;
const MAX_POINTS = 32;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const tick = (v: number) => String(Math.round(v * 100) / 100);

type Domain = { xMax: number; yLo: number; yHi: number };

function domainFor(pts: { x: number; y: number }[]): Domain {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const xMax = Math.max(20, Math.ceil((xs.length ? Math.max(...xs) : 0) * 1.2 / 10) * 10);
  const lo = ys.length ? Math.min(...ys) : 1, hi = ys.length ? Math.max(...ys) : 1;
  const pad = Math.max((hi - lo) * 0.5, 0.1);
  return { xMax, yLo: Math.max(0.01, lo - pad), yHi: hi + pad };
}

export default function LutPlot({ rows, onChange }: { rows: Row[]; onChange: (rows: Row[]) => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  // The domain is frozen while a point is held. Re-fitting it on every move
  // would rescale the axes under the cursor and the point would run away.
  const frozen = useRef<Domain | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const pts = rows.map((r, i) => ({ i, x: Number(r.x), y: Number(r.y), ok: r.x.trim() !== '' && r.y.trim() !== '' }))
    .filter(p => p.ok && Number.isFinite(p.x) && Number.isFinite(p.y));
  const dom = frozen.current ?? domainFor(pts);

  const px = (x: number) => ML + (x / dom.xMax) * (W - ML - MR);
  const py = (y: number) => H - MB - ((y - dom.yLo) / (dom.yHi - dom.yLo)) * (H - MT - MB);

  // Pointer position -> data units, through the svg's own on-screen box so it
  // holds at any card width.
  function toData(e: { clientX: number; clientY: number }) {
    const b = svgRef.current!.getBoundingClientRect();
    const sx = ((e.clientX - b.left) / b.width) * W, sy = ((e.clientY - b.top) / b.height) * H;
    return {
      x: ((sx - ML) / (W - ML - MR)) * dom.xMax,
      y: dom.yLo + ((H - MB - sy) / (H - MT - MB)) * (dom.yHi - dom.yLo),
    };
  }

  function move(i: number, e: React.PointerEvent) {
    if (!dragging || active !== i) return;
    const d = toData(e);
    const prev = pts.filter(p => p.i < i).pop(), next = pts.find(p => p.i > i);
    const x = r1(Math.min(Math.max(d.x, 0), dom.xMax));
    const y = r3(Math.min(Math.max(d.y, Math.max(0.01, dom.yLo)), dom.yHi));
    // A point may not pass or equal its neighbour, so the order never flips
    // mid-drag and no two points ever share a speed.
    if ((prev && x <= prev.x) || (next && x >= next.x)) return;
    onChange(rows.map((r, j) => (j === i ? { x: String(x), y: String(y) } : r)));
  }

  function addAt(e: React.MouseEvent) {
    if (rows.length >= MAX_POINTS) return;
    const d = toData(e);
    const x = r1(Math.max(d.x, 0.1)), y = r3(Math.max(d.y, 0.01));
    if (pts.some(p => p.x === x)) return;
    const at = rows.findIndex(r => Number(r.x) > x);
    const row = { x: String(x), y: String(y) };
    onChange(at < 0 ? [...rows, row] : [...rows.slice(0, at), row, ...rows.slice(at)]);
  }

  const sorted = [...pts].sort((a, b) => a.x - b.x);
  const line = sorted.length
    ? [`${px(0)},${py(sorted[0].y)}`, ...sorted.map(p => `${px(p.x)},${py(p.y)}`)].join(' ')
    : '';
  let tail: string | null = null;
  if (sorted.length >= 2) {
    const a = sorted[sorted.length - 2], b = sorted[sorted.length - 1];
    if (b.x < dom.xMax) {
      const yEnd = Math.min(Math.max(b.y + ((b.y - a.y) / (b.x - a.x)) * (dom.xMax - b.x), dom.yLo), dom.yHi);
      tail = `${px(b.x)},${py(b.y)} ${px(dom.xMax)},${py(yEnd)}`;
    }
  }
  const xt = [0, 1, 2, 3, 4].map(k => (dom.xMax * k) / 4);
  const yt = [dom.yLo, (dom.yLo + dom.yHi) / 2, dom.yHi];
  const shown = pts.find(p => p.i === active);

  return (
    <div data-inspect-id="sl-lut-plot">
      <svg
        ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block select-none"
        style={{ touchAction: 'none' }} role="img" aria-label="Lookup table plot: speed against multiplier"
      >
        {xt.map(v => (
          <g key={`x${v}`}>
            <line x1={px(v)} x2={px(v)} y1={MT} y2={H - MB} stroke="rgb(var(--ow-border))" strokeWidth={0.5} />
            <text x={px(v)} y={H - 6} textAnchor="middle" fontSize={9} fill="var(--faint-2)">{tick(v)}</text>
          </g>
        ))}
        {yt.map(v => (
          <g key={`y${v}`}>
            <line x1={ML} x2={W - MR} y1={py(v)} y2={py(v)} stroke="rgb(var(--ow-border))" strokeWidth={0.5} />
            <text x={ML - 4} y={py(v) + 3} textAnchor="end" fontSize={9} fill="var(--faint-2)">{tick(v)}</text>
          </g>
        ))}
        <rect
          x={ML} y={MT} width={W - ML - MR} height={H - MT - MB} fill="transparent"
          style={{ cursor: 'crosshair' }} onClick={addAt} data-inspect-id="sl-lut-plot-area"
        />
        {line && <polyline points={line} fill="none" stroke="#F7931E" strokeWidth={1.5} strokeLinejoin="round" pointerEvents="none" />}
        {tail && <polyline points={tail} fill="none" stroke="#F7931E" strokeWidth={1.5} strokeDasharray="3 3" opacity={0.7} pointerEvents="none" />}
        {pts.map(p => (
          <g
            key={p.i} data-inspect-id="sl-lut-plot-point" style={{ cursor: 'grab' }}
            onPointerEnter={() => !dragging && setActive(p.i)}
            onPointerLeave={() => !dragging && setActive(null)}
            onPointerDown={e => {
              e.currentTarget.setPointerCapture(e.pointerId);
              frozen.current = domainFor(pts); setActive(p.i); setDragging(true);
            }}
            onPointerMove={e => move(p.i, e)}
            onPointerUp={() => { frozen.current = null; setDragging(false); }}
            onPointerCancel={() => { frozen.current = null; setDragging(false); }}
            onDoubleClick={() => rows.length > 2 && onChange(rows.filter((_, j) => j !== p.i))}
          >
            <circle cx={px(p.x)} cy={py(p.y)} r={9} fill="transparent" />
            <circle cx={px(p.x)} cy={py(p.y)} r={active === p.i ? 5 : 4} fill="var(--field-bg)" stroke="#F7931E" strokeWidth={1.5} />
          </g>
        ))}
        {shown && (
          <text x={W - MR - 2} y={MT + 9} textAnchor="end" fontSize={10} fill="var(--ink)" pointerEvents="none">
            {shown.x}, {shown.y}
          </text>
        )}
      </svg>
      <p className="text-[10px] text-[var(--faint-2)] mb-2">Drag to move · click empty space to add · double-click a point to remove</p>
    </div>
  );
}

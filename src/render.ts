import type { LayoutResult } from './layout.ts';
import type { Scene } from './scene.ts';

const NS = 'http://www.w3.org/2000/svg';
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.append(node);
  return node;
};

export interface Drawing {
  svg: SVGSVGElement;
  focus(id: string | null): void;
  zoomTo(id: string): void;
  fit(): void;
  zoomBy(f: number): void;
  scale(): number;
  destroy(): void;
}

interface Handlers {
  onSelect(id: string | null): void;
  onScale(scale: number): void;
  insets(): { left: number; right: number; top: number; bottom: number };
}

const pathOf = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');

export function draw(host: HTMLElement, scene: Scene, lay: LayoutResult, h: Handlers): Drawing {
  host.replaceChildren();
  const svg = el('svg', { class: 'sheet', role: 'img', 'aria-label': `Dependency drawing: ${scene.nodes.length} ${scene.mode}, ${scene.edges.length} imports` }, host);
  const defs = el('defs', {}, svg);
  for (const [id, cls] of [['arrow', 'arrowhead'], ['arrow-red', 'arrowhead red'], ['arrow-hot', 'arrowhead hot']]) {
    const m = el('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: 'M1 1.5 9 5 1 8.5', class: cls }, m);
  }
  const world = el('g', { class: 'world' }, svg);

  /* Clusters: dashed drafting frames with a dimension line across the top. */
  const nodeCount = new Map<string, number>();
  for (const n of scene.nodes) nodeCount.set(n.group, (nodeCount.get(n.group) ?? 0) + 1);
  const gClusters = el('g', { class: 'clusters' }, world);
  for (const g of lay.groups) {
    const c = el('g', { class: 'cluster' }, gClusters);
    el('rect', { x: g.x, y: g.y, width: g.w, height: g.h, class: 'frame' }, c);
    el('text', { x: g.x + 14, y: g.y + 22, class: 'cluster-label' }, c).textContent = g.id === '·' ? '(root)' : g.id;
    const y = g.y - 9;
    if (g.w > 70) {
      el('path', { d: `M${g.x} ${y}H${g.x + g.w}M${g.x} ${y - 4}V${y + 4}M${g.x + g.w} ${y - 4}V${y + 4}`, class: 'dim' }, c);
      const t = el('text', { x: g.x + g.w / 2, y: y - 4, class: 'dim-label' }, c);
      const n = nodeCount.get(g.id) ?? 0;
      t.textContent = `${n} ${scene.mode === 'files' ? (n === 1 ? 'FILE' : 'FILES') : n === 1 ? 'FOLDER' : 'FOLDERS'}`;
    }
  }

  /* Edges */
  const gEdges = el('g', { class: 'edges' }, world);
  const edgeEls: SVGPathElement[] = [];
  const edgesOf = new Map<string, number[]>();
  for (const e of lay.edges) {
    const s = scene.edges[e.index];
    const p = el('path', {
      d: pathOf(e.points), class: `edge k-${s.kind}${s.cycle ? ' cycle' : ''}`,
      'marker-end': `url(#${s.cycle ? 'arrow-red' : 'arrow'})`,
      'stroke-width': scene.mode === 'folders' ? Math.min(1 + Math.log2(s.count), 4).toFixed(2) : '',
    }, gEdges);
    p.style.setProperty('--len', String(Math.ceil(p.getTotalLength?.() || 400)));
    p.style.setProperty('--d', `${Math.min(e.index * 6, 900)}ms`);
    edgeEls[e.index] = p;
    for (const id of [s.from, s.to]) edgesOf.set(id, [...(edgesOf.get(id) ?? []), e.index]);
  }

  /* Nodes */
  const gNodes = el('g', { class: 'nodes' }, world);
  const nodeEls = new Map<string, SVGGElement>();
  const box = new Map(lay.nodes.map((n) => [n.id, n]));
  const maxWeight = Math.max(1, ...scene.nodes.map((n) => n.weight));
  for (const n of scene.nodes) {
    const b = box.get(n.id);
    if (!b) continue;
    const g = el('g', { class: `node${n.cycle ? ' cycle' : ''}${n.test ? ' test' : ''}${n.entry ? ' entry' : ''}`, transform: `translate(${b.x} ${b.y})`, tabindex: 0, role: 'button', 'aria-label': n.id }, gNodes);
    g.dataset.id = n.id;
    el('rect', { width: b.w, height: b.h, rx: 2, class: 'box' }, g);
    // Hotspot bar: how much of the repo leans on this module.
    if (n.weight > 0) el('rect', { x: 0, y: b.h - 3, width: Math.max(4, (b.w * n.weight) / maxWeight), height: 3, class: 'heat' }, g);
    if (n.entry) el('path', { d: `M0 0h8L0 8z`, class: 'entry-mark' }, g);
    el('text', { x: 12, y: n.sub ? 18 : b.h / 2 + 4, class: 'label' }, g).textContent = n.label;
    if (n.sub) el('text', { x: 12, y: 33, class: 'sub' }, g).textContent = n.sub;
    nodeEls.set(n.id, g);
  }

  /* Viewport: pan, wheel zoom, pinch. Transform only, no layout. */
  let k = 1, tx = 0, ty = 0;
  const apply = () => {
    world.setAttribute('transform', `translate(${tx.toFixed(1)} ${ty.toFixed(1)}) scale(${k.toFixed(4)})`);
    svg.style.setProperty('--grid', `${(16 * k).toFixed(2)}px`);
    svg.style.setProperty('--gx', `${tx.toFixed(1)}px`);
    svg.style.setProperty('--gy', `${ty.toFixed(1)}px`);
    h.onScale(k);
  };
  const clampK = (v: number) => Math.min(3, Math.max(0.08, v));
  const zoomAt = (f: number, cx: number, cy: number) => {
    const nk = clampK(k * f);
    tx = cx - ((cx - tx) * nk) / k;
    ty = cy - ((cy - ty) * nk) / k;
    k = nk;
    apply();
  };
  const fit = () => {
    // Fit into the area the panels leave free, not the whole canvas.
    const r = host.getBoundingClientRect();
    const i = h.insets();
    const w = Math.max(120, r.width - i.left - i.right), hh = Math.max(120, r.height - i.top - i.bottom);
    k = clampK(Math.min(w / Math.max(lay.width, 1), hh / Math.max(lay.height + 24, 1), 1.4));
    tx = i.left + (w - lay.width * k) / 2;
    ty = i.top + 12 + (hh - lay.height * k) / 2;
    apply();
  };

  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0, moved = false;
  let pressed: string | null = null; // pointer capture retargets pointerup, so remember the node here
  const onDown = (e: PointerEvent) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pressed = ((e.target as Element).closest('.node') as SVGGElement | null)?.dataset.id ?? null;
    svg.setPointerCapture(e.pointerId);
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const onMove = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const r = svg.getBoundingClientRect();
      if (pinch) zoomAt(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      pinch = d;
      moved = true;
      return;
    }
    if (Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y) > 0) {
      tx += cur.x - prev.x;
      ty += cur.y - prev.y;
      if (Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y) > 1) moved = true;
      svg.classList.add('panning');
      apply();
    }
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    svg.classList.remove('panning');
    if (!moved && pointers.size === 0) h.onSelect(pressed);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
  };
  const onKey = (e: KeyboardEvent) => {
    const node = (e.target as Element).closest?.('.node') as SVGGElement | null;
    if (node && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      h.onSelect(node.dataset.id ?? null);
    }
  };
  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onUp);
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => fit());
  ro.observe(host);
  fit();
  requestAnimationFrame(() => svg.classList.add('plotted'));

  return {
    svg,
    focus(id) {
      svg.classList.toggle('focusing', !!id);
      for (const n of nodeEls.values()) n.classList.remove('on', 'near');
      for (const p of edgeEls) p?.classList.remove('on', 'in', 'out');
      if (!id) return;
      nodeEls.get(id)?.classList.add('on');
      for (const i of edgesOf.get(id) ?? []) {
        const s = scene.edges[i];
        edgeEls[i]?.classList.add('on', s.from === id ? 'out' : 'in');
        nodeEls.get(s.from === id ? s.to : s.from)?.classList.add('near');
      }
    },
    zoomTo(id) {
      const b = box.get(id);
      if (!b) return;
      const r = host.getBoundingClientRect();
      const i = h.insets();
      k = clampK(Math.max(k, 1));
      tx = i.left + (r.width - i.left - i.right) / 2 - (b.x + b.w / 2) * k;
      ty = i.top + (r.height - i.top - i.bottom) / 2 - (b.y + b.h / 2) * k;
      apply();
    },
    fit,
    zoomBy(f) {
      const r = host.getBoundingClientRect();
      zoomAt(f, r.width / 2, r.height / 2);
    },
    scale: () => k,
    destroy() {
      ro.disconnect();
    },
  };
}

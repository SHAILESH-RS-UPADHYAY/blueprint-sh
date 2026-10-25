import type { Graph } from './types.ts';
import type { Scene } from './scene.ts';

const save = (blob: Blob, name: string) => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'drawing';

// Bake the live CSS variables into the file so it renders the same anywhere.
function standalone(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const world = svg.querySelector('.world') as SVGGElement;
  const bb = world.getBBox();
  const pad = 48;
  clone.querySelector('.world')!.setAttribute('transform', `translate(${pad - bb.x} ${pad - bb.y})`);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(Math.ceil(bb.width + pad * 2)));
  clone.setAttribute('height', String(Math.ceil(bb.height + pad * 2)));
  clone.setAttribute('viewBox', `0 0 ${Math.ceil(bb.width + pad * 2)} ${Math.ceil(bb.height + pad * 2)}`);
  clone.classList.remove('focusing', 'panning');
  const cs = getComputedStyle(svg);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `
    svg { background: ${v('--sheet')}; font-family: 'Overpass Mono', ui-monospace, monospace; }
    .frame { fill: none; stroke: ${v('--ink')}; stroke-opacity: .45; stroke-dasharray: 6 4; }
    .cluster-label { fill: ${v('--ink')}; font: 700 13px 'Big Shoulders Display', sans-serif; letter-spacing: .08em; text-transform: uppercase; }
    .dim { stroke: ${v('--ink')}; stroke-opacity: .5; } .dim-label { fill: ${v('--ink')}; fill-opacity: .7; font-size: 9px; text-anchor: middle; letter-spacing: .1em; }
    .edge { fill: none; stroke: ${v('--ink')}; stroke-opacity: .55; stroke-width: 1.2; }
    .edge.k-dynamic { stroke-dasharray: 6 4; } .edge.k-type { stroke-dasharray: 1.5 3; }
    .edge.cycle { stroke: ${v('--red')}; stroke-opacity: 1; }
    .arrowhead { fill: none; stroke: ${v('--ink')}; stroke-width: 1.4; } .arrowhead.red { stroke: ${v('--red')}; }
    .box { fill: ${v('--sheet')}; stroke: ${v('--ink')}; stroke-width: 1.3; } .node.cycle .box { stroke: ${v('--red')}; }
    .heat { fill: ${v('--ink')}; fill-opacity: .55; } .entry-mark { fill: ${v('--ink')}; }
    .label { fill: ${v('--ink')}; font-size: 11px; } .sub { fill: ${v('--ink')}; fill-opacity: .6; font-size: 9.5px; }`;
  clone.prepend(style);
  return new XMLSerializer().serializeToString(clone);
}

export function exportSvg(svg: SVGSVGElement, name: string) {
  save(new Blob([standalone(svg)], { type: 'image/svg+xml' }), `${slug(name)}.svg`);
}

export async function exportPng(svg: SVGSVGElement, name: string) {
  const text = standalone(svg);
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  await img.decode();
  // ponytail: 2× capped at 8k px per side; browsers refuse larger canvases.
  const scale = Math.min(2, 8000 / Math.max(img.width, img.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  canvas.toBlob((b) => b && save(b, `${slug(name)}.png`), 'image/png');
}

export function toMermaid(scene: Scene): string {
  const ids = new Map(scene.nodes.map((n, i) => [n.id, `n${i}`]));
  const lines = ['flowchart LR'];
  const groups = new Map<string, Scene['nodes']>();
  for (const n of scene.nodes) groups.set(n.group, [...(groups.get(n.group) ?? []), n]);
  let gi = 0;
  for (const [g, nodes] of groups) {
    lines.push(`  subgraph g${gi++}["${g.replace(/"/g, "'")}"]`);
    for (const n of nodes) lines.push(`    ${ids.get(n.id)}["${n.label.replace(/"/g, "'")}"]`);
    lines.push('  end');
  }
  const arrow = { static: '-->', reexport: '-->', dynamic: '-.->', type: '-.->' } as const;
  scene.edges.forEach((e) => lines.push(`  ${ids.get(e.from)} ${arrow[e.kind]} ${ids.get(e.to)}`));
  scene.edges.forEach((e, i) => e.cycle && lines.push(`  linkStyle ${i} stroke:#d23a2c`));
  return lines.join('\n');
}

export function exportMermaid(scene: Scene, name: string) {
  save(new Blob([toMermaid(scene)], { type: 'text/plain' }), `${slug(name)}.mmd`);
}

export function exportJson(g: Graph, name: string) {
  save(new Blob([JSON.stringify(g, null, 2)], { type: 'application/json' }), `${slug(name)}.json`);
}

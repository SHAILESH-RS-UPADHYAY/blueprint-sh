// The ELK graph for a scene, and the drawing coordinates read back from ELK's answer.
// Pure: the browser runs it through ELK's worker, the build script through elk.bundled.
import type { Scene } from './scene.ts';

export interface LayoutInput {
  direction: 'RIGHT' | 'DOWN';
  groups: string[];
  nodes: { id: string; group: string; label: string; sub?: string }[];
  edges: { from: string; to: string }[];
}

export interface LayoutResult {
  width: number;
  height: number;
  groups: { id: string; x: number; y: number; w: number; h: number }[];
  nodes: { id: string; x: number; y: number; w: number; h: number }[];
  edges: { index: number; points: [number, number][] }[];
}

interface ElkNode { id: string; x?: number; y?: number; width?: number; height?: number; children?: ElkNode[] }
interface ElkEdge { id: string; container?: string; sections?: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: { x: number; y: number }[] }[] }
export interface ElkLike { layout(graph: object): Promise<unknown> }

const CHAR = 6.9; // Overpass Mono 11px advance
const PAD = { top: 44, side: 20, bottom: 20 };

export const inputOf = (scene: Scene, direction: LayoutInput['direction']): LayoutInput => ({
  direction,
  groups: [...new Set(scene.nodes.map((n) => n.group))].sort(),
  nodes: scene.nodes.map(({ id, group, label, sub }) => ({ id, group, label, sub })),
  edges: scene.edges.map(({ from, to }) => ({ from, to })),
});

export function toElk({ nodes, groups, edges, direction }: LayoutInput) {
  const byGroup = new Map<string, typeof nodes>();
  for (const n of nodes) byGroup.set(n.group, [...(byGroup.get(n.group) ?? []), n]);
  const size = (n: LayoutInput['nodes'][number]) => ({
    width: Math.max(96, Math.ceil(Math.max(n.label.length, (n.sub ?? '').length * 0.85) * CHAR) + 30),
    height: n.sub ? 44 : 34,
  });
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.spacing.nodeNode': '36',
      'elk.spacing.edgeNode': '16',
      'elk.spacing.edgeEdge': '8',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    },
    children: groups.map((g) => ({
      id: `group:${g}`,
      layoutOptions: { 'elk.padding': `[top=${PAD.top},left=${PAD.side},bottom=${PAD.bottom},right=${PAD.side}]` },
      children: (byGroup.get(g) ?? []).map((n) => ({ id: n.id, ...size(n) })),
    })),
    edges: edges.map((ed, i) => ({ id: `e${i}`, sources: [ed.from], targets: [ed.to] })),
  };
}

export function fromElk(answer: unknown): LayoutResult {
  const out = answer as ElkNode & { edges?: ElkEdge[] };
  const offset = new Map<string, { x: number; y: number }>([['root', { x: 0, y: 0 }]]);
  const result: LayoutResult = { width: out.width ?? 0, height: out.height ?? 0, groups: [], nodes: [], edges: [] };
  for (const g of out.children ?? []) {
    offset.set(g.id, { x: g.x ?? 0, y: g.y ?? 0 });
    result.groups.push({ id: g.id.slice(6), x: g.x ?? 0, y: g.y ?? 0, w: g.width ?? 0, h: g.height ?? 0 });
    for (const n of g.children ?? []) result.nodes.push({ id: n.id, x: (g.x ?? 0) + (n.x ?? 0), y: (g.y ?? 0) + (n.y ?? 0), w: n.width ?? 0, h: n.height ?? 0 });
  }
  for (const ed of out.edges ?? []) {
    const o = offset.get(ed.container ?? 'root') ?? { x: 0, y: 0 };
    const s = ed.sections?.[0];
    if (!s) continue;
    const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => [p.x + o.x, p.y + o.y] as [number, number]);
    result.edges.push({ index: Number(ed.id.slice(1)), points: pts });
  }
  return result;
}

export const layoutWith = async (elk: ElkLike, scene: Scene, direction: LayoutInput['direction']) =>
  fromElk(await elk.layout(toElk(inputOf(scene, direction))));

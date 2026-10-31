import type { Graph, ImportKind } from './types.ts';
import { folderView } from './graph.ts';

/** What gets drawn: either files grouped by folder, or folders grouped by parent. */
export interface Scene {
  mode: 'files' | 'folders';
  nodes: { id: string; group: string; label: string; sub?: string; cycle: boolean; weight: number; test: boolean; entry: boolean; lang?: string }[];
  edges: { from: string; to: string; kind: ImportKind; cycle: boolean; count: number }[];
}

export interface SceneOptions { mode: 'files' | 'folders'; depth: number; tests: boolean; types: boolean }

export function buildScene(g: Graph, o: SceneOptions): Scene {
  if (o.mode === 'folders') {
    const files = g.files.filter((f) => o.tests || !f.test);
    const kept = new Set(files.map((f) => f.id));
    const v = folderView({ ...g, files, edges: g.edges.filter((e) => kept.has(e.from) && kept.has(e.to) && (o.types || e.kind !== 'type')) }, o.depth);
    const parent = (id: string) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : g.root);
    return {
      mode: 'folders',
      nodes: v.nodes.map((n) => ({
        id: n.id, group: parent(n.id), label: n.id === '·' ? '(root files)' : `${n.id.split('/').pop()}/`,
        sub: `${n.files} ${n.files === 1 ? 'file' : 'files'}, ${n.loc.toLocaleString('en-US')} loc`,
        cycle: n.cycle, weight: n.files, test: false, entry: false,
      })),
      edges: v.edges.map((e) => ({ from: e.from, to: e.to, kind: 'static', cycle: e.cycle, count: e.count })),
    };
  }
  const files = g.files.filter((f) => o.tests || !f.test);
  const keep = new Set(files.map((f) => f.id));
  const entries = new Set(g.entries);
  return {
    mode: 'files',
    nodes: files.map((f) => ({
      id: f.id, group: f.dir || '·', label: f.name, cycle: f.cycle >= 0, weight: f.fanIn, test: f.test, entry: entries.has(f.id), lang: f.lang,
    })),
    edges: g.edges
      .filter((e) => keep.has(e.from) && keep.has(e.to) && (o.types || e.kind !== 'type'))
      .map((e) => ({ from: e.from, to: e.to, kind: e.kind, cycle: e.cycle, count: 1 })),
  };
}

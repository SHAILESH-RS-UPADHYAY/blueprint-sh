import type { Edge, FileNode, Graph, Lang, Source, Specifier } from './types.ts';
import { RANK, parseJs, scriptBlocks } from './parse/js.ts';
import { parsePython } from './parse/python.ts';
import { createResolver, readAliasConfig, type AliasConfig } from './resolve.ts';
import { basename, dirname, normalize } from './path.ts';

export const LIMITS = { files: 5000, bytes: 1_000_000 };

const LANG: Record<string, Lang> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', vue: 'vue', svelte: 'svelte', py: 'py',
};
const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output', '.turbo',
  '.vercel', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache', 'target',
  'vendor', 'bower_components', 'site-packages', 'storybook-static', '.idea', '.vscode']);
const TEST = /(^|\/)(__tests__|__mocks__|tests?|spec|e2e)\/|\.(test|spec|stories|e2e)\.[^/]+$|(^|\/)(test_[^/]+|[^/]+_test|conftest)\.py$/;
const CONFIG = /(^|\/)(tsconfig[\w.-]*|jsconfig)\.json$/;

export const langOf = (path: string): Lang | null => LANG[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? null;
export const isIgnoredPath = (path: string) => path.split('/').slice(0, -1).some((seg) => IGNORED.has(seg));
export const isWanted = (path: string) => !isIgnoredPath(path) && (langOf(path) !== null || CONFIG.test(path));

// Bundled or minified output reads as one enormous line; it isn't source.
const minified = (path: string, text: string) =>
  /\.min\.[cm]?js$/.test(path) || (text.length > 5000 && text.length / (text.split('\n').length || 1) > 500);

/** Drop a shared top folder ("my-repo/src/a.ts" → "src/a.ts") and report it as the project name. */
export function stripCommonRoot(sources: Source[]): { root: string; sources: Source[] } {
  const paths = sources.map((s) => normalize(s.path.replace(/\\/g, '/')));
  const first = paths[0]?.split('/')[0];
  const shared = first && paths.length > 0 && paths.every((p) => p.startsWith(`${first}/`));
  return {
    root: shared ? first : '',
    sources: sources.map((s, i) => ({ path: shared ? paths[i].slice(first.length + 1) : paths[i], text: s.text })),
  };
}

export function buildGraph(sources: Source[], root = 'project'): Graph {
  const skipped: Graph['skipped'] = [];
  const configs: AliasConfig[] = [];
  const code: (Source & { lang: Lang })[] = [];

  for (const s of sources) {
    if (isIgnoredPath(s.path)) continue;
    if (CONFIG.test(s.path)) {
      const c = readAliasConfig(s.path, s.text);
      if (c) configs.push(c);
      continue;
    }
    const lang = langOf(s.path);
    if (!lang) continue;
    if (s.text.length > LIMITS.bytes) skipped.push({ path: s.path, reason: 'larger than 1 MB' });
    else if (minified(s.path, s.text)) skipped.push({ path: s.path, reason: 'minified or generated' });
    else if (code.length >= LIMITS.files) skipped.push({ path: s.path, reason: `over the ${LIMITS.files.toLocaleString()} file limit` });
    else code.push({ ...s, lang });
  }

  const resolver = createResolver(code.map((c) => c.path), configs);
  const nodes = new Map<string, FileNode>();
  const edgeMap = new Map<string, Edge>();
  const unresolved: Graph['unresolved'] = [];

  for (const file of code) {
    const externals = new Set<string>();
    const builtins = new Set<string>();
    const specs: Specifier[] = file.lang === 'py'
      ? parsePython(file.text)
      : parseJs(file.lang === 'vue' || file.lang === 'svelte' ? scriptBlocks(file.text) : file.text);

    for (const s of specs) {
      const results = file.lang === 'py' ? resolver.py(file.path, s.spec, s.names) : [resolver.js(file.path, s.spec)];
      for (const r of results) {
        if (r.kind === 'internal') {
          if (r.target === file.path) continue;
          const key = `${file.path}\u0000${r.target}`;
          const prev = edgeMap.get(key);
          if (!prev || RANK[s.kind] > RANK[prev.kind]) {
            edgeMap.set(key, { from: file.path, to: r.target, kind: s.kind, line: prev ? Math.min(prev.line, s.line) : s.line, cycle: false });
          }
        } else if (r.kind === 'external') externals.add(r.target);
        else if (r.kind === 'builtin') builtins.add(r.target);
        else if (r.kind === 'unresolved') unresolved.push({ from: file.path, spec: s.spec, line: s.line });
      }
    }

    nodes.set(file.path, {
      id: file.path,
      dir: dirname(file.path),
      name: basename(file.path),
      lang: file.lang,
      loc: file.text.split('\n').filter((l) => l.trim()).length,
      bytes: file.text.length,
      test: TEST.test(file.path),
      externals: [...externals].sort(),
      builtins: [...builtins].sort(),
      fanIn: 0,
      fanOut: 0,
      cycle: -1,
    });
  }

  const edges = [...edgeMap.values()];
  for (const e of edges) {
    nodes.get(e.from)!.fanOut++;
    nodes.get(e.to)!.fanIn++;
  }

  // Type-only imports are erased at compile time, so they can't form a runtime cycle.
  const runtime = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind === 'type') continue;
    const list = runtime.get(e.from);
    if (list) list.push(e.to); else runtime.set(e.from, [e.to]);
  }
  const cycles = stronglyConnected([...nodes.keys()], runtime)
    .filter((c) => c.length > 1)
    .map((c) => c.sort())
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
  cycles.forEach((members, i) => members.forEach((id) => (nodes.get(id)!.cycle = i)));
  for (const e of edges) {
    const a = nodes.get(e.from)!.cycle;
    e.cycle = e.kind !== 'type' && a >= 0 && a === nodes.get(e.to)!.cycle;
  }

  const files = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const externalCounts = new Map<string, number>();
  for (const f of files) for (const x of f.externals) externalCounts.set(x, (externalCounts.get(x) ?? 0) + 1);

  return {
    root,
    files,
    edges,
    externals: [...externalCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    cycles,
    entries: files.filter((f) => f.fanIn === 0 && f.fanOut > 0 && !f.test).map((f) => f.id),
    orphans: files.filter((f) => f.fanIn === 0 && f.fanOut === 0).map((f) => f.id),
    unresolved,
    skipped,
  };
}

/** Tarjan's algorithm, iterative so a 5,000-file chain can't blow the call stack. */
export function stronglyConnected(ids: string[], adj: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
  };

  for (const start of ids) {
    if (index.has(start)) continue;
    visit(start);
    const work: [string, number][] = [[start, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      const next = adj.get(v) ?? [];
      if (i < next.length) {
        frame[1]++;
        const w = next[i];
        if (!index.has(w)) {
          visit(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }
      if (low.get(v) === index.get(v)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== v);
        out.push(component);
      }
    }
  }
  return out;
}

export interface FolderView {
  depth: number;
  nodes: { id: string; files: number; loc: number; cycle: boolean; members: string[] }[];
  edges: { from: string; to: string; count: number; cycle: boolean }[];
}

/** Collapse files into folders `depth` levels deep, for repos too big to draw file by file. */
export function folderView(g: Graph, depth: number): FolderView {
  const keyOf = (dir: string) => dir.split('/').filter(Boolean).slice(0, depth).join('/') || '·';
  const nodes = new Map<string, FolderView['nodes'][number]>();
  const owner = new Map<string, string>();
  for (const f of g.files) {
    const k = keyOf(f.dir);
    owner.set(f.id, k);
    const n = nodes.get(k) ?? { id: k, files: 0, loc: 0, cycle: false, members: [] };
    n.files++;
    n.loc += f.loc;
    n.cycle ||= f.cycle >= 0;
    n.members.push(f.id);
    nodes.set(k, n);
  }
  const edges = new Map<string, FolderView['edges'][number]>();
  for (const e of g.edges) {
    const a = owner.get(e.from)!, b = owner.get(e.to)!;
    if (a === b) continue;
    const k = `${a}\u0000${b}`;
    const agg = edges.get(k) ?? { from: a, to: b, count: 0, cycle: false };
    agg.count++;
    agg.cycle ||= e.cycle;
    edges.set(k, agg);
  }
  return { depth, nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Shallowest folder depth that splits the repo into at least `min` groups. */
export function suggestDepth(g: Graph, min = 4): number {
  const maxDepth = Math.max(1, ...g.files.map((f) => f.dir.split('/').filter(Boolean).length));
  for (let d = 1; d <= maxDepth; d++) if (folderView(g, d).nodes.length >= min) return d;
  return maxDepth;
}

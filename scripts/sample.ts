// Snapshots this repo's own source into public/sample.json so the "draw this
// project" demo always reflects the current code, and lays that snapshot out
// once (public/sample-sheet.json) so the intake can draw it without ELK.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ELK from 'elkjs/lib/elk.bundled.js';
import { buildGraph, isWanted } from '../src/graph.ts';
import { buildScene } from '../src/scene.ts';
import { layoutWith } from '../src/elk-graph.ts';

const root = join(import.meta.dirname, '..');
const sources: { path: string; text: string }[] = [];

function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const path = relative(root, full).split(sep).join('/');
    if (statSync(full).isDirectory()) {
      if (!['node_modules', 'dist', 'public', '.git', '.hallmark', '.cloudflare', '.wrangler'].includes(name)) walk(full);
    } else if (isWanted(path)) {
      sources.push({ path, text: readFileSync(full, 'utf8') });
    }
  }
}

walk(root);
mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(join(root, 'public', 'sample.json'), JSON.stringify({ root: 'blueprint.sh', sources }));

const graph = buildGraph(sources, 'blueprint.sh');
const scene = buildScene(graph, { mode: 'files', depth: 2, tests: false, types: false });
const layout = await layoutWith(new ELK(), scene, 'RIGHT');
writeFileSync(join(root, 'public', 'sample-sheet.json'), JSON.stringify({
  scene, layout,
  files: scene.nodes.length, imports: scene.edges.length, cycles: graph.cycles.length,
}));
console.log(`sample.json: ${sources.length} files · sample-sheet.json: ${scene.nodes.length} modules, ${scene.edges.length} imports`);

// Snapshots this repo's own source into public/sample.json so the "draw this
// project" demo always reflects the current code.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isWanted } from '../src/graph.ts';

const root = join(import.meta.dirname, '..');
const sources: { path: string; text: string }[] = [];

function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const path = relative(root, full).split(sep).join('/');
    if (statSync(full).isDirectory()) {
      if (!['node_modules', 'dist', 'public', '.git'].includes(name)) walk(full);
    } else if (isWanted(path)) {
      sources.push({ path, text: readFileSync(full, 'utf8') });
    }
  }
}

walk(root);
mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(join(root, 'public', 'sample.json'), JSON.stringify({ root: 'blueprint.sh', sources }));
console.log(`sample.json: ${sources.length} files`);

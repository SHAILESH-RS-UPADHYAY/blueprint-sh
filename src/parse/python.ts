import type { Specifier } from '../types.ts';
import { lineIndex } from './js.ts';

// Docstrings and comments can quote import statements; blank them first.
const NOISE = /("""|''')[\s\S]*?\1|#[^\n]*/g;
const IMPORT = /^[ \t]*import[ \t]+([\w. \t,]+)$/gm;
const FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm;

const names = (list: string) => list
  .replace(/[()\\\n]/g, ' ')
  .split(',')
  .map((n) => n.trim().split(/\s+as\s+/)[0].trim())
  .filter((n) => n && n !== '*');

// Lines inside `if TYPE_CHECKING:` blocks: those imports never run, like TS `import type`.
function typeCheckingLines(code: string): Set<number> {
  const lines = code.split('\n');
  const out = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*)if\s+(?:[\w.]+\.)?TYPE_CHECKING\s*:\s*$/.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (/^[ \t]*/.exec(lines[j])![0].length <= m[1].length) break;
      out.add(j + 1);
    }
  }
  return out;
}

export function parsePython(text: string): Specifier[] {
  const code = text.replace(NOISE, (t) => t.replace(/[^\n]/g, ' '));
  const lineAt = lineIndex(code);
  const typeOnly = typeCheckingLines(code);
  const kind = (line: number) => (typeOnly.has(line) ? 'type' : 'static');
  const out: Specifier[] = [];
  for (const m of code.matchAll(IMPORT)) {
    const line = lineAt(m.index + m[0].indexOf('import'));
    for (const mod of names(m[1])) out.push({ spec: mod, kind: kind(line), line });
  }
  for (const m of code.matchAll(FROM)) {
    const line = lineAt(m.index + m[0].indexOf('from'));
    out.push({ spec: m[1], kind: kind(line), line, names: names(m[2]) });
  }
  return out.sort((a, b) => a.line - b.line);
}

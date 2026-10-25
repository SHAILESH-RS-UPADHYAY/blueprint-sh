import type { ImportKind, Specifier } from '../types.ts';

// Comments and template-literal bodies are blanked (newlines kept, so line
// numbers survive) before matching. Plain strings stay: they hold the specifiers.
const NOISE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g;
const blank = (s: string) => s.replace(/[^\n]/g, ' ');

const PATTERNS: [RegExp, (m: RegExpExecArray) => ImportKind][] = [
  // import x from 'y' · import { a, type B } from 'y' · import type T from 'y' · import 'y'
  [/(?:^|[\n;{}])\s*import\s+(type\s+)?(?:[\w$*{}\s,]+?\s+from\s*)?(['"])([^'"\n]+)\2/g, (m) => (m[1] ? 'type' : 'static')],
  // export * from 'y' · export { a } from 'y' · export type { T } from 'y'
  [/(?:^|[\n;{}])\s*export\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g, (m) => (m[1] ? 'type' : 'reexport')],
  [/\bimport\s*\(\s*()(['"])([^'"\n]+)\2\s*\)/g, () => 'dynamic'],
  [/(?<![.\w$])require\s*\(\s*()(['"])([^'"\n]+)\2\s*\)/g, () => 'static'],
];

export function scriptBlocks(text: string): string {
  // Vue / Svelte single-file components: only <script> bodies hold imports.
  // Everything else is blanked so line numbers still point at the real file.
  let out = blank(text);
  for (const m of text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const start = m.index + m[1].length;
    out = out.slice(0, start) + m[2] + out.slice(start + m[2].length);
  }
  return out;
}

export function parseJs(text: string): Specifier[] {
  const code = text.replace(NOISE, (t) => (t[0] === '/' || t[0] === '`' ? blank(t) : t));
  const lineAt = lineIndex(code);
  const found = new Map<string, Specifier>();
  for (const [re, kindOf] of PATTERNS) {
    for (const m of code.matchAll(re)) {
      const spec = m[3].trim();
      const kind = kindOf(m);
      const at = m.index + m[0].indexOf(m[2] + m[3]);
      const prev = found.get(spec);
      if (!prev || RANK[kind] > RANK[prev.kind]) found.set(spec, { spec, kind, line: lineAt(at) });
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

// When one file imports the same module several ways, the strongest wins.
export const RANK: Record<ImportKind, number> = { type: 0, dynamic: 1, reexport: 2, static: 3 };

export function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

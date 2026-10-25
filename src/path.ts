// Repo paths are always '/'-separated and relative to the project root.

export const dirname = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export const join = (...parts: string[]) => normalize(parts.filter(Boolean).join('/'));

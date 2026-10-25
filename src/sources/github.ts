import type { Source } from '../types.ts';
import { LIMITS, isWanted } from '../graph.ts';

export interface RepoRef {
  owner: string;
  repo: string;
  ref: string | null;
  subdir: string;
}

export class GithubError extends Error {}

// ponytail: 1,500 files keeps a public repo under ~20 s of raw fetches; drop the folder in for more.
export const GITHUB_MAX_FILES = 1500;

export function parseRepoUrl(input: string): RepoRef | null {
  const s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?$/i.exec(s) ??
    /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  return m ? { owner: m[1], repo: m[2], ref: m[3] ?? null, subdir: m[4] ?? '' } : null;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
interface RepoInfo { default_branch: string }
interface Tree { truncated: boolean; tree: { path: string; type: string; size?: number }[] }

async function getJson<T>(fetcher: Fetcher, url: string): Promise<T> {
  const res = await fetcher(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (res.status === 404) throw new GithubError('Repository not found. It may be private, or the URL may be mistyped.');
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const when = reset ? ` It resets at ${new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '';
    throw new GithubError(`GitHub's hourly limit for anonymous requests is used up.${when} Drop the folder in instead.`);
  }
  if (!res.ok) throw new GithubError(`GitHub answered ${res.status}. Try again, or drop the folder in.`);
  return (await res.json()) as T;
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

export async function fetchRepo(ref: RepoRef, onProgress: (done: number, total: number) => void, fetcher: Fetcher = fetch) {
  const api = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
  const branch = ref.ref ?? (await getJson<RepoInfo>(fetcher, api)).default_branch;
  const tree = await getJson<Tree>(fetcher, `${api}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const prefix = ref.subdir ? `${ref.subdir}/` : '';
  const blobs = tree.tree
    .filter((t) => t.type === 'blob' && t.path.startsWith(prefix) && isWanted(t.path) && (t.size ?? 0) <= LIMITS.bytes);
  const picked = blobs.slice(0, GITHUB_MAX_FILES);
  if (!picked.length) throw new GithubError('No JavaScript, TypeScript or Python files found at that address.');

  const raw = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const sources: Source[] = [];
  let done = 0;
  await pool(picked, 12, async (b) => {
    const res = await fetcher(`${raw}/${b.path.split('/').map(encodeURIComponent).join('/')}`);
    if (res.ok) sources.push({ path: b.path.slice(prefix.length), text: await res.text() });
    onProgress(++done, picked.length);
  });
  sources.sort((a, b) => a.path.localeCompare(b.path));
  return {
    root: ref.subdir ? `${ref.repo}/${ref.subdir}` : ref.repo,
    branch,
    sources,
    left: blobs.length - picked.length,
    truncated: Boolean(tree.truncated),
  };
}

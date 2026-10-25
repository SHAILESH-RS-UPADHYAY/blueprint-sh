import { dirname, join, normalize } from './path.ts';

export type Resolution =
  | { kind: 'internal'; target: string }
  | { kind: 'external' | 'builtin'; target: string }
  | { kind: 'asset' | 'unresolved'; target: string };

export interface AliasConfig {
  dir: string;
  baseUrl: string | null;
  paths: [pattern: string, targets: string[]][];
}

const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];
const ASSET = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|json|md|mdx|txt|html?|wasm|glsl|frag|vert|ya?ml|toml|csv|mp4|webm|mp3|wav)$/i;

const NODE_BUILTINS = new Set(('assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel ' +
  'dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl ' +
  'stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib').split(' '));

// ponytail: common stdlib top-level names, not all ~300; a miss just shows up as an external package.
const PY_STDLIB = new Set(('__future__ abc argparse array ast asyncio atexit base64 binascii bisect builtins bz2 calendar cmath ' +
  'codecs collections colorsys concurrent configparser contextlib contextvars copy copyreg csv ctypes curses dataclasses datetime ' +
  'dbm decimal difflib dis doctest email encodings enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib ' +
  'functools gc getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib importlib inspect io ' +
  'ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap multiprocessing netrc ' +
  'numbers operator optparse os pathlib pdb pickle pkgutil platform plistlib poplib posix pprint profile pstats pty pwd ' +
  'py_compile queue quopri random re readline reprlib resource runpy sched secrets select selectors shelve shlex shutil ' +
  'signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess sys sysconfig ' +
  'syslog tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc ' +
  'tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg wsgiref xml xmlrpc ' +
  'zipapp zipfile zipimport zlib zoneinfo typing_extensions _typeshed').split(' '));

export const packageName = (spec: string) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

// tsconfig/jsconfig allow comments and trailing commas.
export function readAliasConfig(path: string, text: string): AliasConfig | null {
  try {
    const json = JSON.parse(text
      .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? m.replace(/[^\n]/g, ''))
      .replace(/,(\s*[}\]])/g, '$1'));
    const co = json?.compilerOptions ?? {};
    const dir = dirname(path);
    const paths = Object.entries(co.paths ?? {})
      .filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every((t) => typeof t === 'string'));
    return { dir, baseUrl: typeof co.baseUrl === 'string' ? join(dir, co.baseUrl) : null, paths };
  } catch {
    return null;
  }
}

export function createResolver(fileList: Iterable<string>, configs: AliasConfig[]) {
  const files = new Set(fileList);
  const byDir = new Map<string, AliasConfig>();
  for (const c of configs) {
    const prev = byDir.get(c.dir);
    // Vite-style projects split options across tsconfig.json / tsconfig.app.json: merge them.
    byDir.set(c.dir, prev ? { dir: c.dir, baseUrl: prev.baseUrl ?? c.baseUrl, paths: [...prev.paths, ...c.paths] } : c);
  }

  const configFor = (from: string) => {
    for (let d = dirname(from); ; d = dirname(d)) {
      const c = byDir.get(d);
      if (c) return c;
      if (!d) return null;
    }
  };

  function probe(base: string): string | null {
    if (files.has(base)) return base;
    // TS ESM style: `import './util.js'` points at util.ts.
    const stem = base.replace(/\.(?:m|c)?jsx?$/, '');
    for (const s of stem === base ? [base] : [stem, base]) {
      for (const ext of JS_EXT) if (files.has(s + ext)) return s + ext;
      const index = s ? `${s}/index` : 'index'; // `require('../../')` can mean the repo root
      for (const ext of JS_EXT) if (files.has(index + ext)) return index + ext;
    }
    return null;
  }

  function js(from: string, raw: string): Resolution {
    const spec = raw.replace(/[?#].*$/, ''); // Vite suffixes: ?raw, ?url, ?worker
    const local = (path: string): Resolution => {
      const hit = probe(path);
      if (hit) return { kind: 'internal', target: hit };
      return { kind: ASSET.test(spec) ? 'asset' : 'unresolved', target: spec };
    };
    if (spec.startsWith('.')) return local(join(dirname(from), spec));
    if (spec.startsWith('/')) return local(normalize(spec));

    const cfg = configFor(from);
    if (cfg) {
      for (const [pattern, targets] of cfg.paths) {
        const star = pattern.indexOf('*');
        let rest: string | null = null;
        if (star < 0) rest = spec === pattern ? '' : null;
        else {
          const pre = pattern.slice(0, star), post = pattern.slice(star + 1);
          if (spec.length >= pre.length + post.length && spec.startsWith(pre) && spec.endsWith(post)) {
            rest = spec.slice(pre.length, spec.length - post.length);
          }
        }
        if (rest === null) continue;
        for (const t of targets) {
          const hit = probe(join(cfg.baseUrl ?? cfg.dir, t.replace('*', rest)));
          if (hit) return { kind: 'internal', target: hit };
        }
      }
      if (cfg.baseUrl !== null) {
        const hit = probe(join(cfg.baseUrl, spec));
        if (hit) return { kind: 'internal', target: hit };
      }
    }
    // Conventional aliases (@/, ~/, #/) when no config covers them.
    const alias = /^[@~#]\/(.+)$/.exec(spec);
    if (alias) {
      for (const base of ['src', '']) {
        const hit = probe(join(base, alias[1]));
        if (hit) return { kind: 'internal', target: hit };
      }
    }
    const bare = spec.replace(/^node:/, '');
    if (spec.startsWith('node:') || NODE_BUILTINS.has(bare.split('/')[0])) return { kind: 'builtin', target: bare.split('/')[0] };
    return { kind: 'external', target: packageName(spec) };
  }

  /* ── Python ── */

  const pyFile = (modPath: string) =>
    files.has(`${modPath}.py`) ? `${modPath}.py` : files.has(`${modPath}/__init__.py`) ? `${modPath}/__init__.py` : null;

  // Every dotted suffix of every module path, so `app.models` finds src/app/models.py.
  const pyIndex = new Map<string, string[]>();
  for (const f of files) {
    if (!f.endsWith('.py')) continue;
    const parts = f.slice(0, -3).split('/');
    if (parts[parts.length - 1] === '__init__') parts.pop();
    for (let i = 0; i < parts.length; i++) {
      const dotted = parts.slice(i).join('.');
      if (!dotted) continue;
      const list = pyIndex.get(dotted);
      if (list) list.push(f); else pyIndex.set(dotted, [f]);
    }
  }

  const shared = (a: string, b: string) => {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  };

  function pyAbsolute(from: string, dotted: string): string | null {
    const hits = pyIndex.get(dotted);
    if (!hits) return null;
    if (hits.length === 1) return hits[0];
    const rootOf = (f: string) => {
      const depth = dotted.split('.').length + (f.endsWith('/__init__.py') ? 1 : 0);
      return f.split('/').slice(0, -depth).join('/');
    };
    // Prefer modules rooted at the repo root or src/, then the one nearest the importer.
    return [...hits].sort((a, b) => {
      const ra = ['', 'src'].includes(rootOf(a)) ? 1 : 0, rb = ['', 'src'].includes(rootOf(b)) ? 1 : 0;
      return rb - ra || shared(b, from) - shared(a, from);
    })[0];
  }

  function py(from: string, spec: string, names: string[] = []): Resolution[] {
    const dots = /^\.*/.exec(spec)![0].length;
    const rest = spec.slice(dots);
    let module: string | null;
    if (dots) {
      let dir = dirname(from);
      for (let i = 1; i < dots; i++) dir = dirname(dir);
      module = rest ? pyFile(join(dir, rest.replace(/\./g, '/'))) : pyFile(dir);
    } else {
      module = pyAbsolute(from, rest);
    }
    if (!module) {
      if (dots) return [{ kind: 'unresolved', target: spec }];
      const top = rest.split('.')[0];
      return [{ kind: PY_STDLIB.has(top) ? 'builtin' : 'external', target: top }];
    }
    // `from pkg import a, b`: a and b may be submodules rather than attributes.
    const out: Resolution[] = [];
    let attribute = names.length === 0;
    if (module.endsWith('__init__.py')) {
      for (const n of names) {
        const sub = pyFile(join(dirname(module), n));
        if (sub) out.push({ kind: 'internal', target: sub });
        else attribute = true;
      }
    } else attribute = true;
    if (attribute && module !== from) out.push({ kind: 'internal', target: module });
    return out;
  }

  return { js, py };
}

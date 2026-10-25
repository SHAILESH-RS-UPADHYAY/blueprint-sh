import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJs } from './parse/js.ts';
import { parsePython } from './parse/python.ts';
import { buildGraph, folderView, stripCommonRoot, stronglyConnected, suggestDepth } from './graph.ts';
import { GithubError, fetchRepo, parseRepoUrl } from './sources/github.ts';
import type { Source } from './types.ts';
import { buildScene } from './scene.ts';

const src = (files: Record<string, string>): Source[] => Object.entries(files).map(([path, text]) => ({ path, text }));
const edgeSet = (g: ReturnType<typeof buildGraph>) => g.edges.map((e) => `${e.from} -> ${e.to} [${e.kind}${e.cycle ? ',cycle' : ''}]`).sort();

test('parseJs: every import form, strongest kind wins, comments and templates ignored', () => {
  const specs = parseJs(`
// import nope from './commented'
/* import also from './block' */
import def, {
  a,
  type B,
} from './multi';
import type { T } from './types';
import './side-effect.css';
export * from './barrel';
export { x as y } from "./named";
export type { Z } from './z-types';
const lazy = () => import('./lazy');
const cjs = require('./cjs');
const tpl = \`import fake from './template'\`;
obj.require('./method-call');
import type { Again } from './multi';
`);
  assert.deepEqual(specs.map((s) => [s.spec, s.kind, s.line]), [
    ['./multi', 'static', 7],
    ['./types', 'type', 8],
    ['./side-effect.css', 'static', 9],
    ['./barrel', 'reexport', 10],
    ['./named', 'reexport', 11],
    ['./z-types', 'type', 12],
    ['./lazy', 'dynamic', 13],
    ['./cjs', 'static', 14],
  ]);
});

test('parsePython: plain, aliased, relative, parenthesised; docstrings and comments ignored', () => {
  const specs = parsePython(`"""
import fake_in_docstring
"""
import os, sys as system
import pkg.sub.mod  # trailing comment
# import commented
from . import models, utils as u
from ..core import (
    Engine,
    Session as S,
)
from __future__ import annotations
    import indented_inside_function
`);
  assert.deepEqual(specs.map((s) => [s.spec, s.names ?? null]), [
    ['os', null], ['sys', null], ['pkg.sub.mod', null],
    ['.', ['models', 'utils']], ['..core', ['Engine', 'Session']], ['__future__', ['annotations']],
    ['indented_inside_function', null],
  ]);
});

test('TS repo: tsconfig paths, .js→.ts, index files, Vue scripts, assets, externals, cycles, roles', () => {
  const g = buildGraph(src({
    'tsconfig.json': `{ // comments and trailing commas are legal here
      "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*"], }, },
    }`,
    'src/main.ts': `import { App } from '@app/App';\nimport './styles.css';\nimport type { Cfg } from './config';\nimport React from 'react';\nimport fs from 'node:fs';\nimport { join } from 'path';\nconst lazy = () => import('./lazy');`,
    'src/app/App.tsx': `import { util } from '../lib/util.js';\nexport * from './widgets';\nimport { missing } from './missing';`,
    'src/app/widgets/index.ts': `import { App } from '../App';\nimport clsx from 'clsx';\nimport { q } from '@tanstack/react-query/build';`,
    'src/lib/util.ts': `export const s = "import y from './fake'";`,
    'src/config.ts': `import type { App } from './app/App';\nexport type Cfg = {};`,
    'src/lazy.ts': 'export default 1;',
    'src/orphan.ts': 'export {};',
    'src/app/App.test.tsx': `import { App } from './App';`,
    'components/Card.vue': `<template><div/></template>\n<script setup lang="ts">\nimport { util } from '@/lib/util'\n</script>`,
    'node_modules/react/index.js': `module.exports = {}`,
    'dist/app.js': `import './src/main'`,
    'README.md': '# not code',
  }), 'demo');

  assert.deepEqual(edgeSet(g), [
    'components/Card.vue -> src/lib/util.ts [static]',
    'src/app/App.test.tsx -> src/app/App.tsx [static]',
    'src/app/App.tsx -> src/app/widgets/index.ts [reexport,cycle]',
    'src/app/App.tsx -> src/lib/util.ts [static]',
    'src/app/widgets/index.ts -> src/app/App.tsx [static,cycle]',
    'src/config.ts -> src/app/App.tsx [type]',
    'src/main.ts -> src/app/App.tsx [static]',
    'src/main.ts -> src/config.ts [type]',
    'src/main.ts -> src/lazy.ts [dynamic]',
  ]);
  assert.deepEqual(g.cycles, [['src/app/App.tsx', 'src/app/widgets/index.ts']]);
  assert.deepEqual(g.externals, [{ name: '@tanstack/react-query', count: 1 }, { name: 'clsx', count: 1 }, { name: 'react', count: 1 }]);
  const main = g.files.find((f) => f.id === 'src/main.ts')!;
  assert.deepEqual(main.builtins, ['fs', 'path']);
  assert.deepEqual(g.unresolved.map((u) => [u.from, u.spec, u.line]), [['src/app/App.tsx', './missing', 3]]);
  assert.deepEqual(g.entries, ['components/Card.vue', 'src/main.ts']);
  assert.deepEqual(g.orphans, ['src/orphan.ts']);
  assert.equal(g.files.find((f) => f.id === 'src/app/App.test.tsx')!.test, true);
  assert.equal(g.files.length, 9);
  assert.equal(g.root, 'demo');
});

test('Python repo: src root, relative and absolute imports, submodules via from-import, cycles', () => {
  const g = buildGraph(src({
    'src/shop/__init__.py': 'from .models import Order\n',
    'src/shop/models.py': 'import datetime\nfrom shop.db import session\n',
    'src/shop/db.py': 'import sqlalchemy\nfrom . import models\n',
    'src/shop/api/__init__.py': '',
    'src/shop/api/routes.py': '"""\nimport fake\n"""\nfrom ..models import Order\nfrom ..utils import helpers\n# import nope\n',
    'tests/test_models.py': 'from shop.models import Order\nimport pytest\n',
  }));
  assert.deepEqual(edgeSet(g), [
    'src/shop/__init__.py -> src/shop/models.py [static]',
    'src/shop/api/routes.py -> src/shop/models.py [static]',
    'src/shop/db.py -> src/shop/models.py [static,cycle]',
    'src/shop/models.py -> src/shop/db.py [static,cycle]',
    'tests/test_models.py -> src/shop/models.py [static]',
  ]);
  assert.deepEqual(g.unresolved.map((u) => u.spec), ['..utils']);
  assert.deepEqual(g.externals.map((x) => x.name), ['pytest', 'sqlalchemy']);
  assert.deepEqual(g.files.find((f) => f.id === 'src/shop/models.py')!.builtins, ['datetime']);
  assert.equal(g.files.find((f) => f.id === 'tests/test_models.py')!.test, true);
});

test('Python TYPE_CHECKING imports are type-only and never form a cycle', () => {
  const g = buildGraph(src({
    'pkg/__init__.py': '',
    'pkg/app.py': 'from .ctx import Context\n',
    'pkg/ctx.py': 'import typing as t\nif t.TYPE_CHECKING:\n    from .app import App\n\n    import pkg.app\nelse:\n    from . import app\n',
  }));
  assert.deepEqual(edgeSet(g), ['pkg/app.py -> pkg/ctx.py [static,cycle]', 'pkg/ctx.py -> pkg/app.py [static,cycle]']);
  const g2 = buildGraph(src({
    'pkg/__init__.py': '',
    'pkg/app.py': 'from .ctx import Context\n',
    'pkg/ctx.py': 'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from .app import App\nx = 1\n',
  }));
  assert.deepEqual(edgeSet(g2), ['pkg/app.py -> pkg/ctx.py [static]', 'pkg/ctx.py -> pkg/app.py [type]']);
  assert.deepEqual(g2.cycles, []);
});

test('minified, oversized and ignored files are skipped with reasons', () => {
  const g = buildGraph(src({
    'src/a.ts': `import './vendor.min.js'`,
    'src/vendor.min.js': 'var a=1;',
    'src/bundle.js': `${'x'.repeat(6000)}`,
    'src/huge.ts': `// ${'y'.repeat(1_000_001)}`,
    '.venv/lib/x.py': 'import os',
  }));
  assert.deepEqual(g.files.map((f) => f.id), ['src/a.ts']);
  assert.deepEqual(g.skipped.map((s) => [s.path, s.reason]), [
    ['src/vendor.min.js', 'minified or generated'],
    ['src/bundle.js', 'minified or generated'],
    ['src/huge.ts', 'larger than 1 MB'],
  ]);
});

test('stronglyConnected survives a 5,000-node ring without recursion', () => {
  const ids = Array.from({ length: 5000 }, (_, i) => `f${i}`);
  const adj = new Map(ids.map((id, i) => [id, [ids[(i + 1) % ids.length]]]));
  const comps = stronglyConnected(ids, adj);
  assert.equal(comps.length, 1);
  assert.equal(comps[0].length, 5000);
});

test('folderView aggregates edges between folders; suggestDepth finds a useful split', () => {
  const g = buildGraph(src({
    'src/ui/a.ts': `import '../core/b'; import '../core/c';`,
    'src/ui/d.ts': `import '../core/b';`,
    'src/core/b.ts': `import '../ui/a';`,
    'src/core/c.ts': '',
    'src/util/e.ts': '',
    'src/api/f.ts': `import '../util/e';`,
  }));
  const v = folderView(g, 2);
  assert.deepEqual(v.nodes.map((n) => [n.id, n.files, n.cycle]).sort(), [
    ['src/api', 1, false], ['src/core', 2, true], ['src/ui', 2, true], ['src/util', 1, false],
  ]);
  assert.deepEqual(v.edges.map((e) => [e.from, e.to, e.count, e.cycle]).sort(), [
    ['src/api', 'src/util', 1, false], ['src/core', 'src/ui', 1, true], ['src/ui', 'src/core', 3, true],
  ]);
  assert.equal(suggestDepth(g), 2);
});

test('stripCommonRoot removes the dropped folder name', () => {
  const out = stripCommonRoot(src({ 'my-app/src/a.ts': '', 'my-app/package.json': '' }));
  assert.equal(out.root, 'my-app');
  assert.deepEqual(out.sources.map((s) => s.path), ['src/a.ts', 'package.json']);
  assert.equal(stripCommonRoot(src({ 'a.ts': '', 'lib/b.ts': '' })).root, '');
});

test('parseRepoUrl accepts the shapes people paste', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/expressjs/express'), { owner: 'expressjs', repo: 'express', ref: null, subdir: '' });
  assert.deepEqual(parseRepoUrl('github.com/vitejs/vite/tree/main/packages/vite/'), { owner: 'vitejs', repo: 'vite', ref: 'main', subdir: 'packages/vite' });
  assert.deepEqual(parseRepoUrl('pallets/flask.git'), { owner: 'pallets', repo: 'flask', ref: null, subdir: '' });
  assert.equal(parseRepoUrl('https://gitlab.com/a/b'), null);
  assert.equal(parseRepoUrl('not a url'), null);
});

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

test('fetchRepo walks the tree, filters to source, fetches raw files', async () => {
  const seen: string[] = [];
  const fetcher = async (url: string) => {
    seen.push(url);
    if (url.endsWith('/repos/o/r')) return reply({ default_branch: 'dev/next' });
    if (url.includes('/git/trees/')) {
      return reply({
        truncated: false,
        tree: [
          { path: 'lib/a.js', type: 'blob', size: 20 },
          { path: 'lib/b.ts', type: 'blob', size: 20 },
          { path: 'node_modules/x/index.js', type: 'blob', size: 5 },
          { path: 'logo.png', type: 'blob', size: 5 },
          { path: 'lib', type: 'tree' },
          { path: 'tsconfig.json', type: 'blob', size: 5 },
        ],
      });
    }
    return reply(`// ${url.split('/').pop()}`);
  };
  const progress: number[] = [];
  const out = await fetchRepo({ owner: 'o', repo: 'r', ref: null, subdir: '' }, (d) => progress.push(d), fetcher);
  assert.deepEqual(out.sources.map((s) => s.path), ['lib/a.js', 'lib/b.ts', 'tsconfig.json']);
  assert.equal(out.branch, 'dev/next');
  assert.deepEqual(progress.sort(), [1, 2, 3]);
  assert.ok(seen.includes('https://api.github.com/repos/o/r/git/trees/dev%2Fnext?recursive=1'));
  assert.ok(seen.includes('https://raw.githubusercontent.com/o/r/dev/next/lib/a.js'));
});

test('fetchRepo explains rate limits and missing repos', async () => {
  const limited = async () => reply({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-reset': '1767225600' });
  await assert.rejects(fetchRepo({ owner: 'o', repo: 'r', ref: 'main', subdir: '' }, () => {}, limited),
    (e: Error) => e instanceof GithubError && /hourly limit/.test(e.message) && /resets at/.test(e.message));
  const missing = async () => reply({ message: 'Not Found' }, 404);
  await assert.rejects(fetchRepo({ owner: 'o', repo: 'r', ref: null, subdir: '' }, () => {}, missing), /Repository not found/);
});

test('folder scene never references hidden files (tests off)', () => {
  const g = buildGraph(src({ 'index.js': '', 'lib/a.js': "require('../index')", 'test/a.test.js': "require('../lib/a'); require('../index')" }));
  const s = buildScene(g, { mode: 'folders', depth: 1, tests: false, types: true });
  const ids = new Set(s.nodes.map((n) => n.id));
  assert.ok(s.edges.every((e) => ids.has(e.from) && ids.has(e.to)), JSON.stringify(s.edges));
  assert.deepEqual([...ids].sort(), ['lib', '·']);
});

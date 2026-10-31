import type { Graph, Source } from './types.ts';
import { buildGraph, suggestDepth } from './graph.ts';
import { layout, type LayoutResult } from './layout.ts';
import { buildScene, type Scene, type SceneOptions } from './scene.ts';
import { draw, type Drawing } from './render.ts';
import { fromDrop, fromPicker } from './sources/local.ts';
import { GITHUB_MAX_FILES, GithubError, fetchRepo, parseRepoUrl } from './sources/github.ts';
import { exportJson, exportMermaid, exportPng, exportSvg } from './export.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const FILE_VIEW_LIMIT = 350;

let graph: Graph | null = null;
let scene: Scene | null = null;
let drawing: Drawing | null = null;
let autoMode = false;
let userFlipped = false;
let direction: 'RIGHT' | 'DOWN' = innerWidth < 820 ? 'DOWN' : 'RIGHT';
const opts: SceneOptions = { mode: 'files', depth: 2, tests: false, types: false };

/* ── Small helpers ── */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n: number) => n.toLocaleString('en-US');

function busy(text: string | null) {
  $('drafting').hidden = text === null;
  if (text) $('drafting-text').textContent = text;
}

function fail(message: string) {
  busy(null);
  showIntake();
  const e = $('error');
  e.textContent = message;
  e.hidden = false;
}

function showIntake() {
  document.body.dataset.view = 'intake';
  $('intake').hidden = false;
  $('board').hidden = true;
  $('tools').hidden = true;
  setTitleBlock(null);
}

function setTitleBlock(g: Graph | null) {
  $('tb-project').textContent = g?.root ?? 'None yet';
  $('tb-sheet').textContent = g ? '01 / 01' : '00';
  $('tb-files').textContent = g ? num(g.files.length) : '0';
  $('tb-edges').textContent = g ? num(g.edges.length) : '0';
  $('tb-cycles').textContent = g ? String(g.cycles.length) : '0';
  $('tb-cycles').classList.toggle('bad', !!g?.cycles.length);
  if (!g) $('tb-scale').textContent = 'None';
  $('tb-date').textContent = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
}

/* ── Loading a project ── */
async function open(load: () => Promise<{ root: string; sources: Source[] } | null>, label: string) {
  $('error').hidden = true;
  busy(label);
  try {
    const got = await load();
    if (!got) return busy(null);
    busy(`Parsing ${num(got.sources.length)} files`);
    await new Promise((r) => setTimeout(r, 20));
    const g = buildGraph(got.sources, got.root || 'project');
    if (!g.files.length) return fail('No JavaScript, TypeScript or Python files found there. Blueprint.sh reads .js .jsx .ts .tsx .mjs .cjs .vue .svelte and .py.');
    graph = g;
    const visible = g.files.filter((f) => !f.test).length;
    opts.mode = visible > FILE_VIEW_LIMIT ? 'folders' : 'files';
    autoMode = opts.mode === 'files';
    opts.depth = opts.mode === 'folders' ? readableDepth(g) : suggestDepth(g);
    ($('depth') as HTMLSelectElement).value = String(Math.min(opts.depth, 4));
    await swap(showBoard);
    await redraw();
  } catch (err) {
    fail(err instanceof GithubError ? err.message : `Something went wrong while reading the project: ${(err as Error).message}`);
  }
}

// A new sheet crossfades in where the browser supports view transitions.
function swap(change: () => void): Promise<void> {
  const d = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
  if (!d.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    change();
    return Promise.resolve();
  }
  return d.startViewTransition(change).finished.catch(() => {});
}

function showBoard() {
  document.body.dataset.view = 'drawing';
  $('intake').hidden = true;
  $('board').hidden = false;
  $('tools').hidden = false;
  $('project-name').textContent = graph!.root;
  setTitleBlock(graph);
  renderNotes();
  syncControls();
  ($('node-list') as HTMLDataListElement).replaceChildren(...graph!.files.map((f) => Object.assign(document.createElement('option'), { value: f.id })));
}

function syncControls() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.seg button')) b.setAttribute('aria-checked', String(b.dataset.mode === opts.mode));
  $('depth-wrap').hidden = opts.mode !== 'folders';
  ($('opt-tests') as HTMLInputElement).checked = opts.tests;
  ($('opt-types') as HTMLInputElement).checked = opts.types;
}

async function redraw() {
  if (!graph) return;
  select(null);
  scene = buildScene(graph, opts);
  if (!scene.nodes.length) return fail('Nothing left to draw with these filters. Turn tests back on.');
  busy(`Laying out ${num(scene.nodes.length)} ${scene.mode === 'files' ? 'modules' : 'folders'}`);
  try {
    let lay = await layout(scene, direction);
    // A wide, flat repo reads better top-down and a deep one left-right: try both when the fit is poor.
    if (!userFlipped && fitScale(lay) < 0.6) {
      const alt = direction === 'RIGHT' ? 'DOWN' : 'RIGHT';
      const other = await layout(scene, alt);
      if (fitScale(other) > fitScale(lay) * 1.15) {
        lay = other;
        direction = alt;
      }
    }
    drawing?.destroy();
    drawing = draw($('canvas'), scene, lay, {
      onSelect: (id) => select(id),
      insets,
      onScale: (k) => ($('tb-scale').textContent = k >= 1 ? `${(k).toFixed(2)} : 1` : `1 : ${(1 / k).toFixed(2)}`),
    });
    // Too small to read file by file: fall back to folders once, and say so.
    if (autoMode && opts.mode === 'files' && drawing.scale() < 0.36) {
      autoMode = false;
      opts.mode = 'folders';
      opts.depth = readableDepth(graph);
      ($('depth') as HTMLSelectElement).value = String(opts.depth);
      syncControls();
      const note = document.createElement('p');
      note.className = 'switched';
      note.textContent = `${num(scene.nodes.length)} files are too many to read at once, so this sheet starts at folder level. Choose Files to see every module.`;
      $('notes').querySelector('h2')!.after(note);
      return redraw();
    }
    autoMode = false;
    busy(null);
  } catch (err) {
    fail(`The layout engine gave up: ${(err as Error).message}. Try the Folders view.`);
  }
}

// Deepest folder level that still fits on one readable sheet (≤ 24 boxes).
function readableDepth(g: Graph) {
  let depth = 1;
  for (let d = 2; d <= 4; d++) {
    if (buildScene(g, { ...opts, mode: 'folders', depth: d }).nodes.length > 24) break;
    depth = d;
  }
  return depth;
}

function insets() {
  const wide = innerWidth > 820;
  return { left: wide ? $('notes').offsetWidth + 32 : 16, right: wide ? 64 : 16, top: 16, bottom: $('titleblock').offsetHeight + 32 };
}

function fitScale(lay: LayoutResult) {
  const r = $('canvas').getBoundingClientRect();
  const i = insets();
  return Math.min((r.width - i.left - i.right) / Math.max(lay.width, 1), (r.height - i.top - i.bottom) / Math.max(lay.height + 24, 1));
}

/* ── Field notes ── */
function renderNotes() {
  const g = graph!;
  const testIds = new Set(g.files.filter((f) => f.test).map((f) => f.id));
  const unresolved = g.unresolved.filter((u) => !testIds.has(u.from));
  const hot = [...g.files].filter((f) => f.fanIn > 1).sort((a, b) => b.fanIn - a.fanIn).slice(0, 6);
  const item = (id: string, right: string, cls = '') => `<li><button type="button" data-goto="${esc(id)}" title="${esc(id)}"><span class="${cls}">${esc(id)}</span><span class="n">${esc(right)}</span></button></li>`;
  $('notes').innerHTML = `
    <h2>Field notes</h2>
    <div class="tally">
      <div class="${g.cycles.length ? 'bad' : ''}"><b>${g.cycles.length}</b><span>cycles</span></div>
      <div><b>${g.entries.length}</b><span>entries</span></div>
      <div><b>${g.externals.length}</b><span>packages</span></div>
    </div>
    ${g.cycles.length ? `<h3>Import cycles</h3><ul>${g.cycles.slice(0, 6).map((c) => item(c[0], `${c.length} files`, 'cyc')).join('')}</ul>` : '<h3>Import cycles</h3><p>None. Every import points one way.</p>'}
    ${hot.length ? `<h3>Most imported</h3><ul>${hot.map((f) => item(f.id, `${f.fanIn}×`)).join('')}</ul>` : ''}
    ${g.externals.length ? `<h3>Packages</h3><p>${g.externals.slice(0, 14).map((x) => `${esc(x.name)} <span class="n">${x.count}</span>`).join(', ')}${g.externals.length > 14 ? `, and ${g.externals.length - 14} more` : ''}</p>` : ''}
    ${unresolved.length ? `<h3>Unresolved</h3><ul>${unresolved.slice(0, 5).map((u) => item(u.from, `'${u.spec}'`)).join('')}</ul>` : ''}
    ${g.skipped.length ? `<h3>Skipped</h3><p>${g.skipped.length} file${g.skipped.length > 1 ? 's' : ''}: ${esc(g.skipped.slice(0, 3).map((s) => `${s.path} (${s.reason})`).join('; '))}${g.skipped.length > 3 ? '…' : ''}</p>` : ''}`;
}

/* ── Spec sheet ── */
function select(id: string | null) {
  drawing?.focus(id);
  const spec = $('spec');
  if (!id || !graph) {
    spec.hidden = true;
    return;
  }
  if (opts.mode === 'folders') {
    const files = graph.files.filter((f) => f.dir === id || f.dir.startsWith(`${id}/`));
    spec.innerHTML = `<div class="spec-head"><h2>${esc(id.split('/').pop()!)}/</h2>${closeBtn}</div><p class="path">${esc(id)}</p>
      <dl><div><dt>Files</dt><dd>${files.length}</dd></div><div><dt>Loc</dt><dd>${num(files.reduce((n, f) => n + f.loc, 0))}</dd></div>
      <div><dt>In</dt><dd>${scene!.edges.filter((e) => e.to === id).length}</dd></div><div><dt>Out</dt><dd>${scene!.edges.filter((e) => e.from === id).length}</dd></div></dl>
      <h3>Files</h3><ul>${files.slice(0, 40).map((f) => `<li><button type="button" data-file="${esc(f.id)}"><span>${esc(f.id.slice(id.length + 1))}</span><span class="kind">${f.fanIn}×</span></button></li>`).join('')}</ul>`;
    spec.hidden = false;
    return;
  }
  const f = graph.files.find((x) => x.id === id);
  if (!f) return;
  const outs = graph.edges.filter((e) => e.from === id);
  const ins = graph.edges.filter((e) => e.to === id);
  const row = (target: string, kind: string, line?: number) =>
    `<li><button type="button" data-goto="${esc(target)}" title="${esc(target)}"><span>${esc(target)}</span><span class="kind">${kind}${line ? `, line ${line}` : ''}</span></button></li>`;
  const cycle = f.cycle >= 0 ? graph.cycles[f.cycle] : null;
  spec.innerHTML = `
    <div class="spec-head"><h2>${esc(f.name)}</h2>${closeBtn}</div>
    <p class="path">${esc(f.id)}${f.test ? ' (test)' : ''}</p>
    <dl><div><dt>Loc</dt><dd>${num(f.loc)}</dd></div><div><dt>In</dt><dd>${f.fanIn}</dd></div><div><dt>Out</dt><dd>${f.fanOut}</dd></div><div><dt>Lang</dt><dd>${f.lang.toUpperCase()}</dd></div></dl>
    ${cycle ? `<p class="warn">In an import cycle with ${cycle.length - 1} other file${cycle.length > 2 ? 's' : ''}: ${esc(cycle.filter((c) => c !== id).slice(0, 3).join(', '))}${cycle.length > 4 ? '…' : ''}</p>` : ''}
    <h3>Imports</h3>${outs.length ? `<ul>${outs.map((e) => row(e.to, e.kind, e.line)).join('')}</ul>` : '<p class="empty">No local imports.</p>'}
    <h3>Imported by</h3>${ins.length ? `<ul>${ins.map((e) => row(e.from, e.kind)).join('')}</ul>` : `<p class="empty">${graph.entries.includes(id) ? 'Nothing. This is an entry point.' : 'Nothing imports this file.'}</p>`}
    ${f.externals.length ? `<h3>Packages</h3><div class="chips">${f.externals.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
    ${f.builtins.length ? `<h3>Built-ins</h3><div class="chips">${f.builtins.map((x) => `<span>${esc(x)}</span>`).join('')}</div>` : ''}`;
  spec.hidden = false;
}

const closeBtn = '<button type="button" class="icon-btn close" data-close aria-label="Close spec sheet"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15"/></svg></button>';

function goTo(id: string) {
  if (!graph || !scene) return;
  if (opts.mode === 'folders') {
    opts.mode = 'files';
    syncControls();
    void redraw().then(() => goTo(id));
    return;
  }
  if (!scene.nodes.some((n) => n.id === id)) {
    opts.tests = true;
    syncControls();
    void redraw().then(() => goTo(id));
    return;
  }
  drawing?.zoomTo(id);
  select(id);
}

/* ── Wiring ── */
const drop = $('drop');
for (const t of ['dragenter', 'dragover']) addEventListener(t, (e) => { e.preventDefault(); if (document.body.dataset.view === 'intake') drop.classList.add('over'); });
addEventListener('dragleave', (e) => { if (!(e as DragEvent).relatedTarget) drop.classList.remove('over'); });
addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const items = (e as DragEvent).dataTransfer?.items;
  if (items?.length) void open(() => fromDrop(items), 'Reading the folder');
});
$('pick').addEventListener('click', () => void open(fromPicker, 'Reading the folder'));

function openRepo(input: string) {
  const ref = parseRepoUrl(input);
  if (!ref) return fail('That does not look like a GitHub repository. Use github.com/owner/repo or owner/repo.');
  history.replaceState(null, '', `#gh=${ref.owner}/${ref.repo}${ref.subdir ? `/tree/${ref.ref}/${ref.subdir}` : ''}`);
  void open(async () => {
    const r = await fetchRepo(ref, (done, total) => busy(`Fetching ${num(done)} / ${num(total)} files from GitHub`));
    if (r.left > 0) setTimeout(() => {
      const note = document.createElement('p');
      note.innerHTML = `Drew the first ${num(GITHUB_MAX_FILES)} source files; ${num(r.left)} more were left out. Drop the folder in to draw everything.`;
      $('notes').append(note);
    }, 0);
    return r;
  }, `Asking GitHub about ${ref.owner}/${ref.repo}`);
}
$('gh-form').addEventListener('submit', (e) => { e.preventDefault(); openRepo(($('gh-url') as HTMLInputElement).value); });
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-repo]')) b.addEventListener('click', () => { ($('gh-url') as HTMLInputElement).value = b.dataset.repo!; openRepo(b.dataset.repo!); });
const openSample = () => {
  history.replaceState(null, '', '#sample');
  void open(async () => {
    const res = await fetch('/sample.json');
    if (!res.ok) throw new Error('the sample snapshot is missing; run npm run sample');
    return (await res.json()) as { root: string; sources: Source[] };
  }, 'Unrolling the sample sheet');
};
$('sample').addEventListener('click', openSample);
document.querySelector('[data-open-sample]')?.addEventListener('click', openSample);

/* The intake's plate: this repository's own sheet, laid out at build time and plotted here. */
fetch('/sample-sheet.json')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  .then((s: { scene: Scene; layout: LayoutResult; files: number; imports: number }) => {
    $('plate-stats').textContent = `${s.files} modules and ${s.imports} imports`;
    draw($('sample-plate'), s.scene, s.layout, { interactive: false, onSelect: () => {}, onScale: () => {}, insets: () => ({ left: 24, right: 24, top: 32, bottom: 24 }) });
  })
  .catch(() => document.querySelector('.plate')?.setAttribute('hidden', ''));

for (const b of document.querySelectorAll<HTMLButtonElement>('.seg button')) b.addEventListener('click', () => { opts.mode = b.dataset.mode as SceneOptions['mode']; syncControls(); void redraw(); });
$('depth').addEventListener('change', (e) => { opts.depth = Number((e.target as HTMLSelectElement).value); void redraw(); });
$('opt-tests').addEventListener('change', (e) => { opts.tests = (e.target as HTMLInputElement).checked; void redraw(); });
$('opt-types').addEventListener('change', (e) => { opts.types = (e.target as HTMLInputElement).checked; void redraw(); });
$('flip').addEventListener('click', () => { userFlipped = true; direction = direction === 'RIGHT' ? 'DOWN' : 'RIGHT'; void redraw(); });
$('new').addEventListener('click', () => { history.replaceState(null, '', location.pathname); graph = null; drawing?.destroy(); drawing = null; $('canvas').replaceChildren(); void swap(showIntake); });
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = ($('search') as HTMLInputElement).value.trim().toLowerCase();
  const hit = graph?.files.find((f) => f.id.toLowerCase() === q) ?? graph?.files.find((f) => f.id.toLowerCase().includes(q));
  if (hit) goTo(hit.id);
});
$('search').addEventListener('change', (e) => { const v = (e.target as HTMLInputElement).value; if (graph?.files.some((f) => f.id === v)) goTo(v); });

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const go = t.closest<HTMLElement>('[data-goto]');
  if (go) return goTo(go.dataset.goto!);
  const file = t.closest<HTMLElement>('[data-file]');
  if (file) return goTo(file.dataset.file!);
  if (t.closest('[data-close]')) return select(null);
  const z = t.closest<HTMLElement>('[data-zoom]');
  if (z) return z.dataset.zoom === 'fit' ? drawing?.fit() : drawing?.zoomBy(z.dataset.zoom === 'in' ? 1.25 : 0.8);
  const ex = t.closest<HTMLElement>('[data-export]');
  if (ex && drawing && scene && graph) {
    ($('export') as HTMLDetailsElement).open = false;
    const name = `${graph.root}-${scene.mode}`;
    if (ex.dataset.export === 'svg') exportSvg(drawing.svg, name);
    if (ex.dataset.export === 'png') void exportPng(drawing.svg, name);
    if (ex.dataset.export === 'mermaid') exportMermaid(scene, name);
    if (ex.dataset.export === 'json') exportJson(graph, graph.root);
  }
});

addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input, select, textarea')) {
    if (e.key === 'Escape') (e.target as HTMLElement).blur();
    return;
  }
  if (document.body.dataset.view !== 'drawing') return;
  if (e.key === '/') { e.preventDefault(); $('search').focus(); }
  else if (e.key === 'Escape') select(null);
  else if (e.key === 'f') drawing?.fit();
  else if (e.key === '+' || e.key === '=') drawing?.zoomBy(1.25);
  else if (e.key === '-') drawing?.zoomBy(0.8);
});

$('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : !matchMedia('(prefers-color-scheme: light)').matches;
  const next = dark ? 'light' : 'dark';
  // The other print develops over this one, top to bottom.
  root.classList.add('vt-print');
  void swap(() => { root.dataset.theme = next; }).then(() => root.classList.remove('vt-print'));
  try { localStorage.setItem('bp-theme', next); } catch { /* private mode */ }
});

/* Shareable links: #gh=owner/repo or #sample */
setTitleBlock(null);
const hash = decodeURIComponent(location.hash.slice(1));
if (hash.startsWith('gh=')) openRepo(hash.slice(3));
else if (hash === 'sample') openSample();

export type ImportKind = 'static' | 'reexport' | 'dynamic' | 'type';
export type Lang = 'ts' | 'js' | 'py' | 'vue' | 'svelte';

export interface Source {
  path: string;
  text: string;
}

export interface Specifier {
  spec: string;
  kind: ImportKind;
  line: number;
  names?: string[]; // python `from x import a, b`: a and b may be submodules
}

export interface FileNode {
  id: string;
  dir: string;
  name: string;
  lang: Lang;
  loc: number;
  bytes: number;
  test: boolean;
  externals: string[];
  builtins: string[];
  fanIn: number;
  fanOut: number;
  cycle: number; // index into Graph.cycles, -1 when acyclic
}

export interface Edge {
  from: string;
  to: string;
  kind: ImportKind;
  line: number;
  cycle: boolean;
}

export interface Graph {
  root: string;
  files: FileNode[];
  edges: Edge[];
  externals: { name: string; count: number }[];
  cycles: string[][];
  entries: string[];
  orphans: string[];
  unresolved: { from: string; spec: string; line: number }[];
  skipped: { path: string; reason: string }[];
}

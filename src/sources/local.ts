import type { Source } from '../types.ts';
import { LIMITS, isIgnoredPath, isWanted, stripCommonRoot } from '../graph.ts';

// Reading stays lazy: ignored folders are never entered, unwanted files never read.
const MAX_READ = LIMITS.files + 200;

async function readFiles(files: { path: string; file: () => Promise<File> }[]) {
  const wanted = files.filter((f) => isWanted(f.path)).slice(0, MAX_READ);
  const out: Source[] = [];
  for (const f of wanted) {
    const file = await f.file();
    if (file.size <= LIMITS.bytes) out.push({ path: f.path, text: await file.text() });
  }
  return stripCommonRoot(out);
}

/* Drag and drop (webkitGetAsEntry works in every current browser). */
export async function fromDrop(items: DataTransferItemList) {
  const found: { path: string; file: () => Promise<File> }[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      found.push({ path, file: () => new Promise((res, rej) => (entry as FileSystemFileEntry).file(res, rej)) });
      return;
    }
    if (isIgnoredPath(`${path}/x`)) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walk(child, path);
    }
  };
  const roots = [...items].map((i) => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => !!e);
  for (const r of roots) await walk(r, '');
  return readFiles(found);
}

/* Directory picker: File System Access API where available, <input webkitdirectory> elsewhere. */
export async function fromPicker(): Promise<Awaited<ReturnType<typeof readFiles>> | null> {
  const w = window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> };
  if (w.showDirectoryPicker) {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await w.showDirectoryPicker();
    } catch {
      return null; // user closed the dialog
    }
    const found: { path: string; file: () => Promise<File> }[] = [];
    const walk = async (handle: FileSystemDirectoryHandle, prefix: string) => {
      for await (const child of (handle as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        const path = `${prefix}/${child.name}`;
        if (child.kind === 'file') found.push({ path, file: () => (child as FileSystemFileHandle).getFile() });
        else if (!isIgnoredPath(`${path}/x`)) await walk(child as FileSystemDirectoryHandle, path);
      }
    };
    await walk(dir, dir.name);
    return readFiles(found);
  }
  return new Promise<Awaited<ReturnType<typeof readFiles>> | null>((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', webkitdirectory: true, multiple: true });
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])].map((f) => ({ path: f.webkitRelativePath || f.name, file: async () => f }));
      if (files.length) void readFiles(files).then(resolve); else resolve(null);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

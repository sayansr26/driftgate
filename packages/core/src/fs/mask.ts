import type { DirEntry, ReadOnlyFileSystem } from './types.js';

/**
 * A read-only view of a filesystem with some paths hidden.
 *
 * Interop needs this because ruler and rulesync **generate the very files Driftgate's
 * adapters import from**. Run both passes over the same tree and every rule arrives twice:
 * once from `.ruler/*.md`, the source a user actually edits, and once from the `AGENTS.md`
 * ruler built out of it. Masking the observed outputs during the adapter pass keeps the
 * source and drops the copy.
 *
 * A decorator rather than a flag on `collectImports`: the adapters must not know that this
 * is happening, and a filesystem is the seam that already exists for showing them a
 * different view of the tree — `StagedFileSystem` (T052) does the same thing for the git
 * index. It carries no write methods, so nothing here can widen what an importer may do.
 */
export function maskPaths(fs: ReadOnlyFileSystem, hidden: Iterable<string>): ReadOnlyFileSystem {
  const masked = new Set(hidden);

  return {
    async readFile(relPath: string): Promise<string> {
      if (masked.has(relPath)) throw notFound(relPath);
      return fs.readFile(relPath);
    },
    async tryReadFile(relPath: string): Promise<string | undefined> {
      return masked.has(relPath) ? undefined : fs.tryReadFile(relPath);
    },
    async readFileRaw(relPath: string): Promise<Uint8Array> {
      if (masked.has(relPath)) throw notFound(relPath);
      return fs.readFileRaw(relPath);
    },
    async exists(relPath: string): Promise<boolean> {
      return masked.has(relPath) ? false : fs.exists(relPath);
    },
    async listDir(relPath: string): Promise<readonly DirEntry[]> {
      const prefix = relPath === '' ? '' : `${relPath}/`;
      const entries = await fs.listDir(relPath);
      return entries.filter((e) => !masked.has(`${prefix}${e.name}`));
    },
    async glob(pattern: string): Promise<readonly string[]> {
      return (await fs.glob(pattern)).filter((p) => !masked.has(p));
    },
  };
}

function notFound(relPath: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, ${relPath}`);
  error.code = 'ENOENT';
  return error;
}

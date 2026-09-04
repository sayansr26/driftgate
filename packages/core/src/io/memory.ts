import { RulegateError } from '../model/errors.js';
import { escapesRoot, normalizeRelative } from '../fs/paths.js';
import { matchesGlob } from '../fs/glob.js';
import { compareCodepoint } from '../render/order.js';
import { normalizeText } from '../render/eol.js';
import type { DirEntry, WritableFileSystem } from '../fs/types.js';

/**
 * An in-memory filesystem. Used by the round-trip and parser tests, and by any code
 * path that needs to render without touching disk.
 */
export class MemoryFileSystem implements WritableFileSystem {
  private readonly files = new Map<string, string>();

  constructor(initial?: Iterable<readonly [string, string]>) {
    for (const [p, c] of initial ?? []) this.files.set(normalizeRelative(p), c);
  }

  private guard(relPath: string): string {
    if (escapesRoot(relPath)) {
      throw new RulegateError({
        code: 'E_PATH_ESCAPE',
        message: `path escapes the repository root: ${relPath}`,
      });
    }
    return normalizeRelative(relPath);
  }

  snapshot(): ReadonlyMap<string, string> {
    return new Map([...this.files].sort(([a], [b]) => compareCodepoint(a, b)));
  }

  async readFile(relPath: string): Promise<string> {
    const contents = await this.tryReadFile(relPath);
    if (contents === undefined) {
      throw new RulegateError({
        code: 'E_PATH_ESCAPE',
        message: `no such file: ${relPath}`,
      });
    }
    return contents;
  }

  async tryReadFile(relPath: string): Promise<string | undefined> {
    const raw = this.files.get(this.guard(relPath));
    return await Promise.resolve(raw === undefined ? undefined : normalizeText(raw));
  }

  async readFileRaw(relPath: string): Promise<Uint8Array> {
    const raw = this.files.get(this.guard(relPath));
    if (raw === undefined) {
      throw new RulegateError({ code: 'E_PATH_ESCAPE', message: `no such file: ${relPath}` });
    }
    return Promise.resolve(new TextEncoder().encode(raw));
  }

  async exists(relPath: string): Promise<boolean> {
    const p = this.guard(relPath);
    if (this.files.has(p)) return await Promise.resolve(true);
    const prefix = p === '' ? '' : `${p}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return await Promise.resolve(true);
    }
    return await Promise.resolve(false);
  }

  async listDir(relPath: string): Promise<readonly DirEntry[]> {
    const dir = relPath === '' ? '' : this.guard(relPath);
    const prefix = dir === '' ? '' : `${dir}/`;
    const names = new Map<string, DirEntry['kind']>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash === -1) names.set(rest, 'file');
      else names.set(rest.slice(0, slash), 'dir');
    }
    const entries = [...names].map(([name, kind]) => ({ name, kind }));
    entries.sort((a, b) => compareCodepoint(a.name, b.name));
    return await Promise.resolve(entries);
  }

  async glob(pattern: string): Promise<readonly string[]> {
    const matched = [...this.files.keys()].filter((p) => matchesGlob(p, pattern));
    matched.sort(compareCodepoint);
    return await Promise.resolve(matched);
  }

  async writeFile(relPath: string, contents: string): Promise<void> {
    this.files.set(this.guard(relPath), contents);
    return await Promise.resolve();
  }

  async copyFile(fromRelPath: string, toRelPath: string): Promise<void> {
    const raw = this.files.get(this.guard(fromRelPath));
    if (raw === undefined) {
      throw new RulegateError({ code: 'E_PATH_ESCAPE', message: `no such file: ${fromRelPath}` });
    }
    this.files.set(this.guard(toRelPath), raw);
    return await Promise.resolve();
  }

  async deleteFile(relPath: string): Promise<void> {
    this.files.delete(this.guard(relPath));
    return await Promise.resolve();
  }
}

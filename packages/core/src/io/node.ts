import fs from 'node:fs/promises';
import path from 'node:path';
import { DriftgateError } from '../model/errors.js';
import { escapesRoot, fromPosix, normalizeRelative, toPosix } from '../fs/paths.js';
import { matchesGlob } from '../fs/glob.js';
import { compareCodepoint } from '../render/order.js';
import { normalizeText } from '../render/eol.js';
import type { DirEntry, WritableFileSystem } from '../fs/types.js';

/** The only place in the codebase that touches the real filesystem. */
export class NodeFileSystem implements WritableFileSystem {
  constructor(readonly repoRoot: string) {}

  private resolve(relPath: string): string {
    if (escapesRoot(relPath)) {
      throw new DriftgateError({
        code: 'E_PATH_ESCAPE',
        message: `path escapes the repository root: ${relPath}`,
        hint: 'Driftgate never reads or writes outside the repository.',
      });
    }
    return path.join(this.repoRoot, fromPosix(normalizeRelative(relPath)));
  }

  async readFile(relPath: string): Promise<string> {
    return normalizeText(await fs.readFile(this.resolve(relPath), 'utf8'));
  }

  async tryReadFile(relPath: string): Promise<string | undefined> {
    try {
      return await this.readFile(relPath);
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  }

  async readFileRaw(relPath: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(this.resolve(relPath)));
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.stat(this.resolve(relPath));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  async listDir(relPath: string): Promise<readonly DirEntry[]> {
    let raw;
    try {
      raw = await fs.readdir(this.resolve(relPath === '' ? '.' : relPath), {
        withFileTypes: true,
      });
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
    // Sorted here rather than by callers: APFS, ext4, and NTFS all return different
    // orders, and an unsorted listing is how nondeterminism gets into generated output.
    const entries: DirEntry[] = raw.map((d) => ({
      name: d.name.normalize('NFC'),
      kind: d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : 'file',
    }));
    entries.sort((a, b) => compareCodepoint(a.name, b.name));
    return entries;
  }

  async glob(pattern: string): Promise<readonly string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await this.listDir(dir)) {
        const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
        if (entry.kind === 'dir') {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          await walk(child);
          continue;
        }
        if (matchesGlob(child, pattern)) out.push(child);
      }
    };
    await walk('');
    out.sort(compareCodepoint);
    return out;
  }

  async writeFile(relPath: string, contents: string): Promise<void> {
    const abs = this.resolve(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents, 'utf8');
  }

  async deleteFile(relPath: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(relPath));
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
}

function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ENOENT';
}

/** Absolute, normalized, no trailing separator. POSIX form is used inside content only. */
export function resolveRepoRoot(cwd: string): string {
  return path.resolve(cwd);
}

export { toPosix };

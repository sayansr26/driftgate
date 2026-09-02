import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DriftgateError } from '../model/errors.js';
import { DRIFTGATE_DIR } from '../model/paths.js';
import { escapesRoot, fromPosix, normalizeRelative, toPosix } from '../fs/paths.js';
import { matchesGlob } from '../fs/glob.js';
import { compareCodepoint } from '../render/order.js';
import { normalizeText } from '../render/eol.js';
import type { DirEntry, ReadOnlyFileSystem, WritableFileSystem } from '../fs/types.js';

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

  async copyFile(fromRelPath: string, toRelPath: string): Promise<void> {
    const to = this.resolve(toRelPath);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(this.resolve(fromRelPath), to);
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

/**
 * The root to act on when the user did not name one, found by walking up from `startDir`.
 *
 * Git, npm, cargo and eslint all resolve their root this way, and a developer spends most
 * of the day inside a subpackage rather than at the root. Without this, `sync` from
 * `packages/core` fails with `E_NO_CANONICAL_SOURCE` and hints `driftgate init` — advice
 * that would create a second, nested `.driftgate/`.
 *
 * `.git` is a *terminator*, not merely a candidate: the walk never looks above it. That is
 * what keeps "sync never writes outside the repo" true. It is matched as a file as well as
 * a directory, because worktrees and submodules write `.git` as a file containing
 * `gitdir:`, and an `isDirectory()` check would silently climb straight past them.
 *
 * `AGENTS.md` is deliberately not a marker. It decides what the canonical *source* is
 * (RFC-0001 §8), not where the repository is, and it is a common enough filename that an
 * unrelated ancestor's copy could otherwise redirect every write. Once `.git` fixes the
 * root, `parse()` finds `AGENTS.md` there exactly as before.
 *
 * Mount boundaries are an explicit non-goal: detecting them needs a `dev` comparison at
 * every level, behaves differently on Windows, and would refuse bind-mounted container
 * workspaces where a repository legitimately spans a mount.
 *
 * When nothing is found, the starting directory is returned unchanged — never `/`, never
 * the home directory — so the resulting `E_NO_CANONICAL_SOURCE` still describes where the
 * user is standing and `driftgate init` still creates `.driftgate/` there.
 */
export function findRepoRoot(startDir: string): string {
  const start = path.resolve(startDir);
  const home = path.resolve(os.homedir());
  let dir = start;

  for (;;) {
    // A nearer `.driftgate/` wins. Nothing is merged across levels: nested canonical
    // sources are T061, and this is exactly what `--cwd <subpackage>` already means.
    if (probe(path.join(dir, DRIFTGATE_DIR))) return dir;
    if (probe(path.join(dir, '.git'))) return dir;

    const parent = path.dirname(dir);
    // The home directory is examined like any other, but never ascended past: a stray
    // `~/.driftgate` must not silently become the root of an unrelated project.
    if (parent === dir || dir === home) return start;
    dir = parent;
  }
}

/** An ancestor we cannot stat is "no marker here", never a crash. */
function probe(absPath: string): boolean {
  try {
    return existsSync(absPath);
  } catch {
    return false;
  }
}

export { toPosix };

/**
 * The user's home directory, or `undefined` when there is not a usable one.
 *
 * `undefined` rather than a fallback, for the same reason `findRepoRoot` returns its
 * starting directory rather than `/`: a degraded answer that describes nothing is worse
 * than an absent one. `doctor` must be able to say "we did not look" — reporting a
 * user-level file as absent when no home directory was ever resolved would be a lie, and
 * an unfalsifiable one.
 *
 * Stripped containers really do have no home: `$HOME` unset and no `getpwuid` entry makes
 * `os.homedir()` return `''`.
 */
export function homeRoot(): string | undefined {
  let home;
  try {
    home = os.homedir();
  } catch {
    return undefined;
  }
  if (home === '' || !path.isAbsolute(home)) return undefined;
  return probe(home) ? path.resolve(home) : undefined;
}

/**
 * A read-only view of the user's home directory, for the global half of `doctor`.
 *
 * Typed `ReadOnlyFileSystem` rather than `NodeFileSystem` deliberately — the same move
 * T011 made when it dropped `WritableFileSystem` from the kit. Erasing the write methods
 * at the seam means a later caller cannot write into someone's home directory without an
 * explicit, reviewable cast, rather than by autocomplete.
 *
 * Containment comes free: `NodeFileSystem` already refuses any path escaping its root, so
 * `~/../.ssh/id_rsa` is rejected by code that exists and is already tested.
 */
export function createHomeFileSystem(root?: string): ReadOnlyFileSystem | undefined {
  const home = root ?? homeRoot();
  if (home === undefined) return undefined;
  const fs = new NodeFileSystem(home);
  // Six bound methods, not the instance. Returning the `NodeFileSystem` typed as
  // `ReadOnlyFileSystem` would erase the writers at compile time only — and a cast back
  // is precisely what someone reaches for. Here there is nothing to cast *to*: the write
  // methods are not on the returned object at all. This is the same reasoning that took
  // `WritableFileSystem` out of the kit at T011, applied where the blast radius is
  // somebody's home directory rather than their repository.
  return {
    readFile: (p) => fs.readFile(p),
    tryReadFile: (p) => fs.tryReadFile(p),
    readFileRaw: (p) => fs.readFileRaw(p),
    exists: (p) => fs.exists(p),
    listDir: (p) => fs.listDir(p),
    glob: (p) => fs.glob(p),
  };
}

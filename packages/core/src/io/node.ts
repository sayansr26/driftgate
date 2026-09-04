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

  /**
   * Walk the tree, following symlinked directories that stay inside the repository.
   *
   * **Symlinks used to be skipped entirely** (`entry.kind === 'dir'` is false for one), so
   * a repository whose `.cursor/rules` was a link — an ordinary way to share one rule set
   * between checkouts — detected as using Cursor and imported **zero rules**, silently
   * (T069).
   *
   * Following them needs a containment check of its own, and this is the part that must not
   * be simplified away: `escapesRoot` is purely *lexical*, so `.cursor/rules -> ~/shared`
   * yields repo-relative paths whose real targets are anywhere at all. Without the
   * `realpath` test below, `sync` would read — and then, through `writeFile`, write —
   * outside the repository while every path it handled looked perfectly legal.
   *
   * The `seen` set is for cycles: a link pointing at an ancestor otherwise recurses until
   * the stack gives out.
   */
  async glob(pattern: string): Promise<readonly string[]> {
    const out: string[] = [];
    const root = await realpathOr(this.repoRoot);
    const seen = new Set<string>();

    const contained = async (abs: string): Promise<boolean> => {
      const real = await realpathOr(abs);
      const rel = path.relative(root, real);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };

    const walk = async (dir: string): Promise<void> => {
      for (const entry of await this.listDir(dir)) {
        const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
        if (entry.name === 'node_modules' || entry.name === '.git') continue;

        let kind = entry.kind;
        if (kind === 'symlink') {
          const abs = path.join(this.repoRoot, fromPosix(child));
          if (!(await contained(abs))) continue;
          const stat = await fs.stat(abs).catch(() => undefined);
          if (stat === undefined) continue;
          kind = stat.isDirectory() ? 'dir' : 'file';
        }

        if (kind === 'dir') {
          const real = await realpathOr(path.join(this.repoRoot, fromPosix(child)));
          if (seen.has(real)) continue;
          seen.add(real);
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

  /**
   * Remove a symlink standing where we are about to write.
   *
   * `fs.writeFile` and `fs.copyFile` both **follow** a symlink at the destination, so a
   * repository where `CLAUDE.md` links to `AGENTS.md` had its `AGENTS.md` silently rewritten
   * by a render aimed at `CLAUDE.md` — and `runInit` passes `force: true`, so `init --yes`
   * did it on a first run (T069).
   *
   * Replacing the link is the right product behaviour: Driftgate exists to own that path.
   * `restore` will put the bytes back as a regular file rather than as a link, which is
   * stated in `docs/determinism.md` rather than left to be discovered.
   */
  async #materialize(abs: string): Promise<void> {
    const stat = await fs.lstat(abs).catch(() => undefined);
    if (stat?.isSymbolicLink() === true) await fs.unlink(abs);
  }

  async writeFile(relPath: string, contents: string): Promise<void> {
    const abs = this.resolve(relPath);
    await withPathErrors(relPath, abs, async () => {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await this.#materialize(abs);
      await fs.writeFile(abs, contents, 'utf8');
    });
  }

  async copyFile(fromRelPath: string, toRelPath: string): Promise<void> {
    const to = this.resolve(toRelPath);
    await withPathErrors(toRelPath, to, async () => {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await this.#materialize(to);
      await fs.copyFile(this.resolve(fromRelPath), to);
    });
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
  return createReadOnlyFileSystem(home);
}

/**
 * A filesystem that can only read, for the commands that promise not to write.
 *
 * Six bound methods, not the instance. Returning a `NodeFileSystem` typed as
 * `ReadOnlyFileSystem` would erase the writers at compile time only — and a cast back is
 * precisely what someone reaches for. Here there is nothing to cast *to*: the write
 * methods are not on the returned object at all. This is the same reasoning that took
 * `WritableFileSystem` out of the kit at T011. `doctor`'s home-directory view uses it
 * where the blast radius is somebody's home directory; `check` (T023) uses it on the
 * repository so that "read-only by construction" is a fact about the object it holds
 * rather than a promise about the code that holds it.
 */
export function createReadOnlyFileSystem(root: string): ReadOnlyFileSystem {
  const fs = new NodeFileSystem(root);
  return {
    readFile: (p) => fs.readFile(p),
    tryReadFile: (p) => fs.tryReadFile(p),
    readFileRaw: (p) => fs.readFileRaw(p),
    exists: (p) => fs.exists(p),
    listDir: (p) => fs.listDir(p),
    glob: (p) => fs.glob(p),
  };
}

/** `realpath`, falling back to the given path when it cannot be resolved. */
async function realpathOr(abs: string): Promise<string> {
  return fs.realpath(abs).catch(() => abs);
}

/** NAME_MAX on Linux and macOS, and the same per-component cap on NTFS. */
const MAX_COMPONENT = 255;

/** The classic Windows path limit, in force unless long paths are enabled. */
const MAX_WINDOWS_PATH = 260;

/**
 * Does this path overrun a limit some platform will refuse?
 *
 * Only ever asked *about a path that already failed*, to tell one cause of failure from
 * another. Windows reports an over-long path as a bare `ENOENT`, not `ENAMETOOLONG` —
 * which is how the mapping below sat inert on the one platform whose limit it names, for
 * the whole of its existence. `ENOENT` on its own proves nothing (`copyFile` raises it for
 * a missing source too), so it counts as a path refusal only when the path is genuinely
 * over a limit. That is checkable rather than guessable, which is the whole difference.
 */
function overrunsPathLimit(abs: string): boolean {
  if (abs.split(/[\\/]/).some((segment) => segment.length > MAX_COMPONENT)) return true;
  return process.platform === 'win32' && abs.length >= MAX_WINDOWS_PATH;
}

/**
 * Turn a platform path refusal into a named error with a hint.
 *
 * Windows' 260-character limit surfaces as a bare errno naming no limit and suggesting no
 * action — and it makes `check` fail there while passing on Linux for the same repository,
 * which reads as a Driftgate bug rather than a platform one.
 */
async function withPathErrors<T>(relPath: string, abs: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (
      code === 'ENAMETOOLONG' ||
      code === 'ERR_FS_EISDIR' ||
      (code === 'ENOENT' && overrunsPathLimit(abs))
    ) {
      throw new DriftgateError({
        code: 'E_PATH_TOO_LONG',
        message: `the filesystem refused the path ${relPath} (${String(code)})`,
        hint: 'Windows limits paths to 260 characters unless long paths are enabled; shorten a rule id or move the repository nearer the drive root.',
        cause: e,
      });
    }
    throw e;
  }
}

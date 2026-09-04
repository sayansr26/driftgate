import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createHomeFileSystem, findRepoRoot, homeRoot, resolveRepoRoot } from '../src/io/node.js';

/** The stand-in home directory, so no test here reads the machine's real one. */
function fixtureHome(): string {
  return fileURLToPath(new URL('../../../fixtures/detect-engine/home/', import.meta.url));
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'rulegate-root-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const dir = (...parts: string[]) => path.join(tmp, ...parts);
const makeDir = (...parts: string[]) => mkdir(dir(...parts), { recursive: true });

/**
 * `findRepoRoot` returns the start directory when it finds nothing, so the "nothing
 * found" case is only meaningful if the temp directory itself has no marker above it.
 * A developer whose $TMPDIR sits inside a checkout would otherwise see a false failure.
 */
function tmpdirHasMarkerAbove(): boolean {
  let d = path.resolve(tmpdir());
  for (;;) {
    if (existsSync(path.join(d, '.git')) || existsSync(path.join(d, '.rulegate'))) return true;
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

describe('findRepoRoot', () => {
  it('finds the root from a subdirectory', async () => {
    await makeDir('repo/.rulegate');
    await makeDir('repo/packages/core');

    expect(findRepoRoot(dir('repo/packages/core'))).toBe(dir('repo'));
  });

  it('leaves the root alone when already there', async () => {
    await makeDir('repo/.rulegate');

    expect(findRepoRoot(dir('repo'))).toBe(dir('repo'));
  });

  it('stops at a .git directory when there is no .rulegate', async () => {
    await makeDir('repo/.git');
    await makeDir('repo/a/b');

    expect(findRepoRoot(dir('repo/a/b'))).toBe(dir('repo'));
  });

  it('treats a .git file as a boundary, as worktrees and submodules write it', async () => {
    // An isDirectory() check here would climb straight past a worktree's root.
    await makeDir('repo/sub');
    await writeFile(dir('repo/.git'), 'gitdir: /elsewhere/.git/worktrees/repo\n', 'utf8');

    expect(findRepoRoot(dir('repo/sub'))).toBe(dir('repo'));
  });

  it('never escapes the repository to reach a .rulegate above it', async () => {
    // The assertion that keeps "sync never writes outside the repo" true: `outer` has a
    // canonical source, but `repo` is a git repository, so the walk stops at `repo`.
    await makeDir('outer/.rulegate');
    await makeDir('outer/repo/.git');
    await makeDir('outer/repo/pkg');

    expect(findRepoRoot(dir('outer/repo/pkg'))).toBe(dir('outer/repo'));
  });

  it('prefers the nearest .rulegate', async () => {
    // Nothing is merged across levels — nested canonical sources are T061. This is
    // exactly what `--cwd packages/core` already means today.
    await makeDir('repo/.rulegate');
    await makeDir('repo/packages/core/.rulegate');

    expect(findRepoRoot(dir('repo/packages/core'))).toBe(dir('repo/packages/core'));
  });

  it.skipIf(tmpdirHasMarkerAbove())(
    'returns the starting directory unchanged when nothing is found',
    async () => {
      // Not `/`, and not the home directory: E_NO_CANONICAL_SOURCE must still describe
      // where the user is standing, so `rulegate init` creates .rulegate/ there.
      await makeDir('lonely/deep');

      expect(findRepoRoot(dir('lonely/deep'))).toBe(dir('lonely/deep'));
    },
  );

  it('leaves resolveRepoRoot searching for nothing', async () => {
    // The two functions answer different questions, which is why --cwd can keep meaning
    // what it says.
    await makeDir('repo/.rulegate');
    await makeDir('repo/packages/core');

    expect(resolveRepoRoot(dir('repo/packages/core'))).toBe(dir('repo/packages/core'));
  });
});

describe('homeRoot', () => {
  /**
   * `undefined` rather than a fallback, for the same reason `findRepoRoot` returns its
   * starting directory rather than `/`. `doctor` must be able to say "we did not look";
   * reporting a user-level file as absent when no home directory was ever resolved is a
   * wrong answer dressed as a right one.
   */
  it('returns an absolute directory, or nothing', () => {
    const home = homeRoot();
    if (home !== undefined) {
      expect(path.isAbsolute(home)).toBe(true);
      expect(existsSync(home)).toBe(true);
    }
  });

  it('builds a read-only filesystem rooted at an explicit home', async () => {
    const fs = createHomeFileSystem(fixtureHome());
    expect(fs).toBeDefined();
    expect(await fs?.exists('.claude/CLAUDE.md')).toBe(true);
  });

  it('refuses to read above the home root', async () => {
    const fs = createHomeFileSystem(fixtureHome());
    // Containment is inherited, not reimplemented: NodeFileSystem already refuses this,
    // which is the whole reason the global probe is a filesystem rather than a bare stat.
    await expect(fs?.exists('../all/CLAUDE.md')).rejects.toThrow(/E_PATH_ESCAPE|escapes/);
  });

  it('exposes no write method on the returned type', () => {
    const fs = createHomeFileSystem(fixtureHome());
    // A structural check, because the compile-time one disappears at runtime and this is
    // the seam where a stray write would land in someone's home directory.
    expect((fs as unknown as Record<string, unknown>)['writeFile']).toBeUndefined();
  });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRepoRoot, resolveRepoRoot } from '../src/io/node.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'driftgate-root-'));
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
    if (existsSync(path.join(d, '.git')) || existsSync(path.join(d, '.driftgate'))) return true;
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

describe('findRepoRoot', () => {
  it('finds the root from a subdirectory', async () => {
    await makeDir('repo/.driftgate');
    await makeDir('repo/packages/core');

    expect(findRepoRoot(dir('repo/packages/core'))).toBe(dir('repo'));
  });

  it('leaves the root alone when already there', async () => {
    await makeDir('repo/.driftgate');

    expect(findRepoRoot(dir('repo'))).toBe(dir('repo'));
  });

  it('stops at a .git directory when there is no .driftgate', async () => {
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

  it('never escapes the repository to reach a .driftgate above it', async () => {
    // The assertion that keeps "sync never writes outside the repo" true: `outer` has a
    // canonical source, but `repo` is a git repository, so the walk stops at `repo`.
    await makeDir('outer/.driftgate');
    await makeDir('outer/repo/.git');
    await makeDir('outer/repo/pkg');

    expect(findRepoRoot(dir('outer/repo/pkg'))).toBe(dir('outer/repo'));
  });

  it('prefers the nearest .driftgate', async () => {
    // Nothing is merged across levels — nested canonical sources are T061. This is
    // exactly what `--cwd packages/core` already means today.
    await makeDir('repo/.driftgate');
    await makeDir('repo/packages/core/.driftgate');

    expect(findRepoRoot(dir('repo/packages/core'))).toBe(dir('repo/packages/core'));
  });

  it.skipIf(tmpdirHasMarkerAbove())(
    'returns the starting directory unchanged when nothing is found',
    async () => {
      // Not `/`, and not the home directory: E_NO_CANONICAL_SOURCE must still describe
      // where the user is standing, so `driftgate init` creates .driftgate/ there.
      await makeDir('lonely/deep');

      expect(findRepoRoot(dir('lonely/deep'))).toBe(dir('lonely/deep'));
    },
  );

  it('leaves resolveRepoRoot searching for nothing', async () => {
    // The two functions answer different questions, which is why --cwd can keep meaning
    // what it says.
    await makeDir('repo/.driftgate');
    await makeDir('repo/packages/core');

    expect(resolveRepoRoot(dir('repo/packages/core'))).toBe(dir('repo/packages/core'));
  });
});

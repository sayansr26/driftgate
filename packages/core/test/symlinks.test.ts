import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../src/io/node.js';
import { DriftgateError } from '../src/model/errors.js';

/**
 * Symlinks, and the two things Driftgate got wrong about them (T069).
 *
 * Both are **platform-independent bugs** found while auditing for Windows, which is the
 * useful half of that audit: path separators and CRLF were already handled everywhere, and
 * what the audit actually turned up was a repo that imports zero rules and a `sync` that
 * writes through a link.
 *
 * Skipped where the platform refuses to create a symlink — Windows without developer mode
 * — because a test that silently passes on an unprivileged runner is worse than one that
 * says it was skipped. `DRIFTGATE_REQUIRE_SYMLINKS=1` turns the skip into a failure, which
 * is how CI asserts the coverage actually ran somewhere.
 */
let repo: string;
let canSymlink = true;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'driftgate-symlink-'));
  try {
    await writeFile(path.join(repo, '.probe'), 'x');
    await symlink(path.join(repo, '.probe'), path.join(repo, '.probe-link'));
  } catch {
    canSymlink = false;
  }
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function guard(): boolean {
  if (canSymlink) return true;
  if (process.env['DRIFTGATE_REQUIRE_SYMLINKS'] === '1') {
    throw new Error('symlinks are required here but could not be created');
  }
  return false;
}

describe('glob and symlinked directories', () => {
  it('descends a symlinked directory that stays inside the repository', async () => {
    if (!guard()) return;
    // The bug: `glob` descended only `entry.kind === 'dir'`, and a symlink reports as
    // `symlink`. A repository whose `.cursor/rules` is a link — a normal way to share one
    // rule set across two checkouts — was detected as using Cursor and imported **zero
    // rules**, silently.
    await mkdir(path.join(repo, 'shared/rules'), { recursive: true });
    await writeFile(path.join(repo, 'shared/rules/style.mdc'), 'rule');
    await mkdir(path.join(repo, '.cursor'), { recursive: true });
    await symlink(path.join(repo, 'shared/rules'), path.join(repo, '.cursor/rules'), 'dir');

    const fs = new NodeFileSystem(repo);
    expect(await fs.glob('.cursor/rules/**/*.mdc')).toEqual(['.cursor/rules/style.mdc']);
  });

  it('refuses to descend a symlink pointing outside the repository', async () => {
    if (!guard()) return;
    // Containment is the reason this fix is not simply "follow links". `escapesRoot` is
    // purely lexical, so a link out of the tree produces repo-relative paths whose real
    // targets are anywhere at all — and `writeFile` would then follow the same link. That
    // would make "sync never writes outside the repo" false while every path looked legal.
    const outside = await mkdtemp(path.join(tmpdir(), 'driftgate-outside-'));
    try {
      await writeFile(path.join(outside, 'secret.mdc'), 'not ours');
      await mkdir(path.join(repo, '.cursor'), { recursive: true });
      await symlink(outside, path.join(repo, '.cursor/rules'), 'dir');

      const fs = new NodeFileSystem(repo);
      expect(await fs.glob('.cursor/rules/**/*.mdc')).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports a file once when a symlink loops back into the tree', async () => {
    if (!guard()) return;
    // The failure is not a hang — the OS stops following links after ~40 levels — it is
    // **the same physical file reported under several paths**: without the `seen` set this
    // returns a/x.md, a/loop/a/x.md and a/loop/a/loop/a/x.md. For `sync` that is three
    // artifacts claiming one file; for `doctor`'s orphan scan, three orphans.
    //
    // The first version of this test created no `.md` inside the loop and asserted an
    // empty result, so it passed against both implementations — a guard whose input no
    // test supplied, which is the shape this repository has recorded two dozen times.
    await mkdir(path.join(repo, 'a'), { recursive: true });
    await writeFile(path.join(repo, 'a/x.md'), 'once');
    await symlink(repo, path.join(repo, 'a/loop'), 'dir');

    const fs = new NodeFileSystem(repo);
    expect(await fs.glob('**/*.md')).toEqual(['a/x.md']);
  });
});

describe('writeFile and copyFile never follow a symlink', () => {
  it('replaces a symlinked artifact rather than writing through it', async () => {
    if (!guard()) return;
    // The sharper of the two. `runInit` passes `force: true`, so on a repository where
    // CLAUDE.md is a link to AGENTS.md, `init --yes` wrote a render straight through the
    // link and silently rewrote the target — a file Driftgate had not planned to touch.
    await writeFile(path.join(repo, 'AGENTS.md'), 'original\n');
    await symlink(path.join(repo, 'AGENTS.md'), path.join(repo, 'CLAUDE.md'));

    const fs = new NodeFileSystem(repo);
    await fs.writeFile('CLAUDE.md', 'generated\n');

    expect(await readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe('original\n');
    expect(await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('generated\n');
  });

  it('replaces a symlinked backup target rather than copying through it', async () => {
    if (!guard()) return;
    await writeFile(path.join(repo, 'source.md'), 'source\n');
    await writeFile(path.join(repo, 'victim.md'), 'untouched\n');
    await symlink(path.join(repo, 'victim.md'), path.join(repo, 'dest.md'));

    const fs = new NodeFileSystem(repo);
    await fs.copyFile('source.md', 'dest.md');

    expect(await readFile(path.join(repo, 'victim.md'), 'utf8')).toBe('untouched\n');
    expect(await readFile(path.join(repo, 'dest.md'), 'utf8')).toBe('source\n');
  });
});

describe('long paths', () => {
  it('reports a path the platform refuses with a named error and a hint', async () => {
    // Windows' 260-character limit surfaces as a raw ENAMETOOLONG with no explanation of
    // which limit was hit or what to do. `check` failing with a bare errno on Windows and
    // succeeding on Linux is a bug report nobody can act on.
    const fs = new NodeFileSystem(repo);
    const deep = Array.from({ length: 40 }, () => 'a'.repeat(30)).join('/');
    await expect(fs.writeFile(`${deep}/rule.md`, 'x')).rejects.toBeInstanceOf(DriftgateError);
  });
});

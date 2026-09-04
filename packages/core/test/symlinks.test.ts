import fsPromises, { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFileSystem } from '../src/io/node.js';
import { RulegateError } from '../src/model/errors.js';

/**
 * Symlinks, and the two things Rulegate got wrong about them (T069).
 *
 * Both are **platform-independent bugs** found while auditing for Windows, which is the
 * useful half of that audit: path separators and CRLF were already handled everywhere, and
 * what the audit actually turned up was a repo that imports zero rules and a `sync` that
 * writes through a link.
 *
 * Skipped where the platform refuses to create a symlink — Windows without developer mode
 * — because a test that silently passes on an unprivileged runner is worse than one that
 * says it was skipped. `RULEGATE_REQUIRE_SYMLINKS=1` turns the skip into a failure, which
 * is how CI asserts the coverage actually ran somewhere.
 */
let repo: string;
let canSymlink = true;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-symlink-'));
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
  if (process.env['RULEGATE_REQUIRE_SYMLINKS'] === '1') {
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
    const outside = await mkdtemp(path.join(tmpdir(), 'rulegate-outside-'));
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
    // link and silently rewrote the target — a file Rulegate had not planned to touch.
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

/**
 * Windows' 260-character limit surfaces as a raw ENAMETOOLONG naming no limit and
 * suggesting no action. `check` failing with a bare errno on Windows and succeeding on
 * Linux is a bug report nobody can act on, so `io/node.ts` maps it to a named error.
 *
 * Which path a platform *refuses*, and with which errno, is not portable — and the
 * original single test assumed both were. It built a ~1240-character path, which only
 * macOS rejects (PATH_MAX 1024); Linux allows 4096 and the Windows runners have long paths
 * enabled, so it passed on a third of the matrix and asserted nothing on the rest. Worse,
 * making it fail honestly showed that Windows reports an over-long path as ENOENT, so the
 * mapping had never once fired on the platform whose limit it names.
 *
 * So the platform-dependent half is separated from the half Rulegate owns: the mappings
 * are stubbed and must hold identically everywhere, while the one test that asks a real
 * filesystem to refuse something is allowed to skip — out loud — where it will not.
 */
describe('long paths', () => {
  it('maps a platform path refusal onto a named error with a hint', async () => {
    // The errno is stubbed on purpose. This is the half Rulegate owns — ENAMETOOLONG in,
    // E_PATH_TOO_LONG plus a hint out — and it is the half that must be identical on every
    // platform, so it must not depend on talking a real filesystem into refusing anything.
    const fs = new NodeFileSystem(repo);
    vi.spyOn(fsPromises, 'writeFile').mockRejectedValue(
      Object.assign(new Error('name too long'), { code: 'ENAMETOOLONG' }),
    );

    const refusal = await fs.writeFile('rule.md', 'x').catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(RulegateError);
    expect(refusal).toMatchObject({ code: 'E_PATH_TOO_LONG' });
    // The hint is the whole point of the mapping; an error without it is the bare errno
    // again, wearing a nicer name.
    expect((refusal as RulegateError).hint).toBeTruthy();
  });

  it('maps the bare ENOENT Windows reports for an over-long path', async () => {
    // The branch that took a Windows runner to find. Windows does not raise ENAMETOOLONG
    // for a path over its limit — it raises ENOENT, so the mapping above never fired on the
    // one platform whose 260 characters it names. Pinned with a stub because the platform
    // that behaves this way is not the one this suite usually runs on.
    const fs = new NodeFileSystem(repo);
    vi.spyOn(fsPromises, 'writeFile').mockRejectedValue(
      Object.assign(new Error('no such file or directory'), { code: 'ENOENT' }),
    );

    const refusal = await fs.writeFile(`${'a'.repeat(300)}/rule.md`, 'x').catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(RulegateError);
    expect(refusal).toMatchObject({ code: 'E_PATH_TOO_LONG' });
  });

  it('lets an ordinary ENOENT through rather than blaming the path length', async () => {
    // The control, and the reason that branch tests the path and not just the errno:
    // `copyFile` raises ENOENT for a missing *source*, which is a real error a reader must
    // see rather than a lecture about Windows path limits.
    const fs = new NodeFileSystem(repo);
    vi.spyOn(fsPromises, 'writeFile').mockRejectedValue(
      Object.assign(new Error('no such file or directory'), { code: 'ENOENT' }),
    );

    const refusal = await fs.writeFile('rule.md', 'x').catch((e: unknown) => e);

    expect(refusal).not.toBeInstanceOf(RulegateError);
    expect(refusal).toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a genuinely over-long path, where the platform imposes a limit', async ({ skip }) => {
    // Every component is over NAME_MAX (255 on Linux and macOS), so both refuse before any
    // total-length limit is reached. Windows depends on whether long paths are enabled, and
    // a runner that accepts the path skips out loud rather than asserting nothing — the same
    // argument as the symlink guard above.
    const fs = new NodeFileSystem(repo);
    const deep = Array.from({ length: 40 }, () => 'a'.repeat(300)).join('/');

    const refusal = await fs.writeFile(`${deep}/rule.md`, 'x').catch((e: unknown) => e);

    skip(refusal === undefined, 'this platform accepts a path no other one would');
    expect(refusal).toBeInstanceOf(RulegateError);
  });
});

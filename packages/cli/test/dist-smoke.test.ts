import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

/**
 * Vitest aliases @driftgate/* to source so tests run on a clean clone before a build.
 * The cost is that nothing else exercises the built output, so a broken `exports` map
 * or a bad bin shebang would stay invisible until publish day. This suite closes that
 * gap; CI runs it after `pnpm build` with DRIFTGATE_TEST_DIST=1.
 */
describe.runIf(process.env['DRIFTGATE_TEST_DIST'] === '1')('built dist', () => {
  it('runs the published binary and reports a version', async () => {
    const { stdout } = await run(process.execPath, [binPath, '--version']);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exits 2 on a usage error', async () => {
    await expect(
      run(process.execPath, [binPath, 'definitely-not-a-command']),
    ).rejects.toMatchObject({ code: 2 });
  });

  /**
   * The commander `--cwd` default is the one code path T074 lives on, and calling
   * `runSync` directly never reaches it — every unit test passes an explicit cwd. Only
   * a spawned process with a real working directory exercises the walk-up.
   */
  it('syncs the repository root when spawned from a subdirectory', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'driftgate-smoke-'));
    try {
      await cp(path.join(fixtures, 'cursor/input'), repo, { recursive: true });
      const sub = path.join(repo, 'packages/core');
      await mkdir(sub, { recursive: true });

      const { stdout } = await run(process.execPath, [binPath, 'sync'], { cwd: sub });

      expect(stdout).toContain('repo  ');
      await expect(stat(path.join(repo, 'CLAUDE.md'))).resolves.toBeDefined();
      await expect(stat(path.join(sub, 'CLAUDE.md'))).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  /**
   * `doctor` is read-only and exits 0 by design, both of which are properties only a real
   * process can demonstrate: an in-process test shares this runner's working directory, and
   * an exit code the CLI merely returns is not the code the shell sees.
   */
  it('reports from a subdirectory, exits 0, and writes nothing', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'driftgate-smoke-'));
    try {
      await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
      const sub = path.join(repo, 'packages/core');
      await mkdir(sub, { recursive: true });
      const before = await stat(path.join(repo, 'CLAUDE.md'));

      const { stdout, stderr } = await run(process.execPath, [binPath, 'doctor'], { cwd: sub });

      expect(stdout).toContain('repo  ');
      expect(stdout).toContain('GitHub Copilot');
      // The T078 finding has to survive the real binary, not just the aliased source.
      expect(stderr).toContain("duplicates of another adapter's output");
      const after = await stat(path.join(repo, 'CLAUDE.md'));
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  /**
   * T011 split `@driftgate/adapter-kit` into two entry points: `.` is the frozen contract
   * and `./testing` is the fixture harness. The vitest alias resolves both to source, so
   * the normal suite would keep passing with a malformed `exports` map — the exact class
   * of bug this lane exists for, and the one that would only surface on publish day.
   */
  /**
   * T077's fix, checked through the real resolver.
   *
   * `driftgate init` was hinted by two error messages and by RFC §8 for the whole of M0
   * while it was unregistered, so following the only instruction a new user ever received
   * exited **2** — the code that means the user made the mistake. A unit test importing
   * `runInit` cannot catch a command that was never registered on the program.
   */
  it('registers `init`, so following our own hint does not exit 2', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'driftgate-init-smoke-'));
    try {
      await cp(path.join(fixtures, 'claude-code-import/input'), repo, { recursive: true });
      const { stdout } = await run(process.execPath, [binPath, 'init'], { cwd: repo });
      expect(stdout).toContain('nothing was written');

      // And it really wrote nothing: the walk finds no `.driftgate/`.
      await expect(stat(path.join(repo, '.driftgate'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('resolves both adapter-kit entry points from the built output', async () => {
    // Spawned rather than imported: vitest aliases `@driftgate/*` to source, so an
    // in-process `import()` here would resolve to `src/` and pass no matter what the
    // `exports` map says. Only Node's own resolver, running from a package that actually
    // depends on the kit, exercises the map.
    const cwd = fileURLToPath(new URL('../../adapters/cursor/', import.meta.url));
    const probe = [
      "const contract = await import('@driftgate/adapter-kit');",
      "const testing = await import('@driftgate/adapter-kit/testing');",
      'console.log(JSON.stringify({',
      '  finalizeArtifact: typeof contract.finalizeArtifact,',
      '  renderFixture: typeof testing.renderFixture,',
      "  harnessLeakedIntoContract: 'renderFixture' in contract,",
      '}));',
    ].join('\n');

    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', probe], { cwd });

    expect(JSON.parse(stdout) as unknown).toEqual({
      finalizeArtifact: 'function',
      renderFixture: 'function',
      // The harness reads the filesystem, so it must not be reachable from the contract
      // entry: adapters import that one, and adapters do not touch the disk.
      harnessLeakedIntoContract: false,
    });
  });
});

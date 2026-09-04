import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

/**
 * Vitest aliases @rulegate/* to source so tests run on a clean clone before a build.
 * The cost is that nothing else exercises the built output, so a broken `exports` map
 * or a bad bin shebang would stay invisible until publish day. This suite closes that
 * gap; CI runs it after `pnpm build` with RULEGATE_TEST_DIST=1.
 */
describe.runIf(process.env['RULEGATE_TEST_DIST'] === '1')('built dist', () => {
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
    const repo = await mkdtemp(path.join(tmpdir(), 'rulegate-smoke-'));
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
    const repo = await mkdtemp(path.join(tmpdir(), 'rulegate-smoke-'));
    try {
      await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
      const sub = path.join(repo, 'packages/core');
      await mkdir(sub, { recursive: true });
      const before = await stat(path.join(repo, 'CLAUDE.md'));

      const { stdout, stderr } = await run(process.execPath, [binPath, 'doctor'], { cwd: sub });

      expect(stdout).toContain('repo  ');
      expect(stdout).toContain('GitHub Copilot');
      // The T078 finding has to survive the real binary, not just the aliased source.
      expect(stderr).toContain('carry content that also arrives from another file');
      const after = await stat(path.join(repo, 'CLAUDE.md'));
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  /**
   * T011 split `@rulegate/adapter-kit` into two entry points: `.` is the frozen contract
   * and `./testing` is the fixture harness. The vitest alias resolves both to source, so
   * the normal suite would keep passing with a malformed `exports` map — the exact class
   * of bug this lane exists for, and the one that would only surface on publish day.
   */
  /**
   * T077's fix, checked through the real resolver.
   *
   * `rulegate init` was hinted by two error messages and by RFC §8 for the whole of M0
   * while it was unregistered, so following the only instruction a new user ever received
   * exited **2** — the code that means the user made the mistake. A unit test importing
   * `runInit` cannot catch a command that was never registered on the program.
   */
  it('registers `init`, so following our own hint does not exit 2', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'rulegate-init-smoke-'));
    try {
      await cp(path.join(fixtures, 'claude-code-import/input'), repo, { recursive: true });
      const { stdout } = await run(process.execPath, [binPath, 'init'], { cwd: repo });
      expect(stdout).toContain('nothing was written');

      // And it really wrote nothing: the walk finds no `.rulegate/`.
      await expect(stat(path.join(repo, '.rulegate'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  /**
   * T023: the exit code is CI's whole contract, and the code the CLI *returns* is not the
   * code the shell *sees* — the dist lane is the only place the difference exists.
   */
  it('check exits 1 on drift, 0 in sync, 1 on a hand-edit, and never 2', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'rulegate-check-smoke-'));
    try {
      await cp(path.join(fixtures, 'cursor/input'), repo, { recursive: true });

      await expect(run(process.execPath, [binPath, 'check'], { cwd: repo })).rejects.toMatchObject({
        code: 1,
      });

      await run(process.execPath, [binPath, 'sync'], { cwd: repo });
      const { stdout } = await run(process.execPath, [binPath, 'check'], { cwd: repo });
      expect(stdout).toContain('in sync (5 artifacts)');

      await writeFile(path.join(repo, 'CLAUDE.md'), 'edited by hand\n');
      const drifted = await run(process.execPath, [binPath, 'check'], { cwd: repo }).catch(
        (e: { code: number; stdout: string; stderr: string }) => e,
      );
      expect(drifted.code).toBe(1);
      expect(drifted.stdout).toContain('hand-edited  CLAUDE.md');
      expect(drifted.stdout).toContain('-edited by hand');
      expect(drifted.stderr).toContain('hint:');
      // Piped through execFile, so no TTY: the diff must carry no escape sequences.
      expect(drifted.stdout).not.toContain(String.fromCharCode(27));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  /**
   * `--staged` is registered as of T052, and the built binary is the only place that can
   * be proved: the source lane calls `runCheck` directly, so a flag missing from
   * `program.ts` would still pass every test in `staged.test.ts`. This is the same gap the
   * dist lane caught at T009, when a dropped `exitOverride` made usage errors exit 1.
   */
  it('check --staged is a registered flag on the built binary, and never exits 2', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'rulegate-staged-smoke-'));
    const git = (...args: string[]) => run('git', args, { cwd: repo });
    try {
      await cp(path.join(fixtures, 'cursor/input'), repo, { recursive: true });
      await run(process.execPath, [binPath, 'sync'], { cwd: repo });
      await git('init', '--quiet');
      await git('config', 'user.email', 'test@example.com');
      await git('config', 'user.name', 'Rulegate Test');
      await git('add', '-A');

      // Resolving at all is exit 0: `execFile` rejects on any non-zero code, so a flag
      // commander did not know would land here as the 2 this test is named for.
      const clean = await run(process.execPath, [binPath, 'check', '--staged'], { cwd: repo });
      expect(clean.stdout).toContain('in sync');
      expect(clean.stdout).toContain('staged');

      // And it exits 1, not 2, on real drift in the index — the distinction CI reads.
      await writeFile(path.join(repo, 'CLAUDE.md'), 'edited by hand, and staged\n');
      await git('add', '-A');
      const drifted = await run(process.execPath, [binPath, 'check', '--staged'], {
        cwd: repo,
      }).catch((e: { code: number }) => e);
      expect(drifted.code).toBe(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  /**
   * The Action's `main` used to be an exported function nothing called, so
   * `node dist/main.js` exited 0 without looking. Only a spawned process proves the fix:
   * an in-process import of the module would run the top-level call and pass either way.
   */
  it('the Action exits 1 on drift and 0 in sync, and annotates the drift', async () => {
    const actionMain = fileURLToPath(new URL('../../../action/dist/main.js', import.meta.url));
    const repo = await mkdtemp(path.join(tmpdir(), 'rulegate-action-smoke-'));
    const env = { ...process.env };
    delete env['GITHUB_WORKSPACE'];
    delete env['INPUT_ANNOTATIONS'];
    try {
      await cp(path.join(fixtures, 'cursor/input'), repo, { recursive: true });
      const drifted = await run(process.execPath, [actionMain], { cwd: repo, env }).catch(
        (e: { code: number; stdout: string }) => e,
      );
      expect(drifted.code).toBe(1);
      // Annotations are on by default, and they name a real file. `check`'s own output
      // says nothing GitHub can place on a diff, so this is the only assertion that the
      // Action does more than the CLI.
      expect(drifted.stdout).toContain('::error file=CLAUDE.md,');
      expect(drifted.stdout).toContain('title=rulegate%3A');

      await run(process.execPath, [binPath, 'sync'], { cwd: repo });
      const { stdout } = await run(process.execPath, [actionMain], { cwd: repo, env });
      expect(stdout).toContain('in sync');
      // A clean repository must annotate nothing: an annotation on a PR that is in sync
      // is a false failure report, and people stop reading them.
      expect(stdout).not.toContain('::error');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  /**
   * The bundle is committed, so it is the only shipped artifact that can silently
   * describe an older commit. This is `node action/build.mjs --check` reaching the test
   * suite as well as CI, since a contributor who never runs the workflow still runs
   * `pnpm test`.
   *
   * It bundles the CLI through its `exports` map, so it embeds `packages/cli/dist` rather
   * than `src` — which is why this test lives in the dist lane, where a build has
   * necessarily happened. A change anywhere in core or the CLI moves the bundle, and the
   * bundle has to be rebuilt and committed with it.
   */
  it('the committed Action bundle matches a fresh build', async () => {
    const buildScript = fileURLToPath(new URL('../../../action/build.mjs', import.meta.url));
    const { stdout } = await run(process.execPath, [buildScript, '--check'], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    });
    expect(stdout).toContain('up to date');
  });

  /**
   * T080. Piping into a reader that closes early — `rulegate check | head` — used to end
   * in a Node stack trace for `EPIPE`, which is not an error: a C program in the same
   * position gets SIGPIPE and dies quietly. Only a real process with a real pipe can show
   * it, because the failure is an asynchronous stream event, not a thrown value.
   */
  it('says nothing when the reader closes the pipe early', async () => {
    const stderr = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [binPath, 'doctor', '--no-global'], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      });
      let err = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => (err += chunk));
      // Destroy the read end before the child writes anything. Waiting for the first
      // chunk looks more like `head` and proves nothing: `doctor` fits its whole report
      // into the pipe buffer in one go, so by then every write has already succeeded and
      // the unfixed binary passes. The failure needs a write that meets a closed pipe.
      child.stdout.destroy();
      child.on('error', reject);
      child.on('close', () => resolve(err));
    });

    expect(stderr).not.toContain('EPIPE');
    expect(stderr).not.toMatch(/^\s+at /m);
  });

  it('resolves both adapter-kit entry points from the built output', async () => {
    // Spawned rather than imported: vitest aliases `@rulegate/*` to source, so an
    // in-process `import()` here would resolve to `src/` and pass no matter what the
    // `exports` map says. Only Node's own resolver, running from a package that actually
    // depends on the kit, exercises the map.
    const cwd = fileURLToPath(new URL('../../adapters/cursor/', import.meta.url));
    const probe = [
      "const contract = await import('@rulegate/adapter-kit');",
      "const testing = await import('@rulegate/adapter-kit/testing');",
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

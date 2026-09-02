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
});

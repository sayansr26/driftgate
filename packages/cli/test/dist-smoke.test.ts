import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

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
});

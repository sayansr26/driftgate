import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '../src/commands/check.js';
import { runSync } from '../src/commands/sync.js';
import { ExitCode } from '../src/ui/exit.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

/**
 * T023's validation: "a network spy records zero requests." `invariants.test.ts` already
 * scans the source for network primitives; this watches the runtime, so a dependency
 * that reaches out on its own would be caught here rather than trusted.
 */
describe('rulegate check makes no network call', () => {
  let repo: string;
  const spies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'rulegate-check-net-'));
    await cp(path.join(fixtures, 'cursor/input'), repo, { recursive: true });
    const trap = () => {
      throw new Error('network call attempted');
    };
    spies.push(
      vi.spyOn(http, 'request').mockImplementation(trap),
      vi.spyOn(https, 'request').mockImplementation(trap),
      vi.spyOn(net, 'connect').mockImplementation(trap),
      vi.spyOn(dns, 'lookup').mockImplementation(trap),
      vi.spyOn(globalThis, 'fetch').mockImplementation(trap),
    );
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    spies.length = 0;
    await rm(repo, { recursive: true, force: true });
  });

  it('on a clean and on a drifted repository', async () => {
    expect(await runCheck({ cwd: repo, color: false })).toBe(ExitCode.Failure);
    await runSync({ cwd: repo, quiet: true });
    expect(await runCheck({ cwd: repo, color: false })).toBe(ExitCode.Ok);
    await writeFile(path.join(repo, 'CLAUDE.md'), 'edited\n');
    expect(await runCheck({ cwd: repo, color: false })).toBe(ExitCode.Failure);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('would notice one, so the assertion above is known to be able to fail', () => {
    expect(() => globalThis.fetch('http://127.0.0.1:9/')).toThrow('network call attempted');
    expect(spies[4]).toHaveBeenCalledTimes(1);
  });
});

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGlobalCwd } from '../src/cwd.js';

let repo: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-cwd-'));
  await mkdir(path.join(repo, '.rulegate'), { recursive: true });
  await mkdir(path.join(repo, 'packages/core'), { recursive: true });
});

afterEach(async () => {
  // chdir is process-global and vitest shares a process per worker.
  process.chdir(originalCwd);
  await rm(repo, { recursive: true, force: true });
});

describe('global --cwd resolution', () => {
  it('takes an explicit --cwd literally and does not search', () => {
    const sub = path.join(repo, 'packages/core');

    expect(resolveGlobalCwd(sub)).toEqual({ root: sub, searched: false });
  });

  it('walks up when --cwd was not given', () => {
    process.chdir(path.join(repo, 'packages/core'));

    // fs.realpath: macOS resolves /var -> /private/var, so compare against what the
    // process itself reports rather than the path we constructed.
    const here = process.cwd();
    const { root, searched } = resolveGlobalCwd(undefined);

    expect(root).not.toBe(here);
    expect(searched).toBe(true);
    expect(path.basename(root)).toBe(path.basename(repo));
  });

  it('does not announce a root it did not have to search for', () => {
    process.chdir(repo);

    expect(resolveGlobalCwd(undefined).searched).toBe(false);
  });
});

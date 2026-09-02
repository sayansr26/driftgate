import { cp, mkdtemp, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeFileSystem, planRestore, restoreTargetFor } from '@driftgate/core';
import { runSync } from '../src/commands/sync.js';
import { runRestore } from '../src/commands/restore.js';
import { ExitCode } from '../src/ui/exit.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'driftgate-restore-'));
  await cp(path.join(fixtures, 'cursor/input'), repo, { recursive: true });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const abs = (rel: string) => path.join(repo, rel);
const raw = (rel: string) => readFile(abs(rel));

/** Every file in the repo with its bytes, so a "wrote nothing" claim covers rewrites too. */
async function snapshot(dir = repo, prefix = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [k, v] of await snapshot(path.join(dir, entry.name), rel)) out.set(k, v);
      continue;
    }
    out.set(rel, (await readFile(path.join(dir, entry.name))).toString('base64'));
  }
  return out;
}

describe('driftgate restore (T020)', () => {
  // A CRLF file with a BOM: the two things a read-then-write "restore" silently destroys.
  const original = '﻿# Mine\r\n\r\nHand written.\r\n';

  beforeEach(async () => {
    await writeFile(abs('CLAUDE.md'), original, 'utf8');
    // Take ownership, which is what puts the original in the backup in the first place.
    expect(await runSync({ cwd: repo, force: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await raw('.driftgate/backup/CLAUDE.md')).toEqual(Buffer.from(original, 'utf8'));
  });

  it('writes nothing without --yes', async () => {
    const before = await snapshot();
    expect(await runRestore({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    // Compared by *contents*, not by the file tree: a tree comparison does not change
    // when a file is rewritten in place, which is exactly the bug this must catch.
    expect(await snapshot()).toEqual(before);
  });

  it('restores the original byte-for-byte, CRLF and BOM intact', async () => {
    expect(await runRestore({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await raw('CLAUDE.md')).toEqual(Buffer.from(original, 'utf8'));
  });

  it('restores only the paths it is given', async () => {
    await writeFile(abs('.driftgate/backup/other.md'), 'other\n', 'utf8');

    await runRestore({ cwd: repo, only: ['CLAUDE.md'], yes: true, quiet: true });

    expect(await raw('CLAUDE.md')).toEqual(Buffer.from(original, 'utf8'));
    await expect(stat(abs('other.md'))).rejects.toThrow();
  });

  /**
   * The comparison that decides whether a restore is a no-op must be on raw bytes.
   * `tryReadFile` is BOM-stripped and EOL-normalized, so a CRLF backup and an LF file on
   * disk read as *equal* through the text path — and skipping there would leave the CRLF
   * original permanently unrestorable by the command that exists to restore it.
   */
  it('does not mistake an EOL-normalized copy for the original', async () => {
    await writeFile(abs('CLAUDE.md'), '# Mine\n\nHand written.\n', 'utf8');

    const candidates = await planRestore(new NodeFileSystem(repo));
    expect(candidates.find((c) => c.to === 'CLAUDE.md')?.identical).toBe(false);

    await runRestore({ cwd: repo, yes: true, quiet: true });
    expect(await raw('CLAUDE.md')).toEqual(Buffer.from(original, 'utf8'));
  });

  it('reports an already-identical file as identical and copies nothing', async () => {
    await runRestore({ cwd: repo, yes: true, quiet: true });

    const candidates = await planRestore(new NodeFileSystem(repo));
    expect(candidates.find((c) => c.to === 'CLAUDE.md')?.identical).toBe(true);
  });

  it('says so, and exits 0, when there is nothing to restore', async () => {
    await rm(abs('.driftgate/backup'), { recursive: true, force: true });
    expect(await planRestore(new NodeFileSystem(repo))).toEqual([]);
    expect(await runRestore({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it('never resolves a target outside the backup, including a backup of a backup', () => {
    expect(restoreTargetFor('.driftgate/backup/CLAUDE.md')).toBe('CLAUDE.md');
    expect(restoreTargetFor('.driftgate/backup/a/b.md')).toBe('a/b.md');
    expect(restoreTargetFor('CLAUDE.md')).toBeUndefined();
    expect(restoreTargetFor('.driftgate/state.json')).toBeUndefined();
    expect(restoreTargetFor('.driftgate/backup/')).toBeUndefined();
    expect(restoreTargetFor('.driftgate/backup/.driftgate/backup/x.md')).toBeUndefined();
  });
});

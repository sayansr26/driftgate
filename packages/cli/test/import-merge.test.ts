import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFileSystem } from '@rulegate/core';
import { runCheck } from '../src/commands/check.js';
import { runSync } from '../src/commands/sync.js';
import { ExitCode } from '../src/ui/exit.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

let repo: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-merge-'));
  stdout = [];
  stderr = [];
  await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  await runSync({ cwd: repo, quiet: true });
  stdout.length = 0;
  stderr.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
});

const read = (rel: string) => readFile(path.join(repo, rel), 'utf8');
const rulePath = '.rulegate/rules/10-style.md';

/** Hand-edit a generated file the way a user does: type into it. */
async function handEdit(artifact: string, line: string): Promise<void> {
  const text = await read(artifact);
  await writeFile(path.join(repo, artifact), text.replace('## Style', `## Style\n\n${line}`));
}

describe('rulegate sync --import (T051)', () => {
  it('recovers the edit into the rule it came from, and writes nothing without --yes', async () => {
    await handEdit('CLAUDE.md', 'A line the user added by hand.');
    const before = await read(rulePath);

    const spy = vi.spyOn(NodeFileSystem.prototype, 'writeFile');
    try {
      expect(await runSync({ cwd: repo, import: true })).toBe(ExitCode.Ok);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await read(rulePath)).toBe(before);
    // The plan is shown, not merely counted: the diff is what makes it reviewable.
    expect(stdout.join('')).toContain('would merge');
    expect(stdout.join('')).toContain('+A line the user added by hand.');

    expect(await runSync({ cwd: repo, import: true, yes: true })).toBe(ExitCode.Ok);
    expect(await read(rulePath)).toContain('A line the user added by hand.');
  });

  it('closes the loop: import, sync, and the repository is clean', async () => {
    await handEdit('GEMINI.md', 'Recovered from the Gemini artifact.');

    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Failure);
    expect(await runSync({ cwd: repo, import: true, yes: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);

    // The edit reached every adapter, which is the whole point of putting it in canonical
    // rather than back into the one file it was typed into.
    for (const artifact of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      expect(await read(artifact)).toContain('Recovered from the Gemini artifact.');
    }
  });

  /**
   * The case the task text does not describe, and the one that shapes the design:
   * `state.json` holds a hash, not the ancestor's text. When canonical has moved on too,
   * the version the user edited is not reconstructible from anything, and inventing an
   * ancestor is how a silent clobber gets in.
   */
  it('refuses when canonical also moved on, instead of guessing an ancestor', async () => {
    await handEdit('CLAUDE.md', 'edited in the artifact.');
    await writeFile(path.join(repo, rulePath), `${await read(rulePath)}\nand in canonical too.\n`);
    const before = await read(rulePath);

    expect(await runSync({ cwd: repo, import: true, yes: true })).toBe(ExitCode.Failure);
    expect(stderr.join('')).toContain('no-ancestor');
    expect(stderr.join('')).toContain('CLAUDE.md');
    // Nothing was written, and --yes did not make it write anyway.
    expect(await read(rulePath)).toBe(before);
  });

  it('refuses a rule two files edited differently, naming both', async () => {
    await handEdit('CLAUDE.md', 'edited one way.');
    await handEdit('AGENTS.md', 'edited another way.');
    const before = await read(rulePath);

    expect(await runSync({ cwd: repo, import: true, yes: true })).toBe(ExitCode.Failure);
    const text = stderr.join('');
    expect(text).toContain('conflict');
    expect(text).toContain('CLAUDE.md');
    expect(text).toContain('AGENTS.md');
    expect(await read(rulePath)).toBe(before);
  });

  /**
   * Matching is by position, because a rule's `id` does not survive rendering — the
   * heading is its *description* (T017). Adding a heading by hand desynchronizes that
   * zip, and a misaligned merge writes one rule's text into another rule's file: silent,
   * and worse than the edit being lost.
   */
  it('refuses a file whose section count no longer matches the rules that produced it', async () => {
    await writeFile(
      path.join(repo, 'CLAUDE.md'),
      `${await read('CLAUDE.md')}\n## Invented\n\nnew.\n`,
    );
    const before = await read(rulePath);

    expect(await runSync({ cwd: repo, import: true, yes: true })).toBe(ExitCode.Failure);
    expect(stderr.join('')).toContain('unrecoverable');
    expect(await read(rulePath)).toBe(before);
  });

  it('says so plainly when there is nothing to import', async () => {
    expect(await runSync({ cwd: repo, import: true })).toBe(ExitCode.Ok);
    expect(stdout.join('')).toContain('nothing to import');
  });

  it('agrees with check about which files are hand-edited', async () => {
    await handEdit('CLAUDE.md', 'one edit.');
    await runCheck({ cwd: repo });
    const checked = stdout.join('').includes('hand-edited  CLAUDE.md');
    stdout.length = 0;

    await runSync({ cwd: repo, import: true });
    // Both answers come from `verifyPlan`, so they cannot describe one file two ways —
    // an import that decided this question its own way could offer to merge a file
    // `check` calls clean.
    expect(checked).toBe(true);
    expect(stdout.join('')).toContain('CLAUDE.md');
  });
});

describe('sync --force covers hand-edited files (T075)', () => {
  it('overwrites the edit, but only after copying it to .rulegate/backup/', async () => {
    await handEdit('CLAUDE.md', 'about to be discarded.');
    const edited = await read('CLAUDE.md');

    // Without --force it is still refused: widening the flag must not widen the default.
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Failure);
    expect(await read('CLAUDE.md')).toBe(edited);

    expect(await runSync({ cwd: repo, force: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await read('CLAUDE.md')).not.toContain('about to be discarded.');
    // T020's rule: a destructive operation backs up first, and `restore` can undo it.
    expect(await read('.rulegate/backup/CLAUDE.md')).toBe(edited);
  });

  it('offers both recoveries when it refuses, not just the destructive one', async () => {
    await handEdit('CLAUDE.md', 'an edit worth keeping.');
    await runSync({ cwd: repo });

    const hints = stderr.join('');
    expect(hints).toContain('re-apply your edit in .rulegate/');
    expect(hints).toContain('--import');
  });
});

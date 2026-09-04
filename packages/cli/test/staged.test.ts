import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StagedFileSystem } from '@rulegate/core';
import { runCheck } from '../src/commands/check.js';
import { runSync } from '../src/commands/sync.js';
import { ExitCode } from '../src/ui/exit.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const runFile = promisify(execFile);

let repo: string;

// `execFile` with an argument array, never `exec`: no shell, so a temp-directory path
// containing a shell metacharacter stays an argument.
const git = (...args: string[]) => runFile('git', args, { cwd: repo });

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-staged-'));
  await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });

  await git('init', '--quiet');
  // Set locally so the suite does not depend on the machine's git identity, and does not
  // change it either.
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Rulegate Test');
  await git('add', '-A');
  await git('commit', '--quiet', '-m', 'initial');

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
});

/**
 * Make git keep the bytes it is given.
 *
 * Without this, `git add` normalizes CRLF to LF in the blob itself, so *git* satisfies the
 * assertion and our own normalization can be deleted with every test still green — the
 * environment answering for the code, which is the same shape as T027's `--no-color` and
 * T055's real home directory. `-text` is not a contrivance either: this repository ships
 * exactly that attribute for `fixtures/**`, so a CRLF blob is a real thing to meet.
 */
async function keepCrlfInBlobs(): Promise<void> {
  await git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(repo, '.gitattributes'), '* -text\n');
  await git('add', '.gitattributes');
}

const rule = (name: string) => path.join(repo, '.rulegate/rules', name);

/**
 * T052. The two commands must be able to disagree, and each direction has to be reachable
 * on its own — a test where the index and the working tree always agree passes against a
 * `--staged` that silently reads the working tree, which is the whole failure mode.
 */
describe('rulegate check --staged', () => {
  it('fails on an index that is out of sync while the working tree is clean', async () => {
    // A new rule, synced, so the *working tree* is fully in sync…
    await writeFile(rule('30-extra.md'), '# Extra\n\nan extra rule.\n');
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    // …and only the rule is staged, so the index holds the new rule with the old
    // artifacts. That is precisely the commit a hook has to stop: it would land a
    // repository whose generated files do not match its canonical source.
    await git('add', '.rulegate/rules/30-extra.md');

    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await runCheck({ cwd: repo, quiet: true, staged: true })).toBe(ExitCode.Failure);
  });

  it('passes on a clean index while the working tree is drifted', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), 'hand-edited, and not staged\n');

    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Failure);
    expect(await runCheck({ cwd: repo, quiet: true, staged: true })).toBe(ExitCode.Ok);
  });

  it('sees a staged change the working tree has already moved past', async () => {
    // Staged: a new rule and its artifacts, all consistent. Working tree: the rule
    // deleted again. The index is what would be committed, and it is in sync.
    await writeFile(rule('30-extra.md'), '# Extra\n\nan extra rule.\n');
    await runSync({ cwd: repo, quiet: true });
    await git('add', '-A');
    await rm(rule('30-extra.md'));

    expect(await runCheck({ cwd: repo, quiet: true, staged: true })).toBe(ExitCode.Ok);
    // The control: the working tree genuinely differs, so the answers are not the same
    // answer arrived at twice.
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Failure);
  });

  it('refuses rather than falling back to the working tree outside a git repository', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'rulegate-nogit-'));
    try {
      await cp(path.join(fixtures, 'doctor/adopted'), bare, { recursive: true });
      // Without `--staged` this repository is perfectly checkable, so a fallback would
      // exit 0 and tell a hook author their commit was verified against an index nobody
      // read.
      expect(await runCheck({ cwd: bare, quiet: true })).toBe(ExitCode.Ok);
      expect(await runCheck({ cwd: bare, quiet: true, staged: true })).toBe(ExitCode.Failure);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('normalizes CRLF in the index, so a Windows checkout is not reported as drift', async () => {
    await keepCrlfInBlobs();
    const claude = path.join(repo, 'CLAUDE.md');
    const lf = await readFile(claude, 'utf8');
    await writeFile(claude, lf.replace(/\n/g, '\r\n'));
    await git('add', '-A');

    // `hashContents` is EOL-blind and `sync` would not rewrite this, so `check` must not
    // fail it — the Windows policy `state.json` has had since T008, now reachable through
    // a second read path that could have quietly broken it.
    expect(await runCheck({ cwd: repo, quiet: true, staged: true })).toBe(ExitCode.Ok);
  });

  /**
   * Two properties of the staged view that no end-to-end assertion can reach, and both
   * were found by a mutation that passed.
   *
   * `verifyPlan` compares by `hashContents`, which is EOL-blind, so dropping the
   * normalization changes no exit code — it changes `VerifyEntry.actual`, which is
   * documented EOL-normalized and is what the unified diff renders. Left unnormalized, a
   * CRLF checkout's first real drift prints every line as changed.
   *
   * And `--cached` is what makes this the *index*: with untracked files folded in, the
   * view stops being the commit-to-be and no exit-code test notices, because an untracked
   * path has no blob to read anyway.
   */
  describe('the staged view itself', () => {
    it('reads a CRLF blob back as LF, like every other read in the codebase', async () => {
      await keepCrlfInBlobs();
      const claude = path.join(repo, 'CLAUDE.md');
      await writeFile(claude, (await readFile(claude, 'utf8')).replace(/\n/g, '\r\n'));
      await git('add', '-A');

      const text = await new StagedFileSystem(repo).readFile('CLAUDE.md');
      expect(text).not.toContain('\r');
      // The control: something was actually read, so an empty string cannot pass this.
      expect(text.length).toBeGreaterThan(0);
    });

    it('is the index and not the working tree: an untracked file is not in it', async () => {
      await writeFile(rule('40-untracked.md'), '# Untracked\n\nnever staged.\n');
      const staged = new StagedFileSystem(repo);

      expect(await staged.exists('.rulegate/rules/40-untracked.md')).toBe(false);
      expect(await staged.glob('.rulegate/rules/*.md')).not.toContain(
        '.rulegate/rules/40-untracked.md',
      );
      // The control: the tracked rules beside it *are* there, so this is not an empty view.
      expect(await staged.glob('.rulegate/rules/*.md')).toContain('.rulegate/rules/10-style.md');
      // And the whole point of the distinction — an unstaged rule does not fail the commit.
      expect(await runCheck({ cwd: repo, quiet: true, staged: true })).toBe(ExitCode.Ok);
      expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Failure);
    });
  });

  // NFR6: the hook must be fast enough that nobody disables it. `check` measures ~0.07 s
  // on this repository, and the staged path adds one `git ls-files` plus one `git
  // cat-file` per artifact.
  //
  // The budget is per-platform because the cost being measured is mostly process spawn,
  // and Windows spawns roughly an order of magnitude slower than POSIX. A Windows runner
  // measured 588 ms against a flat 500 ms — the platform, not a regression. Raising the
  // number everywhere would have hidden a real slowdown on the two platforms where 500 ms
  // is met with room to spare, so the tight budget is kept where it means something.
  const budgetMs = process.platform === 'win32' ? 1500 : 500;

  it(`stays well inside the ${String(budgetMs)} ms a commit hook can spend`, async () => {
    const started = performance.now();
    await runCheck({ cwd: repo, quiet: true, staged: true });
    expect(performance.now() - started).toBeLessThan(budgetMs);
  });
});

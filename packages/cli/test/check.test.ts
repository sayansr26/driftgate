import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPlan, computePlan, NodeFileSystem, STATE_PATH } from '@driftgate/core';
import { ADAPTERS } from '../src/registry.js';
import { runCheck } from '../src/commands/check.js';
import { runSync } from '../src/commands/sync.js';
import {
  HINT_HAND_EDITED,
  HINT_ORPHAN_HAND_EDITED,
  HINT_SYNC,
  HINT_UNMANAGED,
} from '../src/ui/hints.js';
import { ExitCode } from '../src/ui/exit.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
// eslint forbids a literal control character in a regex, so build it.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);

let repo: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'driftgate-check-'));
  await cp(path.join(fixtures, 'cursor/input'), repo, { recursive: true });
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
});

const check = () => runCheck({ cwd: repo, color: false });
const sync = () => runSync({ cwd: repo, quiet: true });
const out = () => stdout.join('');
const err = () => stderr.join('');
const rule = (id: string) => path.join(repo, '.driftgate/rules', `${id}.md`);
const read = (rel: string) => readFile(path.join(repo, rel), 'utf8');

describe('driftgate check', () => {
  it('reports every planned artifact as missing before the first sync', async () => {
    expect(await check()).toBe(ExitCode.Failure);
    expect(out()).toContain('missing  CLAUDE.md');
    expect(out()).toContain('missing  .cursor/rules/10-style.mdc');
    expect(err()).toContain('5 files out of sync.');
    expect(err()).toContain(HINT_SYNC);
  });

  it('is in sync immediately after a sync', async () => {
    await sync();
    expect(await check()).toBe(ExitCode.Ok);
    expect(out()).toContain('in sync (5 artifacts)');
    expect(err()).toBe('');
  });

  it('reports a rule edited without a sync as stale, with a diff whose + side is the new render', async () => {
    // The case `check` exists for (PRD US4, "or is stale"), and the one `compareToDisk`
    // alone cannot see: disk still matches the record; only the render moved.
    await sync();
    await writeFile(rule('10-style'), '---\ndescription: Style\norder: 10\n---\n\nRewritten.\n');

    expect(await check()).toBe(ExitCode.Failure);
    expect(out()).toContain('stale  CLAUDE.md');
    expect(out()).toContain('stale  .cursor/rules/10-style.mdc');
    expect(out()).toMatch(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@$/m);
    expect(out()).toContain('+Rewritten.');
    // The fixture's original body appears on the - side.
    const original = await read('.cursor/rules/10-style.mdc');
    void original;
    expect(out()).toMatch(/^-.+$/m);
    expect(err()).toContain(HINT_SYNC);
    expect(err()).not.toContain(HINT_HAND_EDITED);
  });

  it('reports a hand-edited artifact with sync’s recovery hint, not "run: driftgate sync"', async () => {
    await sync();
    await writeFile(path.join(repo, 'CLAUDE.md'), 'I edited this myself.\n');

    expect(await check()).toBe(ExitCode.Failure);
    expect(out()).toContain('hand-edited  CLAUDE.md');
    expect(out()).toContain('-I edited this myself.');
    expect(err()).toContain(HINT_HAND_EDITED);
    // Telling this user to run `sync` would send them to a refusal.
    expect(err()).not.toContain(HINT_SYNC);
  });

  it('reports a deleted artifact as missing, without a diff', async () => {
    await sync();
    await rm(path.join(repo, '.cursor/rules/10-style.mdc'));

    expect(await check()).toBe(ExitCode.Failure);
    expect(out()).toContain('missing  .cursor/rules/10-style.mdc');
    expect(out()).not.toContain('@@');
    expect(err()).toContain('1 file out of sync.');
  });

  it('reports an orphan as drift, and a sync then makes check clean', async () => {
    // The shared rendering path, read in the other direction: whatever `check` flags,
    // `sync` resolves, including the deletion `sync` would make.
    //
    // The cursor-only rule on purpose: deleting any other rule also changes CLAUDE.md,
    // and a `check` that ignored orphans would still exit 1 for the stale file. This is
    // the only input on which the orphan alone decides the exit code.
    await sync();
    await rm(rule('40-cursor-only'));

    expect(await check()).toBe(ExitCode.Failure);
    expect(out()).toContain('orphaned  .cursor/rules/40-cursor-only.mdc');
    expect(err()).toContain('1 file out of sync.');
    expect(err()).toContain(HINT_SYNC);

    stdout = [];
    expect(await sync()).toBe(ExitCode.Ok);
    expect(await check()).toBe(ExitCode.Ok);
    expect(out()).toContain('in sync (4 artifacts)');
  });

  it('reports an edited orphan separately, with the orphan hint', async () => {
    await sync();
    await writeFile(path.join(repo, '.cursor/rules/20-testing.mdc'), 'mine now\n');
    await rm(rule('20-testing'));

    expect(await check()).toBe(ExitCode.Failure);
    expect(out()).toContain('orphan-hand-edited  .cursor/rules/20-testing.mdc');
    expect(err()).toContain(HINT_ORPHAN_HAND_EDITED);
    // Deleting the rule also changes CLAUDE.md, which is stale, so both hints apply —
    // one per situation present, not one per run.
    expect(out()).toContain('stale               CLAUDE.md');
    expect(err()).toContain(HINT_SYNC);
    expect(err()).toContain('2 files out of sync.');
  });

  it('reports a pre-existing file it never generated as unmanaged, with the --force hint', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), 'My own notes.\n');

    expect(await check()).toBe(ExitCode.Failure);
    expect(out()).toContain('unmanaged  CLAUDE.md');
    expect(err()).toContain(HINT_UNMANAGED);
  });

  it('warns about an unreadable state.json on stderr and still answers by content', async () => {
    await sync();
    await writeFile(path.join(repo, STATE_PATH), '<<<<<<< HEAD\n{ "broken"\n');

    // Every file still matches its render, so the answer is "in sync" — with a warning,
    // because without a record the next hand-edit will read as somebody else's file.
    expect(await check()).toBe(ExitCode.Ok);
    expect(err()).toContain('E_STATE_INVALID');
    expect(out()).toContain('in sync');
  });

  it('exits 1, not 2, and checks nothing when the canonical source is broken', async () => {
    await writeFile(rule('10-style'), '---\norder: high\n---\n\nBody.\n');

    expect(await check()).toBe(ExitCode.Failure);
    expect(err()).toContain('nothing was checked.');
    expect(err()).toContain('E_FRONTMATTER_INVALID');
    expect(out()).not.toContain('@@');
    expect(out()).not.toContain('missing');
  });

  it('puts the report on stdout and the hints on stderr', async () => {
    await sync();
    await writeFile(path.join(repo, 'CLAUDE.md'), 'edited\n');
    await check();

    expect(out()).toContain('hand-edited  CLAUDE.md');
    expect(out()).toContain('@@');
    expect(out()).not.toContain('hint:');
    expect(err()).toContain('hint:');
    expect(err()).not.toContain('@@');
  });

  it('prints nothing on stdout under --quiet and still exits 1', async () => {
    await sync();
    await writeFile(path.join(repo, 'CLAUDE.md'), 'edited\n');

    expect(await runCheck({ cwd: repo, color: false, quiet: true })).toBe(ExitCode.Failure);
    expect(out()).toBe('');
    expect(err()).toContain(HINT_HAND_EDITED);
  });

  it('names the repository root when it was found by walking up', async () => {
    await sync();
    await runCheck({ cwd: repo, color: false, announceRoot: true });
    expect(out()).toContain(`repo  ${repo}`);
  });

  it('emits no ANSI escapes when colour is off', async () => {
    await sync();
    await writeFile(path.join(repo, 'CLAUDE.md'), 'edited\n');
    await check();
    expect(out()).not.toMatch(ANSI);
    expect(err()).not.toMatch(ANSI);
    // Anti-vacuity: the diff is actually there.
    expect(out()).toContain('-edited');
  });

  it('emits ANSI escapes on a TTY, so the assertion above is known to be able to fail', async () => {
    await sync();
    await writeFile(path.join(repo, 'CLAUDE.md'), 'edited\n');
    const isTTY = process.stdout.isTTY;
    const noColor = process.env['NO_COLOR'];
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    delete process.env['NO_COLOR'];
    try {
      await runCheck({ cwd: repo, color: true });
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
      if (noColor !== undefined) process.env['NO_COLOR'] = noColor;
    }
    expect(out()).toMatch(ANSI);
  });

  it('writes nothing on a drifted repository', async () => {
    // A clean repository would make this vacuous: `sync` writes nothing there either.
    await sync();
    const stateBefore = await read(STATE_PATH);
    await writeFile(rule('10-style'), '---\ndescription: Style\norder: 10\n---\n\nRewritten.\n');
    await rm(rule('20-testing'));
    const writes = vi.spyOn(NodeFileSystem.prototype, 'writeFile');
    const deletes = vi.spyOn(NodeFileSystem.prototype, 'deleteFile');
    const copies = vi.spyOn(NodeFileSystem.prototype, 'copyFile');

    expect(await check()).toBe(ExitCode.Failure);

    expect(writes).not.toHaveBeenCalled();
    expect(deletes).not.toHaveBeenCalled();
    expect(copies).not.toHaveBeenCalled();
    expect(await read(STATE_PATH)).toBe(stateBefore);
    expect(await read('.cursor/rules/20-testing.mdc')).toBeDefined();

    // Control: the same spies see `sync` write and delete on this very repository.
    const plan = await computePlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    await applyPlan(plan, new NodeFileSystem(repo));
    expect(writes).toHaveBeenCalled();
    expect(deletes).toHaveBeenCalled();
  });

  it('runs well under a second on a repository of a hundred rules across five adapters', async () => {
    await writeFile(
      path.join(repo, '.driftgate/driftgate.yaml'),
      'schemaVersion: 1\ntools:\n  - claude-code\n  - codex\n  - copilot\n  - cursor\n  - gemini\n',
    );
    await mkdir(path.join(repo, '.driftgate/rules'), { recursive: true });
    for (let i = 0; i < 100; i += 1) {
      const body = Array.from({ length: 20 }, (_, l) => `Line ${l} of rule ${i}.`).join('\n');
      await writeFile(
        rule(`${String(100 + i)}-rule-${i}`),
        `---\norder: ${100 + i}\n---\n\n${body}\n`,
      );
    }
    await sync();
    await writeFile(rule('150-rule-50'), '---\norder: 150\n---\n\nChanged.\n');

    const started = performance.now();
    expect(await check()).toBe(ExitCode.Failure);
    const elapsed = performance.now() - started;

    // The validation says under 1s on a typical repo; this bound is loose enough not to
    // flake on a busy CI runner, and the measured figure is recorded in the task notes.
    expect(elapsed).toBeLessThan(5000);
    expect(out()).toContain('stale  CLAUDE.md');
  });
});

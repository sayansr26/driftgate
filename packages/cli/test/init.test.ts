import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFileSystem, computeInitPlan, computePlan } from '@driftgate/core';
import { ADAPTERS } from '../src/registry.js';
import { runInit } from '../src/commands/init.js';
import { runSync } from '../src/commands/sync.js';
import { ExitCode } from '../src/ui/exit.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'driftgate-init-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** Every file in the repo, repo-relative and sorted — the shape a filesystem spy compares. */
async function tree(dir = repo, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await tree(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

const read = (rel: string) => readFile(path.join(repo, rel), 'utf8');

const plan = () =>
  computeInitPlan({ repoRoot: repo, fs: new NodeFileSystem(repo), adapters: ADAPTERS });

/** A repository as it looks before anyone has heard of Driftgate. */
async function seedNativeConfigs(): Promise<void> {
  // Three shapes on purpose: a marker-bearing `CLAUDE.md` that imports structurally and
  // re-renders to the same bytes, a hand-written CRLF `AGENTS.md` that does not, and
  // Cursor's per-file `.mdc` plus a legacy `.cursorrules`.
  await cp(path.join(fixtures, 'claude-code-import/input'), repo, { recursive: true });
  await cp(path.join(fixtures, 'codex-import/input'), repo, { recursive: true });
  await cp(path.join(fixtures, 'cursor-import/input'), repo, { recursive: true });
}

describe('driftgate init', () => {
  it('writes nothing at all without --yes', async () => {
    await seedNativeConfigs();
    const before = await tree();

    // The filesystem spy T019's validation asks for. `writeFile` is what `applyPlan` and
    // `applyCanonicalFiles` both call, so a run that touched anything trips it — and the
    // tree comparison catches a write that went around it.
    const spy = vi.spyOn(NodeFileSystem.prototype, 'writeFile');
    try {
      expect(await runInit({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await tree()).toEqual(before);
  });

  it('applies exactly the plan it printed', async () => {
    await seedNativeConfigs();
    const planned = await computeInitPlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });

    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);

    for (const file of planned.canonicalFiles) {
      expect(await read(file.path)).toBe(file.contents);
    }
    for (const artifact of planned.plan.artifacts) {
      expect(await read(artifact.path)).toBe(artifact.contents);
    }
  });

  it('leaves the repository in a state where sync is already up to date', async () => {
    // The actual promise of `init`: after it, the loop works. If the first `sync` after
    // `init` rewrote files or refused them, `init` would have handed the user a repo in a
    // state its own tool disagrees with.
    await seedNativeConfigs();
    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);

    const after = await computePlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    for (const artifact of after.artifacts) {
      expect(await read(artifact.path)).toBe(artifact.contents);
    }
  });

  it('backs every pre-existing file up before taking ownership of it', async () => {
    await seedNativeConfigs();
    const original = await read('AGENTS.md');

    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);

    // Taking ownership is what the user asked for; taking their work is not. The original
    // bytes are recoverable, byte for byte, from inside the repository — CRLF and BOM
    // included, which is why the backup is a `copyFile` and not a read-then-write.
    expect(await read('.driftgate/backup/AGENTS.md')).toBe(original);
    expect(await read('AGENTS.md')).not.toBe(original);

    // The other half, and the more interesting one: a file whose re-render is
    // byte-identical is adopted rather than rewritten, so it is not backed up and not
    // touched. `CLAUDE.md` here carries our marker, so import and render round-trip it.
    expect(await read('CLAUDE.md')).toBe(
      await readFile(path.join(fixtures, 'claude-code-import/input/CLAUDE.md'), 'utf8'),
    );
  });

  it('loses nothing from the file it takes over', async () => {
    await seedNativeConfigs();
    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);

    const canonical = (await readdir(path.join(repo, '.driftgate/rules'))).sort();
    const contents = (await Promise.all(canonical.map((f) => read(`.driftgate/rules/${f}`)))).join(
      '\n',
    );

    for (const line of (await read('.driftgate/backup/AGENTS.md')).split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.includes('generated by driftgate')) continue;
      expect(contents, `line lost on import: ${trimmed}`).toContain(trimmed);
    }
  });

  it('says so and does nothing when the repository is already adopted', async () => {
    await cp(path.join(fixtures, 'cursor/input'), repo, { recursive: true });
    await seedNativeConfigs();
    const before = await tree();
    const manifest = await read('.driftgate/driftgate.yaml');

    const planned = await computeInitPlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    // The assertion that actually reaches the branch. Comparing the file tree alone is
    // not enough: with the guard removed, init re-imports the native files and rewrites
    // `.driftgate/driftgate.yaml` in place, which adds no paths and changes everything.
    expect(planned.adopted).toBe(true);
    expect(planned.canonicalFiles).toEqual([]);

    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await tree()).toEqual(before);
    expect(await read('.driftgate/driftgate.yaml')).toBe(manifest);
  });

  it('leaves a canonical rule that already says what init would write it', async () => {
    // Reachable through `.driftgate/rules/` with no manifest — the parser's `rules-only`
    // mode. Without a leave-alone classification init reports every such file as a
    // create and rewrites it, which is a lie in the plan before it is a write on disk.
    await seedNativeConfigs();
    const first = await computeInitPlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    const rule = first.canonicalFiles.find((f) => f.path.startsWith('.driftgate/rules/'));
    expect(rule).toBeDefined();

    await mkdir(path.join(repo, '.driftgate/rules'), { recursive: true });
    await writeFile(path.join(repo, rule!.path), rule!.contents);

    const second = await computeInitPlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    expect(second.canonicalFiles.find((f) => f.path === rule!.path)?.kind).toBe('leave-alone');
  });

  it('reports a repository with no AI tool configuration rather than failing on it', async () => {
    await writeFile(path.join(repo, 'README.md'), '# nothing to see\n');
    expect(await runInit({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await tree()).toEqual(['README.md']);
  });

  it('warns that a formatter and a generator cannot both own the generated files', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, '.prettierrc'), '{}\n');

    const planned = await plan();
    expect(planned.warnings.map((w) => w.code)).toContain('E_FORMATTER_CONFLICT');

    // The paired control: no formatter config, no warning. Without it the assertion above
    // passes against a warning that fires unconditionally.
    await rm(path.join(repo, '.prettierrc'));
    const quiet = await plan();
    expect(quiet.warnings.map((w) => w.code)).not.toContain('E_FORMATTER_CONFLICT');
  });

  // T072: Prettier was the only formatter the warning knew about, so a repository
  // formatted by anything else walked into the same deadlock with nothing said.
  it.each([
    ['Biome', 'biome.json', 'files.includes'],
    ['dprint', 'dprint.json', 'excludes'],
    ['ESLint', 'eslint.config.js', '.eslintignore'],
  ])('warns about %s too, naming where its exclusions live', async (name, config, where) => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, config), '{}\n');

    const warning = (await plan()).warnings.find((w) => w.message.includes(name));
    expect(warning?.code).toBe('E_FORMATTER_CONFLICT');
    // The hint has to name that formatter's own mechanism. Biome and dprint have no
    // ignore file at all, so "add these lines to .prettierignore" is wrong advice, which
    // is the same failure as no advice.
    expect(warning?.hint).toContain(where);
  });

  it('detects Prettier from package.json when there is no config file', async () => {
    await seedNativeConfigs();
    await writeFile(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'x', devDependencies: { prettier: '^3.0.0' } }, null, 2),
    );

    expect((await plan()).warnings.map((w) => w.code)).toContain('E_FORMATTER_CONFLICT');
  });

  // The false positive, and the reason exact-line matching had to go: this repository's
  // own `.prettierignore` lists `.cursor/rules/` and `.github/instructions/`, which cover
  // their contents without naming one of them. A warning that fires on a correctly
  // configured repository is one people learn to ignore.
  it('stays quiet when the ignore file covers the generated paths by directory or glob', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, '.prettierrc'), '{}\n');

    const planned = await plan();
    const generated = planned.plan.artifacts.map((a) => a.path);
    expect(generated.length).toBeGreaterThan(0);
    // Deliberately not the literal paths: directory entries and one `**` glob, which is
    // what a real ignore file looks like and what the old matcher could not read.
    await writeFile(
      path.join(repo, '.prettierignore'),
      ['# generated', '.cursor/', '.github/', '**/*.md', ''].join('\n'),
    );

    expect((await plan()).warnings.map((w) => w.code)).not.toContain('E_FORMATTER_CONFLICT');
  });

  // The other half of the same rule: a negation un-ignores, and the last matching line
  // wins. Without it a user who deliberately re-included one generated file is told
  // nothing about the only file that will actually be reformatted.
  it('warns about exactly the path a negation re-includes', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, '.prettierrc'), '{}\n');
    await writeFile(
      path.join(repo, '.prettierignore'),
      ['.cursor/', '.github/', '**/*.md', '!CLAUDE.md', ''].join('\n'),
    );

    const warning = (await plan()).warnings.find((w) => w.code === 'E_FORMATTER_CONFLICT');
    expect(warning?.hint).toContain('CLAUDE.md');
    expect(warning?.message).toContain('1 generated file(s)');
  });

  // T019's decision, made mechanical: `init` warns about the user's ignore file and never
  // edits it. A tool whose pitch is that it never touches what it did not generate should
  // not open its first conversation by editing something it did not generate.
  it('never writes an ignore file, even under --yes', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, '.prettierrc'), '{}\n');
    await writeFile(path.join(repo, '.prettierignore'), '# mine\n');

    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);

    expect(await read('.prettierignore')).toBe('# mine\n');
    expect(await tree()).not.toContain('.eslintignore');
  });
});

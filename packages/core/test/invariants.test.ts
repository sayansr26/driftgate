import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../../../vitest.config.js';
import { GIT_SUBCOMMANDS, StagedFileSystem } from '../src/git/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Repo-relative and POSIX. Every allowlist and expected value in this file is written
 * with forward slashes, but `path.relative` emits `\` on Windows — which is how the write
 * allowlist and the picocolors pin came to report five correct files and one correct
 * import as violations on the Windows cells, and only there. The separator is exactly the
 * class of difference this matrix exists to find, so the tests that police it must not be
 * the ones that trip over it.
 */
function relPosix(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

/**
 * NFR1 says zero network calls "by default and forever". A README promise decays;
 * a test does not. These two suites are the mechanical form of that promise, and of
 * the thin-dependency claim the project's own pitch rests on.
 */

const ALLOWED_RUNTIME_DEPS = new Set(['yaml', 'commander', 'picocolors']);

async function adapterDirs(): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, 'packages/adapters'), { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => `packages/adapters/${e.name}`)
    .sort();
}

async function packageManifests(): Promise<{ name: string; dir: string; json: PackageJson }[]> {
  // Adapters are *discovered*, not listed. A hardcoded list would silently stop covering
  // the next adapter someone scaffolds (T028), and an invariant that quietly narrows its
  // own scope while staying green is worse than not having it.
  // `packages/interop` is listed explicitly (T054): it is not an adapter and does not live
  // under `packages/adapters/`, but it ships, so the dependency allowlist and the engines
  // pin must cover it. A package that escapes this list is a package where a third-party
  // dependency can arrive unnoticed.
  const dirs = [
    'packages/core',
    'packages/cli',
    'packages/adapter-kit',
    'packages/interop',
    'action',
  ].concat(await adapterDirs());
  return Promise.all(
    dirs.map(async (dir) => {
      const json = JSON.parse(
        await readFile(path.join(repoRoot, dir, 'package.json'), 'utf8'),
      ) as PackageJson;
      return { name: json.name, dir, json };
    }),
  );
}

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  engines?: { node?: string };
  type?: string;
}

describe('dependency surface', () => {
  it('declares no third-party runtime dependency outside the allowlist', async () => {
    const offenders: string[] = [];
    for (const { name, json } of await packageManifests()) {
      for (const dep of Object.keys(json.dependencies ?? {})) {
        if (dep.startsWith('@driftgate/') || dep === 'driftgate') continue;
        if (!ALLOWED_RUNTIME_DEPS.has(dep)) offenders.push(`${name} -> ${dep}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('pins every package to ESM and Node >=20', async () => {
    for (const { name, json } of await packageManifests()) {
      expect(json.type, `${name} must be ESM`).toBe('module');
      expect(json.engines?.node, `${name} engines.node`).toBe('>=20');
    }
  });
});

/**
 * The only directory in shipped source that may spawn a process (T052). One entry, and
 * the test above pins the length.
 */
const SPAWN_ALLOWLIST = ['packages/core/src/git'];

describe('zero network calls', () => {
  const FORBIDDEN = [
    /from\s+['"]node:(https?|net|dgram|dns|tls)['"]/,
    /require\(\s*['"]node:(https?|net|dgram|dns|tls)['"]\s*\)/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
  ];

  it('has no network primitive anywhere in shipped source', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) {
          offenders.push(`${relPosix(file)} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('spawns no process outside the one allowlisted directory', async () => {
    // T023 banned `child_process` outright and said the ban would be narrowed when
    // `check --staged` arrived, because reading the git index means a subprocess. T052 is
    // that narrowing. The allowlist has **exactly one** entry and the assertion below
    // pins its length: a ban that grows an entry per feature is not a ban, and `curl` is
    // one `execFile` away from "zero network calls" being false.
    expect(SPAWN_ALLOWLIST).toHaveLength(1);

    const FORBIDDEN_SPAWN = [
      /from\s+['"](node:)?child_process['"]/,
      /require\(\s*['"](node:)?child_process['"]\s*\)/,
    ];
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const rel = relPosix(file);
      if (SPAWN_ALLOWLIST.some((dir) => rel.startsWith(dir))) continue;
      const text = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_SPAWN) {
        if (pattern.test(text)) offenders.push(`${rel} matches ${String(pattern)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runs only read-only git subcommands, and only from the allowlisted directory', async () => {
    // The allowlist is a hole, so the hole gets its own guard. `execFile('git', [...])`
    // reaches `git fetch` and a submodule update as easily as `ls-files`, and either one
    // makes "zero network calls" false while every file scan above stays green.
    expect([...GIT_SUBCOMMANDS].sort()).toEqual(['cat-file', 'ls-files', 'rev-parse']);

    const text = await readFile(path.join(repoRoot, SPAWN_ALLOWLIST[0]!, 'index.ts'), 'utf8');
    // `exec` runs a shell; `execFile` does not. The difference is whether a filename
    // containing `$(…)` is an argument or a command.
    expect(text).not.toMatch(/\bexec\s*\(/);
    expect(text).toMatch(/\bexecFile\s*\(/);
    // Every literal subcommand in the file must be one the contract declares.
    for (const [, sub] of text.matchAll(/run\(\s*\[\s*'([a-z-]+)'/g)) {
      expect(GIT_SUBCOMMANDS).toContain(sub);
    }
  });

  it('has no nondeterministic primitive in shipped source', async () => {
    // See docs/determinism.md. os.EOL, locale-sensitive comparison, and clock or
    // randomness reads all make output depend on where it was produced.
    const FORBIDDEN_NONDETERMINISM = [/\bos\.EOL\b/, /\.localeCompare\(/, /Math\.random\(/];
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_NONDETERMINISM) {
        if (pattern.test(text)) {
          offenders.push(`${relPosix(file)} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

async function sourceFiles(): Promise<string[]> {
  const roots = [path.join(repoRoot, 'packages'), path.join(repoRoot, 'action', 'src')];
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'test') {
          continue;
        }
        await walk(child);
        continue;
      }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(child);
    }
  };
  await Promise.all(roots.map(walk));
  return out.sort();
}

describe('the shared rendering path', () => {
  /**
   * `check` and `sync` must consume one rendering pass. The mechanism is that only
   * `pipeline/apply.ts` writes and only adapters render — so if writing or rendering
   * leaks into the CLI, the two commands can drift apart and `check` starts lying.
   * These are structural assertions, not style rules.
   */
  it('keeps every filesystem write inside the core io and apply layers', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const rel = relPosix(file);
      if (
        !/\bwriteFile\(|\bcopyFile\(|\bunlink\(|\brmSync\(|\bdeleteFile\(/.test(
          await readFile(file, 'utf8'),
        )
      ) {
        continue;
      }
      const allowed =
        rel.startsWith('packages/core/src/io/') ||
        rel === 'packages/core/src/pipeline/apply.ts' ||
        rel === 'packages/core/src/fs/types.ts';
      if (!allowed) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * `check` is read-only by construction: it holds a filesystem with no write methods
   * and never calls the one function that writes. The runtime test for that is inert on
   * a clean repository — `applyPlan` writes nothing there either — so this pins the
   * absence of the call site itself.
   */
  it('keeps applyPlan and any writable filesystem out of check', async () => {
    const check = path.join(repoRoot, 'packages/cli/src/commands/check.ts');
    const text = await readFile(check, 'utf8');
    expect(text).not.toMatch(/applyPlan/);
    // `createReadOnlyFileSystem` returns an object with no writers on it; a
    // `NodeFileSystem` typed as read-only is one cast away from a write.
    expect(text).not.toMatch(/new NodeFileSystem\(/);
    expect(text).toMatch(/createReadOnlyFileSystem\(/);
  });

  /**
   * `--staged` gave `check` a second filesystem, so the guarantee above needs a second
   * proof. A textual scan cannot make it: `StagedFileSystem` is a class `check` legitimately
   * constructs, and the risk is not the call site but the class quietly gaining a writer.
   * Asked of the object itself instead — there is nothing to cast to if the methods are not
   * there, which is the same argument that shaped `createReadOnlyFileSystem` at T016.
   */
  it('gives the staged filesystem no write method to reach', () => {
    const fs: object = new StagedFileSystem(repoRoot);
    for (const method of ['writeFile', 'copyFile', 'deleteFile', 'mkdir', 'rm']) {
      expect(method in fs, `StagedFileSystem must not expose ${method}`).toBe(false);
    }
    // The paired control: a method it *does* have, so the loop is not passing on a typo.
    expect('readFile' in fs).toBe(true);
  });

  /**
   * picocolors' module default force-enables colour under `CI` and on win32, so the only
   * colours anything may use are the ones `createOutput` derives from the real TTY state.
   * A second import site is a second chance to write escapes into a CI log.
   */
  it('imports picocolors in exactly one place', async () => {
    const importers: string[] = [];
    for (const file of await sourceFiles()) {
      if (/from\s+['"]picocolors['"]/.test(await readFile(file, 'utf8'))) {
        importers.push(relPosix(file));
      }
    }
    expect(importers).toEqual(['packages/cli/src/ui/report.ts']);
  });

  it('keeps rendering out of the CLI', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const rel = relPosix(file);
      if (!rel.startsWith('packages/cli/src/')) continue;
      const text = await readFile(file, 'utf8');
      // The one file that names the renderers without calling them: `adapter new`
      // *emits* an adapter's source (T028), so they appear inside template literals.
      // The guarantee is kept by a stronger check — it cannot call what it never
      // imports, and its only import from core is a type.
      if (rel === 'packages/cli/src/commands/adapter/templates.ts') {
        const coreImports = [
          ...text.matchAll(/^import (type )?\{[^}]*\} from '@driftgate\/core'/gm),
        ];
        expect(coreImports.length, rel).toBeGreaterThan(0);
        for (const match of coreImports) expect(match[1], rel).toBe('type ');
        continue;
      }
      // The CLI parses flags, calls the pipeline, and prints. It never builds output.
      if (/renderConcatenated|renderRuleSection|finalizeArtifact|withHtmlMarker/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The detection engine reaches the user's home directory, which is the one place in
   * this codebase where "reads only" stops being enforced by `ReadOnlyFileSystem` alone
   * and starts depending on *which root* the filesystem was built with. The engine takes
   * both filesystems as parameters and constructs neither, so the choice of root is the
   * caller's and the engine stays testable against `MemoryFileSystem`.
   *
   * If it ever imports `io/` or `node:os` directly, that seam is gone and the guarantee
   * becomes a convention. Lint enforces the `node:fs` half; this covers the rest.
   */
  it('keeps the detection engine off the io layer and the host OS', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const rel = relPosix(file);
      if (!rel.startsWith('packages/core/src/detect/')) continue;
      const text = await readFile(file, 'utf8');
      if (/from\s+['"]\.\.\/io\/|from\s+['"]node:(os|fs)/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("exposes verifyPlan alongside applyPlan, so `check` shares sync's plan", async () => {
    const pipeline = path.join(repoRoot, 'packages/core/src/pipeline');
    const files = (await readdir(pipeline)).sort();
    expect(files).toEqual(['apply.ts', 'plan.ts', 'verify.ts']);
  });
});

describe('the adapter contract boundary', () => {
  /**
   * T011 froze `@driftgate/adapter-kit` as the contract external contributors write
   * against, and the proof that the contract is sufficient is that our own two adapters
   * need nothing else. `eslint.config.js` bans the core import too; this exists because
   * an inline `eslint-disable` defeats a lint rule and nothing defeats a file scan.
   */
  it('keeps adapters off @driftgate/core entirely', async () => {
    const offenders: string[] = [];
    for (const file of await adapterFiles()) {
      const rel = relPosix(file);
      if (/from\s+['"]@driftgate\/core/.test(await readFile(file, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('declares only the kit as an adapter dependency', async () => {
    for (const dir of await adapterDirs()) {
      const json = JSON.parse(
        await readFile(path.join(repoRoot, dir, 'package.json'), 'utf8'),
      ) as PackageJson;
      expect(Object.keys(json.dependencies ?? {}).sort(), dir).toEqual(['@driftgate/adapter-kit']);
    }
  });

  it('leaves no type escape behind in the migrated adapters', async () => {
    // T011's stated validation is that the adapters compile against the extracted types
    // "with no local type escapes" — asserted rather than eyeballed.
    const offenders: string[] = [];
    for (const file of await adapterFiles()) {
      const text = await readFile(file, 'utf8');
      if (/\bas any\b|as unknown as|@ts-expect-error|@ts-ignore/.test(text)) {
        offenders.push(relPosix(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

async function adapterFiles(): Promise<string[]> {
  const dirs = await adapterDirs();
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        await walk(child);
        continue;
      }
      if (entry.name.endsWith('.ts')) out.push(child);
    }
  };
  // Adapter tests are included on purpose: a test is where the next author copies their
  // import block from, so the boundary has to hold there too.
  await Promise.all(dirs.map((d) => walk(path.join(repoRoot, d))));
  return out.sort();
}

/**
 * Two hand-maintained copies of one package -> source map: `tsconfig.eslint.json` for the
 * linter and `vitest.config.ts` for the runner. Both exist because `pnpm verify` runs
 * `lint` and `test` *before* `build`, so neither may resolve a workspace package through
 * its `exports` map into a `dist/` that a clean clone does not have.
 *
 * They drifted. The CLI is the one package whose name is unscoped — `driftgate`, not
 * `@driftgate/cli` — and it was registered in the runner and missed in the linter, so
 * `action/`'s imports fell back to an absent `dist/index.d.ts` and every symbol behind
 * them, down to `Hunk.oldStart`, linted as `any`. Green on a machine with a built `dist/`,
 * fifty-four errors on CI. Two copies of a list stay equal because something checks, so
 * this pins both to the workspace itself rather than to each other alone.
 */
describe('workspace source maps', () => {
  // `action` is private and nothing imports it, so it needs no entry in either map.
  const UNIMPORTED = new Set(['@driftgate/action']);

  /** `@driftgate/adapter-kit/testing` is a subpath of `@driftgate/adapter-kit`. */
  function basePackage(key: string): string {
    const segments = key.split('/');
    return key.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? key);
  }

  async function eslintPaths(): Promise<Record<string, string[]>> {
    const text = await readFile(path.join(repoRoot, 'tsconfig.eslint.json'), 'utf8');
    // The file is JSONC. Its comments are all whole-line, which is the only form this
    // strips; a trailing one would make `JSON.parse` throw here rather than pass quietly.
    const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    const paths = parsed.compilerOptions?.paths;
    if (paths === undefined) throw new Error('tsconfig.eslint.json has no compilerOptions.paths');
    return paths;
  }

  async function expectedNames(): Promise<string[]> {
    return (await packageManifests())
      .map(({ name }) => name)
      .filter((name) => !UNIMPORTED.has(name))
      .sort();
  }

  it("covers every workspace package in eslint's path map", async () => {
    const mapped = [...new Set(Object.keys(await eslintPaths()).map(basePackage))].sort();
    expect(mapped).toEqual(await expectedNames());
  });

  it("covers every workspace package in vitest's alias map", async () => {
    const alias = vitestConfig.resolve?.alias;
    if (alias === undefined || Array.isArray(alias)) {
      throw new Error('vitest.config.ts resolve.alias must be a record of package names');
    }
    const mapped = [...new Set(Object.keys(alias).map(basePackage))].sort();
    expect(mapped).toEqual(await expectedNames());
  });

  it('points every eslint path entry at a file that exists', async () => {
    const missing: string[] = [];
    for (const [key, targets] of Object.entries(await eslintPaths())) {
      for (const target of targets) {
        // A map entry left behind by a rename resolves to nothing, which reads exactly
        // like the bug above: the linter silently falls back to the `exports` map.
        const exists = await stat(path.join(repoRoot, target)).then(
          () => true,
          () => false,
        );
        if (!exists) missing.push(`${key} -> ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

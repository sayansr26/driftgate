import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

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
  const dirs = ['packages/core', 'packages/cli', 'packages/adapter-kit', 'action'].concat(
    await adapterDirs(),
  );
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
          offenders.push(`${path.relative(repoRoot, file)} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('spawns no process anywhere in shipped source', async () => {
    // `check --staged` will need the git index one day (T052), and reading it means a
    // subprocess. Until a directory is deliberately allowlisted here, the answer is
    // that shipped code never spawns anything — which also keeps "zero network calls"
    // honest, since `curl` is one `execFile` away.
    const FORBIDDEN_SPAWN = [
      /from\s+['"](node:)?child_process['"]/,
      /require\(\s*['"](node:)?child_process['"]\s*\)/,
    ];
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_SPAWN) {
        if (pattern.test(text)) {
          offenders.push(`${path.relative(repoRoot, file)} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
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
          offenders.push(`${path.relative(repoRoot, file)} matches ${String(pattern)}`);
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
      const rel = path.relative(repoRoot, file);
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
   * picocolors' module default force-enables colour under `CI` and on win32, so the only
   * colours anything may use are the ones `createOutput` derives from the real TTY state.
   * A second import site is a second chance to write escapes into a CI log.
   */
  it('imports picocolors in exactly one place', async () => {
    const importers: string[] = [];
    for (const file of await sourceFiles()) {
      if (/from\s+['"]picocolors['"]/.test(await readFile(file, 'utf8'))) {
        importers.push(path.relative(repoRoot, file));
      }
    }
    expect(importers).toEqual(['packages/cli/src/ui/report.ts']);
  });

  it('keeps rendering out of the CLI', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const rel = path.relative(repoRoot, file);
      if (!rel.startsWith('packages/cli/src/')) continue;
      const text = await readFile(file, 'utf8');
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
      const rel = path.relative(repoRoot, file);
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
      const rel = path.relative(repoRoot, file);
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
        offenders.push(path.relative(repoRoot, file));
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

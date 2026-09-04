import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NodeFileSystem,
  parse,
  renderConcatenated,
  selects,
  sortRules,
  withHtmlMarker,
} from '@driftgate/core';
import { runAdapterNew } from '../src/commands/adapter/index.js';
import { registerInRegistry } from '../src/commands/adapter/register.js';
import { ExitCode } from '../src/ui/exit.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * T028: the scaffold's stated validation is that a scaffolded adapter passes `pnpm test`
 * immediately. That claim is only fully testable by running the scaffold in this
 * repository and running the suite — which is how it was checked, and what
 * `registry.test.ts`, `precedence-docs.test.ts` and `import-roundtrip.test.ts` then cover
 * for free, since all three are driven off `ADAPTERS`.
 *
 * What is testable here, in a temporary tree, is everything up to that point: the refusals,
 * that nothing is written without `--yes`, that all four registration files are patched,
 * and — the one that matters most — that the golden the scaffold writes is byte-identical
 * to what the stub it also writes will render. A generated golden that does not match its
 * own generator would make the contributor's first `pnpm test` red for a reason that is
 * not their fault.
 */

/** The four files the scaffold patches, copied from the real repo so the patchers run on real content. */
const PATCHED = [
  'packages/cli/src/registry.ts',
  'packages/cli/package.json',
  'vitest.config.ts',
  'docs/rfc-0001-canonical-format.md',
] as const;

let repo: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'driftgate-scaffold-'));
  for (const file of PATCHED) {
    await mkdir(path.join(repo, path.dirname(file)), { recursive: true });
    await cp(path.join(repoRoot, file), path.join(repo, file));
  }
  await mkdir(path.join(repo, 'packages/adapters'), { recursive: true });

  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const read = (rel: string): Promise<string> => readFile(path.join(repo, rel), 'utf8');
const exists = (rel: string): Promise<boolean> =>
  readFile(path.join(repo, rel), 'utf8').then(
    () => true,
    () => false,
  );

describe('driftgate adapter new — refusals', () => {
  it('rejects an id that is not a package directory name', async () => {
    for (const bad of ['Kiro', 'my tool', 'tool/../etc', '-kiro', '']) {
      expect(await runAdapterNew({ cwd: repo, tool: bad })).toBe(ExitCode.Usage);
    }
    // Usage, not failure: CI reads the exit code, and a typo must not look like drift.
    expect(await exists('packages/adapters/Kiro/package.json')).toBe(false);
  });

  it('rejects an id that already ships', async () => {
    expect(await runAdapterNew({ cwd: repo, tool: 'cursor' })).toBe(ExitCode.Usage);
    expect(stderr.join('')).toContain('already ships');
  });

  it('refuses to run outside a checkout of the monorepo', async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'driftgate-elsewhere-'));
    try {
      expect(await runAdapterNew({ cwd: elsewhere, tool: 'kiro' })).toBe(ExitCode.Usage);
      expect(stderr.join('')).toContain('not a checkout of the driftgate monorepo');
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses rather than overwrite an existing path, and writes nothing at all', async () => {
    await mkdir(path.join(repo, 'packages/adapters/kiro/src'), { recursive: true });
    await writeFile(path.join(repo, 'packages/adapters/kiro/src/index.ts'), 'mine\n');
    const registryBefore = await read('packages/cli/src/registry.ts');

    expect(await runAdapterNew({ cwd: repo, tool: 'kiro', yes: true })).toBe(ExitCode.Failure);
    expect(stderr.join('')).toContain('E_SCAFFOLD_CONFLICT');

    // The check runs over every path before the first write, so a collision leaves the
    // repository exactly as it was rather than half-scaffolded.
    expect(await read('packages/adapters/kiro/src/index.ts')).toBe('mine\n');
    expect(await exists('packages/adapters/kiro/package.json')).toBe(false);
    expect(await read('packages/cli/src/registry.ts')).toBe(registryBefore);
  });
});

describe('driftgate adapter new — the plan', () => {
  it('writes nothing without --yes', async () => {
    expect(await runAdapterNew({ cwd: repo, tool: 'kiro' })).toBe(ExitCode.Ok);

    const output = stdout.join('');
    expect(output).toContain('would create  packages/adapters/kiro/src/index.ts');
    expect(output).toContain('would register in  packages/cli/src/registry.ts');
    expect(output).toContain('driftgate adapter new kiro --yes');
    expect(await exists('packages/adapters/kiro/package.json')).toBe(false);
    expect(await read('packages/cli/src/registry.ts')).not.toContain('kiro');
  });
});

describe('driftgate adapter new --yes', () => {
  beforeEach(async () => {
    expect(await runAdapterNew({ cwd: repo, tool: 'kiro', yes: true })).toBe(ExitCode.Ok);
  });

  it('creates the package, its tests, and all three fixture layouts', async () => {
    for (const file of [
      'packages/adapters/kiro/package.json',
      'packages/adapters/kiro/tsconfig.json',
      'packages/adapters/kiro/src/index.ts',
      'packages/adapters/kiro/src/docs.ts',
      'packages/adapters/kiro/test/detect.test.ts',
      'packages/adapters/kiro/test/write.test.ts',
      'packages/adapters/kiro/test/read.test.ts',
      'fixtures/kiro/input/.driftgate/driftgate.yaml',
      'fixtures/kiro/expected/KIRO.md',
      'fixtures/kiro-detect/positive/KIRO.md',
      'fixtures/kiro-detect/negative/README.md',
      'fixtures/kiro-import/input/KIRO.md',
      'fixtures/kiro-import/expected/rules/style.md',
    ]) {
      expect(await exists(file), file).toBe(true);
    }
  });

  it('registers the adapter in all four places, in sorted position', async () => {
    const registry = await read('packages/cli/src/registry.ts');
    expect(registry).toContain("import { kiro } from '@driftgate/adapter-kiro';");

    // Asserted as *sorted position*, not as a pinned roster. The literal list was
    // roster-bound: every new shipped adapter broke this test for a reason that had
    // nothing to do with the scaffold, which is the failure T028 recorded when three
    // other tests turned out to be silently bound the same way.
    const listed = /ADAPTERS: readonly Adapter\[\] = \[([^\]]*)\]/.exec(registry)?.[1];
    expect(listed).toBeDefined();
    const names = listed!.split(',').map((n) => n.trim());
    expect(names).toContain('kiro');
    expect([...names].sort()).toEqual(names);

    expect(await read('packages/cli/package.json')).toContain(
      '"@driftgate/adapter-kiro": "workspace:*"',
    );
    expect(await read('vitest.config.ts')).toContain(
      "'@driftgate/adapter-kiro': src('./packages/adapters/kiro/src/index.ts')",
    );
    // RFC-0001 §4.1 is asserted against the registry by `rfc-output.test.ts`, so an
    // unpatched table is a failing suite rather than a documentation nit.
    expect(await read('docs/rfc-0001-canonical-format.md')).toContain('| `kiro`');
  });

  it('leaves the patched files parseable and still Prettier-shaped', async () => {
    const pkg = JSON.parse(await read('packages/cli/package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@driftgate/adapter-kiro']).toBe('workspace:*');

    const rfc = (await read('docs/rfc-0001-canonical-format.md')).split('\n');
    const table = rfc.slice(rfc.findIndex((l) => /^\|\s*Id\s*\|/.test(l)));
    const rows = table.slice(
      0,
      table.findIndex((l) => !l.startsWith('|')),
    );
    // Every row is padded to one width, which is what Prettier would produce; a scaffold
    // whose output fails `pnpm format` teaches the contributor the repo is broken.
    expect(rows.some((r) => r.startsWith('| `kiro`'))).toBe(true);
    expect(new Set(rows.filter((r) => r.startsWith('| `')).map((r) => r.length)).size).toBe(1);
  });

  it('writes a golden that is exactly what the stub it wrote will render', async () => {
    // The load-bearing assertion. The template's `write()` and the template's golden are
    // two hand-written strings, and nothing else in the suite compares them until a
    // contributor runs the scaffold. Rendering the generated fixture here with the same
    // primitives the stub uses pins them together — and fails if the renderer changes.
    const input = path.join(repo, 'fixtures/kiro/input');
    const parsed = await parse({ fs: new NodeFileSystem(input) });
    expect(parsed.errors).toEqual([]);

    const rules = sortRules(
      parsed.canonical.rules.filter((r) => selects(r.frontmatter.tools, 'kiro')),
    );
    const rendered = withHtmlMarker(
      renderConcatenated(rules, { headingLevel: 2, showGlobs: true }),
      parsed.canonical.manifest.options.marker,
    );

    expect(await read('fixtures/kiro/expected/KIRO.md')).toBe(rendered);
    // And the excluded rule really is excluded, so the fixture tests something.
    expect(rendered).not.toContain('must not reach kiro');
  });
});

describe('the registry patch', () => {
  it('is idempotent in shape: importing and listing stay in one sorted order', () => {
    const source = [
      "import { gemini } from '@driftgate/adapter-gemini';",
      "import { codex } from '@driftgate/adapter-codex';",
      "import type { Adapter } from '@driftgate/core';",
      '',
      'export const ADAPTERS: readonly Adapter[] = [gemini, codex];',
      '',
    ].join('\n');

    expect(registerInRegistry(source, 'kiro')).toBe(
      [
        "import { codex } from '@driftgate/adapter-codex';",
        "import { gemini } from '@driftgate/adapter-gemini';",
        "import { kiro } from '@driftgate/adapter-kiro';",
        "import type { Adapter } from '@driftgate/core';",
        '',
        'export const ADAPTERS: readonly Adapter[] = [codex, gemini, kiro];',
        '',
      ].join('\n'),
    );
  });

  it('turns a registry it does not recognize into a stated refusal', () => {
    expect(() => registerInRegistry('// nothing here\n', 'kiro')).toThrow(/E_SCAFFOLD_CONFLICT|/);
  });
});

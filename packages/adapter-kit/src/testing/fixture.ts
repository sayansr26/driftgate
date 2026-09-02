import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADAPTER_API_VERSION,
  DRIFTGATE_DIR,
  MANIFEST_PATH,
  NodeFileSystem,
  emptyCanonical,
  parse,
  serializeCanonical,
  type Adapter,
  type AdapterContext,
} from '@driftgate/core';

/**
 * A small fixture runner shared by the adapters.
 *
 * Deliberately minimal: the full harness — readable diffs, an `--update-fixtures`
 * escape hatch, and a per-adapter registration API — is T012. This exists because two
 * adapters now need the same three functions, and duplicating them would be worse than
 * a premature abstraction.
 */

export const fixturesRoot = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));

export async function contextFor(fixtureDir: string, adapter: Adapter): Promise<AdapterContext> {
  const repoRoot = path.join(fixturesRoot, fixtureDir);
  const fs = new NodeFileSystem(repoRoot);
  const result = await parse({ fs });
  // A missing canonical source is expected here rather than exceptional: `detect()`
  // runs on repositories that have not adopted Driftgate yet — that is the first step
  // of `init`. Any other parse error is a broken fixture.
  const fatal = result.errors.filter((e) => e.code !== 'E_NO_CANONICAL_SOURCE');
  if (fatal.length > 0) {
    throw new Error(
      `fixture ${fixtureDir} failed to parse:\n${fatal.map((e) => e.format()).join('\n')}`,
    );
  }
  const options = result.canonical.manifest.tools.find((t) => t.id === adapter.name)?.options ?? {};
  return { repoRoot, canonical: result.canonical, fs, options, apiVersion: ADAPTER_API_VERSION };
}

export async function renderFixture(
  fixtureDir: string,
  adapter: Adapter,
): Promise<Map<string, string>> {
  const ctx = await contextFor(`${fixtureDir}/input`, adapter);
  const artifacts = await adapter.write(ctx);
  return new Map(artifacts.map((a) => [a.path, a.contents]));
}

export async function readExpected(fixtureDir: string): Promise<Map<string, string>> {
  const root = path.join(fixturesRoot, fixtureDir, 'expected');
  const out = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, rel);
      else out.set(rel, await readFile(child, 'utf8'));
    }
  };
  await walk(root, '');
  return out;
}

/**
 * The two fixture layouts, resolved so that no caller ever concatenates a subpath.
 *
 * They differ because the situations differ: a write fixture needs an `input/` repo plus
 * the `expected/` bytes it must produce, while a detect fixture is a whole repo that
 * either shows the tool's fingerprints or does not, and has no expected output at all.
 * Callers that built the subpath by hand had to know which shape they were addressing.
 */
export function writeFixture(tool: string): { readonly input: string; readonly expected: string } {
  return { input: `${tool}/input`, expected: `${tool}/expected` };
}

export function detectFixture(tool: string, kase: 'positive' | 'negative'): string {
  return `${tool}-detect/${kase}`;
}

/**
 * The aggregate detection fixtures (T016): whole repositories exercising the engine over
 * the entire shipped adapter set rather than one adapter's `detect()`.
 *
 * `home` is the odd one out and is named rather than inferred — it stands in for `$HOME`,
 * not for a repository, so that no test reads the machine's real home directory.
 */
export function detectEngineFixture(kase: 'none' | 'one' | 'all' | 'home'): string {
  return `detect-engine/${kase}`;
}

/** An absolute path to a fixture directory, for callers that need a filesystem root. */
export function fixturePath(fixtureDir: string): string {
  return path.join(fixturesRoot, fixtureDir);
}

/**
 * The import fixture layout: `fixtures/<tool>-import/{input,expected}`.
 *
 * A third shape, because import asks a third question. `input/` is a repository with
 * the tool's *native* files and no `.driftgate/` — the state a real repo is in before
 * anyone has heard of Driftgate — and `expected/` holds the canonical rules the import
 * must produce, serialized exactly as `init` would write them under `.driftgate/`.
 */
export function importFixture(tool: string): { readonly input: string; readonly expected: string } {
  return { input: `${tool}-import/input`, expected: `${tool}-import/expected` };
}

/**
 * An `AdapterContext` for import: the repository's files, and a canonical model that is
 * empty rather than parsed.
 *
 * This is not a shortcut, it is what `init` does. `parse()` on a repo whose only
 * instruction file is `AGENTS.md` enters bare-AGENTS.md mode and lists that file in
 * `canonicalSources` — so a parsed context makes the Codex adapter's self-reference guard
 * fire and `read()` return nothing at all. Correct for `sync`, wrong for `init`: a user
 * running `init` is asking for a `.driftgate/`, and handing them back "your AGENTS.md is
 * already canonical, there is nothing to do" is a refusal dressed as a result. The guard
 * still protects the case it was written for, a manifest that declares the file canonical.
 */
export function importContextFor(fixtureDir: string): AdapterContext {
  const repoRoot = path.join(fixturesRoot, fixtureDir);
  return {
    repoRoot,
    canonical: emptyCanonical({ file: fixtureDir }),
    fs: new NodeFileSystem(repoRoot),
    options: {},
    apiVersion: ADAPTER_API_VERSION,
  };
}

/**
 * Run an adapter's `read()` over `fixtures/<tool>-import/input` and serialize the result.
 *
 * The comparison is made against serialized canonical rather than against an in-memory
 * model because the bytes are what a user ends up reading in `.driftgate/rules/`, and a
 * golden a reviewer cannot read is a golden nobody checks. The manifest is dropped:
 * `read()` returns rules, and assembling a manifest is `init`'s job (T019).
 */
export async function importFixtureRules(
  tool: string,
  adapter: Adapter,
): Promise<Map<string, string>> {
  const dir = importFixture(tool).input;
  const partial = await adapter.read(importContextFor(dir));
  const canonical = { ...emptyCanonical({ file: dir }), rules: partial.rules ?? [] };

  const out = new Map<string, string>();
  for (const [file, contents] of serializeCanonical(canonical)) {
    if (file === MANIFEST_PATH) continue;
    out.set(file.slice(`${DRIFTGATE_DIR}/`.length), contents);
  }
  return out;
}

/** Every file under a fixture directory, as repo-relative POSIX path -> contents. */
export async function readInput(fixtureDir: string): Promise<Map<string, string>> {
  const root = path.join(fixturesRoot, fixtureDir);
  const out = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, rel);
      else out.set(rel, await readFile(child, 'utf8'));
    }
  };
  await walk(root, '');
  return out;
}

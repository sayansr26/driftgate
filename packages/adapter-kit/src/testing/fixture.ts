import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADAPTER_API_VERSION,
  NodeFileSystem,
  parse,
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

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { NodeFileSystem, collectImports, dedupeImported, type ImportSource } from '@driftgate/core';
import { fixturesRoot } from '@driftgate/adapter-kit/testing';
import { ADAPTERS } from '../src/registry.js';

/**
 * The adapters the `import-dedupe` fixtures were authored for.
 *
 * Pinned rather than read from the live registry, because `kind: 'all'` below means
 * "every enabled adapter carried this rule". A freshly scaffolded adapter (T028) has no
 * file in these fixtures, so it would correctly turn that answer into a five-item list —
 * and fail a test about dedupe for a reason that has nothing to do with dedupe.
 */
const FIXTURE_TOOLS = ['claude-code', 'codex', 'copilot', 'cursor', 'gemini'];
const FIXTURE_ADAPTERS = ADAPTERS.filter((a) => FIXTURE_TOOLS.includes(a.name));

async function importFrom(fixture: string): Promise<readonly ImportSource[]> {
  const repoRoot = path.join(fixturesRoot, 'import-dedupe', fixture);
  const result = await collectImports({
    repoRoot,
    fs: new NodeFileSystem(repoRoot),
    adapters: FIXTURE_ADAPTERS,
  });
  expect(result.errors).toEqual([]);
  return result.sources;
}

describe('content dedupe on import (T018)', () => {
  it('still ships every adapter the fixtures were written against', () => {
    // The pinned list above is only safe while it is a subset of the registry: an
    // adapter renamed or dropped would otherwise silently shrink the set under test.
    expect(FIXTURE_ADAPTERS.map((a) => a.name).sort()).toEqual([...FIXTURE_TOOLS].sort());
  });

  it('collapses the same rules in four formats into one canonical set', async () => {
    const sources = await importFrom('four-formats');
    // The premise the fixture rests on: without dedupe this is ten rules for two — the
    // number T078 measured on this repository, arriving as content instead of as bytes.
    expect(sources.flatMap((s) => s.rules)).toHaveLength(10);

    const { rules, conflicts } = dedupeImported(sources);
    expect(rules.map((r) => r.frontmatter.description)).toEqual(['Style', 'Frontend']);
    expect(conflicts).toEqual([]);
  });

  it('reconstructs the tools selector from which tools actually carried the rule', async () => {
    const { rules } = dedupeImported(await importFrom('four-formats'));
    const style = rules.find((r) => r.frontmatter.description === 'Style');
    const frontend = rules.find((r) => r.frontmatter.description === 'Frontend');

    // Style reached all five, so it is `all` — not a frozen list of today's five adapters,
    // which would quietly exclude the sixth a user enables tomorrow.
    expect(style?.frontmatter.tools).toEqual({ kind: 'all' });
    // Frontend is absent from the Copilot repo-wide file by design (it is glob-scoped, so
    // it lives in its own .instructions.md) and present everywhere else — so it is still all.
    expect(frontend?.frontmatter.tools).toEqual({ kind: 'all' });
    expect(frontend?.frontmatter.globs).toEqual(['src/components/**/*.tsx']);
  });

  it('preserves the reading order of the source document as real order values', async () => {
    const { rules } = dedupeImported(await importFrom('four-formats'));
    expect(rules.map((r) => r.frontmatter.order)).toEqual([10, 20]);
  });

  it('surfaces divergent rules as a conflict instead of merging them', async () => {
    const { rules, conflicts } = dedupeImported(await importFrom('divergent'));

    // Both variants survive as rules. Nothing is dropped on a heuristic's say-so.
    const styles = rules.filter((r) => r.frontmatter.description === 'Style');
    expect(styles).toHaveLength(2);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toBe('same-heading');
    expect(conflicts[0]?.variants.map((v) => v.tools)).toEqual([['claude-code'], ['gemini']]);

    // The rule that is genuinely identical in both files still collapses, so the conflict
    // is about the divergence and not about the file pair.
    expect(rules.filter((r) => r.frontmatter.description === 'Deployment')).toHaveLength(1);
  });

  it('does not depend on the order the adapters are read in', async () => {
    const sources = await importFrom('four-formats');
    const shape = (s: readonly ImportSource[]): string =>
      JSON.stringify(
        dedupeImported(s).rules.map((r) => [
          r.frontmatter.description,
          r.frontmatter.globs,
          r.frontmatter.tools,
          r.body,
        ]),
      );

    // A seeded shuffle, because Math.random is banned here and a nondeterministic test
    // that fails one run in ten is worse than no test.
    let seed = 7;
    const shuffled = [...sources];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    expect(shape(shuffled)).toBe(shape(sources));
  });
});

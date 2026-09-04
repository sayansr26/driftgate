import { describe, expect, it } from 'vitest';
import {
  ADAPTER_API_VERSION,
  MemoryFileSystem,
  emptyCanonical,
  selects,
  sortRules,
  type Adapter,
  type RuleDocument,
} from '@rulegate/core';
import { contextFor, writeFixture } from '@rulegate/adapter-kit/testing';
import { ADAPTERS } from '../src/registry.js';

/**
 * `write()` then `read()` must return the rules it started with.
 *
 * This is what makes the structured import mode worth having at all. The content-coverage
 * assertions in each adapter's `read.test.ts` prove nothing is *lost*; they would still
 * pass if the importer glued every section into one rule, because all the text would
 * still be there. This proves the structure comes back too — that a section boundary, a
 * description, and a glob survive the trip.
 *
 * Three fields are compared and three are not, and the omissions are load-bearing rather
 * than lenient. `id`, `order` and `tools` are irrecoverable by construction: rendering
 * encodes the rule *sequence* and never the order numbers, a heading is a description
 * (falling back to the id, which makes them indistinguishable in the output), and one
 * tool's file can only prove a rule reaches that tool. Asserting on them here would be
 * asserting that the importer guesses the same way the test does.
 */
interface Recoverable {
  readonly description: string | undefined;
  readonly globs: readonly string[];
  readonly body: string;
}

function recoverable(rule: RuleDocument): Recoverable {
  return {
    description: rule.frontmatter.description,
    globs: [...rule.frontmatter.globs],
    body: rule.body.replace(/\n+$/, ''),
  };
}

/** The order rules reach the output in — sequence is the only ordering that survives. */
function expectedFor(adapter: Adapter, rules: readonly RuleDocument[]): Recoverable[] {
  return sortRules(rules.filter((r) => selects(r.frontmatter.tools, adapter.name))).map(
    recoverable,
  );
}

describe('write() -> read() round trip (T017)', () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter.name} reads back what it wrote`, async () => {
      const source = await contextFor(writeFixture(adapter.name).input, adapter);
      const artifacts = await adapter.write(source);
      expect(artifacts.length, 'fixture produced no artifacts to read back').toBeGreaterThan(0);

      // A repository containing only what this adapter just wrote, and no `.rulegate/` —
      // which is exactly the shape `init` meets. The canonical is empty for the same
      // reason: a parsed one would let the Codex self-reference guard decline its own
      // `AGENTS.md`, and `init` has no canonical to parse yet.
      const fs = new MemoryFileSystem(artifacts.map((a) => [a.path, a.contents] as const));
      const imported = await adapter.read({
        repoRoot: source.repoRoot,
        canonical: emptyCanonical({ file: '<memory>' }),
        fs,
        options: source.options,
        apiVersion: ADAPTER_API_VERSION,
      });

      expect((imported.rules ?? []).map(recoverable)).toEqual(
        expectedFor(adapter, source.canonical.rules),
      );
    });
  }
});

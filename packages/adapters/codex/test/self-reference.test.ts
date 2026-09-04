import { describe, expect, it } from 'vitest';
import type { Canonical } from '@rulegate/adapter-kit';
import { codex, AGENTS_MD } from '../src/index.js';
import { contextFor, importContextFor, importFixture } from '@rulegate/adapter-kit/testing';

/**
 * T014's stated validation, and the only trap this adapter carries.
 *
 * `AGENTS.md` is a valid canonical *input* — a repository with no `.rulegate/` can use it
 * as its source of truth — and it is also this adapter's *output*. Generating a file from
 * itself destroys the source, which PRD §11 rates trust-fatal.
 *
 * The assertion is deliberately about `write()` alone rather than about the pipeline.
 * `computePlan` refuses the same path with `E_ARTIFACT_OVERWRITES_SOURCE`, so a test that
 * went through the pipeline would still pass with the guard deleted from this adapter — it
 * would be testing core's net, not the adapter. `packages/cli/test/agents-self-reference.test.ts`
 * covers the end-to-end behaviour separately, and both are needed.
 */
describe('codex and the AGENTS.md self-reference', () => {
  async function writeWithCanonicalSources(sources: readonly string[]) {
    const ctx = await contextFor('codex/input', codex);
    const canonical: Canonical = {
      ...ctx.canonical,
      manifest: { ...ctx.canonical.manifest, canonicalSources: sources },
    };
    return codex.write({ ...ctx, canonical });
  }

  it('emits nothing when AGENTS.md is the canonical source', async () => {
    expect(await writeWithCanonicalSources([AGENTS_MD])).toEqual([]);
  });

  it('still emits AGENTS.md when some other file is the canonical source', async () => {
    // The negative half. Without it the test above passes against an adapter that emits
    // nothing at all, which is the failure mode a guard like this actually has.
    const artifacts = await writeWithCanonicalSources(['.rulegate/rulegate.yaml']);
    expect(artifacts.map((a) => a.path)).toEqual([AGENTS_MD]);
  });

  /**
   * `read()` carries the mirror-image guard, and it needs its own coverage.
   *
   * Every import context is built with an *empty* canonical, because that is the state
   * `init` runs in — so nothing in the import fixtures reaches this branch, and it sat
   * inert until a mutation removing it broke no test at all. The case it exists for is a
   * repository whose manifest declares `AGENTS.md` canonical: the parser has already read
   * that file, and importing it again would duplicate every rule in it.
   */
  async function readWithCanonicalSources(sources: readonly string[]) {
    const ctx = importContextFor(importFixture('codex').input);
    const canonical: Canonical = {
      ...ctx.canonical,
      manifest: { ...ctx.canonical.manifest, canonicalSources: sources },
    };
    return codex.read({ ...ctx, canonical });
  }

  it('imports nothing when AGENTS.md is already the canonical source', async () => {
    expect(await readWithCanonicalSources([AGENTS_MD])).toEqual({});
  });

  it('still imports AGENTS.md when some other file is the canonical source', async () => {
    const imported = await readWithCanonicalSources(['.rulegate/rulegate.yaml']);
    expect(imported.rules?.map((r) => r.id)).toEqual(['agents']);
  });
});

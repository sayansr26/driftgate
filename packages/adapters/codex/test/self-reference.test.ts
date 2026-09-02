import { describe, expect, it } from 'vitest';
import type { Canonical } from '@driftgate/adapter-kit';
import { codex, AGENTS_MD } from '../src/index.js';
import { contextFor } from '@driftgate/adapter-kit/testing';

/**
 * T014's stated validation, and the only trap this adapter carries.
 *
 * `AGENTS.md` is a valid canonical *input* — a repository with no `.driftgate/` can use it
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
    const artifacts = await writeWithCanonicalSources(['.driftgate/driftgate.yaml']);
    expect(artifacts.map((a) => a.path)).toEqual([AGENTS_MD]);
  });
});

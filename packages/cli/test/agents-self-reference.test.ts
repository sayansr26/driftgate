import { describe, expect, it } from 'vitest';
import { computePlan, MemoryFileSystem } from '@rulegate/core';
import { ADAPTERS } from '../src/registry.js';

/**
 * T014's self-reference trap, at the layer a real repository actually hits.
 *
 * `packages/adapters/codex/test/self-reference.test.ts` proves the adapter declines on its
 * own. This proves the whole pipeline does — with the real registry, so it also catches the
 * case where some *other* adapter starts claiming `AGENTS.md` and reintroduces the bug from
 * outside the codex package.
 *
 * The scenario is not exotic: a repository with no `.rulegate/` and a hand-written
 * `AGENTS.md` is the single most likely first contact anyone has with this tool, and
 * `parse` promotes that file to `canonicalSources` precisely so this cannot happen.
 */
describe('a repository whose canonical source is AGENTS.md', () => {
  const AGENTS = '# House rules\n\nBe careful with migrations.\n';

  it('is not regenerated from itself, and the run stays clean', async () => {
    const plan = await computePlan({
      repoRoot: '/repo',
      fs: new MemoryFileSystem(new Map([['AGENTS.md', AGENTS]])),
      adapters: ADAPTERS,
    });

    // Not merely "no error": no adapter may claim the path at all. A refusal that arrived
    // as E_ARTIFACT_OVERWRITES_SOURCE would be a failed sync on a perfectly ordinary repo.
    expect(plan.errors).toEqual([]);
    expect(plan.artifacts.map((a) => a.path)).not.toContain('AGENTS.md');
  });

  it('still renders that content out to the other tools', async () => {
    const plan = await computePlan({
      repoRoot: '/repo',
      fs: new MemoryFileSystem(new Map([['AGENTS.md', AGENTS]])),
      adapters: ADAPTERS,
    });

    // The point of accepting a bare AGENTS.md is that it feeds every *other* adapter. If
    // the guard were implemented as "codex writes nothing when AGENTS.md exists", this
    // would still pass — but if it were implemented as "skip the whole run", it would not.
    const paths = plan.artifacts.map((a) => a.path);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('GEMINI.md');
    for (const artifact of plan.artifacts) {
      expect(artifact.contents).toContain('Be careful with migrations.');
    }
  });

  it('generates AGENTS.md when the canonical source is .rulegate/ instead', async () => {
    // The negative half. Without it, an adapter that never emitted AGENTS.md under any
    // circumstance would pass both tests above.
    const plan = await computePlan({
      repoRoot: '/repo',
      fs: new MemoryFileSystem(
        new Map([
          ['.rulegate/rulegate.yaml', 'schemaVersion: 1\ntools:\n  - codex\n'],
          ['.rulegate/rules/10-style.md', '---\ndescription: Style\norder: 10\n---\n\nUse tabs.\n'],
        ]),
      ),
      adapters: ADAPTERS,
    });

    expect(plan.errors).toEqual([]);
    expect(plan.artifacts.map((a) => a.path)).toEqual(['AGENTS.md']);
  });
});

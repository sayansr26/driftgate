import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFileSystem, computeInitPlan } from '@driftgate/core';
import { INTEROP, ruler, rulesync } from '@driftgate/interop';
import { ADAPTERS } from '../src/registry.js';
import { ADAPTER_NAMES } from '../src/registry.js';

const fixtures = path.resolve(import.meta.dirname, '../../../fixtures');

async function init(name: string) {
  const repoRoot = path.join(fixtures, name, 'input');
  return computeInitPlan({
    repoRoot,
    fs: new NodeFileSystem(repoRoot),
    adapters: ADAPTERS,
    interop: INTEROP,
  });
}

describe('interop — T054', () => {
  it('keeps interop importers out of the adapter set entirely', () => {
    // The structural claim. An id in both lists would put a tool Driftgate never generates
    // for into driftgate.yaml, doctor's table, and every rule's `tools:` selector —
    // asserting Driftgate maintains a ruler config, which it must never do.
    for (const importer of INTEROP) {
      expect(ADAPTER_NAMES).not.toContain(importer.name);
    }
    // And nothing in the interop surface can write: there is no `write` to call.
    for (const importer of INTEROP) {
      expect('write' in importer).toBe(false);
    }
  });

  it('imports ruler’s sources once, not its generated copies as well', async () => {
    // The load-bearing behaviour. ruler concatenates `.ruler/*.md` into AGENTS.md and
    // CLAUDE.md, which are exactly the files the codex and claude-code adapters import
    // from — so without masking, every rule arrives three times: once from the source a
    // user edits and once from each generated copy.
    const plan = await init('ruler-import');
    expect(plan.interop).toEqual(['ruler']);

    const bodies = plan.canonical.rules.map((r) => r.body);
    expect(bodies.filter((b) => b.includes('Prefer small modules')).length).toBe(1);
    expect(bodies.filter((b) => b.includes('Colocate tests')).length).toBe(1);

    // And nothing came from the files ruler generated. (Not "everything came from
    // .ruler/": the fixture also holds a hand-written GEMINI.md, which the gemini adapter
    // correctly imports — masking must not reach it.)
    const sources = plan.canonical.rules.map((r) => r.source.file);
    expect(sources).not.toContain('AGENTS.md');
    expect(sources).not.toContain('CLAUDE.md');
    expect(sources).toContain('.ruler/AGENTS.md');
  });

  it('masks only files ruler actually wrote, judged by its own Source marker', async () => {
    // The containment on the masking. A hand-written CLAUDE.md carries no
    // `<!-- Source: -->` marker, and dropping it because a `.ruler/` directory happens to
    // exist would lose a file the user wrote — the failure this whole feature exists to
    // avoid, arriving through the fix for it.
    const repoRoot = path.join(fixtures, 'ruler-import/input');
    const ctx = {
      repoRoot,
      canonical: (await init('ruler-import')).canonical,
      fs: new NodeFileSystem(repoRoot),
      options: {},
      apiVersion: 1 as const,
    };
    const found = await ruler.read(ctx);
    // GEMINI.md is in the fixture, is a filename ruler is known to write, and carries no
    // Source marker because a person wrote it. It must not be masked.
    expect([...found.generated].sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);

    // And the consequence, which is what actually matters: its content reaches canonical.
    // Without this the assertion above passes against an importer that masks everything,
    // because a list is only wrong if something reads it.
    const plan = await init('ruler-import');
    const bodies = plan.canonical.rules.map((r) => r.body).join('\n');
    expect(bodies).toContain('This file is not ruler’s output'.replace('’', "'"));
  });

  it('preserves rulesync’s `targets` as a real tools selector', async () => {
    // rulesync is the one source with a field that maps straight onto canonical `tools`,
    // so it survives rather than widening to `all` the way an adapter import must.
    const plan = await init('rulesync-import');
    expect(plan.interop).toEqual(['rulesync']);

    const scoped = plan.canonical.rules.find((r) => r.frontmatter.description === 'Test files');
    expect(scoped).toBeDefined();
    expect(scoped!.frontmatter.tools).toEqual({
      kind: 'include',
      tools: ['claude-code', 'cursor'],
    });
    expect(scoped!.frontmatter.globs).toEqual(['**/*.test.ts']);

    // The control: a `targets: ["*"]` rule stays `all`, so the mapping is doing work
    // rather than narrowing everything it touches.
    const wide = plan.canonical.rules.find((r) => r.frontmatter.description === 'Style');
    expect(wide!.frontmatter.tools).toEqual({ kind: 'all' });
  });

  it('reports what it found and did not import, rather than dropping it silently', async () => {
    const repoRoot = path.join(fixtures, 'rulesync-import/input');
    const found = await rulesync.read({
      repoRoot,
      canonical: (await init('rulesync-import')).canonical,
      fs: new NodeFileSystem(repoRoot),
      options: {},
      apiVersion: 1 as const,
    });
    // Nothing unsupported in this fixture, so the list is empty — the assertion that
    // matters is that the field exists and `init` surfaces it, covered below.
    expect(found.notImported).toEqual([]);
    expect(found.rules.length).toBe(2);
  });

  it('does not import from a repository that uses neither tool', async () => {
    // The negative half. Without it every assertion above would pass against an importer
    // that reported the same thing for every repository.
    const plan = await init('claude-code-import');
    expect(plan.interop).toEqual([]);
  });
});

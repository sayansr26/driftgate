import { describe, expect, it } from 'vitest';
import type { Canonical } from '@driftgate/adapter-kit';
import {
  contextFor,
  expectFixtureMatch,
  expectIdempotent,
  renderFixture,
} from '@driftgate/adapter-kit/testing';
import { windsurf, RULES_DIR } from '../src/index.js';

describe('windsurf write()', () => {
  it('matches the golden fixture byte for byte', async () => {
    await expectFixtureMatch('windsurf', windsurf);
  });

  it('is idempotent across repeated renders', async () => {
    // Determinism is a contract (NFR4): `check` compares bytes, so output that varies
    // between runs is drift the user cannot fix.
    await expectIdempotent('windsurf', windsurf);
  });

  it('excludes rules that target other tools', async () => {
    const actual = await renderFixture('windsurf', windsurf);
    // Every file, not one: this adapter writes one per rule, so asserting on a single
    // path would pass while the excluded rule sat in a file the assertion never read.
    const all = [...actual.values()].join('\n');
    expect(all).not.toContain('This rule must not reach windsurf');
    expect([...actual.keys()]).not.toContain(`${RULES_DIR}/30-cursor-only.md`);
  });

  it('gives a glob-scoped rule `trigger: glob` rather than the prose fallback', async () => {
    // Windsurf has a native per-glob mechanism, so scoping must survive. The lossy
    // `**Applies to:**` line is for tools with no mechanism at all — emitting it here
    // would turn a rule meant for one path into a repo-wide instruction.
    const actual = await renderFixture('windsurf', windsurf);
    const scoped = actual.get(`${RULES_DIR}/40-tests.md`);
    expect(scoped).toContain('trigger: glob');
    expect(scoped).toContain('globs: **/*.test.ts');
    expect(scoped).not.toContain('Applies to:');

    // The negative half: an unscoped rule must not claim a glob trigger.
    expect(actual.get(`${RULES_DIR}/10-style.md`)).toContain('trigger: always_on');
  });

  it('puts the frontmatter at byte zero, ahead of the marker', async () => {
    // Windsurf requires the block to occupy the first bytes. A marker comment above it
    // pushes it out of position and the rule is read as untriggered prose — output that
    // looks correct and is inert, which is this project's worst failure mode.
    const actual = await renderFixture('windsurf', windsurf);
    for (const contents of actual.values()) expect(contents.startsWith('---\n')).toBe(true);
  });

  it('records which rule produced each file', async () => {
    const ctx = await contextFor('windsurf/input', windsurf);
    const artifacts = await windsurf.write(ctx);

    // One rule per artifact, unlike the concatenating adapters — so `sync --import` (T051)
    // can map an edit back to exactly one canonical rule.
    expect(artifacts.map((a) => a.provenance?.ruleIds)).toEqual([
      ['10-style'],
      ['20-testing'],
      ['40-tests'],
    ]);
  });

  it('emits no file when no rule targets this tool', async () => {
    const ctx = await contextFor('windsurf/input', windsurf);
    const canonical: Canonical = { ...ctx.canonical, rules: [] };
    expect(await windsurf.write({ ...ctx, canonical })).toEqual([]);
  });
});

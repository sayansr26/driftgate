import { describe, expect, it } from 'vitest';
import type { Canonical } from '@driftgate/adapter-kit';
import {
  contextFor,
  expectFixtureMatch,
  expectIdempotent,
  renderFixture,
} from '@driftgate/adapter-kit/testing';
import { cline, RULES_DIR } from '../src/index.js';

describe('cline write()', () => {
  it('matches the golden fixture byte for byte', async () => {
    await expectFixtureMatch('cline', cline);
  });

  it('is idempotent across repeated renders', async () => {
    await expectIdempotent('cline', cline);
  });

  it('excludes rules that target other tools', async () => {
    const actual = await renderFixture('cline', cline);
    // Every file, not one: this adapter writes one per rule, so asserting on a single
    // path would pass while the excluded rule sat in a file nothing read.
    expect([...actual.values()].join('\n')).not.toContain('This rule must not reach cline');
    expect([...actual.keys()]).not.toContain(`${RULES_DIR}/30-cursor-only.md`);
  });

  it('keeps a glob-scoped rule visibly lossy rather than silently repo-wide', async () => {
    // Cline has no per-glob mechanism, so the prose line is the honest degradation.
    // Dropping it would turn a rule meant for one path into a repo-wide instruction —
    // a wrong answer rather than a missing one.
    const actual = await renderFixture('cline', cline);
    expect(actual.get(`${RULES_DIR}/40-tests.md`)).toContain('**Applies to:** `**/*.test.ts`');
    // The negative half: an unscoped rule gets no such line.
    expect(actual.get(`${RULES_DIR}/10-style.md`)).not.toContain('Applies to:');
  });

  it('writes .md only, though it reads .txt as well', async () => {
    const actual = await renderFixture('cline', cline);
    for (const path of actual.keys()) expect(path.endsWith('.md')).toBe(true);
  });

  it('records which rule produced each file', async () => {
    const ctx = await contextFor('cline/input', cline);
    const artifacts = await cline.write(ctx);
    expect(artifacts.map((a) => a.provenance?.ruleIds)).toEqual([
      ['10-style'],
      ['20-testing'],
      ['40-tests'],
    ]);
  });

  it('emits no file when no rule targets this tool', async () => {
    const ctx = await contextFor('cline/input', cline);
    const canonical: Canonical = { ...ctx.canonical, rules: [] };
    expect(await cline.write({ ...ctx, canonical })).toEqual([]);
  });
});

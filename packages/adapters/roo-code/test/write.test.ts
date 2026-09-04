import { describe, expect, it } from 'vitest';
import type { Canonical } from '@rulegate/adapter-kit';
import {
  contextFor,
  expectFixtureMatch,
  expectIdempotent,
  renderFixture,
} from '@rulegate/adapter-kit/testing';
import { rooCode, RULES_DIR } from '../src/index.js';

describe('roo-code write()', () => {
  it('matches the golden fixture byte for byte', async () => {
    await expectFixtureMatch('roo-code', rooCode);
  });

  it('is idempotent across repeated renders', async () => {
    await expectIdempotent('roo-code', rooCode);
  });

  it('names files so Roo\u2019s own sort reproduces the canonical order', async () => {
    // The one thing this adapter has to get right. Roo concatenates .roo/rules/ sorted
    // "by basename only, case-insensitive" — an ordering that knows nothing about
    // canonical `order`. The fixture is built so the two disagree: `40-alpha-last` is
    // ordered last and sorts first under any id-only scheme.
    const actual = await renderFixture('roo-code', rooCode);
    const names = [...actual.keys()].filter((p) => p.startsWith(RULES_DIR));

    // Sorted the way Roo sorts (lowercased basename; `localeCompare` is lint-banned
    // repo-wide, so this is the comparison spelled without it).
    const rooOrder = [...names].sort((a, b) => {
      const x = (a.split('/').pop() ?? '').toLowerCase();
      const y = (b.split('/').pop() ?? '').toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });

    expect(rooOrder).toEqual([
      `${RULES_DIR}/001-10-style.md`,
      `${RULES_DIR}/002-20-testing.md`,
      `${RULES_DIR}/003-01-applied-last.md`,
    ]);

    // And the control: without the index, Roo's sort would put the last rule first.
    const withoutIndex = names.map((p) => (p.split('/').pop() ?? '').replace(/^\d{3}-/, ''));
    expect([...withoutIndex].sort()).not.toEqual(withoutIndex);
  });

  it('excludes rules that target other tools', async () => {
    const actual = await renderFixture('roo-code', rooCode);
    expect([...actual.values()].join('\n')).not.toContain('This rule must not reach roo-code');
  });

  it('records which rule produced each file', async () => {
    const ctx = await contextFor('roo-code/input', rooCode);
    const artifacts = await rooCode.write(ctx);
    expect(artifacts.map((a) => a.provenance?.ruleIds)).toEqual([
      ['10-style'],
      ['20-testing'],
      ['01-applied-last'],
    ]);
  });

  it('emits no file when no rule targets this tool', async () => {
    const ctx = await contextFor('roo-code/input', rooCode);
    const canonical: Canonical = { ...ctx.canonical, rules: [] };
    expect(await rooCode.write({ ...ctx, canonical })).toEqual([]);
  });
});

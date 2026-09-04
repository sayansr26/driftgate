import { describe, expect, it } from 'vitest';
import type { Canonical } from '@rulegate/adapter-kit';
import {
  contextFor,
  expectFixtureMatch,
  expectIdempotent,
  renderFixture,
} from '@rulegate/adapter-kit/testing';
import { zed, RULES_FILE } from '../src/index.js';

describe('zed write()', () => {
  it('matches the golden fixture byte for byte', async () => {
    await expectFixtureMatch('zed', zed);
  });

  it('is idempotent across repeated renders', async () => {
    // Determinism is a contract (NFR4): `check` compares bytes, so output that varies
    // between runs is drift the user cannot fix.
    await expectIdempotent('zed', zed);
  });

  it('excludes rules that target other tools', async () => {
    const actual = await renderFixture('zed', zed);
    expect(actual.get(RULES_FILE)).not.toContain('This rule must not reach zed');
  });

  it('records which rules produced the file', async () => {
    const ctx = await contextFor('zed/input', zed);
    const [artifact] = await zed.write(ctx);

    expect(artifact?.provenance?.ruleIds).toEqual(['10-style', '20-testing']);
  });

  it('emits no file when no rule targets this tool', async () => {
    const ctx = await contextFor('zed/input', zed);
    const canonical: Canonical = { ...ctx.canonical, rules: [] };
    expect(await zed.write({ ...ctx, canonical })).toEqual([]);
  });
});

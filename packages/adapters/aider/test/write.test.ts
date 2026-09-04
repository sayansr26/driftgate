import { describe, expect, it } from 'vitest';
import type { Canonical } from '@rulegate/adapter-kit';
import {
  contextFor,
  expectFixtureMatch,
  expectIdempotent,
  renderFixture,
} from '@rulegate/adapter-kit/testing';
import { aider, CONVENTIONS_MD } from '../src/index.js';

describe('aider write()', () => {
  it('matches the golden fixture byte for byte', async () => {
    await expectFixtureMatch('aider', aider);
  });

  it('is idempotent across repeated renders', async () => {
    // Determinism is a contract (NFR4): `check` compares bytes, so output that varies
    // between runs is drift the user cannot fix.
    await expectIdempotent('aider', aider);
  });

  it('excludes rules that target other tools', async () => {
    const actual = await renderFixture('aider', aider);
    expect(actual.get(CONVENTIONS_MD)).not.toContain('This rule must not reach aider');
  });

  it('records which rules produced the file', async () => {
    const ctx = await contextFor('aider/input', aider);
    const [artifact] = await aider.write(ctx);

    expect(artifact?.provenance?.ruleIds).toEqual(['10-style', '20-testing']);
  });

  it('emits no file when no rule targets this tool', async () => {
    const ctx = await contextFor('aider/input', aider);
    const canonical: Canonical = { ...ctx.canonical, rules: [] };
    expect(await aider.write({ ...ctx, canonical })).toEqual([]);
  });
});

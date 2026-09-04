import { describe, expect, it } from 'vitest';
import { contextFor, detectFixture } from '@driftgate/adapter-kit/testing';
import { zed } from '../src/index.js';

describe('zed detect()', () => {
  it('finds Zed and says what gave it away', async () => {
    const ctx = await contextFor(detectFixture('zed', 'positive'), zed);
    const result = await zed.detect(ctx);

    expect(result.detected).toBe(true);
    // Evidence is sorted, so this is the order `doctor` prints.
    expect(result.evidence).toEqual(['.rules', '.zed'].sort());
  });

  it('reports absence on a repo that does not use it', async () => {
    const ctx = await contextFor(detectFixture('zed', 'negative'), zed);
    const result = await zed.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});

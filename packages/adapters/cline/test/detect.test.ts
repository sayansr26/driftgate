import { describe, expect, it } from 'vitest';
import { contextFor, detectFixture } from '@rulegate/adapter-kit/testing';
import { cline } from '../src/index.js';

describe('cline detect()', () => {
  it('finds Cline and says what gave it away', async () => {
    const ctx = await contextFor(detectFixture('cline', 'positive'), cline);
    const result = await cline.detect(ctx);

    expect(result.detected).toBe(true);
    // Evidence is sorted, so this is the order `doctor` prints.
    expect(result.evidence).toEqual(['.clinerules']);
  });

  it('reports absence on a repo that does not use it', async () => {
    const ctx = await contextFor(detectFixture('cline', 'negative'), cline);
    const result = await cline.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});

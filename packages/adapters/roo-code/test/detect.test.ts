import { describe, expect, it } from 'vitest';
import { contextFor, detectFixture } from '@driftgate/adapter-kit/testing';
import { rooCode } from '../src/index.js';

describe('roo-code detect()', () => {
  it('finds Roo Code and says what gave it away', async () => {
    const ctx = await contextFor(detectFixture('roo-code', 'positive'), rooCode);
    const result = await rooCode.detect(ctx);

    expect(result.detected).toBe(true);
    // Evidence is sorted, so this is the order `doctor` prints.
    expect(result.evidence).toEqual(['.roo']);
  });

  it('reports absence on a repo that does not use it', async () => {
    const ctx = await contextFor(detectFixture('roo-code', 'negative'), rooCode);
    const result = await rooCode.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { contextFor, detectFixture } from '@rulegate/adapter-kit/testing';
import { windsurf } from '../src/index.js';

describe('windsurf detect()', () => {
  it('finds Windsurf and says what gave it away', async () => {
    const ctx = await contextFor(detectFixture('windsurf', 'positive'), windsurf);
    const result = await windsurf.detect(ctx);

    expect(result.detected).toBe(true);
    // Evidence is sorted, so this is the order `doctor` prints.
    expect(result.evidence).toEqual(['.windsurf']);
  });

  it('reports absence on a repo that does not use it', async () => {
    const ctx = await contextFor(detectFixture('windsurf', 'negative'), windsurf);
    const result = await windsurf.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});

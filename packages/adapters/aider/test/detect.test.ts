import { describe, expect, it } from 'vitest';
import { contextFor, detectFixture } from '@driftgate/adapter-kit/testing';
import { aider } from '../src/index.js';

describe('aider detect()', () => {
  it('finds Aider and says what gave it away', async () => {
    const ctx = await contextFor(detectFixture('aider', 'positive'), aider);
    const result = await aider.detect(ctx);

    expect(result.detected).toBe(true);
    // Evidence is sorted, so this is the order `doctor` prints.
    expect(result.evidence).toEqual(['.aider.conf.yml']);
  });

  it('reports absence on a repo that does not use it', async () => {
    const ctx = await contextFor(detectFixture('aider', 'negative'), aider);
    const result = await aider.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});

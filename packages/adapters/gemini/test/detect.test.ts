import { describe, expect, it } from 'vitest';
import { gemini } from '../src/index.js';
import { contextFor, detectFixture } from '@driftgate/adapter-kit/testing';

describe('gemini detect()', () => {
  it('finds Gemini and says what gave it away', async () => {
    const ctx = await contextFor(detectFixture('gemini', 'positive'), gemini);
    const result = await gemini.detect(ctx);

    expect(result.detected).toBe(true);
    expect(result.evidence).toEqual(['.gemini', 'GEMINI.md']);
  });

  it('reports absence on a repo that does not use it', async () => {
    const ctx = await contextFor(detectFixture('gemini', 'negative'), gemini);
    const result = await gemini.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});

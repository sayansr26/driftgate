import { describe, expect, it } from 'vitest';
import { codex } from '../src/index.js';
import { contextFor, detectFixture } from '@driftgate/adapter-kit/testing';

describe('codex detect()', () => {
  it('finds Codex and says what gave it away', async () => {
    const ctx = await contextFor(detectFixture('codex', 'positive'), codex);
    const result = await codex.detect(ctx);

    expect(result.detected).toBe(true);
    expect(result.evidence).toEqual(['.codex', 'AGENTS.md']);
  });

  it('reports absence on a repo that does not use it', async () => {
    const ctx = await contextFor(detectFixture('codex', 'negative'), codex);
    const result = await codex.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});

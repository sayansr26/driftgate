import { describe, expect, it } from 'vitest';
import { claudeCode } from '../src/index.js';
import { contextFor, detectFixture } from '@rulegate/adapter-kit/testing';

describe('claude-code detect()', () => {
  it('finds Claude Code and says what gave it away', async () => {
    const ctx = await contextFor(detectFixture('claude-code', 'positive'), claudeCode);
    const result = await claudeCode.detect(ctx);

    expect(result.detected).toBe(true);
    // `doctor` has to explain itself; "detected Claude Code" with no evidence is the
    // unfalsifiable output the doctor exists to replace.
    expect(result.evidence).toEqual(['.claude', 'CLAUDE.md']);
  });

  it('reports absence on a repo that does not use it', async () => {
    const ctx = await contextFor(detectFixture('claude-code', 'negative'), claudeCode);
    const result = await claudeCode.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { copilot } from '../src/index.js';
import { contextFor, detectFixture } from '@driftgate/adapter-kit/testing';

describe('copilot detect()', () => {
  it('finds Copilot and says what gave it away', async () => {
    const ctx = await contextFor(detectFixture('copilot', 'positive'), copilot);
    const result = await copilot.detect(ctx);

    expect(result.detected).toBe(true);
    expect(result.evidence).toEqual(['.github/copilot-instructions.md', '.github/instructions']);
  });

  /**
   * The negative fixture deliberately *has* a `.github/` directory. Almost every
   * repository does, so a detector keyed on it would report Copilot everywhere — evidence
   * that is always true is not evidence, and `doctor` exists to replace exactly that.
   */
  it('does not fire on a repo that merely has a .github directory', async () => {
    const ctx = await contextFor(detectFixture('copilot', 'negative'), copilot);
    const result = await copilot.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { contextFor } from '@driftgate/adapter-kit';
import { cursor } from '../src/index.js';

describe('cursor detect()', () => {
  it('finds Cursor and reports the evidence', async () => {
    const ctx = await contextFor('cursor-detect/positive', cursor);
    const result = await cursor.detect(ctx);

    expect(result.detected).toBe(true);
    expect(result.evidence).toEqual(['.cursor', '.cursorrules']);
  });

  it('reports absence on a repo that does not use it', async () => {
    const ctx = await contextFor('cursor-detect/negative', cursor);
    const result = await cursor.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});

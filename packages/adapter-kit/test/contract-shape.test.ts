import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createKitProgram, formatDiagnostics } from './program.js';

const pins = fileURLToPath(new URL('./shape/pins.ts', import.meta.url));

/**
 * Compiles `shape/pins.ts` and asserts it type-checks. See that file for what is pinned
 * and why the pins are hand-written duplicates rather than references.
 */
describe('the frozen contract shapes (T011)', () => {
  it('type-checks the structural pins', () => {
    const diagnostics = formatDiagnostics(createKitProgram([pins]));
    expect(
      diagnostics,
      'a frozen contract shape changed — a pin failing here is a breaking change even though no export name moved; see docs/adapter-api-v1.md',
    ).toEqual([]);
  });
});

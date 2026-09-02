import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADAPTERS, ADAPTER_NAMES } from '../src/registry.js';

const adaptersDir = fileURLToPath(new URL('../../adapters/', import.meta.url));

describe('the adapter registry', () => {
  /**
   * A scaffolded-but-unregistered adapter is invisible rather than broken: every `sync`
   * silently omits it, `E_UNKNOWN_TOOL` rejects its own id, and no test fails. T028 will
   * scaffold adapters, so the registry has to be checked against the filesystem rather
   * than against itself.
   *
   * Asserting the live `ADAPTER_NAMES` rather than the text of `registry.ts` is the whole
   * point: an earlier version of this test scanned the file for the import specifier and
   * passed while `cursor` was deleted from the ADAPTERS array — the import line survived,
   * so the string was still there.
   */
  it('contains exactly the adapter packages on disk', async () => {
    const entries = await readdir(adaptersDir, { withFileTypes: true });
    const onDisk = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect([...ADAPTER_NAMES].sort()).toEqual(onDisk);
  });

  it('gives every adapter a name matching its package directory', () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.name, `${adapter.name} must be kebab-case`).toMatch(
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
      );
      expect(path.basename(adapter.name)).toBe(adapter.name);
    }
  });
});

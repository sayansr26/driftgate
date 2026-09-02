import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatTokens } from '../src/ui/report.js';

const cliSrc = fileURLToPath(new URL('../src/', import.meta.url));

describe('formatTokens', () => {
  it.each([
    [0, '~0'],
    [7, '~7'],
    [999, '~999'],
    [1000, '~1,000'],
    [4210, '~4,210'],
    [1234567, '~1,234,567'],
  ])('renders %i as %s', (input, expected) => {
    expect(formatTokens(input)).toBe(expected);
  });

  it('groups identically regardless of host locale', () => {
    // `toLocaleString` would print 4.210 in a German CI log. Manual grouping is the only
    // way this is the same string everywhere, which `docs/determinism.md` rule 2 requires.
    expect(formatTokens(4210)).toBe('~4,210');
  });
});

describe('the tilde is not optional', () => {
  /**
   * Every token count a user sees must go through `formatTokens`.
   *
   * A scan rather than a type, for the reason `invariants.test.ts` gives about the write
   * allowlist: a lint rule can be `eslint-disable`d and a branded type can be cast, and
   * nothing defeats a file scan. Printing a raw `4210` would present a ±15%
   * approximation as a measurement.
   */
  it('routes every estimateTokens call in the CLI through formatTokens', async () => {
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(child);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const text = await readFile(child, 'utf8');
        if (text.includes('estimateTokens') && !text.includes('formatTokens')) {
          offenders.push(path.relative(cliSrc, child));
        }
      }
    };
    await walk(cliSrc);
    expect(offenders).toEqual([]);
  });
});

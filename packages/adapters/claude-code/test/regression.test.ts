import { describe, expect, it } from 'vitest';
import {
  compareFixture,
  formatFixtureReport,
  readExpected,
  renderFixture,
} from '@rulegate/adapter-kit/testing';
import { claudeCode } from '../src/index.js';

/**
 * T012's stated validation: the harness catches a deliberately introduced one-byte
 * regression in the Claude adapter.
 *
 * The test this replaces was named for that and did not do it — it tampered with the
 * *expected* string and then asserted the untampered render still matched the untampered
 * expectation, which proves `toBe` works. The difference matters: this one feeds the
 * comparison a rendering that is wrong by exactly one byte and asserts the harness says
 * so, by path and by line.
 */
describe('a one-byte regression in the Claude adapter', () => {
  it('is caught, and named by file and line', async () => {
    const expected = await readExpected('claude-code');
    const actual = new Map(await renderFixture('claude-code', claudeCode));

    const target = 'CLAUDE.md';
    const original = actual.get(target);
    expect(original, 'the Claude fixture must produce CLAUDE.md').toBeDefined();

    // One byte: the first letter of a section heading is lowercased.
    const lines = (original ?? '').split('\n');
    const index = lines.findIndex((line) => line.startsWith('## '));
    expect(index, 'the fixture must contain a section heading').toBeGreaterThan(-1);
    const heading = lines[index] ?? '';
    lines[index] = `## ${heading.slice(3, 4).toLowerCase()}${heading.slice(4)}`;
    expect(lines[index], 'the mutation must change exactly one byte').not.toBe(heading);
    actual.set(target, lines.join('\n'));

    const report = compareFixture(actual, expected);
    expect(report.ok).toBe(false);
    expect(report.differing.map((d) => d.path)).toEqual([target]);

    const message = formatFixtureReport('claude-code', report);
    expect(message).toContain(target);
    expect(message).toContain(`line ${String(index + 1)}`);
    expect(message).toContain(heading);
    expect(message).toContain('adapter regression');
  });

  it('accepts the untampered rendering', async () => {
    const report = compareFixture(
      await renderFixture('claude-code', claudeCode),
      await readExpected('claude-code'),
    );
    expect(formatFixtureReport('claude-code', report)).toBe('');
  });
});

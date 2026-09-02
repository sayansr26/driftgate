import { describe, expect, it } from 'vitest';
import { compareFixture, formatFixtureReport } from '../src/testing/compare.js';
import { escapeInvisibles, firstDifference } from '../src/testing/diff.js';

/**
 * The comparison and diff layer, tested on strings alone — no adapter, no filesystem.
 * The fixture-backed half of T012's validation (a real one-byte regression in a real
 * adapter's output) lives in `packages/adapters/claude-code/test/regression.test.ts`,
 * because the kit must not depend on an adapter.
 */
describe('the fixture comparison', () => {
  it('reports a missing file and an unexpected file as different failures', () => {
    const report = compareFixture(
      new Map([['STRAY.md', 'x\n']]),
      new Map([['CLAUDE.md', 'one\n']]),
    );
    expect(report.missing).toEqual(['CLAUDE.md']);
    expect(report.unexpected).toEqual(['STRAY.md']);
    expect(report.differing).toEqual([]);

    const message = formatFixtureReport('claude-code', report);
    expect(message).toContain('expected but not produced');
    expect(message).toContain('produced but not expected');
    expect(message).toContain('pnpm fixtures:update');
  });

  it('says nothing at all when the rendering matches', () => {
    const same = new Map([['a.md', 'one\ntwo\n']]);
    const report = compareFixture(same, new Map(same));
    expect(report.ok).toBe(true);
    expect(formatFixtureReport('x', report)).toBe('');
  });

  /**
   * The failure a generic diff loses completely: two lines that render identically in a
   * terminal and differ by one trailing space. If the harness cannot show this, it cannot
   * show the regressions golden fixtures exist for.
   */
  it('makes an invisible difference visible', () => {
    const diff = firstDifference('alpha\nbeta\n', 'alpha\nbeta \n');
    expect(diff?.line).toBe(2);
    expect(diff?.column).toBe(5);

    expect(escapeInvisibles('beta ')).toBe('beta\u00b7');
    expect(escapeInvisibles('a\tb')).toBe('a\u2409b');
    expect(escapeInvisibles('crlf\r')).toBe('crlf\u240d');
    expect(escapeInvisibles('\uFEFFbom')).toBe('\u27e8BOM\u27e9bom');
  });

  it('distinguishes a missing line from an empty one', () => {
    // Both files end with a newline in practice, so a shorter one yields an *empty* line
    // rather than a missing one — and an empty line printed as nothing next to a real one
    // reads as a broken test. The two must not render the same.
    const shorter = compareFixture(new Map([['a.md', 'one\n']]), new Map([['a.md', 'one\ntwo\n']]));
    const detail = shorter.differing[0]?.detail ?? '';
    expect(detail).toContain('line 2');
    expect(detail).not.toContain('\u27e8no such line\u27e9');

    // The genuinely-absent case, which `finalizeArtifact` makes unreachable for artifacts
    // but not for callers comparing arbitrary strings.
    const truncated = compareFixture(new Map([['a.md', 'one']]), new Map([['a.md', 'one\ntwo']]));
    expect(truncated.differing[0]?.detail).toContain('\u27e8no such line\u27e9');
  });

  it('finds no difference in identical content', () => {
    expect(firstDifference('same\n', 'same\n')).toBeUndefined();
  });
});

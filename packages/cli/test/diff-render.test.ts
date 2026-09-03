import { describe, expect, it } from 'vitest';
import { diffLines, formatHunks } from '@driftgate/core';
import { renderDiff } from '../src/ui/diff.js';
import { createOutput } from '../src/ui/report.js';

// eslint forbids a literal control character in a regex, so build it.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);

const OLD = 'a\nb\nc\n';
const NEW = 'a\nB\nc\n';

describe('renderDiff', () => {
  it('emits no escape sequences when colour is off', () => {
    const out = renderDiff(formatHunks(diffLines(OLD, NEW)), createOutput({ color: false }).c);
    expect(out.join('\n')).not.toMatch(ANSI);
    // Anti-vacuity: the lines are actually there.
    expect(out).toEqual(['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c']);
  });

  it('emits escape sequences on a TTY, so the assertion above is known to be able to fail', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const noColor = process.env['NO_COLOR'];
    delete process.env['NO_COLOR'];
    try {
      const out = renderDiff(formatHunks(diffLines(OLD, NEW)), createOutput({ color: true }).c);
      expect(out.join('\n')).toMatch(ANSI);
      // Colour wraps whole lines and never changes how many there are.
      expect(out).toHaveLength(5);
      expect(out[1]).toBe(' a');
    } finally {
      if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
      if (noColor !== undefined) process.env['NO_COLOR'] = noColor;
    }
  });
});

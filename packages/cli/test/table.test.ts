import { describe, expect, it } from 'vitest';
import { displayWidth, formatTable, padEndWide } from '../src/ui/table.js';

const cols = [{ priority: 0 }, { priority: 3 }, { priority: 1 }] as const;

const rows = [
  ['.github/copilot-instructions.md', 'generated', 'from copilot'],
  ['AGENTS.md', 'unmanaged', 'from codex'],
];

describe('formatTable', () => {
  it('pads every cell of a column to one width', () => {
    const out = formatTable(cols, rows, 120);
    expect(out).toHaveLength(2);
    const starts = out.map((l) =>
      l.indexOf('generated') >= 0 ? l.indexOf('generated') : l.indexOf('unmanaged'),
    );
    expect(new Set(starts).size).toBe(1);
  });

  it('drops the lowest-priority column rather than truncating a path', () => {
    // Nothing in the doctor fixtures is wide enough to reach this branch, so without a
    // direct test it is dead code: a mutation making the width check unconditional passed
    // the entire command-level suite. That is exactly the shape of defect this repository
    // keeps finding, so the branch gets its own test rather than an assumption.
    const wide = formatTable(cols, rows, 120);
    const narrow = formatTable(cols, rows, 45);

    expect(wide[0]).toContain('from copilot');
    expect(narrow[0]).not.toContain('from copilot');
    // The path column has priority 0 and is never dropped: a truncated path is unusable,
    // and it is the column the reader came for.
    expect(narrow[0]).toContain('.github/copilot-instructions.md');
    expect(narrow[0]).toContain('generated');
  });

  it('keeps the never-dropped column even when nothing fits', () => {
    const out = formatTable(cols, rows, 5);
    expect(out[0]).toBe('.github/copilot-instructions.md');
  });

  it('returns nothing for no rows', () => {
    expect(formatTable(cols, [], 80)).toEqual([]);
  });
});

describe('displayWidth', () => {
  it('charges two columns for wide codepoints', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('a日')).toBe(3);
  });

  it('pads by display width, not by UTF-16 length', () => {
    // `String.length` counts UTF-16 units, so a CJK cell padded that way is two columns
    // short and every column to its right shifts left. Explicit ranges rather than
    // `\p{...}`, for the reason tokens/estimate.ts documents: a property escape resolves
    // against the host V8's Unicode version and would differ between Node 20 and 22.
    expect(displayWidth(padEndWide('日本', 8))).toBe(8);
    expect(padEndWide('日本', 8)).toHaveLength(6);
  });
});

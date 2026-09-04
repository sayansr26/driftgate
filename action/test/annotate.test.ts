import { describe, expect, it } from 'vitest';
import type { VerifyEntry, VerifyReport } from 'driftgate';
import {
  annotationsFor,
  escapeData,
  escapeProperty,
  MAX_ANNOTATIONS,
  renderAnnotations,
} from '../src/annotate.js';

function entry(over: Partial<VerifyEntry> & Pick<VerifyEntry, 'path' | 'status'>): VerifyEntry {
  return over;
}

function report(entries: readonly VerifyEntry[]): VerifyReport {
  return {
    clean: entries.length === 0,
    entries,
    drifted: entries.map((e) => e.path),
    missing: [],
    warnings: [],
  };
}

describe('escaping', () => {
  it('escapes the three characters that end a workflow command', () => {
    expect(escapeData('a\nb\rc')).toBe('a%0Ab%0Dc');
  });

  it('escapes % before the substitutions that introduce one', () => {
    // The ordering is the whole guard. Escaping the newline first produces `%250A`,
    // which renders as the literal text "%0A" instead of a line break — a bug that
    // looks like a formatting quirk rather than a broken escape.
    expect(escapeData('100%\n')).toBe('100%25%0A');
  });

  it('escapes the property separators on top of the data escapes', () => {
    // `,` separates properties and `:` ends them, so an unescaped one is reparsed as
    // the start of another property and the annotation lands somewhere else entirely.
    expect(escapeProperty('C:\\a,b')).toBe('C%3A\\a%2Cb');
    expect(escapeProperty('x\ny')).toBe('x%0Ay');
  });

  it('leaves an ordinary path untouched, so the assertions above can fail', () => {
    expect(escapeProperty('.cursor/rules/10-style.mdc')).toBe('.cursor/rules/10-style.mdc');
  });
});

describe('annotationsFor', () => {
  it('takes line numbers from the file on disk, not from the render', () => {
    // Disk and render disagree about where the change is: the render has two extra
    // lines above it. An annotation computed from the render's coordinates would point
    // at the right file and the wrong lines, which is worse than no annotation.
    const actual = 'one\ntwo\nCHANGED\n';
    const expected = 'added\nadded\none\ntwo\nfixed\n';

    const [first] = annotationsFor(entry({ path: 'CLAUDE.md', status: 'stale', actual, expected }));

    expect(first).toBeDefined();
    expect(first?.line).toBe(1);
    // The old side runs 1..3; the new side runs 1..5. Anything past 3 came from the render.
    expect(first?.endLine).toBe(3);
  });

  it('never emits line 0 for an insertion at the top of the file', () => {
    // `Hunk.oldStart` is 0 for a pure insertion and GitHub's lines are 1-based, so an
    // unclamped value is silently dropped by the runner.
    const notes = annotationsFor(
      entry({ path: 'CLAUDE.md', status: 'stale', actual: '', expected: 'new\n' }),
    );

    for (const a of notes) {
      expect(a.line).toBeGreaterThanOrEqual(1);
      expect(a.endLine ?? 0).toBeGreaterThanOrEqual(a.line ?? 0);
    }
  });

  it.each(['missing', 'orphaned'] as const)(
    'annotates a %s file at file level, with no fabricated line',
    (status) => {
      const notes = annotationsFor(entry({ path: 'GEMINI.md', status }));

      expect(notes).toHaveLength(1);
      expect(notes[0]?.line).toBeUndefined();
      expect(notes[0]?.endLine).toBeUndefined();
    },
  );

  it('carries the recovery hint the CLI would print for that status', () => {
    const [handEdited] = annotationsFor(
      entry({ path: 'CLAUDE.md', status: 'hand-edited', actual: 'a\n', expected: 'b\n' }),
    );
    const [orphan] = annotationsFor(entry({ path: 'CLAUDE.md', status: 'orphaned' }));

    expect(handEdited?.message).toContain('re-apply your edit in .driftgate/');
    // Different situation, different fix: telling somebody to re-apply an edit in a rule
    // that no longer exists is the mistake `hints.ts` exists to prevent.
    expect(orphan?.message).not.toContain('re-apply your edit in .driftgate/');
    expect(orphan?.message).toContain('driftgate sync');
  });
});

describe('renderAnnotations', () => {
  it('emits nothing for a clean report', () => {
    expect(renderAnnotations(report([]))).toEqual([]);
  });

  it('formats a whole-file annotation without a line property', () => {
    const [line] = renderAnnotations(report([entry({ path: 'GEMINI.md', status: 'missing' })]));

    expect(line).toContain('::error file=GEMINI.md,');
    expect(line).not.toContain('line=');
    expect(line).toContain('title=driftgate%3A missing');
  });

  it('caps the annotations and counts what it dropped', () => {
    const many = Array.from({ length: MAX_ANNOTATIONS + 3 }, (_, i) =>
      entry({ path: `rule-${String(i)}.md`, status: 'missing' as const }),
    );

    const lines = renderAnnotations(report(many));

    expect(lines).toHaveLength(MAX_ANNOTATIONS + 1);
    expect(lines.filter((l) => l.startsWith('::error'))).toHaveLength(MAX_ANNOTATIONS);
    // Not merely truncated: a repository with thirteen drifted regions must not look
    // like one with ten.
    expect(lines.at(-1)).toContain('3 more drifted regions not annotated');
  });

  it('says "region" rather than "regions" for a single overflow', () => {
    const many = Array.from({ length: MAX_ANNOTATIONS + 1 }, (_, i) =>
      entry({ path: `rule-${String(i)}.md`, status: 'missing' as const }),
    );

    expect(renderAnnotations(report(many)).at(-1)).toContain('1 more drifted region not');
  });

  it('emits no notice when nothing was dropped', () => {
    const lines = renderAnnotations(
      report([
        entry({ path: 'a.md', status: 'missing' }),
        entry({ path: 'b.md', status: 'missing' }),
      ]),
    );

    expect(lines.every((l) => l.startsWith('::error'))).toBe(true);
  });
});

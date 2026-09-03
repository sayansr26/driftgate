import { describe, expect, it } from 'vitest';
import { diffLines, formatHunks, unifiedDiff, escapeInvisibles } from '../src/diff/unified.js';
import type { Hunk } from '../src/diff/unified.js';

const lines = (...ls: string[]) => ls.map((l) => `${l}\n`).join('');
const TEN = lines('l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10');

/** Replays the hunks over `oldText` and returns what they say `newText` is. */
function apply(oldText: string, hunks: readonly Hunk[]): string {
  const old = oldText === '' ? [] : oldText.split('\n');
  const oldNoNewline = old.length > 0 && old[old.length - 1] !== '';
  if (!oldNoNewline && old.length > 0) old.pop();
  const out: string[] = [];
  let cursor = 0;
  let newNoNewline = false;
  for (const hunk of hunks) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    while (cursor < start) out.push(old[cursor++] ?? '');
    for (const line of hunk.lines) {
      if (line.kind === 'remove') {
        cursor += 1;
        continue;
      }
      if (line.kind === 'context') cursor += 1;
      out.push(line.text);
      if (line.noNewline === true) newNoNewline = true;
    }
  }
  while (cursor < old.length) {
    out.push(old[cursor++] ?? '');
    if (oldNoNewline && cursor === old.length) newNoNewline = true;
  }
  if (out.length === 0) return '';
  return out.join('\n') + (newNoNewline ? '' : '\n');
}

function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 0x100000000;
    return state / 0x100000000;
  };
}

describe('diffLines', () => {
  it('returns no hunks for identical text', () => {
    expect(diffLines(TEN, TEN)).toEqual([]);
    expect(diffLines('', '')).toEqual([]);
  });

  it('renders a one-line change mid-file as one hunk of eight lines', () => {
    // T022's validation: a 1-line change is under 10 lines. The hunk is `@@` plus three
    // lines of context either side of the `-`/`+` pair.
    const changed = TEN.replace('l5\n', 'L5\n');
    const out = formatHunks(diffLines(TEN, changed)).map((l) => l.text);
    expect(out).toEqual([
      '@@ -2,7 +2,7 @@',
      ' l2',
      ' l3',
      ' l4',
      '-l5',
      '+L5',
      ' l6',
      ' l7',
      ' l8',
    ]);
    expect(out.length).toBeLessThan(10);
  });

  it('truncates context at the start and end of the file', () => {
    expect(unifiedDiff(TEN, TEN.replace('l1\n', 'X\n')).split('\n')).toEqual([
      '@@ -1,4 +1,4 @@',
      '-l1',
      '+X',
      ' l2',
      ' l3',
      ' l4',
    ]);
    expect(unifiedDiff(TEN, TEN.replace('l10\n', 'X\n')).split('\n')).toEqual([
      '@@ -7,4 +7,4 @@',
      ' l7',
      ' l8',
      ' l9',
      '-l10',
      '+X',
    ]);
  });

  it('merges edits whose context would touch and splits edits further apart', () => {
    // l3 and l9 changed: the five unchanged lines between them (l4-l8) are within
    // 2*context, so the two changes share one hunk. A gap of three would merge under a
    // rule of `<= context` too, so it would not distinguish the right rule from that one.
    const near = TEN.replace('l3\n', 'A\n').replace('l9\n', 'B\n');
    expect(diffLines(TEN, near)).toHaveLength(1);

    // l1 and l10 changed: eight unchanged lines between them, two hunks.
    const far = TEN.replace('l1\n', 'A\n').replace('l10\n', 'B\n');
    const hunks = diffLines(TEN, far);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.oldStart).toBe(1);
    expect(hunks[1]?.oldStart).toBe(7);
  });

  it('honours the context width', () => {
    const changed = TEN.replace('l5\n', 'L5\n');
    expect(unifiedDiff(TEN, changed, 1).split('\n')).toEqual([
      '@@ -4,3 +4,3 @@',
      ' l4',
      '-l5',
      '+L5',
      ' l6',
    ]);
    expect(unifiedDiff(TEN, changed, 0).split('\n')).toEqual(['@@ -5 +5 @@', '-l5', '+L5']);
  });

  it('reports a pure insertion and a pure deletion with git’s zero-length ranges', () => {
    expect(unifiedDiff('', lines('a', 'b')).split('\n')).toEqual(['@@ -0,0 +1,2 @@', '+a', '+b']);
    expect(unifiedDiff(lines('a', 'b'), '').split('\n')).toEqual(['@@ -1,2 +0,0 @@', '-a', '-b']);
    expect(unifiedDiff(lines('a'), lines('a', 'b')).split('\n')).toEqual([
      '@@ -1 +1,2 @@',
      ' a',
      '+b',
    ]);
  });

  it('marks a side that has no trailing newline, so a newline-only drift is visible', () => {
    // hashContents('a') differs from hashContents('a\n'); a diff that showed two
    // identical `a` lines would make the reader conclude the tool is broken.
    expect(unifiedDiff('a\n', 'a').split('\n')).toEqual([
      '@@ -1 +1 @@',
      '-a',
      '+a',
      '\\ No newline at end of file',
    ]);
    expect(unifiedDiff('a', 'a\n').split('\n')).toEqual([
      '@@ -1 +1 @@',
      '-a',
      '\\ No newline at end of file',
      '+a',
    ]);
    // Both sides newline-less and equal there: the shared last line carries one note.
    expect(unifiedDiff(lines('x') + 'end', lines('y') + 'end').split('\n')).toEqual([
      '@@ -1,2 +1,2 @@',
      '-x',
      '+y',
      ' end',
      '\\ No newline at end of file',
    ]);
  });

  it('makes trailing spaces and tabs visible on changed lines only', () => {
    const out = unifiedDiff(lines('\tcode', 'text'), lines('\tcode', 'text  ')).split('\n');
    expect(out).toEqual(['@@ -1,2 +1,2 @@', ' \tcode', '-text', '+text··']);

    const tab = unifiedDiff(lines('a'), lines('a\tb')).split('\n');
    expect(tab).toEqual(['@@ -1 +1 @@', '-a', '+a␉b']);

    // Control: a change with no invisibles shows no escapes.
    expect(unifiedDiff(lines('a'), lines('b'))).not.toMatch(/[·␉␍]/);
  });

  it('swaps + and - exactly when the arguments are swapped', () => {
    const changed = TEN.replace('l5\n', 'L5\n');
    const forward = formatHunks(diffLines(TEN, changed));
    const backward = formatHunks(diffLines(changed, TEN));
    const texts = (ls: readonly { kind: string; text: string }[], kind: string) =>
      ls.filter((l) => l.kind === kind).map((l) => l.text.slice(1));
    // Within a change block removals always print before additions, so the swap is a
    // swap of *sides*, not a line-for-line sign flip.
    expect(texts(backward, 'remove')).toEqual(texts(forward, 'add'));
    expect(texts(backward, 'add')).toEqual(texts(forward, 'remove'));
    expect(texts(backward, 'context')).toEqual(texts(forward, 'context'));
    expect(backward[0]?.text).toBe('@@ -2,7 +2,7 @@');
  });

  it('is deterministic across repeated runs', () => {
    const a = lines('a', 'b', 'c', 'd', 'e', 'f');
    const b = lines('a', 'c', 'x', 'd', 'e', 'y', 'f');
    const first = unifiedDiff(a, b);
    for (let i = 0; i < 100; i += 1) expect(unifiedDiff(a, b)).toBe(first);
  });

  it('produces a script that rebuilds the new text from the old, over 300 random pairs', () => {
    // The property that matters for a diff `sync` will be trusted to have explained: the
    // hunks, replayed over what is on disk, give exactly what canonical would generate.
    const alphabet = ['a', 'b', 'c', 'd'];
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = rng(seed);
      const gen = (): string => {
        const count = Math.floor(next() * 12);
        const ls = Array.from(
          { length: count },
          () => alphabet[Math.floor(next() * alphabet.length)] ?? 'a',
        );
        const text = ls.join('\n');
        return text === '' ? '' : next() < 0.8 ? `${text}\n` : text;
      };
      const oldText = gen();
      const newText = gen();
      const hunks = diffLines(oldText, newText, Math.floor(next() * 3));
      expect(apply(oldText, hunks), `seed ${seed}`).toBe(newText);
    }
  });

  it('falls back to one replace hunk rather than stalling on a huge unrelated change', () => {
    const big = (tag: string) => Array.from({ length: 3000 }, (_, i) => `${tag}${i}\n`).join('');
    const started = Date.now();
    const hunks = diffLines(big('a'), big('b'));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.oldLines).toBe(3000);
    expect(hunks[0]?.newLines).toBe(3000);
    expect(apply(big('a'), hunks)).toBe(big('b'));
  });
});

describe('escapeInvisibles', () => {
  it('escapes only what a reader cannot see', () => {
    expect(escapeInvisibles('a b')).toBe('a b');
    expect(escapeInvisibles('a b  ')).toBe('a b··');
    expect(escapeInvisibles('a\tb\r')).toBe('a␉b␍');
  });
});

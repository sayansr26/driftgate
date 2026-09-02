/**
 * A line diff for golden fixtures, built around the failures this project actually
 * produces.
 *
 * A generic string diff renders a trailing space, a stray CRLF, or a BOM as *nothing* —
 * the two lines look identical and the reader concludes the test is broken. Those are
 * precisely the one-byte regressions the golden fixtures exist to catch, so invisibles
 * are escaped before anything is printed.
 */

const ESCAPES: readonly (readonly [RegExp, string])[] = [
  [/\uFEFF/g, '⟨BOM⟩'],
  [/\r/g, '␍'],
  [/\t/g, '␉'],
];

/** Makes the difference visible; never called on anything but diff output. */
export function escapeInvisibles(line: string): string {
  let out = line;
  for (const [pattern, replacement] of ESCAPES) out = out.replace(pattern, replacement);
  // Only trailing runs of spaces matter — marking every space would be unreadable.
  return out.replace(/ +$/, (spaces) => '·'.repeat(spaces.length));
}

export interface LineDifference {
  /** 1-based. */
  readonly line: number;
  /** 1-based, in code units. */
  readonly column: number;
  /** 0-based offset into the whole file, so a hex dump can be found from here. */
  readonly byteOffset: number;
  readonly expected: string | undefined;
  readonly actual: string | undefined;
}

/**
 * The first line at which two renderings differ, or `undefined` if they are identical.
 *
 * Deliberately not a full LCS diff: golden output is generated, so the interesting case
 * is "one thing changed", and the first difference plus its context answers it. A minimal
 * edit script would be a dependency or ~200 lines, and neither is worth it here.
 */
export function firstDifference(expected: string, actual: string): LineDifference | undefined {
  if (expected === actual) return undefined;

  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const count = Math.max(expectedLines.length, actualLines.length);

  let byteOffset = 0;
  for (let i = 0; i < count; i += 1) {
    const e = expectedLines[i];
    const a = actualLines[i];
    if (e === a) {
      // +1 for the '\n' that split() removed. The last line has none, but the loop
      // cannot reach past it without having already returned.
      byteOffset += (e?.length ?? 0) + 1;
      continue;
    }
    let column = 0;
    while (column < (e?.length ?? 0) && column < (a?.length ?? 0) && e?.[column] === a?.[column]) {
      column += 1;
    }
    return {
      line: i + 1,
      column: column + 1,
      byteOffset: byteOffset + column,
      expected: e,
      actual: a,
    };
  }
  return undefined;
}

/** `expected` and `actual` around the first difference, with three lines of context. */
export function formatDifference(expected: string, actual: string, contextLines = 3): string {
  const diff = firstDifference(expected, actual);
  if (diff === undefined) return '';

  const expectedLines = expected.split('\n');
  const from = Math.max(0, diff.line - 1 - contextLines);
  const to = diff.line - 1;

  const out: string[] = [
    `first difference at line ${String(diff.line)}, column ${String(diff.column)} (byte ${String(diff.byteOffset)})`,
  ];
  for (let i = from; i < to; i += 1) {
    out.push(`  ${String(i + 1).padStart(4)} │ ${escapeInvisibles(expectedLines[i] ?? '')}`);
  }
  out.push(`- ${String(diff.line).padStart(4)} │ ${describe(diff.expected)}`);
  out.push(`+ ${String(diff.line).padStart(4)} │ ${describe(diff.actual)}`);
  for (let i = diff.line; i < Math.min(expectedLines.length, diff.line + contextLines); i += 1) {
    out.push(`  ${String(i + 1).padStart(4)} │ ${escapeInvisibles(expectedLines[i] ?? '')}`);
  }
  return out.join('\n');
}

function describe(line: string | undefined): string {
  // A missing line and an empty line are different failures and must not print the same.
  return line === undefined ? '⟨no such line⟩' : escapeInvisibles(line);
}

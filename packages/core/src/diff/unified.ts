/**
 * A line-level unified diff, hand-rolled because a dependency here would be one more
 * package in a tool whose pitch is a thin tree — and because the output has to carry the
 * one thing a generic diff hides.
 *
 * `rulegate check` reports drift by hash, and `hashContents` sees a trailing space, a
 * tab, or a missing final newline that a printed diff renders as *nothing*. A reader
 * shown two identical-looking lines concludes the tool is broken. So `+`/`-` lines have
 * their invisibles escaped, and a side without a final newline is marked the way git
 * marks it. Context lines are printed verbatim: a fenced code block legitimately holds
 * tabs, and escaping them there would be noise about lines that did not change.
 *
 * Both inputs are expected to be EOL-normalized already (`ReadOnlyFileSystem.readFile`
 * and every rendered artifact are), so a CRLF/LF difference cannot reach this function —
 * which is consistent with `hashContents` not seeing one either.
 *
 * Pure and deterministic: the output depends on the two strings and the context width and
 * nothing else. No clock, no locale, no randomness.
 */

export interface DiffLine {
  readonly kind: 'context' | 'add' | 'remove';
  readonly text: string;
  /** This is the last line of a side that does not end in a newline. */
  readonly noNewline?: true;
}

export interface Hunk {
  /** 1-based; 0 when the old side contributes no lines (a pure insertion at the top). */
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface FormattedLine {
  readonly kind: 'hunk' | 'context' | 'add' | 'remove' | 'note';
  readonly text: string;
}

/**
 * Beyond this many edit steps the O(ND) search is abandoned for a single replace hunk.
 * Bounds memory at roughly `MAX_EDITS²` numbers regardless of file size, and a diff with
 * a thousand edits is not one anybody reads line by line anyway.
 */
const MAX_EDITS = 1000;

interface Side {
  readonly lines: readonly string[];
  /** Comparison keys: the final line of a newline-less side is distinct from the same text with one. */
  readonly keys: readonly string[];
  readonly noNewline: boolean;
}

function splitSide(text: string): Side {
  if (text === '') return { lines: [], keys: [], noNewline: false };
  const lines = text.split('\n');
  const noNewline = lines[lines.length - 1] !== '';
  if (!noNewline) lines.pop();
  const keys = lines.map((line, i) =>
    // A line cannot contain '\n', so this suffix cannot collide with real content.
    noNewline && i === lines.length - 1 ? `${line}\n` : line,
  );
  return { lines, keys, noNewline };
}

type Op =
  | { readonly kind: 'context'; readonly oldIndex: number; readonly newIndex: number }
  | { readonly kind: 'remove'; readonly oldIndex: number }
  | { readonly kind: 'add'; readonly newIndex: number };

/**
 * Myers' O(ND) shortest edit script over `a[lo..hi)` and `b[lo..hi)`, with a fixed
 * tie-break (a deletion is preferred over an insertion at equal cost) so the same inputs
 * always yield the same script. Returns `undefined` when the script would exceed
 * `MAX_EDITS`.
 */
function shortestEdit(a: readonly string[], b: readonly string[]): readonly Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];

  const offset = max + 1;
  const width = 2 * max + 3;
  let v = new Int32Array(width);
  v[offset + 1] = 0;
  // `trace[d]` is the frontier as it stood *before* round `d`, which is what round `d`
  // read from; backtracking replays each round's choice against that same snapshot.
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d += 1) {
    if (d > MAX_EDITS) return undefined;
    trace.push(v);
    v = v.slice();
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, offset);
    }
  }
  return undefined;
}

function backtrack(
  trace: readonly Int32Array[],
  n: number,
  m: number,
  offset: number,
): readonly Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d];
    if (v === undefined) break;
    const k = x - y;
    const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    // Walk the diagonal (matching lines) back to where this round's single step landed.
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: 'context', oldIndex: x, newIndex: y });
    }
    if (d > 0) {
      if (down) ops.push({ kind: 'add', newIndex: prevY });
      else ops.push({ kind: 'remove', oldIndex: prevX });
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  return ops;
}

/** Everything removed, then everything added: the honest answer when the real script is too long to be read. */
function replaceAll(oldCount: number, newCount: number): readonly Op[] {
  const ops: Op[] = [];
  for (let i = 0; i < oldCount; i += 1) ops.push({ kind: 'remove', oldIndex: i });
  for (let i = 0; i < newCount; i += 1) ops.push({ kind: 'add', newIndex: i });
  return ops;
}

function editScript(oldSide: Side, newSide: Side): readonly Op[] {
  const a = oldSide.keys;
  const b = newSide.keys;

  // Common prefix and suffix are context by definition; trimming them keeps the search
  // proportional to the change, which for a generated file is usually a few lines.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  const middle = shortestEdit(middleA, middleB) ?? replaceAll(middleA.length, middleB.length);

  const ops: Op[] = [];
  for (let i = 0; i < prefix; i += 1) ops.push({ kind: 'context', oldIndex: i, newIndex: i });
  for (const op of middle) {
    if (op.kind === 'context') {
      ops.push({ kind: 'context', oldIndex: op.oldIndex + prefix, newIndex: op.newIndex + prefix });
    } else if (op.kind === 'remove') {
      ops.push({ kind: 'remove', oldIndex: op.oldIndex + prefix });
    } else {
      ops.push({ kind: 'add', newIndex: op.newIndex + prefix });
    }
  }
  for (let i = 0; i < suffix; i += 1) {
    ops.push({
      kind: 'context',
      oldIndex: a.length - suffix + i,
      newIndex: b.length - suffix + i,
    });
  }
  return ops;
}

function toDiffLine(op: Op, oldSide: Side, newSide: Side): DiffLine {
  if (op.kind === 'remove') {
    const text = oldSide.lines[op.oldIndex] ?? '';
    const last = oldSide.noNewline && op.oldIndex === oldSide.lines.length - 1;
    return last ? { kind: 'remove', text, noNewline: true } : { kind: 'remove', text };
  }
  if (op.kind === 'add') {
    const text = newSide.lines[op.newIndex] ?? '';
    const last = newSide.noNewline && op.newIndex === newSide.lines.length - 1;
    return last ? { kind: 'add', text, noNewline: true } : { kind: 'add', text };
  }
  const text = oldSide.lines[op.oldIndex] ?? '';
  // Keys matched, so either both sides end here without a newline or neither does.
  const last = oldSide.noNewline && op.oldIndex === oldSide.lines.length - 1;
  return last ? { kind: 'context', text, noNewline: true } : { kind: 'context', text };
}

/**
 * Hunks of the unified diff from `oldText` to `newText`: `remove` lines are what the old
 * side has, `add` lines are what the new side has. Empty when the texts are equal.
 */
export function diffLines(oldText: string, newText: string, context = 3): readonly Hunk[] {
  if (oldText === newText) return [];
  const oldSide = splitSide(oldText);
  const newSide = splitSide(newText);
  const ops = editScript(oldSide, newSide);
  const ctx = Math.max(0, Math.floor(context));

  const changeIndices: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind !== 'context') changeIndices.push(i);
  });
  if (changeIndices.length === 0) return [];

  // Group changes whose surrounding context would touch or overlap into one hunk.
  const groups: { readonly first: number; readonly last: number }[] = [];
  let first = changeIndices[0] ?? 0;
  let last = first;
  for (const index of changeIndices.slice(1)) {
    if (index - last - 1 <= 2 * ctx) {
      last = index;
    } else {
      groups.push({ first, last });
      first = index;
      last = index;
    }
  }
  groups.push({ first, last });

  return groups.map((group) => {
    const from = Math.max(0, group.first - ctx);
    const to = Math.min(ops.length - 1, group.last + ctx);
    const lines: DiffLine[] = [];
    let oldLines = 0;
    let newLines = 0;
    for (let i = from; i <= to; i += 1) {
      const op = ops[i];
      if (op === undefined) continue;
      if (op.kind !== 'add') oldLines += 1;
      if (op.kind !== 'remove') newLines += 1;
      lines.push(toDiffLine(op, oldSide, newSide));
    }
    const firstOp = ops[from];
    const oldIndex = firstOp === undefined ? 0 : oldIndexAt(ops, from);
    const newIndex = firstOp === undefined ? 0 : newIndexAt(ops, from);
    return {
      // git's convention: a side that contributes nothing reports the line *before*.
      oldStart: oldLines === 0 ? oldIndex : oldIndex + 1,
      oldLines,
      newStart: newLines === 0 ? newIndex : newIndex + 1,
      newLines,
      lines,
    };
  });
}

/** The old-side line index the op at `at` sits on, counting only ops that consume old lines. */
function oldIndexAt(ops: readonly Op[], at: number): number {
  let count = 0;
  for (let i = 0; i < at; i += 1) if (ops[i]?.kind !== 'add') count += 1;
  return count;
}

function newIndexAt(ops: readonly Op[], at: number): number {
  let count = 0;
  for (let i = 0; i < at; i += 1) if (ops[i]?.kind !== 'remove') count += 1;
  return count;
}

function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** Makes an invisible difference visible. Applied to changed lines only. */
export function escapeInvisibles(line: string): string {
  return line
    .replace(/\r/g, '␍')
    .replace(/\t/g, '␉')
    .replace(/ +$/, (spaces) => '·'.repeat(spaces.length));
}

const NO_NEWLINE_NOTE = '\\ No newline at end of file';

/** The hunks as the lines of a unified diff, tagged so a caller can colour them after layout. */
export function formatHunks(hunks: readonly Hunk[]): readonly FormattedLine[] {
  const out: FormattedLine[] = [];
  for (const hunk of hunks) {
    out.push({
      kind: 'hunk',
      text: `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`,
    });
    for (const line of hunk.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
      const text = line.kind === 'context' ? line.text : escapeInvisibles(line.text);
      out.push({ kind: line.kind, text: `${prefix}${text}` });
      if (line.noNewline === true) out.push({ kind: 'note', text: NO_NEWLINE_NOTE });
    }
  }
  return out;
}

/** `formatHunks(diffLines(oldText, newText, context))` joined by newlines; empty for equal inputs. */
export function unifiedDiff(oldText: string, newText: string, context = 3): string {
  return formatHunks(diffLines(oldText, newText, context))
    .map((l) => l.text)
    .join('\n');
}

/**
 * Column alignment for terminal output.
 *
 * Deliberately not a "renderer" in this codebase's sense — it produces terminal
 * presentation, never artifact bytes, and nothing here may be reached from the pipeline.
 * Kept free of the `render*` naming so it stays obviously distinct from
 * `packages/core/src/render/`, whose primitives are banned from the CLI outright.
 */

/**
 * Printable width of a string in terminal cells.
 *
 * Wide codepoints occupy two columns, so `String.length` (UTF-16 units) mis-aligns any
 * table containing CJK. The ranges are written out explicitly rather than as `\p{...}`
 * for the reason `tokens/estimate.ts` documents at length: a Unicode property escape
 * resolves against the host V8's Unicode version, so the same input can measure
 * differently on Node 20 and Node 22, and this output has to be reproducible.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function padEndWide(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

export function padStartWide(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? ' '.repeat(pad) + text : text;
}

export interface Column {
  /** Right-aligned columns are for numbers, where the decimal point is the eye's anchor. */
  readonly align?: 'left' | 'right';
  /**
   * Lower drops first when the terminal is too narrow.
   *
   * Columns are dropped whole rather than truncated: a truncated path is unusable, and the
   * summary is the part worth keeping. `0` means the column is never dropped.
   */
  readonly priority?: number;
}

/**
 * Lay rows out in aligned columns, dropping the least important ones to fit `width`.
 *
 * Cells are plain text; colour is applied by the caller *after* layout, because an ANSI
 * escape has zero printable width and would silently corrupt every column measurement.
 */
export function formatTable(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  width: number,
  gutter = '  ',
): string[] {
  if (rows.length === 0) return [];

  let keep = columns.map((_, i) => i);
  for (;;) {
    const widths = keep.map((i) => Math.max(...rows.map((r) => displayWidth(r[i] ?? ''))));
    const total = widths.reduce((n, w) => n + w, 0) + gutter.length * (keep.length - 1);
    const droppable = [...keep]
      .filter((i) => (columns[i]?.priority ?? 1) > 0)
      .sort((a, b) => (columns[a]?.priority ?? 1) - (columns[b]?.priority ?? 1));

    if (total <= width || droppable.length === 0 || keep.length === 1) {
      return rows.map((row) =>
        keep
          .map((col, n) => {
            const cell = row[col] ?? '';
            const w = widths[n] ?? 0;
            return columns[col]?.align === 'right' ? padStartWide(cell, w) : padEndWide(cell, w);
          })
          .join(gutter)
          .trimEnd(),
      );
    }
    const drop = droppable[0];
    keep = keep.filter((i) => i !== drop);
  }
}

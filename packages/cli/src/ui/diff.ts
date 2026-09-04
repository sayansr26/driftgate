import type { FormattedLine } from '@rulegate/core';
import type { Colors } from './report.js';

/**
 * Colour a formatted diff for the terminal.
 *
 * Presentation only: the hunks were computed in `core`, and this function adds nothing a
 * reader could mistake for content. Colour is applied per whole line *after* the text is
 * final, and only through the `Colors` handed in from `createOutput` — never via a direct
 * `picocolors` import, whose module default force-enables colour under `CI` and on
 * Windows and would put escape sequences into exactly the logs this output exists for.
 */
export function renderDiff(lines: readonly FormattedLine[], c: Colors): string[] {
  return lines.map((line) => {
    switch (line.kind) {
      case 'hunk':
        return c.cyan(line.text);
      case 'add':
        return c.green(line.text);
      case 'remove':
        return c.red(line.text);
      case 'note':
        return c.dim(line.text);
      default:
        return line.text;
    }
  });
}

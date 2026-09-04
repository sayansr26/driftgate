import { RulegateError } from '../model/errors.js';
import { normalizeText } from '../render/eol.js';

export interface FrontmatterSplit {
  /** Raw YAML between the fences, or undefined when the file has no frontmatter. */
  readonly yaml?: string;
  /** Lines consumed before the YAML begins — 1 when the file opens with `---`. */
  readonly yamlLineOffset: number;
  readonly body: string;
}

/**
 * Split `---` YAML frontmatter from a Markdown body.
 *
 * Hand-rolled rather than pulling `gray-matter`, which drags in `js-yaml` plus three
 * more packages and discards positions anyway. Normalization happens *before* the
 * split so the offset arithmetic is identical on a CRLF checkout.
 */
export function splitFrontmatter(
  raw: string,
  file: string,
): { ok: true; value: FrontmatterSplit } | { ok: false; error: RulegateError } {
  const text = normalizeText(raw);
  const lines = text.split('\n');

  if (lines[0]?.trim() !== '---') {
    return { ok: true, value: { yamlLineOffset: 0, body: text } };
  }

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === '---' || line === '...') {
      return {
        ok: true,
        value: {
          yaml: lines.slice(1, i).join('\n'),
          yamlLineOffset: 1,
          body: lines
            .slice(i + 1)
            .join('\n')
            .replace(/^\n+/, ''),
        },
      };
    }
  }

  return {
    ok: false,
    error: new RulegateError({
      code: 'E_FRONTMATTER_UNTERMINATED',
      message: 'frontmatter opened with `---` but was never closed',
      source: { file, line: 1, column: 1 },
      hint: 'add a closing `---` on its own line',
    }),
  };
}

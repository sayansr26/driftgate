import { MARKER_TEXT } from '../render/marker.js';

/**
 * One section of a concatenated instruction file: the inverse of `renderRuleSection`.
 *
 * `heading` is absent for content that precedes the first heading. That preamble is not
 * a formatting quirk to be tidied away — in a hand-written `CLAUDE.md` it is usually the
 * most important paragraph in the file, and dropping it is exactly the trust-fatal
 * import failure the losslessness rule exists to prevent.
 */
export interface DocumentSection {
  readonly heading?: string;
  readonly globs: readonly string[];
  readonly body: string;
  /** 1-based line in the source file where this section's heading (or content) begins. */
  readonly line: number;
}

export interface SplitOptions {
  /** The heading level the renderer emits. Only this level splits; deeper ones are body. */
  readonly headingLevel: 1 | 2 | 3;
  /**
   * Read the `**Applies to:**` line back into globs.
   *
   * False for Copilot's repository-wide file, whose rules are repo-wide by construction
   * (`showGlobs: false` on the way out), so a bold line that happens to read like one is
   * the user's prose, not our marker.
   */
  readonly parseGlobs: boolean;
}

const APPLIES_TO = /^\*\*Applies to:\*\*\s*(.+)$/;

/**
 * Remove the generated-by marker comment, if the file opens with one.
 *
 * Only the opening lines are considered, matching `hasMarker`'s 512-byte window: the
 * same sentence appearing further down is a user writing about Rulegate, not a claim
 * of authorship, and deleting a line from the middle of someone's document to satisfy a
 * heuristic is not a trade this importer makes.
 */
export function stripMarker(text: string): string {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.trim() !== '');
  if (index === -1) return text;

  const line = lines[index] ?? '';
  const isComment = line.trimStart().startsWith('<!--') || line.trimStart().startsWith('#');
  if (!isComment || !line.includes(MARKER_TEXT)) return text;

  let rest = index + 1;
  while (rest < lines.length && lines[rest]?.trim() === '') rest += 1;
  return lines.slice(rest).join('\n');
}

/**
 * Blank the contents of fenced code blocks so heading detection cannot fire inside one.
 *
 * Returns a mask the same length in lines as the input, never the content itself — the
 * caller slices the original. A `## Usage` inside a fenced example is a code sample, and
 * splitting a rule there would silently cut somebody's snippet in half. The same trap
 * bit T076's RFC section extractor, which read one path and passed.
 */
function maskFences(lines: readonly string[]): readonly string[] {
  const masked: string[] = [];
  let fence: string | undefined;

  for (const line of lines) {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === undefined) {
      if (opener) fence = opener[1]?.[0] === '`' ? '`' : '~';
      masked.push(fence === undefined ? line : '');
      continue;
    }
    masked.push('');
    if (opener && (opener[1]?.[0] ?? '') === fence) fence = undefined;
  }
  return masked;
}

function parseGlobList(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^`+|`+$/g, '')
        .trim(),
    )
    .filter((part) => part !== '');
}

/**
 * Split a concatenated instruction file back into sections.
 *
 * The exact inverse of `renderConcatenated` for output Rulegate produced, and a
 * reasonable reading of anything else — but the decision of *whether* to split at all
 * belongs to the caller, because on an unmarked file it is a guess.
 */
export function splitSections(text: string, options: SplitOptions): readonly DocumentSection[] {
  const marker = '#'.repeat(options.headingLevel);
  const heading = new RegExp(`^${marker}\\s+(.*)$`);

  const lines = text.split('\n');
  const masked = maskFences(lines);

  const starts: number[] = [];
  masked.forEach((line, i) => {
    if (heading.test(line)) starts.push(i);
  });

  const sections: DocumentSection[] = [];

  const preambleEnd = starts[0] ?? lines.length;
  const preamble = lines.slice(0, preambleEnd);
  if (preamble.some((line) => line.trim() !== '')) {
    sections.push({ globs: [], body: joinBody(preamble), line: 1 });
  }

  starts.forEach((start, i) => {
    const end = starts[i + 1] ?? lines.length;
    const title = (heading.exec(masked[start] ?? '')?.[1] ?? '').trim();
    const rest = lines.slice(start + 1, end);

    let cursor = 0;
    while (cursor < rest.length && (rest[cursor] ?? '').trim() === '') cursor += 1;

    let globs: readonly string[] = [];
    if (options.parseGlobs) {
      const applies = APPLIES_TO.exec((rest[cursor] ?? '').trim());
      if (applies) {
        globs = parseGlobList(applies[1] ?? '');
        cursor += 1;
        while (cursor < rest.length && (rest[cursor] ?? '').trim() === '') cursor += 1;
      }
    }

    sections.push({
      ...(title === '' ? {} : { heading: title }),
      globs,
      body: joinBody(rest.slice(cursor)),
      line: start + 1,
    });
  });

  return sections;
}

/** Trailing blank lines are rendering artifacts; leading ones were already consumed. */
function joinBody(lines: readonly string[]): string {
  const body = lines.join('\n').replace(/\n+$/, '');
  return body === '' ? '' : `${body}\n`;
}

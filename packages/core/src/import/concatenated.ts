import { normalizeText } from '../render/eol.js';
import { hasMarker } from '../render/marker.js';
import type { RuleDocument } from '../model/rule.js';
import { claimRuleId, importRuleId, importedRule } from './rule.js';
import { splitSections, stripMarker } from './sections.js';

export interface ImportConcatenatedOptions {
  /** Repo-relative POSIX path of the file being imported; recorded in `source`. */
  readonly file: string;
  readonly contents: string;
  /** The level this format's renderer emits. Default 2, which is what all five use. */
  readonly headingLevel?: 1 | 2 | 3;
  /** Read `**Applies to:**` back into globs. Default true; false for Copilot's repo file. */
  readonly parseGlobs?: boolean;
  /**
   * Split into one rule per heading.
   *
   * Defaults to whether the file carries our marker, and that default is the whole
   * design. For a file Rulegate wrote, splitting is the exact inverse of the renderer.
   * For a hand-written one it is a guess — headings in somebody's `CLAUDE.md` are
   * prose structure, not rule boundaries, and a wrong guess silently reorders their
   * instructions and attaches the wrong globs. So an unmarked file is imported whole,
   * which is lossless by construction and can be split by hand afterwards.
   */
  readonly structured?: boolean;
  /** Rule id for the whole-file import, and for a section whose heading yields no slug. */
  readonly idFallback: string;
}

/** Native concatenated Markdown -> canonical rules. The inverse of `renderConcatenated`. */
export function importConcatenated(options: ImportConcatenatedOptions): readonly RuleDocument[] {
  const text = stripMarker(normalizeText(options.contents));
  if (text.trim() === '') return [];

  const { file, idFallback } = options;
  const structured = options.structured ?? hasMarker(normalizeText(options.contents));

  if (!structured) {
    return [
      importedRule({
        id: idFallback,
        body: text.replace(/\n+$/, '') + '\n',
        source: { file, line: 1 },
      }),
    ];
  }

  const sections = splitSections(text, {
    headingLevel: options.headingLevel ?? 2,
    parseGlobs: options.parseGlobs ?? true,
  });

  const taken = new Set<string>();
  return sections.map((section, index) => {
    const desired =
      section.heading === undefined
        ? idFallback
        : importRuleId(section.heading, `${idFallback}-${String(index + 1)}`);
    return importedRule({
      id: claimRuleId(desired, taken),
      ...(section.heading === undefined ? {} : { description: section.heading }),
      globs: section.globs,
      body: section.body,
      source: { file, line: section.line },
    });
  });
}

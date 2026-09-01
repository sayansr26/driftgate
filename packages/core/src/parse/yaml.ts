import { LineCounter, parseDocument, type Document, type Node } from 'yaml';
import { DriftgateError } from '../model/errors.js';
import type { SourceRef } from '../model/ids.js';

export interface YamlParse {
  readonly doc: Document.Parsed;
  /** Turn a byte offset from `node.range` into a 1-based file position. */
  posAt(offset: number | undefined, field?: string): SourceRef;
}

/**
 * `yaml` is used over `js-yaml` for exactly one reason: `parseDocument` keeps a
 * CST-backed AST where every node carries a `range`, so a *semantically* wrong value
 * (`order: high` — valid YAML, wrong type) still has a line and column. `js-yaml`
 * discards positions on a successful parse, which would leave the parser re-scanning
 * source with regexes to answer "which line?" — and that breaks on multi-line and
 * flow-style values.
 *
 * @param lineOffset lines consumed before this YAML began (frontmatter fence).
 */
export function parseYaml(
  text: string,
  file: string,
  lineOffset = 0,
): { ok: true; value: YamlParse } | { ok: false; error: DriftgateError } {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, keepSourceTokens: true });

  const posAt = (offset: number | undefined, field?: string): SourceRef => {
    if (offset === undefined) return field === undefined ? { file } : { file, field };
    const { line, col } = lineCounter.linePos(offset);
    const ref: SourceRef = { file, line: line + lineOffset, column: col };
    return field === undefined ? ref : { ...ref, field };
  };

  const fatal = doc.errors[0];
  if (fatal) {
    const hint = yamlSyntaxHint(text, fatal.message);
    return {
      ok: false,
      error: new DriftgateError({
        code: 'E_YAML_SYNTAX',
        message: fatal.message.replace(/\s+at line \d+, column \d+.*$/s, ''),
        source: posAt(fatal.pos[0]),
        ...(hint === undefined ? {} : { hint }),
      }),
    };
  }

  return { ok: true, value: { doc, posAt } };
}

/**
 * A user's first glob will be `globs: *.ts`, and bare `*` opens a YAML alias, so they
 * get an opaque "Aliases and anchors must be named" error on their very first edit.
 * Special-casing it turns a guaranteed first-run papercut into a one-line fix.
 */
function yamlSyntaxHint(text: string, message: string): string | undefined {
  if (/alias|anchor/i.test(message) && /:\s*\*/.test(text)) {
    return "quote glob patterns that start with '*', e.g. globs: ['*.ts']";
  }
  if (/tab/i.test(message)) return 'YAML does not allow tabs for indentation; use spaces';
  return undefined;
}

export function nodeStart(node: Node | null | undefined): number | undefined {
  return node?.range?.[0];
}

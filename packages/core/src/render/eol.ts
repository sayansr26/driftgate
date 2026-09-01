/**
 * Text normalization. Every text read passes through here, and every artifact is
 * finalized through here, so that a CRLF checkout and an LF checkout produce
 * byte-identical output. See docs/determinism.md.
 */

const BOM = '﻿';

export function stripBom(s: string): string {
  return s.startsWith(BOM) ? s.slice(1) : s;
}

export function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/**
 * Exactly one trailing newline, unless the content is empty — an adapter signals
 * "emit no file" by producing no artifact, so empty content stays empty rather than
 * becoming a lone newline.
 */
export function ensureSingleTrailingNewline(s: string): string {
  if (s === '') return '';
  return s.replace(/\n*$/, '') + '\n';
}

/** stripBom -> normalizeEol. Applied to every text read at the io boundary. */
export function normalizeText(s: string): string {
  return normalizeEol(stripBom(s));
}

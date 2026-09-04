import { describe, expect, it } from 'vitest';
import { ignoreCovers } from '../src/init/formatters.js';

/**
 * T072. The interesting half of the formatter warning is not which formatters it knows
 * about but whether it can read an ignore file that a human wrote — directory entries,
 * bare names, roots and negations rather than one literal path per line. Exact-line
 * matching was the original implementation and it reported this repository's own
 * correctly-configured `.prettierignore` as covering nothing.
 *
 * These are aimed one rule at a time on purpose: the fixture-level test in
 * `init.test.ts` passes with the any-depth branch deleted, because an overlapping rule
 * covers the same paths there. A mutation must be able to fail exactly one assertion.
 */
describe('ignoreCovers', () => {
  it('covers a directory entry, with or without the trailing slash', () => {
    expect(ignoreCovers('.cursor/rules/\n', '.cursor/rules/10-style.mdc')).toBe(true);
    expect(ignoreCovers('.cursor/rules\n', '.cursor/rules/10-style.mdc')).toBe(true);
  });

  it('covers a literal path and a glob', () => {
    expect(ignoreCovers('CLAUDE.md\n', 'CLAUDE.md')).toBe(true);
    expect(ignoreCovers('**/*.mdc\n', '.cursor/rules/10-style.mdc')).toBe(true);
  });

  // The any-depth rule, with no other line able to answer for it. A bare name with no
  // slash matches at every depth — the same gitignore rule whose leading-`/` omission
  // silently excluded this repository's Claude fixtures for the whole of M0.
  it('matches a bare name at every depth, and a rooted one only at the root', () => {
    expect(ignoreCovers('instructions\n', '.github/instructions/x.instructions.md')).toBe(true);
    expect(ignoreCovers('/instructions\n', '.github/instructions/x.instructions.md')).toBe(false);
    expect(ignoreCovers('/CLAUDE.md\n', 'CLAUDE.md')).toBe(true);
  });

  it('ignores comments and blank lines', () => {
    expect(ignoreCovers('# CLAUDE.md\n\n', 'CLAUDE.md')).toBe(false);
  });

  it('lets the last matching line win, so a negation un-ignores', () => {
    expect(ignoreCovers('**/*.md\n!CLAUDE.md\n', 'CLAUDE.md')).toBe(false);
    // Order matters, which is what "last match wins" means rather than "any negation".
    expect(ignoreCovers('!CLAUDE.md\n**/*.md\n', 'CLAUDE.md')).toBe(true);
    // And a negation for something else does not un-ignore this one.
    expect(ignoreCovers('**/*.md\n!AGENTS.md\n', 'CLAUDE.md')).toBe(true);
  });

  it('is false on an empty ignore file', () => {
    expect(ignoreCovers('', 'CLAUDE.md')).toBe(false);
  });
});

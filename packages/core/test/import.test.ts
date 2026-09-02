import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECTION_OPTIONS,
  HTML_MARKER,
  MARKER_TEXT,
  claimRuleId,
  importConcatenated,
  importRuleId,
  importedRule,
  renderRuleSection,
  splitSections,
  stripMarker,
} from '../src/index.js';

const marked = (body: string): string => `${HTML_MARKER}\n\n${body}`;

describe('stripMarker', () => {
  it('removes the marker and the blank lines after it', () => {
    expect(stripMarker(marked('## Style\n\nUse tabs.\n'))).toBe('## Style\n\nUse tabs.\n');
  });

  it('leaves a file that does not open with the marker completely alone', () => {
    const text = `## Style\n\nWe use ${MARKER_TEXT} as our convention.\n`;
    expect(stripMarker(text)).toBe(text);
  });

  it('does not delete a line from the middle of a document that mentions the marker', () => {
    // The user writing *about* Driftgate is not claiming Driftgate wrote the file. A
    // substring search over the whole document would silently eat this line.
    const text = `## Notes\n\n<!-- ${MARKER_TEXT} -->\n\nnot the opening line\n`;
    expect(stripMarker(text)).toBe(text);
  });
});

describe('splitSections', () => {
  const split = (text: string): ReturnType<typeof splitSections> =>
    splitSections(text, { headingLevel: 2, parseGlobs: true });

  it('keeps content before the first heading as an unnamed section', () => {
    const sections = split('Read the architecture doc first.\n\n## Style\n\nUse tabs.\n');
    expect(sections).toHaveLength(2);
    expect(sections[0]?.heading).toBeUndefined();
    expect(sections[0]?.body).toBe('Read the architecture doc first.\n');
    expect(sections[1]?.heading).toBe('Style');
  });

  it('does not split on a heading inside a fenced code block', () => {
    const sections = split('## Style\n\n```md\n## Not a heading\n```\n');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.body).toBe('```md\n## Not a heading\n```\n');
  });

  it('does not split on a deeper heading', () => {
    const sections = split('## Style\n\n### Details\n\nUse tabs.\n');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.body).toBe('### Details\n\nUse tabs.\n');
  });

  it('reads the Applies to line back into globs and removes it from the body', () => {
    const sections = split(
      '## Frontend\n\n**Applies to:** `a/**`, `b/*.tsx`\n\nServer components.\n',
    );
    expect(sections[0]?.globs).toEqual(['a/**', 'b/*.tsx']);
    expect(sections[0]?.body).toBe('Server components.\n');
  });

  it('ignores an Applies to line that is not the first content of the section', () => {
    // Mid-body it is the user's prose. Only the position the renderer emits it in is ours.
    const sections = split('## Frontend\n\nServer components.\n\n**Applies to:** `a/**`\n');
    expect(sections[0]?.globs).toEqual([]);
    expect(sections[0]?.body).toContain('**Applies to:**');
  });

  it('leaves globs alone when the caller does not want them parsed', () => {
    const sections = splitSections('## Testing\n\n**Applies to:** everything\n\nVitest.\n', {
      headingLevel: 2,
      parseGlobs: false,
    });
    expect(sections[0]?.globs).toEqual([]);
    expect(sections[0]?.body).toBe('**Applies to:** everything\n\nVitest.\n');
  });
});

describe('importConcatenated', () => {
  const opts = { file: 'CLAUDE.md', idFallback: 'claude' } as const;

  it('splits a file that carries our marker', () => {
    const rules = importConcatenated({
      ...opts,
      contents: marked('## Style\n\nUse tabs.\n\n## Testing\n\nVitest.\n'),
    });
    expect(rules.map((r) => r.id)).toEqual(['style', 'testing']);
    expect(rules.map((r) => r.frontmatter.description)).toEqual(['Style', 'Testing']);
  });

  it('imports an unmarked file whole, headings and all', () => {
    // The conservative half of the design: in somebody else's `CLAUDE.md` a heading is
    // prose structure, not a rule boundary, and splitting on it reorders their file.
    const contents = '# Agent instructions\n\n## Deployments\n\nStaging on merge.\n';
    const rules = importConcatenated({ ...opts, contents });
    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).toBe('claude');
    expect(rules[0]?.frontmatter.description).toBeUndefined();
    expect(rules[0]?.body).toBe(contents);
  });

  it('normalizes CRLF and strips a BOM', () => {
    const rules = importConcatenated({ ...opts, contents: '﻿one\r\ntwo\r\n' });
    expect(rules[0]?.body).toBe('one\ntwo\n');
  });

  it('produces nothing at all for an empty or whitespace-only file', () => {
    expect(importConcatenated({ ...opts, contents: '' })).toEqual([]);
    expect(importConcatenated({ ...opts, contents: marked('\n\n') })).toEqual([]);
  });

  it('defaults order and tools rather than guessing them', () => {
    const rules = importConcatenated({ ...opts, contents: marked('## Style\n\nUse tabs.\n') });
    expect(rules[0]?.frontmatter.order).toBe(100);
    expect(rules[0]?.frontmatter.tools).toEqual({ kind: 'all' });
  });

  it('leaves `path` empty so init writes the rule under .driftgate/, not back over the source', () => {
    const rules = importConcatenated({ ...opts, contents: marked('## Style\n\nUse tabs.\n') });
    expect(rules[0]?.path).toBe('');
    expect(rules[0]?.source.file).toBe('CLAUDE.md');
  });
});

describe('rule ids', () => {
  it('falls back when a heading slugs to nothing', () => {
    expect(importRuleId('Style', 'claude-1')).toBe('style');
    expect(importRuleId('日本語', 'claude-1')).toBe('claude-1');
    expect(importRuleId('🚀', 'claude-1')).toBe('claude-1');
  });

  it('suffixes a collision rather than dropping the second rule', () => {
    const taken = new Set<string>();
    expect(claimRuleId('style', taken)).toBe('style');
    expect(claimRuleId('style', taken)).toBe('style-2');
    expect(claimRuleId('style', taken)).toBe('style-3');
  });
});

describe('renderRuleSection and the untitled rule (T019)', () => {
  const untitled = importedRule({
    id: 'claude',
    body: '# My own heading\n\nMy own words.\n',
    source: { file: 'CLAUDE.md' },
  });
  const titled = importedRule({
    id: 'style',
    description: 'Style',
    body: 'Use tabs.\n',
    source: { file: 'CLAUDE.md' },
  });

  it('adds no heading to a rule that has no description', () => {
    // A hand-written CLAUDE.md imports as exactly this: one untitled rule holding the
    // whole file. Falling back to the id put a `## claude` line at the top of the user's
    // own document that nobody wrote — content preserved, and a line invented.
    expect(renderRuleSection(untitled, DEFAULT_SECTION_OPTIONS)).toBe(
      '# My own heading\n\nMy own words.',
    );
  });

  it('still renders a heading when the rule has a description', () => {
    // The paired control. Without it the assertion above passes against a renderer that
    // never emits a heading at all.
    expect(renderRuleSection(titled, DEFAULT_SECTION_OPTIONS)).toBe('## Style\n\nUse tabs.');
  });
});

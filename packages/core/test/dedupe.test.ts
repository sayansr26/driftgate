import { describe, expect, it } from 'vitest';
import { dedupeImported, importedRule, type ImportSource } from '../src/index.js';

function rule(id: string, body: string, description?: string) {
  return importedRule({
    id,
    ...(description === undefined ? {} : { description }),
    body,
    source: { file: `${id}.md` },
  });
}

const source = (tool: string, ...rules: ReturnType<typeof rule>[]): ImportSource => ({
  tool,
  rules,
});

describe('dedupeImported', () => {
  it('narrows the selector to the tools that actually carried the rule', () => {
    const { rules } = dedupeImported([
      source('cursor', rule('composer', 'Use the composer for multi-file edits.\n')),
      source('claude-code'),
      source('gemini'),
    ]);
    expect(rules[0]?.frontmatter.tools).toEqual({ kind: 'include', tools: ['cursor'] });
  });

  it('counts a tool that found nothing, so one tool of three is not mistaken for all', () => {
    // The reason `collectImports` returns an entry per adapter rather than only the ones
    // with rules. Drop the empty sources and this rule becomes `all`, and the next sync
    // pushes a Cursor-only rule into everybody's context.
    const { rules } = dedupeImported([source('cursor', rule('composer', 'Use it.\n'))]);
    expect(rules[0]?.frontmatter.tools).toEqual({ kind: 'all' });
  });

  it('reports rules that share a heading but not their content', () => {
    const { rules, conflicts } = dedupeImported([
      source('claude-code', rule('style', 'Use tabs.\n', 'Style')),
      source('gemini', rule('style', 'Use two spaces.\n', 'Style')),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toBe('same-heading');
    expect(rules).toHaveLength(2);
  });

  it('reports near-identical bodies even when neither has a heading', () => {
    const body = ['one', 'two', 'three', 'four', 'five'].join('\n');
    const { conflicts } = dedupeImported([
      source('claude-code', rule('a', `${body}\n`)),
      source('gemini', rule('b', `${body}\nsix\n`)),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toBe('similar-content');
    expect(conflicts[0]?.similarity).toBeGreaterThan(0.7);
  });

  it('leaves genuinely different rules alone — no conflict, no merge', () => {
    const { rules, conflicts } = dedupeImported([
      source('claude-code', rule('style', 'Use tabs. Never any.\n', 'Style')),
      source('gemini', rule('deploy', 'Deploy from main only.\n', 'Deployment')),
    ]);
    expect(conflicts).toEqual([]);
    expect(rules).toHaveLength(2);
  });

  it('keeps every conflicting variant as its own rule, with distinct ids', () => {
    // The whole point: a conflict is a question, not a deletion. Both bodies survive.
    const { rules } = dedupeImported([
      source('claude-code', rule('style', 'Use tabs.\n', 'Style')),
      source('gemini', rule('style', 'Use two spaces.\n', 'Style')),
    ]);
    expect(rules.map((r) => r.id)).toEqual(['style', 'style-2']);
    expect(rules.map((r) => r.body)).toEqual(['Use tabs.\n', 'Use two spaces.\n']);
  });

  it('collapses on content rather than on id', () => {
    // The same rule reaches Cursor as `10-style.mdc` and Claude Code as a `## Style`
    // heading, so an id-keyed dedupe collapses nothing at all.
    const { rules } = dedupeImported([
      source('claude-code', rule('style', 'Use tabs.\n', 'Style')),
      source('cursor', rule('10-style', 'Use tabs.\n', 'Style')),
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.frontmatter.tools).toEqual({ kind: 'all' });
  });

  it('does not collapse rules that differ only in scope', () => {
    // Same words, different globs, is two rules — one scoped to components and one to
    // routes. Leaving globs out of the key merges them and silently widens one scope.
    const scoped = (id: string, glob: string) =>
      importedRule({
        id,
        description: 'Frontend',
        globs: [glob],
        body: 'Prefer server components.\n',
        source: { file: `${id}.md` },
      });
    const { rules } = dedupeImported([
      { tool: 'claude-code', rules: [scoped('a', 'src/components/**')] },
      { tool: 'cursor', rules: [scoped('b', 'src/app/**')] },
    ]);
    expect(rules).toHaveLength(2);
  });

  it('does not merge two rules whose fields concatenate to the same string', () => {
    // `description` + `body` with nothing between them: `ab` + `c` and `a` + `bc` are the
    // same characters in the same order and are not the same rule.
    const { rules } = dedupeImported([
      source('claude-code', rule('x', 'c\n', 'ab')),
      source('gemini', rule('y', 'bc\n', 'a')),
    ]);
    expect(rules).toHaveLength(2);
  });

  it('picks the same representative however the sources are ordered', () => {
    // The variants in a group are identical by construction, so this decides only which
    // id and source survive — but deciding it by array position means the same repository
    // yields different filenames depending on the order adapters are registered in.
    // Codepoint order on the source path, then the id.
    const claude = source('claude-code', rule('style', 'Use tabs.\n', 'Style'));
    const cursor = source('cursor', rule('10-style', 'Use tabs.\n', 'Style'));

    expect(dedupeImported([claude, cursor]).rules[0]?.id).toBe('10-style');
    expect(dedupeImported([cursor, claude]).rules[0]?.id).toBe('10-style');
  });

  it('is a no-op on an empty import', () => {
    expect(dedupeImported([])).toEqual({ rules: [], conflicts: [] });
  });
});

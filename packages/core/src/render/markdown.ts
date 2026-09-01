import { ensureSingleTrailingNewline } from './eol.js';
import { sortRules } from './order.js';
import { ruleHeading } from '../model/rule.js';
import type { RuleDocument } from '../model/rule.js';

export interface SectionOptions {
  readonly headingLevel: 1 | 2 | 3;
  /**
   * Emit an "Applies to" line for glob-scoped rules.
   *
   * Formats with no native per-glob mechanism (Claude Code, Codex) would otherwise
   * drop the scope silently, turning a rule meant for `src/components/**` into a
   * repo-wide instruction. Stating it in prose is lossy, but it is *visibly* lossy,
   * which is the difference that matters.
   */
  readonly showGlobs: boolean;
}

export const DEFAULT_SECTION_OPTIONS: SectionOptions = { headingLevel: 2, showGlobs: true };

export function renderRuleSection(rule: RuleDocument, options: SectionOptions): string {
  const heading = '#'.repeat(options.headingLevel);
  const parts = [`${heading} ${ruleHeading(rule)}`];

  if (options.showGlobs && rule.frontmatter.globs.length > 0) {
    const globs = rule.frontmatter.globs.map((g) => `\`${g}\``).join(', ');
    parts.push(`**Applies to:** ${globs}`);
  }

  const body = rule.body.replace(/\n+$/, '');
  if (body !== '') parts.push(body);

  return parts.join('\n\n');
}

/** Concatenate rules into one document, in the canonical order. */
export function renderConcatenated(
  rules: readonly RuleDocument[],
  options: SectionOptions = DEFAULT_SECTION_OPTIONS,
): string {
  const sections = sortRules(rules).map((rule) => renderRuleSection(rule, options));
  return sections.length === 0 ? '' : ensureSingleTrailingNewline(sections.join('\n\n'));
}

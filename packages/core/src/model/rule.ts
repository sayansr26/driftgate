import type { JsonValue, RuleId, SourceRef } from './ids.js';
import type { ToolSelector } from './selector.js';

export const DEFAULT_RULE_ORDER = 100;

/**
 * The five frontmatter keys of RFC-0001, and nothing else.
 *
 * `unknown` is not a convenience — it is the losslessness guarantee (T017) and the
 * forward-compatibility escape hatch. A strict parser that rejected unrecognized keys
 * would turn every future feature into a breaking change, and would silently destroy
 * whatever a user was experimenting with.
 */
export interface RuleFrontmatter {
  /** One line. Becomes a section heading, and Cursor's `description` field. */
  readonly description?: string;
  /** Path globs this rule is scoped to. Empty means it applies repo-wide. */
  readonly globs: readonly string[];
  /** Which adapters receive this rule. */
  readonly tools: ToolSelector;
  /** Lower renders first; ties broken by `id`, never by filesystem order. */
  readonly order: number;
  /** Every frontmatter key Rulegate does not understand, preserved verbatim. */
  readonly unknown: Readonly<Record<string, JsonValue>>;
}

export interface RuleDocument {
  /** Path under `.rulegate/rules` minus `.md`, POSIX, NFC-normalized. */
  readonly id: RuleId;
  /** Repo-relative POSIX path of the file this came from. */
  readonly path: string;
  /** Markdown body: EOL-normalized, BOM-stripped, frontmatter removed. */
  readonly body: string;
  readonly frontmatter: RuleFrontmatter;
  readonly source: SourceRef;
}

export function appliesRepoWide(rule: RuleDocument): boolean {
  return rule.frontmatter.globs.length === 0;
}

/** The heading a rule renders under: its description, falling back to its id. */
export function ruleHeading(rule: RuleDocument): string {
  return rule.frontmatter.description ?? rule.id;
}

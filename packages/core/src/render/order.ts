import type { RuleDocument } from '../model/rule.js';
import type { Artifact } from '../adapter/artifact.js';

/**
 * Ordering primitives. Never `localeCompare`: its result depends on the host locale
 * and ICU version, so the same model would render differently on two machines.
 * Codepoint order is not linguistically ideal, but it is identical everywhere, which
 * is the property that actually matters here.
 */
export function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rules sort by explicit `order`, then by `id`. The id tiebreak is what makes the
 * ordering *total*: without it, two rules sharing an order would fall back to
 * filesystem order, and the same repository would render different bytes on different
 * machines.
 */
export function sortRules(rules: readonly RuleDocument[]): readonly RuleDocument[] {
  return [...rules].sort(
    (a, b) => a.frontmatter.order - b.frontmatter.order || compareCodepoint(a.id, b.id),
  );
}

export function sortArtifacts(artifacts: readonly Artifact[]): readonly Artifact[] {
  return [...artifacts].sort((a, b) => compareCodepoint(a.path, b.path));
}

/** Sorted key/value pairs. Used wherever a map would otherwise leak insertion order. */
export function sortedEntries<T>(record: Readonly<Record<string, T>>): [string, T][] {
  return Object.keys(record)
    .sort(compareCodepoint)
    .map((key) => [key, record[key]!]);
}

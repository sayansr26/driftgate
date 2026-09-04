import { compareCodepoint } from '../render/order.js';
import { ALL_TOOLS, type ToolSelector } from '../model/selector.js';
import type { ToolId } from '../model/ids.js';
import type { RuleDocument } from '../model/rule.js';
import type { McpServer } from '../model/mcp.js';
import { claimRuleId } from './rule.js';

/** What one adapter's `read()` returned, tagged with the adapter it came from. */
export interface ImportSource {
  readonly tool: ToolId;
  readonly rules: readonly RuleDocument[];
  readonly mcpServers: readonly McpServer[];
  /**
   * Whether this tool has a project-level MCP file at all, read off its own `docs`.
   *
   * `dedupeMcpServers` divides by the tools that could have answered, and a tool with no
   * MCP format was never asked. Counting Gemini as a tool that declined would narrow every
   * imported server away from `all` for a reason that is about Rulegate's roster rather
   * than about the user's configuration — the same trap `dedupeImported` avoids by taking
   * `allTools` from the sources it was handed.
   */
  readonly carriesMcp: boolean;
  /** Messages the MCP importer produced — converted credentials, refused servers. */
  readonly mcpWarnings: readonly string[];
}

export interface ConflictVariant {
  readonly tools: readonly ToolId[];
  readonly rule: RuleDocument;
}

/**
 * Two imported rules that look like the same rule and are not.
 *
 * Never resolved here. Both variants are kept as separate canonical rules and the
 * conflict is reported alongside them, so the caller can put the choice in front of the
 * person who wrote them. Merging on a similarity score would mean deleting one of two
 * things a user wrote, on the strength of a heuristic — the failure PRD §11 rates
 * trust-fatal, arrived at by being clever rather than by being careless.
 */
export interface ImportConflict {
  readonly reason: 'same-heading' | 'similar-content';
  /** 0–1, rounded to two places. 1 is unreachable: identical content is not a conflict. */
  readonly similarity: number;
  readonly variants: readonly ConflictVariant[];
}

export interface DedupeResult {
  readonly rules: readonly RuleDocument[];
  readonly conflicts: readonly ImportConflict[];
}

/**
 * How alike two rule bodies must be before "these are probably the same rule, edited"
 * beats "these are two different rules".
 *
 * Chosen high on purpose. A false positive costs the user a question they have to read
 * and answer about two rules that were never related; a false negative costs them two
 * similar rules in `.rulegate/` that they can merge in ten seconds. Only one of those
 * errors erodes trust in the output, so the threshold leans away from it.
 */
const SIMILARITY_THRESHOLD = 0.7;

/** Rules are spaced so a person can insert one between two imported ones without renumbering. */
const ORDER_STEP = 10;

const FIELD_SEPARATOR = '\u0000';
const RECORD_SEPARATOR = '\u0001';

interface Group {
  readonly key: string;
  readonly tools: Set<ToolId>;
  readonly variants: RuleDocument[];
}

/**
 * Collapse the same rule arriving from several tools into one canonical rule.
 *
 * With all five adapters enabled this is not an optimization: `CLAUDE.md`, `AGENTS.md`
 * and `GEMINI.md` are byte-identical in a synced repository (measured on this one at
 * T078), so a first-run import without this step writes the user's rule set out three or
 * four times over.
 *
 * The exact pass does the collapsing and the fuzzy pass does not collapse anything — it
 * only reports. That split is the whole design: identical content is a fact, and
 * similar content is an opinion.
 */
export function dedupeImported(sources: readonly ImportSource[]): DedupeResult {
  const allTools = sources.map((s) => s.tool);
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();

  // First-appearance order across the sources, which is the reading order of the
  // documents they came from. It is the only ordering information import recovers —
  // `order` numbers do not survive rendering — so it is preserved here rather than
  // resorted, and turned into real `order` values below.
  for (const source of sources) {
    for (const rule of source.rules) {
      const key = contentKey(rule);
      const existing = byKey.get(key);
      if (existing === undefined) {
        const group: Group = { key, tools: new Set([source.tool]), variants: [rule] };
        byKey.set(key, group);
        groups.push(group);
      } else {
        existing.tools.add(source.tool);
        existing.variants.push(rule);
      }
    }
  }

  const taken = new Set<string>();
  const rules = groups.map((group, index) => {
    const representative = pickRepresentative(group.variants);
    return {
      ...representative,
      id: claimRuleId(representative.id, taken),
      frontmatter: {
        ...representative.frontmatter,
        order: (index + 1) * ORDER_STEP,
        tools: selectorFor(group.tools, allTools),
      },
    };
  });

  return { rules, conflicts: findConflicts(groups, allTools) };
}

/**
 * What makes two imported rules "the same rule".
 *
 * Description, globs and body — every field import can actually recover. Not `id`: the
 * same rule reaches Cursor as `10-style.mdc` and Claude Code as a `## Style` heading, so
 * keying on the id would collapse nothing at all, which is the bug this function is one
 * line away from having.
 */
function contentKey(rule: RuleDocument): string {
  // Joined on separators that cannot occur in Markdown, not on the empty string: with no
  // separator, a rule described `ab` with body `c` and one described `a` with body `bc`
  // produce the same key and get merged into one.
  return [
    rule.frontmatter.description ?? '',
    [...rule.frontmatter.globs].sort(compareCodepoint).join(FIELD_SEPARATOR),
    rule.body.replace(/\n+$/, ''),
  ].join(RECORD_SEPARATOR);
}

/**
 * Which of several identical variants supplies the id and source.
 *
 * The variants have equal content by construction, so this decides only cosmetics — but
 * it must not decide them by array position, or the same repository yields different
 * filenames depending on the order adapters happen to be registered in.
 */
function pickRepresentative(variants: readonly RuleDocument[]): RuleDocument {
  return [...variants].sort(
    (a, b) => compareCodepoint(a.source.file, b.source.file) || compareCodepoint(a.id, b.id),
  )[0] as RuleDocument;
}

/**
 * The selector this rule's presence actually justifies.
 *
 * A rule found in every tool that was read is `all` — not an explicit list of those five,
 * which would silently exclude the sixth adapter a user enables tomorrow. A rule found in
 * some of them is an include list, because that is the observation: it reached those
 * tools and not the others, and widening it to `all` would push a Cursor-only rule into
 * everyone's context on the next sync.
 */
function selectorFor(tools: ReadonlySet<ToolId>, allTools: readonly ToolId[]): ToolSelector {
  if (allTools.every((tool) => tools.has(tool))) return ALL_TOOLS;
  return { kind: 'include', tools: [...tools].sort(compareCodepoint) };
}

function findConflicts(
  groups: readonly Group[],
  allTools: readonly ToolId[],
): readonly ImportConflict[] {
  const conflicts: ImportConflict[] = [];

  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const a = groups[i] as Group;
      const b = groups[j] as Group;

      const headingA = (a.variants[0] as RuleDocument).frontmatter.description?.trim() ?? '';
      const headingB = (b.variants[0] as RuleDocument).frontmatter.description?.trim() ?? '';
      const sameHeading = headingA !== '' && headingA === headingB;

      const similarity = jaccard(a.variants[0] as RuleDocument, b.variants[0] as RuleDocument);
      if (!sameHeading && similarity < SIMILARITY_THRESHOLD) continue;

      conflicts.push({
        reason: sameHeading ? 'same-heading' : 'similar-content',
        similarity: Math.round(similarity * 100) / 100,
        variants: [a, b].map((group) => ({
          tools: selectorTools(group.tools, allTools),
          rule: group.variants[0] as RuleDocument,
        })),
      });
    }
  }

  return conflicts;
}

function selectorTools(tools: ReadonlySet<ToolId>, allTools: readonly ToolId[]): readonly ToolId[] {
  return allTools.filter((tool) => tools.has(tool));
}

/**
 * Similarity as the overlap of the distinct non-blank lines two rules contain.
 *
 * Lines rather than characters or tokens because instruction files are lists of
 * statements, and the edit that matters — someone changed one bullet in a copy of a rule
 * — moves a line-set score sharply and a character-diff score barely at all. Set-based,
 * so a reordered rule still scores as the same rule.
 */
function jaccard(a: RuleDocument, b: RuleDocument): number {
  const left = lineSet(a);
  const right = lineSet(b);
  if (left.size === 0 && right.size === 0) return 1;

  let shared = 0;
  for (const line of left) if (right.has(line)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function lineSet(rule: RuleDocument): Set<string> {
  const text = `${rule.frontmatter.description ?? ''}\n${rule.body}`;
  return new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
}

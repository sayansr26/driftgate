import { slugForId, type JsonValue, type SourceRef } from '../model/ids.js';
import { DEFAULT_RULE_ORDER, type RuleDocument } from '../model/rule.js';
import { ALL_TOOLS } from '../model/selector.js';

export interface ImportedRuleInit {
  readonly id: string;
  readonly description?: string;
  readonly globs?: readonly string[];
  readonly body: string;
  /** Frontmatter keys the native format carried that canonical has no home for. */
  readonly unknown?: Readonly<Record<string, JsonValue>>;
  readonly source: SourceRef;
}

/**
 * Build a canonical rule from imported content.
 *
 * Two fields are deliberately defaulted rather than inferred, because a single native
 * file cannot know them and a guess here is a wrong answer that survives into every
 * later `sync`:
 *
 *   - `order` — rendering encodes the *sequence*, never the numbers. Every imported rule
 *     gets `DEFAULT_RULE_ORDER`; the file order is preserved by array position and
 *     re-derived when canonical is serialized.
 *   - `tools` — a rule found in `CLAUDE.md` proves it reaches Claude Code and says
 *     nothing about the other four. Narrowing the selector needs a cross-adapter view,
 *     which is T018's job, not an adapter's.
 *
 * `path` is empty on purpose. `serializeCanonical` writes a rule to `rule.path` when it
 * has one, so carrying the *native* path here (`CLAUDE.md`) would make `init` write the
 * canonical rule straight back over the file it was imported from. The origin lives in
 * `source`, which is where the error formatter looks for it anyway.
 */
export function importedRule(init: ImportedRuleInit): RuleDocument {
  return {
    id: init.id,
    path: '',
    body: init.body,
    frontmatter: {
      ...(init.description === undefined ? {} : { description: init.description }),
      globs: init.globs ?? [],
      tools: ALL_TOOLS,
      order: DEFAULT_RULE_ORDER,
      unknown: init.unknown ?? {},
    },
    source: init.source,
  };
}

/**
 * A rule id from arbitrary heading or filename text.
 *
 * `slugForId` collapses everything outside `[a-z0-9]`, so a heading that is entirely
 * CJK or emoji slugs to the empty string — a real case, not a hypothetical, since
 * instruction files are written in every language. The fallback keeps ids meaningful
 * instead of producing a file called `.md`.
 */
export function importRuleId(text: string, fallback: string): string {
  const slug = slugForId(text.normalize('NFC'));
  return slug === '' ? fallback : slug;
}

/**
 * Claim `desired`, suffixing it until it is free, and record the claim.
 *
 * Ids become filenames, so a collision is a lost rule. Suffixing is deterministic and
 * depends only on the order rules are offered, which is itself derived from
 * codepoint-sorted paths — never from a directory listing.
 */
export function claimRuleId(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) {
    taken.add(desired);
    return desired;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${desired}-${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

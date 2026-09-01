import { DriftgateError, appliesRepoWide, type RuleDocument } from '@driftgate/core';

/**
 * Cursor's `.mdc` frontmatter is *not* strict YAML as an emitter would produce it, and
 * this is the trap T007 exists to expose.
 *
 *   - `globs` is a bare, comma-joined string — `globs: a,b` — not a YAML sequence and
 *     not quoted. A YAML emitter would write a block sequence or quote the value, which
 *     looks plausible and behaves differently.
 *   - An empty `globs` is written as a bare key with nothing after it, not `globs: []`.
 *   - `alwaysApply` is *derived* from the canonical model (true exactly when the rule
 *     is repo-wide) rather than stored, so it never appears in canonical frontmatter.
 *
 * Hence: hand-rendered, and hand-rendered *here* rather than in core, because the
 * dialect is tool-specific and core must stay free of tool knowledge.
 */
export interface MdcFrontmatter {
  readonly description?: string;
  readonly globs: readonly string[];
  readonly alwaysApply: boolean;
}

export function frontmatterFor(rule: RuleDocument): MdcFrontmatter {
  const description = rule.frontmatter.description;
  return {
    ...(description === undefined ? {} : { description }),
    globs: rule.frontmatter.globs,
    alwaysApply: appliesRepoWide(rule),
  };
}

export function renderMdcFrontmatter(fm: MdcFrontmatter): string {
  const lines = ['---'];
  if (fm.description !== undefined) lines.push(`description: ${fm.description}`);
  lines.push(fm.globs.length === 0 ? 'globs:' : `globs: ${fm.globs.join(',')}`);
  lines.push(`alwaysApply: ${String(fm.alwaysApply)}`);
  lines.push('---');
  return lines.join('\n');
}

/**
 * The dialect has no escaping: a value runs to the end of the line. A description
 * containing a newline would silently corrupt the frontmatter and swallow the keys
 * after it, so it is rejected rather than mangled.
 */
export function assertRenderable(rule: RuleDocument): void {
  const description = rule.frontmatter.description;
  if (description !== undefined && /[\r\n]/.test(description)) {
    throw new DriftgateError({
      code: 'E_FRONTMATTER_INVALID',
      message: `rule \`${rule.id}\` has a multi-line description, which Cursor's .mdc frontmatter cannot represent`,
      source: rule.source,
      hint: 'use a single-line description; put the detail in the rule body',
    });
  }
  for (const glob of rule.frontmatter.globs) {
    if (glob.includes(',')) {
      throw new DriftgateError({
        code: 'E_FRONTMATTER_INVALID',
        message: `glob \`${glob}\` in rule \`${rule.id}\` contains a comma, which separates globs in Cursor's .mdc format`,
        source: rule.source,
        hint: 'split it into two glob entries',
      });
    }
  }
}

/** `frontend/react` -> `frontend-react`. Cursor rules live in one flat directory. */
export function slugFor(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

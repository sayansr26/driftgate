import { DriftgateError, type RuleDocument } from '@driftgate/adapter-kit';

/**
 * The frontmatter of a `.instructions.md` file.
 *
 * Unlike Cursor's `.mdc`, this one *is* real YAML — but only one key carries semantics,
 * and it is not a sequence. `applyTo` is a single quoted glob string, and several patterns
 * are comma-separated *inside* that one string (`'**\/*.ts,**\/*.tsx'`). Emitting a YAML
 * list here is the plausible-looking mistake: it parses, and Copilot then matches nothing.
 *
 * Source: https://code.visualstudio.com/docs/copilot/customization/custom-instructions and
 * https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions
 * (both retrieved 2026-09-02).
 */
export interface InstructionsFrontmatter {
  readonly description?: string;
  readonly applyTo: readonly string[];
}

export function frontmatterFor(rule: RuleDocument): InstructionsFrontmatter {
  const description = rule.frontmatter.description;
  return {
    ...(description === undefined ? {} : { description: foldDescription(description) }),
    applyTo: rule.frontmatter.globs,
  };
}

/**
 * YAML single-quoted scalars escape one character and only one: a quote is doubled.
 * Everything else — including the backslashes and braces that turn up in globs — is
 * literal, which is precisely why single quotes are the right style here.
 */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderInstructionsFrontmatter(fm: InstructionsFrontmatter): string {
  const lines = ['---'];
  if (fm.description !== undefined) lines.push(`description: ${quote(fm.description)}`);
  lines.push(`applyTo: ${quote(fm.applyTo.join(','))}`);
  lines.push('---');
  return lines.join('\n');
}

/**
 * The comma is a separator inside `applyTo`, so a glob containing one would silently
 * become two wrong globs. Rejected rather than mangled — the same call Cursor's `.mdc`
 * renderer makes, for the same reason.
 *
 * A multi-line description is not rejected here the way Cursor rejects it: a YAML
 * single-quoted scalar can legally span lines. It is folded to spaces instead, because
 * the alternative is a frontmatter block whose indentation depends on the user's prose.
 */
export function assertRenderable(rule: RuleDocument): void {
  for (const glob of rule.frontmatter.globs) {
    if (glob.includes(',')) {
      throw new DriftgateError({
        code: 'E_FRONTMATTER_INVALID',
        message: `glob \`${glob}\` in rule \`${rule.id}\` contains a comma, which separates patterns in Copilot's applyTo field`,
        source: rule.source,
        hint: 'split it into two glob entries',
      });
    }
  }
}

function foldDescription(description: string): string {
  return description.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

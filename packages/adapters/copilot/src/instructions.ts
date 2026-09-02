import {
  DriftgateError,
  stripMarker,
  type JsonValue,
  type RuleDocument,
} from '@driftgate/adapter-kit';

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

export interface ParsedInstructions {
  readonly description?: string;
  readonly applyTo: readonly string[];
  /** Keys the frontmatter carried that canonical has no field for, preserved verbatim. */
  readonly unknown: Readonly<Record<string, JsonValue>>;
  readonly body: string;
}

const KEY_LINE = /^([^:\s][^:]*):[ \t]?(.*)$/;

/**
 * `.instructions.md` -> its parts. The mirror image of the `.mdc` trap: this frontmatter
 * *is* real YAML, and the mistake is trusting that fact one step too far. `applyTo` is a
 * single scalar holding comma-separated patterns, so a YAML reader hands back one string
 * that matches nothing rather than the list it looks like.
 *
 * Parsed line-wise rather than with the `yaml` package because an adapter's dependency
 * footprint is part of its contract, and the two keys that carry meaning here need
 * exactly one YAML rule between them: a single-quoted scalar escapes a quote by doubling
 * it, and nothing else.
 */
export function parseInstructions(contents: string): ParsedInstructions {
  const lines = contents.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    return { applyTo: [], unknown: {}, body: joinBody(lines) };
  }

  const close = lines.findIndex((line, i) => i > 0 && ['---', '...'].includes(line.trim()));
  if (close === -1) return { applyTo: [], unknown: {}, body: joinBody(lines) };

  let description: string | undefined;
  let applyTo: readonly string[] = [];
  const unknown: Record<string, JsonValue> = {};

  for (const line of lines.slice(1, close)) {
    const match = KEY_LINE.exec(line);
    if (match === null) continue;
    const key = (match[1] ?? '').trim();
    const value = unquote((match[2] ?? '').trim());

    if (key === 'description') {
      if (value !== '') description = value;
    } else if (key === 'applyTo') {
      applyTo = value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
    } else if (key !== '') {
      unknown[key] = value;
    }
  }

  return {
    ...(description === undefined ? {} : { description }),
    applyTo,
    unknown,
    body: joinBody(lines.slice(close + 1)),
  };
}

/** The inverse of `quote`, plus tolerance for a hand-written double-quoted or bare value. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

function joinBody(lines: readonly string[]): string {
  const body = stripMarker(lines.join('\n')).replace(/^\n+/, '').replace(/\n+$/, '');
  return body === '' ? '' : `${body}\n`;
}

import { DriftgateError, stripMarker } from '@driftgate/adapter-kit';

/**
 * Windsurf's workspace-rule frontmatter, hand-rendered.
 *
 * The third dialect in this repository and the third trap. Cursor's `.mdc` looks like YAML
 * and is not; Copilot's `.instructions.md` is YAML and the mistake is treating it like YAML.
 * This one is a plain YAML block with a *derived* discriminator: `trigger` is not something
 * a canonical rule carries, it is computed from whether the rule has globs.
 *
 * Source: https://docs.devin.ai/desktop/cascade/memories (read 2026-09-04; the documented
 * `docs.windsurf.com` URL 307-redirects there).
 */

/** The four documented activation modes. Driftgate emits two of them. */
export type Trigger = 'always_on' | 'model_decision' | 'glob' | 'manual';

export interface FrontmatterInit {
  readonly globs: readonly string[];
  readonly description?: string;
}

function invalid(what: string, hint: string): DriftgateError {
  return new DriftgateError({ code: 'E_FRONTMATTER_INVALID', message: what, hint });
}

/**
 * A bare, unquoted `globs:` value, exactly as the vendor's one example writes it.
 *
 * **Multiple patterns are undocumented.** The vendor page shows a single bare pattern and
 * says nothing about separators. Comma joining is what Cursor's `.mdc` uses and what the
 * community guides assume, so it is what Driftgate emits — recorded as an unverified claim
 * in `docs.notes` rather than presented as a documented fact. A comma *inside* a glob is
 * refused for the same reason Cursor refuses it: it would silently split into two wrong
 * patterns, and a wrong answer is worse than a missing one.
 */
function renderGlobs(globs: readonly string[]): string {
  for (const glob of globs) {
    if (glob.includes(',')) {
      throw invalid(
        `glob \`${glob}\` contains a comma, which windsurf cannot express`,
        'windsurf separates patterns with commas and has no escape for one inside a pattern; split the rule in two',
      );
    }
  }
  return globs.join(',');
}

/**
 * A single-line description.
 *
 * Folded rather than mangled, the same treatment Copilot's gets: the block is plain YAML,
 * so a multi-line value would need a block scalar, and the key is one line in every
 * documented example.
 */
function renderDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim();
}

/**
 * The frontmatter block, including its delimiters and trailing blank line.
 *
 * `trigger` is **derived**, not authored — `glob` exactly when the rule is scoped, and
 * `always_on` otherwise. Canonical has no `trigger` field and should not gain one: it is
 * Windsurf's word for a distinction canonical already makes with `globs`. This is the same
 * shape as Cursor's derived `alwaysApply`.
 *
 * `model_decision` and `manual` are never emitted. Both mean "the model may skip this
 * rule", and a rule somebody wrote in `.driftgate/rules/` is a rule they want applied;
 * choosing them for the user would quietly downgrade every rule Driftgate generates.
 */
export function renderFrontmatter(init: FrontmatterInit): string {
  const lines: string[] = ['---'];
  const scoped = init.globs.length > 0;
  lines.push(`trigger: ${scoped ? 'glob' : 'always_on'}`);
  if (scoped) lines.push(`globs: ${renderGlobs(init.globs)}`);
  if (init.description !== undefined && init.description !== '') {
    lines.push(`description: ${renderDescription(init.description)}`);
  }
  // Two newlines after the closing delimiter: the block ends, then a blank line, then
  // the body. Windsurf only requires the block to start at byte zero; the blank line is
  // ordinary Markdown and keeps the generated file readable.
  lines.push('---', '', '');
  return lines.join('\n');
}

export interface ParsedRule {
  readonly globs: readonly string[];
  readonly description?: string;
  readonly body: string;
}

/**
 * Read a workspace rule file back.
 *
 * `trigger` is dropped: it is derived on the way out, so recovering it would put a value in
 * canonical that the next render would compute anyway — and a round trip that adds a field
 * nobody wrote is how `sync` starts reporting drift against text Driftgate invented (the
 * T019 lesson about `description ?? id`).
 */
export function parseRule(contents: string): ParsedRule {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(contents);
  if (match === null) return { globs: [], body: stripMarker(contents).trim() };

  // The generated-file marker sits below the frontmatter (it cannot sit above it — the
  // block must occupy the first bytes), so it has to come off here rather than being
  // handled by a shared concatenated importer. Leaving it in makes `write()` -> `read()`
  // grow a line of Driftgate's own text on every round trip.
  const body = stripMarker(contents.slice(match[0].length).replace(/^\s*\n/, ''));
  const globs: string[] = [];
  let description: string | undefined;

  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (pair === null) continue;
    const [, key, raw] = pair;
    const value = raw!.trim().replace(/^["']|["']$/g, '');
    if (key === 'globs' && value !== '') {
      globs.push(...value.split(',').map((g) => g.trim()).filter((g) => g !== ''));
    } else if (key === 'description' && value !== '') {
      description = value;
    }
  }

  return {
    globs,
    ...(description === undefined ? {} : { description }),
    body: body.trim(),
  };
}

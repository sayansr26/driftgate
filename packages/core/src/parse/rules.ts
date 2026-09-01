import { isMap, isScalar, isSeq, type Node } from 'yaml';
import type { DriftgateError } from '../model/errors.js';
import { DEFAULT_RULE_ORDER, type RuleDocument, type RuleFrontmatter } from '../model/rule.js';
import { ALL_TOOLS, type ToolSelector } from '../model/selector.js';
import { deriveRuleId } from '../model/paths.js';
import { splitFrontmatter } from './frontmatter.js';
import { parseYaml } from './yaml.js';
import { Validator } from './validate.js';
import type { JsonValue } from '../model/ids.js';

const KNOWN_KEYS = new Set(['description', 'globs', 'tools', 'order']);

export interface ParsedRule {
  readonly rule?: RuleDocument;
  readonly errors: readonly DriftgateError[];
}

export function parseRuleFile(relPath: string, raw: string): ParsedRule {
  const split = splitFrontmatter(raw, relPath);
  if (!split.ok) return { errors: [split.error] };

  const { yaml, yamlLineOffset, body } = split.value;
  const id = deriveRuleId(relPath);

  if (yaml === undefined || yaml.trim() === '') {
    // A file with no frontmatter is valid, and is what makes a bare AGENTS.md a
    // legitimate canonical source (US7).
    return { rule: makeRule(id, relPath, body, defaultFrontmatter()), errors: [] };
  }

  const parsed = parseYaml(yaml, relPath, yamlLineOffset);
  if (!parsed.ok) return { errors: [parsed.error] };

  const v = new Validator(relPath, parsed.value, 'E_FRONTMATTER_INVALID');
  const root = parsed.value.doc.contents as Node | null;
  const map = root === null ? undefined : v.asMap(root, 'frontmatter');

  const description = v.string(v.get(map, 'description'), 'description');
  const globs = v.stringArray(v.get(map, 'globs'), 'globs');
  const order = v.integer(v.get(map, 'order'), 'order', DEFAULT_RULE_ORDER);
  const tools = parseToolSelector(v, v.get(map, 'tools'));

  const unknown: Record<string, JsonValue> = {};
  for (const key of v.keys(map)) {
    if (KNOWN_KEYS.has(key)) continue;
    unknown[key] = v.plain(v.get(map, key));
  }

  const frontmatter: RuleFrontmatter = {
    ...(description === undefined ? {} : { description }),
    globs,
    tools,
    order,
    unknown,
  };

  return { rule: makeRule(id, relPath, body, frontmatter), errors: v.errors };
}

function makeRule(
  id: string,
  path: string,
  body: string,
  frontmatter: RuleFrontmatter,
): RuleDocument {
  return { id, path, body, frontmatter, source: { file: path } };
}

export function defaultFrontmatter(): RuleFrontmatter {
  return { globs: [], tools: ALL_TOOLS, order: DEFAULT_RULE_ORDER, unknown: {} };
}

/**
 * Three accepted forms, per RFC-0001 §7: omitted (all), a list (include), or
 * `{ exclude: [...] }`. Anything else is an error rather than a guess — silently
 * misreading a tool selector would send a rule to the wrong tools, which is worse
 * than refusing to proceed.
 */
function parseToolSelector(v: Validator, node: Node | undefined): ToolSelector {
  if (node === undefined) return ALL_TOOLS;

  if (isSeq(node) || (isScalar(node) && typeof node.value === 'string')) {
    const tools = v.stringArray(node, 'tools');
    return tools.length === 0 ? ALL_TOOLS : { kind: 'include', tools };
  }

  if (isMap(node)) {
    const exclude = v.get(node, 'exclude');
    if (exclude === undefined) {
      v.fail(
        node,
        'tools',
        '`tools` mapping must have an `exclude` key',
        "use `tools: { exclude: ['cursor'] }` or a plain list to include",
      );
      return ALL_TOOLS;
    }
    const tools = v.stringArray(exclude, 'tools.exclude');
    return tools.length === 0 ? ALL_TOOLS : { kind: 'exclude', tools };
  }

  v.fail(node, 'tools', '`tools` must be a list of tool ids or `{ exclude: [...] }`');
  return ALL_TOOLS;
}

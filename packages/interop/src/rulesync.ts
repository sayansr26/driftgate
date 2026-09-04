import {
  claimRuleId,
  importRuleId,
  importedRule,
  type AdapterContext,
  type JsonValue,
  type RuleDocument,
  type ToolSelector,
} from '@rulegate/adapter-kit';
import type { InteropImporter, InteropResult } from './types.js';

const RULESYNC_DIR = '.rulesync';
const RULES_DIR = `${RULESYNC_DIR}/rules`;

/**
 * rulesync keeps one Markdown file per rule under `.rulesync/rules/`, with YAML
 * frontmatter — a shape close enough to Rulegate's that the import is nearly lossless.
 *
 * Verified against `dyoshikawa/rulesync` on 2026-09-04:
 * `src/constants/rulesync-paths.ts` (the directory layout and `rulesync.jsonc`) and
 * `src/features/rules/rulesync-rule.ts` (`RulesyncRuleFrontmatterSchema`: `root?`,
 * `localRoot?`, `targets` defaulting to `["*"]`, `description?`, `globs?`, plus a loose
 * per-tool object for each supported tool).
 */

/** rulesync target ids that name a tool Rulegate also has. Anything else is preserved. */
const TARGET_TO_TOOL: Readonly<Record<string, string>> = {
  claudecode: 'claude-code',
  cursor: 'cursor',
  copilot: 'copilot',
  codexcli: 'codex',
  geminicli: 'gemini',
  cline: 'cline',
  roo: 'roo-code',
  windsurf: 'windsurf',
  augmentcode: 'augmentcode',
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Files rulesync is known to generate, hidden from the adapter pass when it wrote them. */
const KNOWN_OUTPUTS = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
  '.clinerules',
  '.windsurfrules',
];

async function detect(ctx: AdapterContext): Promise<boolean> {
  return (await ctx.fs.exists(RULESYNC_DIR)) || (await ctx.fs.exists('rulesync.jsonc'));
}

/**
 * A deliberately small YAML reader for the handful of keys rulesync's frontmatter uses.
 *
 * The kit exposes no YAML parser and this package may not reach past it, exactly as an
 * adapter may not. The keys are `description` (a scalar), `globs` and `targets` (inline or
 * block sequences of scalars) — the same subset the `.mdc` and `.instructions.md` readers
 * handle, and for the same reason: a dependency here would be a supply-chain surface in a
 * tool whose pitch is a thin dependency tree.
 */
export function parseFrontmatter(block: string): {
  description?: string;
  globs: string[];
  targets: string[];
  unknown: Record<string, JsonValue>;
} {
  const globs: string[] = [];
  const targets: string[] = [];
  const unknown: Record<string, JsonValue> = {};
  let description: string | undefined;
  let list: string[] | undefined;

  const scalar = (raw: string): string => raw.trim().replace(/^["']|["']$/g, '');

  for (const line of block.split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item !== null && list !== undefined) {
      list.push(scalar(item[1]!));
      continue;
    }

    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (pair === null) continue;
    list = undefined;
    const [, key, rest] = pair;
    const value = (rest ?? '').trim();

    const inline = (): string[] | undefined => {
      if (!value.startsWith('[')) return undefined;
      return value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(scalar)
        .filter((v) => v !== '');
    };

    if (key === 'globs' || key === 'targets') {
      const target = key === 'globs' ? globs : targets;
      const items = inline();
      if (items !== undefined) target.push(...items);
      else if (value === '') list = target;
      else target.push(scalar(value));
      continue;
    }
    if (key === 'description') {
      if (value !== '') description = scalar(value);
      continue;
    }
    // Everything else — `root`, `localRoot`, and the per-tool objects — is preserved rather
    // than interpreted. A key this reader does not understand is not a key the user should
    // lose.
    if (value !== '') unknown[key!] = scalar(value);
  }

  return { ...(description === undefined ? {} : { description }), globs, targets, unknown };
}

/** `targets: ["*"]` is rulesync's default and means every tool — canonical's `all`. */
function selectorFor(targets: readonly string[]): ToolSelector | undefined {
  if (targets.length === 0 || targets.includes('*')) return undefined;
  const tools = targets.map((t) => TARGET_TO_TOOL[t] ?? t).sort();
  return { kind: 'include', tools };
}

async function read(ctx: AdapterContext): Promise<InteropResult> {
  const rules: RuleDocument[] = [];
  const taken = new Set<string>();
  const generated: string[] = [];
  const notImported: string[] = [];

  for (const path of await ctx.fs.glob(`${RULES_DIR}/**/*.md`)) {
    const contents = await ctx.fs.tryReadFile(path);
    if (contents === undefined) continue;

    const match = FRONTMATTER.exec(contents);
    const meta =
      match === null
        ? { globs: [], targets: [], unknown: {} as Record<string, JsonValue> }
        : parseFrontmatter(match[1]!);
    const body = (match === null ? contents : contents.slice(match[0].length)).trim();
    if (body === '' && meta.description === undefined) continue;

    const base = path
      .slice(RULES_DIR.length + 1)
      .replace(/\.md$/i, '')
      .replace(/\//g, '-');
    const rule = importedRule({
      id: claimRuleId(importRuleId(base, 'rulesync'), taken),
      ...(meta.description === undefined ? {} : { description: meta.description }),
      globs: meta.globs,
      body,
      unknown: meta.unknown,
      source: { file: path, line: 1 },
    });

    // `targets` is the one field rulesync has that maps straight onto canonical `tools`,
    // so it survives rather than widening to `all` the way an adapter import has to.
    const tools = selectorFor(meta.targets);
    rules.push(
      tools === undefined ? rule : { ...rule, frontmatter: { ...rule.frontmatter, tools } },
    );
  }

  for (const path of [
    `${RULESYNC_DIR}/mcp.jsonc`,
    `${RULESYNC_DIR}/mcp.json`,
    `${RULESYNC_DIR}/commands`,
    `${RULESYNC_DIR}/subagents`,
    `${RULESYNC_DIR}/skills`,
    'rulesync.jsonc',
  ]) {
    if (await ctx.fs.exists(path)) notImported.push(path);
  }

  // rulesync writes no marker of its own, so the only honest signal that it generated a
  // file is that the repository is a rulesync repository and the file is one of its known
  // outputs. Narrower than ruler's `<!-- Source: -->` and stated as such in the docs page.
  for (const candidate of KNOWN_OUTPUTS) {
    if (await ctx.fs.exists(candidate)) generated.push(candidate);
  }

  return { rules, generated, notImported };
}

export const rulesync: InteropImporter = {
  name: 'rulesync',
  displayName: 'rulesync',
  detect,
  read,
};

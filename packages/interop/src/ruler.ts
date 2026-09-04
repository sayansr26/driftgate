import {
  claimRuleId,
  importRuleId,
  importedRule,
  type AdapterContext,
  type RuleDocument,
} from '@driftgate/adapter-kit';
import type { InteropImporter, InteropResult } from './types.js';

const RULER_DIR = '.ruler';

/**
 * Ruler keeps its sources in `.ruler/` and concatenates them into each tool's file.
 *
 * Two directories are excluded from that concatenation by ruler itself and are therefore
 * not rules: `skills/` always, and `agents/` unless the config opts in. Importing them as
 * rules would turn a user's subagent definitions into instructions.
 *
 * Verified against `intellectronica/ruler` on 2026-09-04: `src/constants.ts`
 * (`DEFAULT_RULES_FILENAME = 'AGENTS.md'`), `src/core/RuleProcessor.ts` (the section
 * format below), `src/core/FileSystemUtils.ts` (ordering and the two exclusions).
 */
const EXCLUDED = new Set(['skills', 'agents']);

/**
 * Ruler's own section marker.
 *
 * `concatenateRules` emits two blank lines, `<!-- Source: <path> -->`, a blank line, then
 * the trimmed content. **That is better provenance than Driftgate's own format gives us**:
 * a heading is ambiguous, but this names the source file outright, so a generated
 * `AGENTS.md` can be split back into exactly the rules that produced it.
 */
const SOURCE_MARKER = /^<!--\s*Source:\s*(.+?)\s*-->$/;

/** Files ruler is known to generate, so they can be hidden from the adapter pass. */
const KNOWN_OUTPUTS = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  'CONVENTIONS.md',
];

async function detect(ctx: AdapterContext): Promise<boolean> {
  return ctx.fs.exists(RULER_DIR);
}

/**
 * Split one ruler-generated file into the sections it was built from.
 *
 * Returns `undefined` when the file carries no `<!-- Source: -->` marker, which means ruler
 * did not write it — and a file ruler did not write must not be masked from the adapters,
 * or a hand-written `CLAUDE.md` would vanish from the import.
 */
export function splitRulerOutput(
  contents: string,
): readonly { file: string; body: string }[] | undefined {
  const lines = contents.split('\n');
  const sections: { file: string; body: string[] }[] = [];

  for (const line of lines) {
    const match = SOURCE_MARKER.exec(line.trim());
    if (match !== null) {
      sections.push({ file: match[1]!, body: [] });
      continue;
    }
    sections[sections.length - 1]?.body.push(line);
  }

  if (sections.length === 0) return undefined;
  return sections.map((s) => ({ file: s.file, body: s.body.join('\n').trim() }));
}

async function read(ctx: AdapterContext): Promise<InteropResult> {
  const rules: RuleDocument[] = [];
  const taken = new Set<string>();
  const generated: string[] = [];
  const notImported: string[] = [];

  // The sources, not the outputs. `.ruler/*.md` is the thing a ruler user actually edits,
  // so it is what canonical should hold — importing the generated files instead would
  // preserve the content and lose the structure.
  for (const path of await ctx.fs.glob(`${RULER_DIR}/**/*.md`)) {
    const rel = path.slice(RULER_DIR.length + 1);
    const top = rel.split('/')[0] ?? '';
    if (EXCLUDED.has(top)) {
      notImported.push(path);
      continue;
    }

    const contents = await ctx.fs.tryReadFile(path);
    if (contents === undefined || contents.trim() === '') continue;

    const base = rel.replace(/\.md$/i, '').replace(/\//g, '-');
    rules.push(
      importedRule({
        id: claimRuleId(importRuleId(base, 'ruler'), taken),
        body: contents.trim(),
        source: { file: path, line: 1 },
      }),
    );
  }

  // Ruler's TOML config carries MCP and other settings this importer does not read. Named
  // rather than ignored — a user whose servers did not come across needs to be told now,
  // not when one stops working.
  for (const config of ['.ruler/ruler.toml', 'ruler.toml']) {
    if (await ctx.fs.exists(config)) notImported.push(config);
  }
  if (await ctx.fs.exists(`${RULER_DIR}/skills`)) notImported.push(`${RULER_DIR}/skills`);

  // Only files that actually carry ruler's marker are treated as its output.
  for (const candidate of KNOWN_OUTPUTS) {
    const contents = await ctx.fs.tryReadFile(candidate);
    if (contents === undefined) continue;
    if (splitRulerOutput(contents) !== undefined) generated.push(candidate);
  }
  for (const path of await ctx.fs.glob('.cursor/rules/**/*.mdc')) {
    const contents = await ctx.fs.tryReadFile(path);
    if (contents !== undefined && splitRulerOutput(contents) !== undefined) generated.push(path);
  }

  return { rules, generated, notImported };
}

export const ruler: InteropImporter = {
  name: 'ruler',
  displayName: 'ruler',
  detect,
  read,
};

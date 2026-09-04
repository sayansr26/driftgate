import {
  ADAPTER_API_VERSION,
  basenamePosix,
  claimRuleId,
  detected,
  finalizeArtifact,
  importConcatenated,
  importRuleId,
  isCanonicalSource,
  renderRuleSection,
  selects,
  slugForId,
  sortRules,
  withHtmlMarker,
  type Adapter,
  type AdapterContext,
  type Artifact,
  type DetectResult,
  type ImportResult,
  type RuleDocument,
} from '@driftgate/adapter-kit';
import { MCP_FILE, importMcpConfig, renderMcpJson } from './mcp.js';
import { docs } from './docs.js';

export const RULES_DIR = '.roo/rules';
export const LEGACY_FILE = '.roorules';

const DETECTION_PATHS = ['.roo', LEGACY_FILE] as const;

async function detect(ctx: AdapterContext): Promise<DetectResult> {
  const evidence: string[] = [];
  for (const path of DETECTION_PATHS) {
    if (await ctx.fs.exists(path)) evidence.push(path);
  }
  return detected(evidence);
}

/**
 * The generated filename, and the only design decision in this adapter that is not
 * boilerplate.
 *
 * Roo Code concatenates `.roo/rules/` sorted **by basename only, case-insensitive** — its
 * own ordering, which knows nothing about canonical `order`. A file named `40-alpha-last.md`
 * would sort ahead of `10-style.md` under any scheme keyed on the rule id, silently
 * inverting the order its author asked for.
 *
 * So the name carries a zero-padded index taken from the rule's position in `sortRules`,
 * and the full canonical id follows it. The index makes Roo's sort agree with Driftgate's;
 * keeping the id after it means every output file still traces to exactly one canonical
 * rule, which is why T007 kept the `10-` prefix in `.mdc` filenames rather than stripping
 * it for looks.
 *
 * Indexed by *position* rather than by the `order` value: a raw order is stable across
 * insertions but breaks lexicographically on a negative or five-digit value, and its
 * tiebreak would be `slugForId(id)` where `sortRules`' is `id` — two orderings that can
 * disagree. The cost, accepted: reordering rules renames files.
 *
 * Source: https://roocodeinc.github.io/Roo-Code/features/custom-instructions (read
 * 2026-09-04).
 */
function ruleFilename(rule: RuleDocument, position: number): string {
  const index = String(position + 1).padStart(3, '0');
  return `${RULES_DIR}/${index}-${slugForId(rule.id)}.md`;
}

/**
 * `.roo/rules/**` and the legacy fallback.
 *
 * `.clinerules` is deliberately **not** read here even though Roo does read it: the cline
 * adapter manages that file, and importing a path two adapters both claim hands
 * `dedupeImported` the same rules twice with different provenance. It is declared in `docs`
 * instead.
 */
async function read(ctx: AdapterContext): Promise<ImportResult> {
  const rules: RuleDocument[] = [];
  const taken = new Set<string>();

  // Recursive, because Roo reads subdirectories too. `.md` and `.txt` only: Roo reads
  // every file regardless of extension, which is a documented loss on import rather than a
  // silent one — importing arbitrary binaries as rules would be worse.
  for (const extension of ['md', 'txt']) {
    for (const path of await ctx.fs.glob(`${RULES_DIR}/**/*.${extension}`)) {
      if (isCanonicalSource(ctx.canonical.manifest, path)) continue;
      const contents = await ctx.fs.tryReadFile(path);
      if (contents === undefined) continue;

      // Strip the generated index before deriving an id, or a round trip grows a `001-`
      // prefix on every rule and the next render adds another.
      const base = basenamePosix(path)
        .replace(/\.(md|txt)$/i, '')
        .replace(/^\d{3}-/, '');

      for (const rule of importConcatenated({
        file: path,
        contents,
        headingLevel: 2,
        idFallback: importRuleId(base, 'roo-code'),
      })) {
        rules.push({ ...rule, id: claimRuleId(importRuleId(base, 'roo-code'), taken) });
      }
    }
  }

  if (!isCanonicalSource(ctx.canonical.manifest, LEGACY_FILE)) {
    const legacy = await ctx.fs.tryReadFile(LEGACY_FILE);
    if (legacy !== undefined) {
      for (const rule of importConcatenated({
        file: LEGACY_FILE,
        contents: legacy,
        headingLevel: 2,
        idFallback: 'roorules',
      })) {
        rules.push({ ...rule, id: claimRuleId(rule.id, taken) });
      }
    }
  }

  const mcp = await readMcp(ctx);
  return { ...(rules.length === 0 ? {} : { rules }), ...mcp };
}

async function readMcp(ctx: AdapterContext): Promise<ImportResult> {
  if (isCanonicalSource(ctx.canonical.manifest, MCP_FILE)) return {};
  const contents = await ctx.fs.tryReadFile(MCP_FILE);
  if (contents === undefined) return {};
  const { servers, warnings } = importMcpConfig(contents);
  return {
    ...(servers.length === 0 ? {} : { mcpServers: servers }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/**
 * One `.roo/rules/<NNN>-<id>.md` per rule, plus `.roo/mcp.json`.
 *
 * Roo has no per-glob mechanism, so a scoped rule keeps the prose `**Applies to:**` line —
 * visibly lossy rather than silently repo-wide.
 */
function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;
  const marker = canonical.manifest.options.marker;
  const rules = sortRules(canonical.rules.filter((r) => selects(r.frontmatter.tools, 'roo-code')));

  const artifacts: Artifact[] = rules.map((rule, i) =>
    finalizeArtifact({
      path: ruleFilename(rule, i),
      contents: withHtmlMarker(
        renderRuleSection(rule, { headingLevel: 2, showGlobs: true }),
        marker,
      ),
      adapter: 'roo-code',
      kind: 'rules',
      provenance: { ruleIds: [rule.id] },
    }),
  );

  const mcp = renderMcpJson(canonical.mcpServers, marker);
  if (mcp !== '' && !isCanonicalSource(canonical.manifest, MCP_FILE)) {
    artifacts.push(
      finalizeArtifact({ path: MCP_FILE, contents: mcp, adapter: 'roo-code', kind: 'mcp' }),
    );
  }

  return Promise.resolve(artifacts);
}

export const rooCode: Adapter = {
  name: 'roo-code',
  apiVersion: ADAPTER_API_VERSION,
  detect,
  read,
  write,
  docs,
};

export default rooCode;
export { docs, MCP_FILE, renderMcpJson };

import {
  ADAPTER_API_VERSION,
  detected,
  importConcatenated,
  finalizeArtifact,
  isCanonicalSource,
  renderConcatenated,
  selects,
  sortRules,
  withHtmlMarker,
  type Adapter,
  type AdapterContext,
  type Artifact,
  type Canonical,
  type DetectResult,
  type ImportResult,
} from '@rulegate/adapter-kit';
import { MCP_FILE, importMcpConfig, renderMcpJson } from './mcp.js';
import { docs } from './docs.js';

export const CLAUDE_MD = 'CLAUDE.md';

// `.mcp.json` is evidence as well as an artifact: `collectImports` is handed only the
// adapters that detected, so without it a repository whose sole AI configuration is an
// MCP file is never asked for its servers and `read()` never runs.
const DETECTION_PATHS = [CLAUDE_MD, 'CLAUDE.local.md', '.claude', MCP_FILE] as const;

async function detect(ctx: AdapterContext): Promise<DetectResult> {
  const evidence: string[] = [];
  for (const path of DETECTION_PATHS) {
    if (await ctx.fs.exists(path)) evidence.push(path);
  }
  return detected(evidence);
}

async function read(ctx: AdapterContext): Promise<Partial<Canonical>> {
  // The same guard `write` makes, for the mirror-image reason: when this file is already
  // the canonical source, the parser has read it and importing it again would duplicate
  // every rule in it. It matters for AGENTS.md above all (T014).
  if (isCanonicalSource(ctx.canonical.manifest, CLAUDE_MD)) return {};

  const contents = await ctx.fs.tryReadFile(CLAUDE_MD);

  return {
    ...(contents === undefined
      ? {}
      : {
          rules: importConcatenated({
            file: CLAUDE_MD,
            contents,
            headingLevel: 2,
            idFallback: 'claude',
          }),
        }),
    ...(await readMcp(ctx)),
  };
}

/**
 * The MCP half, guarded separately from the rules half.
 *
 * A repository can have `.mcp.json` and no `CLAUDE.md`, so returning early when the
 * instruction file is missing would import no servers at all — the mirror of the bug T046
 * found on the write side, where one early return covered the whole adapter.
 */
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

async function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;
  const marker = canonical.manifest.options.marker;
  const artifacts: Artifact[] = [];

  // Each artifact carries its own guards. This used to be one early return covering the
  // whole adapter, which was right while rules were the only output and became wrong the
  // moment MCP arrived: a repository whose `CLAUDE.md` is canonical input, or which has no
  // rules at all, still has MCP servers to generate.
  //
  // The canonical-source check is generic rather than Claude-specific: no adapter may write
  // over a file that is canonical input. It matters most for AGENTS.md (T014), but it costs
  // nothing to honour here and means every adapter inherits the protection.
  if (!isCanonicalSource(canonical.manifest, CLAUDE_MD)) {
    const rules = sortRules(
      canonical.rules.filter((r) => selects(r.frontmatter.tools, 'claude-code')),
    );
    // No rules means no file. Emitting an empty CLAUDE.md would create an artifact that
    // `check` then has to reason about, and that a user has to wonder about.
    if (rules.length > 0) {
      artifacts.push(
        finalizeArtifact({
          path: CLAUDE_MD,
          contents: withHtmlMarker(
            renderConcatenated(rules, { headingLevel: 2, showGlobs: true }),
            marker,
          ),
          adapter: 'claude-code',
          kind: 'rules',
          provenance: { ruleIds: rules.map((r) => r.id) },
        }),
      );
    }
  }

  // No `provenance`: no canonical rule contributed to this file, and claiming one would
  // mislead `doctor` and T051's merge, both of which read `ruleIds` as a real mapping.
  const mcp = renderMcpJson(canonical.mcpServers, marker);
  if (mcp !== '' && !isCanonicalSource(canonical.manifest, MCP_FILE)) {
    artifacts.push(
      finalizeArtifact({
        path: MCP_FILE,
        contents: mcp,
        adapter: 'claude-code',
        kind: 'mcp',
      }),
    );
  }

  return Promise.resolve(artifacts);
}

export const claudeCode: Adapter = {
  name: 'claude-code',
  apiVersion: ADAPTER_API_VERSION,
  detect,
  read,
  write,
  docs,
};

export default claudeCode;
export { docs, MCP_FILE, renderMcpJson };

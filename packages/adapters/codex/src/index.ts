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
} from '@driftgate/adapter-kit';
import { MCP_FILE, importConfigToml, renderConfigToml } from './mcp.js';
import { docs } from './docs.js';

export const AGENTS_MD = 'AGENTS.md';

const DETECTION_PATHS = [AGENTS_MD, '.codex'] as const;

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
  const rules = await readRules(ctx);
  return { ...rules, ...(await readMcp(ctx)) };
}

async function readRules(ctx: AdapterContext): Promise<Partial<Canonical>> {
  if (isCanonicalSource(ctx.canonical.manifest, AGENTS_MD)) return {};

  const contents = await ctx.fs.tryReadFile(AGENTS_MD);
  if (contents === undefined) return {};

  return {
    rules: importConcatenated({
      file: AGENTS_MD,
      contents,
      headingLevel: 2,
      idFallback: 'agents',
    }),
  };
}

/**
 * The MCP half, guarded on `.codex/config.toml` and **not** on `AGENTS.md`.
 *
 * This is the sharpest edge in the adapter. `read()` used to return early whenever
 * `AGENTS.md` was the canonical source — correct for rules, and it would have silently
 * suppressed MCP import on every repository that adopts Driftgate through a bare
 * `AGENTS.md`, which is the most common first contact this tool has. Exactly the mirror of
 * the write-side bug T046 found, arriving from the other direction.
 */
async function readMcp(ctx: AdapterContext): Promise<ImportResult> {
  if (isCanonicalSource(ctx.canonical.manifest, MCP_FILE)) return {};
  const contents = await ctx.fs.tryReadFile(MCP_FILE);
  if (contents === undefined) return {};
  const { servers, warnings } = importConfigToml(contents);
  return {
    ...(servers.length === 0 ? {} : { mcpServers: servers }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

async function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;
  const marker = canonical.manifest.options.marker;
  const artifacts: Artifact[] = [];

  // Each artifact carries its own guards. Both of these used to be early returns covering
  // the whole adapter, which was right while `AGENTS.md` was the only output and became
  // wrong the moment MCP arrived — this adapter has the sharper version of the hole T046
  // found in the other two, because a repository whose `AGENTS.md` *is* the canonical
  // source is the ordinary way to use Codex, and it still has MCP servers to generate.
  //
  // The self-reference. AGENTS.md is a valid canonical *input* as well as this adapter's
  // *output*, so a repo with no `.driftgate/` that uses AGENTS.md as its source would
  // otherwise have Driftgate generate that file from itself and destroy it. `computePlan`
  // catches this too, with E_ARTIFACT_OVERWRITES_SOURCE — but a hard error is the wrong
  // answer for a case that is ordinary rather than mistaken, so the adapter declines
  // quietly and the run stays green.
  if (!isCanonicalSource(canonical.manifest, AGENTS_MD)) {
    const rules = sortRules(canonical.rules.filter((r) => selects(r.frontmatter.tools, 'codex')));
    if (rules.length > 0) {
      artifacts.push(
        finalizeArtifact({
          path: AGENTS_MD,
          contents: withHtmlMarker(
            renderConcatenated(rules, { headingLevel: 2, showGlobs: true }),
            marker,
          ),
          adapter: 'codex',
          kind: 'rules',
          provenance: { ruleIds: rules.map((r) => r.id) },
        }),
      );
    }
  }

  // No `provenance`: no canonical rule contributed to this file, and claiming one would
  // mislead `doctor` and T051's merge, both of which read `ruleIds` as a real mapping.
  const config = renderConfigToml(canonical.mcpServers, marker);
  if (config !== '' && !isCanonicalSource(canonical.manifest, MCP_FILE)) {
    artifacts.push(
      finalizeArtifact({ path: MCP_FILE, contents: config, adapter: 'codex', kind: 'mcp' }),
    );
  }

  return Promise.resolve(artifacts);
}

export const codex: Adapter = {
  name: 'codex',
  apiVersion: ADAPTER_API_VERSION,
  detect,
  read,
  write,
  docs,
};

export default codex;
export { docs, MCP_FILE, renderConfigToml };

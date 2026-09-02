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
} from '@driftgate/adapter-kit';
import { docs } from './docs.js';

export const CLAUDE_MD = 'CLAUDE.md';

const DETECTION_PATHS = [CLAUDE_MD, 'CLAUDE.local.md', '.claude'] as const;

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
  if (contents === undefined) return {};

  return {
    rules: importConcatenated({
      file: CLAUDE_MD,
      contents,
      headingLevel: 2,
      idFallback: 'claude',
    }),
  };
}

async function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;

  // Generic guard, not a Claude-specific one: no adapter may write over a file that
  // is canonical input. It matters most for AGENTS.md (T014), but it costs nothing to
  // honour here and means every adapter inherits the protection.
  if (isCanonicalSource(canonical.manifest, CLAUDE_MD)) return [];

  const rules = sortRules(
    canonical.rules.filter((r) => selects(r.frontmatter.tools, 'claude-code')),
  );
  // No rules means no file. Emitting an empty CLAUDE.md would create an artifact that
  // `check` then has to reason about, and that a user has to wonder about.
  if (rules.length === 0) return [];

  const body = renderConcatenated(rules, { headingLevel: 2, showGlobs: true });

  return Promise.resolve([
    finalizeArtifact({
      path: CLAUDE_MD,
      contents: withHtmlMarker(body, canonical.manifest.options.marker),
      adapter: 'claude-code',
      kind: 'rules',
      provenance: { ruleIds: rules.map((r) => r.id) },
    }),
  ]);
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
export { docs };

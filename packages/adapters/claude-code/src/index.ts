import {
  ADAPTER_API_VERSION,
  detected,
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
} from '@driftgate/core';
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

async function read(_ctx: AdapterContext): Promise<Partial<Canonical>> {
  // Importing an existing CLAUDE.md back into canonical is T017. Returning nothing is
  // correct today; returning a guess would be worse than returning nothing.
  return Promise.resolve({});
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

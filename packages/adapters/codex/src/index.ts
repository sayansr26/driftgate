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

async function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;

  // The self-reference. AGENTS.md is a valid canonical *input* as well as this adapter's
  // *output*, so a repo with no `.driftgate/` that uses AGENTS.md as its source would
  // otherwise have Driftgate generate that file from itself and destroy it. `computePlan`
  // catches this too, with E_ARTIFACT_OVERWRITES_SOURCE — but a hard error is the wrong
  // answer for a case that is ordinary rather than mistaken, so the adapter declines
  // quietly and the run stays green.
  if (isCanonicalSource(canonical.manifest, AGENTS_MD)) return [];

  const rules = sortRules(canonical.rules.filter((r) => selects(r.frontmatter.tools, 'codex')));
  if (rules.length === 0) return [];

  const body = renderConcatenated(rules, { headingLevel: 2, showGlobs: true });

  return Promise.resolve([
    finalizeArtifact({
      path: AGENTS_MD,
      contents: withHtmlMarker(body, canonical.manifest.options.marker),
      adapter: 'codex',
      kind: 'rules',
      provenance: { ruleIds: rules.map((r) => r.id) },
    }),
  ]);
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
export { docs };

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

export const GEMINI_MD = 'GEMINI.md';

const DETECTION_PATHS = [GEMINI_MD, '.gemini'] as const;

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
  if (isCanonicalSource(ctx.canonical.manifest, GEMINI_MD)) return {};

  const contents = await ctx.fs.tryReadFile(GEMINI_MD);
  if (contents === undefined) return {};

  return {
    rules: importConcatenated({
      file: GEMINI_MD,
      contents,
      headingLevel: 2,
      idFallback: 'gemini',
    }),
  };
}

async function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;

  // Generic guard: no adapter writes over a file that is canonical input. GEMINI.md is
  // not a canonical source Driftgate discovers on its own, but a manifest may name one,
  // and honouring it here costs nothing.
  if (isCanonicalSource(canonical.manifest, GEMINI_MD)) return [];

  const rules = sortRules(canonical.rules.filter((r) => selects(r.frontmatter.tools, 'gemini')));
  if (rules.length === 0) return [];

  const body = renderConcatenated(rules, { headingLevel: 2, showGlobs: true });

  return Promise.resolve([
    finalizeArtifact({
      path: GEMINI_MD,
      contents: withHtmlMarker(body, canonical.manifest.options.marker),
      adapter: 'gemini',
      kind: 'rules',
      provenance: { ruleIds: rules.map((r) => r.id) },
    }),
  ]);
}

export const gemini: Adapter = {
  name: 'gemini',
  apiVersion: ADAPTER_API_VERSION,
  detect,
  read,
  write,
  docs,
};

export default gemini;
export { docs };

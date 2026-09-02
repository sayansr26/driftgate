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

async function read(_ctx: AdapterContext): Promise<Partial<Canonical>> {
  // Importing an existing GEMINI.md back into canonical is T017. Returning nothing is
  // correct today; returning a guess would be worse than returning nothing.
  return Promise.resolve({});
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

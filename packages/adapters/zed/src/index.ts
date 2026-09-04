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

export const RULES_FILE = '.rules';

const DETECTION_PATHS = [RULES_FILE, '.zed'] as const;

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
  //
  // Only `.rules` is imported, though Zed reads eight other filenames. Every one of them
  // belongs to another adapter, and importing a file two adapters both claim hands
  // `dedupeImported` the same rules twice with different provenance. They are declared in
  // `docs.files` instead, which is what lets `doctor` say Zed is reading `.cursorrules`
  // and ignoring the generated `CLAUDE.md`.
  if (isCanonicalSource(ctx.canonical.manifest, RULES_FILE)) return {};

  const contents = await ctx.fs.tryReadFile(RULES_FILE);
  if (contents === undefined) return {};

  return {
    rules: importConcatenated({
      file: RULES_FILE,
      contents,
      headingLevel: 2,
      idFallback: 'zed',
    }),
  };
}

async function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;

  // Generic guard: no adapter writes over a file that is canonical input. `.rules` is not
  // a canonical source Driftgate discovers on its own, but a manifest may name one, and
  // honouring it here costs nothing.
  if (isCanonicalSource(canonical.manifest, RULES_FILE)) return [];

  const rules = sortRules(canonical.rules.filter((r) => selects(r.frontmatter.tools, 'zed')));
  if (rules.length === 0) return [];

  const body = renderConcatenated(rules, { headingLevel: 2, showGlobs: true });

  return Promise.resolve([
    finalizeArtifact({
      path: RULES_FILE,
      contents: withHtmlMarker(body, canonical.manifest.options.marker),
      adapter: 'zed',
      kind: 'rules',
      provenance: { ruleIds: rules.map((r) => r.id) },
    }),
  ]);
}

export const zed: Adapter = {
  name: 'zed',
  apiVersion: ADAPTER_API_VERSION,
  detect,
  read,
  write,
  docs,
};

export default zed;
export { docs };

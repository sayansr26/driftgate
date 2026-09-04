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
} from '@rulegate/adapter-kit';
import { docs } from './docs.js';

export const CONVENTIONS_MD = 'CONVENTIONS.md';

/**
 * **`CONVENTIONS.md` is deliberately not evidence.**
 *
 * Aider reads nothing automatically, and `sync` writes that file itself — so treating it as
 * detection evidence would make every repository Rulegate has ever synced report Aider as
 * configured, forever, and make `doctor` unfalsifiable on this tool.
 *
 * The cost, accepted: `init` on a repository with a hand-written `CONVENTIONS.md` and no
 * config will not import it, because `collectImports` only calls `read()` on detected
 * adapters. Nothing loads that file either, so nothing is lost that was working.
 */
const DETECTION_PATHS = ['.aider.conf.yml'] as const;

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
  if (isCanonicalSource(ctx.canonical.manifest, CONVENTIONS_MD)) return {};

  const contents = await ctx.fs.tryReadFile(CONVENTIONS_MD);
  if (contents === undefined) return {};

  return {
    rules: importConcatenated({
      file: CONVENTIONS_MD,
      contents,
      headingLevel: 2,
      idFallback: 'aider',
    }),
  };
}

async function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;

  // Generic guard: no adapter writes over a file that is canonical input.
  //
  // **`.aider.conf.yml` is never written**, under any flag. It is the user's file, it can
  // hold literal API keys (`--openai-api-key` is a documented YAML-expressible option), and
  // taking it over would mean owning every Aider setting the way the codex adapter owns
  // `config.toml`. The consequence — a generated `CONVENTIONS.md` that the config never
  // names is loaded by nothing — is carried by encoded `docs` data and a `warn` note, not
  // by code that edits somebody's configuration.
  if (isCanonicalSource(canonical.manifest, CONVENTIONS_MD)) return [];

  const rules = sortRules(canonical.rules.filter((r) => selects(r.frontmatter.tools, 'aider')));
  if (rules.length === 0) return [];

  const body = renderConcatenated(rules, { headingLevel: 2, showGlobs: true });

  return Promise.resolve([
    finalizeArtifact({
      path: CONVENTIONS_MD,
      contents: withHtmlMarker(body, canonical.manifest.options.marker),
      adapter: 'aider',
      kind: 'rules',
      provenance: { ruleIds: rules.map((r) => r.id) },
    }),
  ]);
}

export const aider: Adapter = {
  name: 'aider',
  apiVersion: ADAPTER_API_VERSION,
  detect,
  read,
  write,
  docs,
};

export default aider;
export { docs };

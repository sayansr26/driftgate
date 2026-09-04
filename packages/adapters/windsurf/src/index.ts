import {
  ADAPTER_API_VERSION,
  RulegateError,
  basenamePosix,
  claimRuleId,
  detected,
  finalizeArtifact,
  importConcatenated,
  importRuleId,
  importedRule,
  isCanonicalSource,
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
} from '@rulegate/adapter-kit';
import { parseRule, renderFrontmatter } from './frontmatter.js';
import { docs } from './docs.js';

export const RULES_DIR = '.windsurf/rules';
/** The Devin Desktop directory, which **takes precedence** over `.windsurf/`. Never written. */
export const DEVIN_RULES_DIR = '.devin/rules';
export const LEGACY_FILE = '.windsurfrules';

const DETECTION_PATHS = ['.windsurf', LEGACY_FILE] as const;

async function detect(ctx: AdapterContext): Promise<DetectResult> {
  const evidence: string[] = [];
  for (const path of DETECTION_PATHS) {
    if (await ctx.fs.exists(path)) evidence.push(path);
  }
  return detected(evidence);
}

/**
 * Both mechanisms are imported, `.devin/rules/` included.
 *
 * The Devin directory is read but never written: it belongs to a different product, and an
 * adapter named `windsurf` generating into another tool's directory is how one adapter comes
 * to own another's paths. Reading it is a different matter — it takes precedence over
 * `.windsurf/rules/`, so a user who has one is a user whose real rules live there, and
 * dropping the source because we will not write it back would lose them.
 */
async function read(ctx: AdapterContext): Promise<ImportResult> {
  const rules: RuleDocument[] = [];
  const taken = new Set<string>();

  for (const dir of [DEVIN_RULES_DIR, RULES_DIR]) {
    for (const path of await ctx.fs.glob(`${dir}/**/*.md`)) {
      if (isCanonicalSource(ctx.canonical.manifest, path)) continue;
      const contents = await ctx.fs.tryReadFile(path);
      if (contents === undefined) continue;

      const parsed = parseRule(contents);
      if (parsed.body === '' && parsed.description === undefined) continue;

      const base = basenamePosix(path).replace(/\.md$/i, '');
      rules.push(
        importedRule({
          id: claimRuleId(importRuleId(base, 'windsurf'), taken),
          ...(parsed.description === undefined ? {} : { description: parsed.description }),
          globs: parsed.globs,
          body: parsed.body,
          source: { file: path, line: 1 },
        }),
      );
    }
  }

  if (!isCanonicalSource(ctx.canonical.manifest, LEGACY_FILE)) {
    const legacy = await ctx.fs.tryReadFile(LEGACY_FILE);
    if (legacy !== undefined) {
      for (const rule of importConcatenated({
        file: LEGACY_FILE,
        contents: legacy,
        headingLevel: 2,
        idFallback: 'windsurfrules',
      })) {
        rules.push({ ...rule, id: claimRuleId(rule.id, taken) });
      }
    }
  }

  return rules.length === 0 ? {} : { rules };
}

/**
 * One `.windsurf/rules/<id>.md` per rule.
 *
 * Windsurf is one of only two tools in the roster with a **native per-glob mechanism**, so a
 * scoped rule becomes `trigger: glob` rather than degrading to the prose `**Applies to:**`
 * line the concatenating adapters emit. The lossy fallback is for tools that have no
 * mechanism, not for tools whose mechanism we did not use.
 */
function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;
  const marker = canonical.manifest.options.marker;
  const rules = sortRules(canonical.rules.filter((r) => selects(r.frontmatter.tools, 'windsurf')));

  const artifacts: Artifact[] = [];
  const claimed = new Map<string, string>();

  for (const rule of rules) {
    const path = `${RULES_DIR}/${slugForId(rule.id)}.md`;
    const previous = claimed.get(path);
    if (previous !== undefined) {
      throw new RulegateError({
        code: 'E_ARTIFACT_PATH_CONFLICT',
        message: `rules \`${previous}\` and \`${rule.id}\` both render to ${path}`,
        source: rule.source,
        hint: 'rename one of them; windsurf rule filenames are flattened rule ids',
      });
    }
    claimed.set(path, rule.id);

    const frontmatter = renderFrontmatter({
      globs: rule.frontmatter.globs,
      ...(rule.frontmatter.description === undefined
        ? {}
        : { description: rule.frontmatter.description }),
    });

    artifacts.push(
      finalizeArtifact({
        path,
        // The marker goes *after* the frontmatter: Windsurf requires the block to occupy
        // the first bytes of the file, so a comment above it would push it out of position
        // and the rule would be read as untriggered prose.
        contents: `${frontmatter}${withHtmlMarker(rule.body, marker)}`,
        adapter: 'windsurf',
        kind: 'rules',
        provenance: { ruleIds: [rule.id] },
      }),
    );
  }

  return Promise.resolve(artifacts);
}

export const windsurf: Adapter = {
  name: 'windsurf',
  apiVersion: ADAPTER_API_VERSION,
  detect,
  read,
  write,
  docs,
};

export default windsurf;
export { docs };

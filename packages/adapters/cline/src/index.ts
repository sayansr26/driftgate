import {
  ADAPTER_API_VERSION,
  DriftgateError,
  basenamePosix,
  claimRuleId,
  detected,
  finalizeArtifact,
  importConcatenated,
  importRuleId,
  isCanonicalSource,
  renderRuleSection,
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
} from '@driftgate/adapter-kit';
import { docs } from './docs.js';

export const RULES_DIR = '.clinerules';

/**
 * `.clinerules` is the directory, and the extensions are both documented.
 *
 * The vendor is explicit that Cline "processes all `.md` and `.txt` files inside
 * `.clinerules/`", so the import side reads both. Driftgate writes only `.md`: a generator
 * picking `.txt` for prose would be choosing the less useful of two formats the tool treats
 * identically.
 *
 * Source: https://docs.cline.bot/features/cline-rules (read 2026-09-04).
 */
const READ_EXTENSIONS = ['md', 'txt'] as const;

const DETECTION_PATHS = [RULES_DIR] as const;

async function detect(ctx: AdapterContext): Promise<DetectResult> {
  const evidence: string[] = [];
  for (const path of DETECTION_PATHS) {
    if (await ctx.fs.exists(path)) evidence.push(path);
  }
  return detected(evidence);
}

/**
 * Only `.clinerules/`, deliberately.
 *
 * Cline also reads `.cursorrules`, `.windsurfrules` and `AGENTS.md`, and this adapter
 * imports **none** of them: each is another adapter's territory, and importing a file two
 * adapters both claim would hand `dedupeImported` two copies of the same rules with
 * different provenance. They are declared in `docs.files` as `managed: false` instead, which
 * is what makes `doctor` report the duplicate load with no Cline-specific code anywhere.
 */
async function read(ctx: AdapterContext): Promise<ImportResult> {
  const rules: RuleDocument[] = [];
  const taken = new Set<string>();

  for (const extension of READ_EXTENSIONS) {
    for (const path of await ctx.fs.glob(`${RULES_DIR}/*.${extension}`)) {
      if (isCanonicalSource(ctx.canonical.manifest, path)) continue;
      const contents = await ctx.fs.tryReadFile(path);
      if (contents === undefined) continue;

      // Each file is a one-section concatenated document — a `## Heading`, an optional
      // `**Applies to:**` line, then the body — which is exactly what `importConcatenated`
      // inverts. Reusing it rather than hand-parsing is what makes the round trip total:
      // the first version read the heading itself and dropped the glob line, so a scoped
      // rule came back repo-wide with its scoping stranded in the body as prose.
      const base = basenamePosix(path).replace(/\.(md|txt)$/i, '');
      const parsed = importConcatenated({
        file: path,
        contents,
        headingLevel: 2,
        idFallback: importRuleId(base, 'cline'),
      });

      // The id comes from the filename, not from the heading: the filename is what this
      // adapter wrote and what a second `sync` has to match, while the heading is the
      // rule's *description* (T017 — a rule's id does not survive rendering).
      for (const rule of parsed) {
        rules.push({ ...rule, id: claimRuleId(importRuleId(base, 'cline'), taken) });
      }
    }
  }

  return rules.length === 0 ? {} : { rules };
}

/**
 * One `.clinerules/<id>.md` per rule.
 *
 * Cline has **no per-glob mechanism**, so a scoped rule keeps the prose `**Applies to:**`
 * line rather than silently becoming repo-wide. Lossy, but visibly lossy — the distinction
 * that decides whether a user can see what happened.
 */
function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;
  const marker = canonical.manifest.options.marker;
  const rules = sortRules(canonical.rules.filter((r) => selects(r.frontmatter.tools, 'cline')));

  const artifacts: Artifact[] = [];
  const claimed = new Map<string, string>();

  for (const rule of rules) {
    const path = `${RULES_DIR}/${slugForId(rule.id)}.md`;
    const previous = claimed.get(path);
    if (previous !== undefined) {
      throw new DriftgateError({
        code: 'E_ARTIFACT_PATH_CONFLICT',
        message: `rules \`${previous}\` and \`${rule.id}\` both render to ${path}`,
        source: rule.source,
        hint: 'rename one of them; cline rule filenames are flattened rule ids',
      });
    }
    claimed.set(path, rule.id);

    artifacts.push(
      finalizeArtifact({
        path,
        contents: withHtmlMarker(
          renderRuleSection(rule, { headingLevel: 2, showGlobs: true }),
          marker,
        ),
        adapter: 'cline',
        kind: 'rules',
        provenance: { ruleIds: [rule.id] },
      }),
    );
  }

  return Promise.resolve(artifacts);
}

export const cline: Adapter = {
  name: 'cline',
  apiVersion: ADAPTER_API_VERSION,
  detect,
  read,
  write,
  docs,
};

export default cline;
export { docs };

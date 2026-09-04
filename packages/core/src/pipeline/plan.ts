import { RulegateError } from '../model/errors.js';
import { escapesRoot, normalizeRelative } from '../fs/paths.js';
import { isCanonicalSource } from '../model/canonical.js';
import { STATE_PATH } from '../model/paths.js';
import { finalizeArtifact } from '../render/finalize.js';
import { scanTextForSecrets } from '../render/secrets.js';
import { sortArtifacts } from '../render/order.js';
import { buildState, type StateFile } from '../state/state.js';
import { parse } from '../parse/index.js';
import { ADAPTER_API_VERSION } from '../adapter/context.js';
import type { Adapter } from '../adapter/adapter.js';
import type { Artifact } from '../adapter/artifact.js';
import type { Canonical } from '../model/canonical.js';
import type { ToolId } from '../model/ids.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface PlanInput {
  readonly repoRoot: string;
  readonly fs: ReadOnlyFileSystem;
  readonly adapters: readonly Adapter[];
  /**
   * Plan from this model instead of parsing `.rulegate/` off disk.
   *
   * For `init` (T019), which has a canonical model in memory — imported from the
   * repository's existing tool configs — and nothing on disk yet to parse. It is a
   * parameter rather than a second planner on purpose: `computePlan` being the only
   * renderer is what makes `check` and `sync` structurally unable to disagree, and an
   * `init` that rendered its preview some other way would be able to promise a user
   * something the first `sync` then did not do.
   */
  readonly canonical?: Canonical;
}

export interface Plan {
  readonly canonical: Canonical;
  /** Finalized, deduplicated, sorted by path. */
  readonly artifacts: readonly Artifact[];
  /** Exactly what `state.json` would contain if this plan were applied. */
  readonly state: StateFile;
  readonly enabledAdapters: readonly ToolId[];
  readonly errors: readonly RulegateError[];
  readonly warnings: readonly RulegateError[];
}

/**
 * Turn a repository into the complete set of artifacts that *should* exist.
 *
 * Reads only; writes nothing, ever. `sync` feeds the result to `applyPlan` and `check`
 * feeds the same result to `verifyPlan`, so the two commands consume one rendering
 * pass and cannot disagree about what the output ought to be. This is the project's
 * single most important structural constraint, and it is a property of this function
 * being the only renderer rather than a rule anyone has to remember.
 */
export async function computePlan(input: PlanInput): Promise<Plan> {
  const { fs, repoRoot, adapters } = input;
  const errors: RulegateError[] = [];
  const warnings: RulegateError[] = [];

  let canonical: Canonical;
  if (input.canonical === undefined) {
    const parsed = await parse({ fs, knownTools: adapters.map((a) => a.name) });
    errors.push(...parsed.errors);
    warnings.push(...parsed.warnings);
    canonical = parsed.canonical;
  } else {
    canonical = input.canonical;
  }
  const enabled = canonical.manifest.tools.filter((t) => t.enabled).map((t) => t.id);
  const selected = adapters.filter((a) => enabled.includes(a.name));

  const artifacts: Artifact[] = [];
  const claimedBy = new Map<string, ToolId>();

  for (const adapter of selected) {
    // `apiVersion` is only versioning if something reads it. TypeScript pins it to 1 for
    // any adapter compiled against this kit, so this branch is unreachable from our own
    // packages — it exists for the cases the type system does not cover: a plain-JS
    // adapter, and a `node_modules` holding an adapter built against a different kit.
    // When v2 arrives, this is the branch that decides whether a v1 adapter still runs.
    if (adapter.apiVersion !== ADAPTER_API_VERSION) {
      errors.push(
        new RulegateError({
          code: 'E_ADAPTER_API_VERSION',
          message: `adapter \`${adapter.name}\` targets adapter API v${String(adapter.apiVersion)}, but this build speaks v${String(ADAPTER_API_VERSION)}`,
          source: { file: canonical.manifest.source.file },
          hint: `upgrade the adapter, or pin rulegate to a version that speaks v${String(adapter.apiVersion)}`,
        }),
      );
      continue;
    }

    const options = canonical.manifest.tools.find((t) => t.id === adapter.name)?.options ?? {};
    const ctx = { repoRoot, canonical, fs, options, apiVersion: ADAPTER_API_VERSION };

    let produced: readonly Artifact[];
    try {
      produced = await adapter.write(ctx);
    } catch (cause) {
      // One broken adapter must not take down the run: the user still needs to see
      // what the others would do, and which one failed.
      errors.push(
        cause instanceof RulegateError
          ? cause
          : new RulegateError({
              code: 'E_ADAPTER_FAILED',
              message: `adapter \`${adapter.name}\` failed: ${describe(cause)}`,
              source: { file: canonical.manifest.source.file },
              cause,
            }),
      );
      continue;
    }

    for (const raw of produced) {
      const artifact = finalizeArtifact(raw);
      const path = normalizeRelative(artifact.path);

      if (escapesRoot(artifact.path)) {
        errors.push(
          new RulegateError({
            code: 'E_PATH_ESCAPE',
            message: `adapter \`${adapter.name}\` tried to write outside the repository: ${artifact.path}`,
            source: { file: artifact.path },
          }),
        );
        continue;
      }

      // The last gate in front of a git-committed credential (T044). The parser refuses
      // a literal in `env`, `headers` and preserved unknown keys, and `SecretValue` keeps
      // an adapter from being handed one — but an adapter renders its own text, and this
      // is the only place that sees what it actually produced. Scoped to `mcp` artifacts
      // because that is where credentials belong: a generic entropy scan over rendered
      // *instructions* fires on git hashes and code samples, and a check people learn to
      // override is not a check.
      if (artifact.kind === 'mcp') {
        const found = scanTextForSecrets(artifact.contents);
        if (found.length > 0) {
          errors.push(
            new RulegateError({
              code: 'E_LITERAL_SECRET',
              // Locations, never the values. A message that quoted what it found would
              // print the secret into CI logs.
              message: `adapter \`${adapter.name}\` would write a literal credential to ${path} (${found.join(', ')})`,
              source: { file: path },
              hint: 'use an `env:NAME` reference in .rulegate/mcp/servers.yaml; rulegate never writes a literal secret',
            }),
          );
          continue;
        }
      }

      if (isCanonicalSource(canonical.manifest, path)) {
        errors.push(
          new RulegateError({
            code: 'E_ARTIFACT_OVERWRITES_SOURCE',
            message: `adapter \`${adapter.name}\` tried to overwrite the canonical source ${path}`,
            source: { file: path },
            hint: 'the file it generates is also the file it reads from; disable that tool or move your canonical source',
          }),
        );
        continue;
      }

      if (path === STATE_PATH) {
        errors.push(
          new RulegateError({
            code: 'E_ARTIFACT_PATH_CONFLICT',
            message: `adapter \`${adapter.name}\` tried to write ${STATE_PATH}, which Rulegate owns`,
            source: { file: path },
          }),
        );
        continue;
      }

      // Case-folded, because NTFS and APFS are case-insensitive: two artifacts differing
      // only in case are two entries for **one physical file** there, so a plan that is
      // legal on Linux makes `check` fail forever on Windows and macOS. Refusing costs an
      // external adapter a rename; not refusing costs a user a repository that can never be
      // in sync (T069).
      const key = path.toLowerCase();
      const other = claimedBy.get(key);
      if (other !== undefined) {
        errors.push(
          new RulegateError({
            code: 'E_ARTIFACT_PATH_CONFLICT',
            message: `adapters \`${other}\` and \`${adapter.name}\` both generate ${path}`,
            source: { file: path },
            hint: 'disable one of the two tools, or report this as an adapter bug. Paths that differ only in case are the same file on Windows and macOS.',
          }),
        );
        continue;
      }

      claimedBy.set(key, adapter.name);
      artifacts.push({ ...artifact, path });
    }
  }

  const sorted = sortArtifacts(artifacts);

  return {
    canonical,
    artifacts: sorted,
    state: buildState(sorted),
    enabledAdapters: selected.map((a) => a.name),
    errors,
    warnings,
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

import { DriftgateError } from '../model/errors.js';
import { escapesRoot, normalizeRelative } from '../fs/paths.js';
import { isCanonicalSource } from '../model/canonical.js';
import { STATE_PATH } from '../model/paths.js';
import { finalizeArtifact } from '../render/finalize.js';
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
}

export interface Plan {
  readonly canonical: Canonical;
  /** Finalized, deduplicated, sorted by path. */
  readonly artifacts: readonly Artifact[];
  /** Exactly what `state.json` would contain if this plan were applied. */
  readonly state: StateFile;
  readonly enabledAdapters: readonly ToolId[];
  readonly errors: readonly DriftgateError[];
  readonly warnings: readonly DriftgateError[];
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
  const errors: DriftgateError[] = [];
  const warnings: DriftgateError[] = [];

  const parsed = await parse({ fs, knownTools: adapters.map((a) => a.name) });
  errors.push(...parsed.errors);
  warnings.push(...parsed.warnings);

  const { canonical } = parsed;
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
        new DriftgateError({
          code: 'E_ADAPTER_API_VERSION',
          message: `adapter \`${adapter.name}\` targets adapter API v${String(adapter.apiVersion)}, but this build speaks v${String(ADAPTER_API_VERSION)}`,
          source: { file: canonical.manifest.source.file },
          hint: `upgrade the adapter, or pin driftgate to a version that speaks v${String(adapter.apiVersion)}`,
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
        cause instanceof DriftgateError
          ? cause
          : new DriftgateError({
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
          new DriftgateError({
            code: 'E_PATH_ESCAPE',
            message: `adapter \`${adapter.name}\` tried to write outside the repository: ${artifact.path}`,
            source: { file: artifact.path },
          }),
        );
        continue;
      }

      if (isCanonicalSource(canonical.manifest, path)) {
        errors.push(
          new DriftgateError({
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
          new DriftgateError({
            code: 'E_ARTIFACT_PATH_CONFLICT',
            message: `adapter \`${adapter.name}\` tried to write ${STATE_PATH}, which Driftgate owns`,
            source: { file: path },
          }),
        );
        continue;
      }

      const other = claimedBy.get(path);
      if (other !== undefined) {
        errors.push(
          new DriftgateError({
            code: 'E_ARTIFACT_PATH_CONFLICT',
            message: `adapters \`${other}\` and \`${adapter.name}\` both generate ${path}`,
            source: { file: path },
            hint: 'disable one of the two tools, or report this as an adapter bug',
          }),
        );
        continue;
      }

      claimedBy.set(path, adapter.name);
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

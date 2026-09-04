import { DriftgateError } from '../model/errors.js';
import { compareCodepoint } from '../render/order.js';
import type { WritableFileSystem } from '../fs/types.js';

/**
 * The writer behind `driftgate adapter new` (T028).
 *
 * It lives in `core/src/io/` rather than in the CLI because that is the only lawful
 * place: `packages/core/test/invariants.test.ts` allows a filesystem write in
 * `core/src/io/`, `pipeline/apply.ts` and `fs/types.ts`, and nowhere else. The rule
 * exists so that `check` and `sync` cannot drift apart, and scaffolding must not be the
 * excuse that widens it. `scripts/update-fixtures.mjs` made the same call from the other
 * side — it sits outside `packages/` for exactly this reason.
 *
 * Nothing here knows what an adapter looks like. The templates are the CLI's, because
 * they encode this monorepo's layout; core only knows how to put bytes on disk without
 * destroying anything.
 */
export interface ScaffoldFile {
  /** Repo-relative POSIX path. */
  readonly path: string;
  readonly contents: string;
  /**
   * `create` must not exist yet; `update` must already exist. Stated per file rather
   * than inferred, so that a template whose path collides with somebody's real file is a
   * refusal instead of a silent overwrite.
   */
  readonly kind: 'create' | 'update';
}

export interface ScaffoldReport {
  readonly created: readonly string[];
  readonly updated: readonly string[];
}

/**
 * Write a scaffold, or report what it would write.
 *
 * Every path is checked before anything is written, so a collision leaves the repository
 * exactly as it was rather than half-scaffolded.
 */
export async function applyScaffold(
  files: readonly ScaffoldFile[],
  fs: WritableFileSystem,
  options: { readonly dryRun: boolean },
): Promise<ScaffoldReport> {
  const ordered = [...files].sort((a, b) => compareCodepoint(a.path, b.path));

  for (const file of ordered) {
    const exists = await fs.exists(file.path);
    if (file.kind === 'create' && exists) {
      throw new DriftgateError({
        code: 'E_SCAFFOLD_CONFLICT',
        message: `${file.path} already exists`,
        hint: 'Driftgate never overwrites a file it did not generate. Remove it, or choose another tool name.',
      });
    }
    if (file.kind === 'update' && !exists) {
      throw new DriftgateError({
        code: 'E_SCAFFOLD_CONFLICT',
        message: `${file.path} is missing, so it cannot be patched`,
        hint: 'Run this from a checkout of the driftgate monorepo.',
      });
    }
  }

  const created: string[] = [];
  const updated: string[] = [];
  for (const file of ordered) {
    if (!options.dryRun) await fs.writeFile(file.path, file.contents);
    (file.kind === 'create' ? created : updated).push(file.path);
  }

  return { created, updated };
}

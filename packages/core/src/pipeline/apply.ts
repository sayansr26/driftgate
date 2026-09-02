import { BACKUP_DIR, STATE_PATH } from '../model/paths.js';
import {
  hashContents,
  parseState,
  serializeState,
  findArtifact,
  EMPTY_STATE,
  type StateArtifact,
  type StateFile,
} from '../state/state.js';
import { compareToDisk } from '../state/compare.js';
import { compareCodepoint } from '../render/order.js';
import type { Plan } from './plan.js';
import type { WritableFileSystem } from '../fs/types.js';

export interface ApplyOptions {
  readonly dryRun: boolean;
  /**
   * Take ownership of files Driftgate did not generate, backing each one up under
   * `.driftgate/backup/` first. Without an opt-in like this there is no way to onboard
   * a repository that already has a `CLAUDE.md` — which is every repository worth
   * onboarding. `force` never widens to hand-edited generated files or to deletion.
   */
  readonly force?: boolean;
}

/** Why a planned artifact was not written. */
export type SkipReason =
  /** Driftgate generated it, and the bytes on disk have since changed. */
  | 'hand-edited'
  /** Driftgate never generated it, and somebody else's bytes are already there. */
  | 'unmanaged';

export interface ApplyReport {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  /** Planned files left alone rather than clobbered. */
  readonly skipped: readonly { readonly path: string; readonly reason: SkipReason }[];
  /** Repo-relative paths of originals copied under `.driftgate/backup/` before overwrite. */
  readonly backedUp: readonly string[];
  readonly stateWritten: boolean;
}

/** `CLAUDE.md` -> `.driftgate/backup/CLAUDE.md`. Stays inside the repo by construction. */
export function backupPathFor(relPath: string): string {
  return `${BACKUP_DIR}/${relPath}`;
}

/**
 * `state.json` must describe what Driftgate actually owns, not what it wished it had
 * written. `plan.state` covers every planned artifact, including the ones this run
 * refused to touch, so writing it verbatim would claim ownership of a file we
 * deliberately left alone — and since `compareToDisk` derives deletion candidates
 * from state alone, that claim is exactly what would later arm orphan deletion (T020)
 * against a file Driftgate never generated.
 *
 * Unmanaged skips are therefore dropped: we do not own them. Hand-edited skips keep
 * their *previous* record, because we do own them and the recorded hash is what makes
 * the next run report the edit rather than silently adopt it.
 */
function reconcileState(
  planned: StateFile,
  previous: StateFile,
  skipped: readonly { readonly path: string; readonly reason: SkipReason }[],
): StateFile {
  if (skipped.length === 0) return planned;

  const reasons = new Map(skipped.map((s) => [s.path, s.reason]));
  const artifacts: StateArtifact[] = [];

  for (const entry of planned.artifacts) {
    const reason = reasons.get(entry.path);
    if (reason === undefined) {
      artifacts.push(entry);
      continue;
    }
    if (reason === 'unmanaged') continue;
    const prior = findArtifact(previous, entry.path);
    if (prior !== undefined) artifacts.push(prior);
  }

  return { schemaVersion: planned.schemaVersion, artifacts };
}

/**
 * The only function in the codebase that writes files.
 *
 * Concentrating writes here is what lets every other layer — adapters especially — be
 * pure, and is what makes the never-delete and never-clobber invariants checkable in
 * one place instead of audited across every adapter.
 */
export async function applyPlan(
  plan: Plan,
  fs: WritableFileSystem,
  options: ApplyOptions = { dryRun: false },
): Promise<ApplyReport> {
  const previous = parseState(await fs.tryReadFile(STATE_PATH)) ?? EMPTY_STATE;
  const comparison = await compareToDisk(previous, plan.artifacts, fs);
  const handEdited = new Set(comparison.changed);
  const unmanaged = new Set(comparison.unmanaged);
  const force = options.force === true;

  const written: string[] = [];
  const unchanged: string[] = [];
  const backedUp: string[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];

  for (const artifact of plan.artifacts) {
    if (handEdited.has(artifact.path)) {
      // Users hand-edit generated files; that habit will not be broken by punishing
      // it. Stopping and pointing at `--import` (T051) keeps their edit.
      skipped.push({ path: artifact.path, reason: 'hand-edited' });
      continue;
    }

    if (unmanaged.has(artifact.path) && !force) {
      // A file Driftgate never generated is not ours to overwrite. `state.json` is the
      // only record of what we own, and this path is absent from it.
      skipped.push({ path: artifact.path, reason: 'unmanaged' });
      continue;
    }

    const onDisk = await fs.tryReadFile(artifact.path);
    if (onDisk !== undefined && hashContents(onDisk) === hashContents(artifact.contents)) {
      // Skip the write entirely rather than rewriting identical bytes: this preserves
      // mtimes, keeps file watchers and build caches quiet, and makes "a second run
      // rewrites nothing" literally true.
      unchanged.push(artifact.path);
      continue;
    }

    if (unmanaged.has(artifact.path) && onDisk !== undefined) {
      // Ordering matters: the copy has to land before the overwrite, or `--force` is
      // just data loss with extra steps.
      if (!options.dryRun) await fs.copyFile(artifact.path, backupPathFor(artifact.path));
      backedUp.push(artifact.path);
    }

    if (!options.dryRun) await fs.writeFile(artifact.path, artifact.contents);
    written.push(artifact.path);
  }

  const nextState = serializeState(reconcileState(plan.state, previous, skipped));
  const currentState = await fs.tryReadFile(STATE_PATH);
  const stateNeedsWrite = currentState !== nextState;

  if (stateNeedsWrite && !options.dryRun) await fs.writeFile(STATE_PATH, nextState);

  return {
    written: written.sort(compareCodepoint),
    unchanged: unchanged.sort(compareCodepoint),
    skipped: [...skipped].sort((a, b) => compareCodepoint(a.path, b.path)),
    backedUp: backedUp.sort(compareCodepoint),
    stateWritten: stateNeedsWrite,
  };
}

/** One `.driftgate/` file `init` proposes to write, and what writing it would do. */
export interface CanonicalFile {
  readonly path: string;
  readonly contents: string;
  readonly kind: 'create' | 'modify' | 'leave-alone';
}

export interface CanonicalWriteReport {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
}

/**
 * Write the `.driftgate/` files `init` computed.
 *
 * Here rather than in `init/` because `packages/core/test/invariants.test.ts` allows
 * filesystem writes in exactly three places, and `pipeline/apply.ts` is the only one of
 * them that is a command's apply step. Giving `init` its own writer would have meant
 * widening a P0 allowlist so that a second function could write files — which is the
 * shape of the change that later makes "applyPlan is the only writer" untrue.
 *
 * Unlike `applyPlan` this has no ownership rules to apply: `.driftgate/` is Driftgate's
 * own directory, and a file already there with different contents means the repository
 * has been adopted, which `computeInitPlan` refuses before reaching this point.
 */
export async function applyCanonicalFiles(
  files: readonly CanonicalFile[],
  fs: WritableFileSystem,
  options: { readonly dryRun: boolean },
): Promise<CanonicalWriteReport> {
  const written: string[] = [];
  const unchanged: string[] = [];

  for (const file of [...files].sort((a, b) => compareCodepoint(a.path, b.path))) {
    if (file.kind === 'leave-alone') {
      unchanged.push(file.path);
      continue;
    }
    if (!options.dryRun) await fs.writeFile(file.path, file.contents);
    written.push(file.path);
  }

  return { written, unchanged };
}

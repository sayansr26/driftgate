import { RulegateError } from '../model/errors.js';
import { BACKUP_DIR, STATE_PATH } from '../model/paths.js';
import {
  hashContents,
  loadState,
  serializeState,
  findArtifact,
  type StateArtifact,
  type StateFile,
} from '../state/state.js';
import { compareToDisk } from '../state/compare.js';
import { pathKeyFor, type PathKey } from '../fs/case.js';
import { compareCodepoint } from '../render/order.js';
import type { Plan } from './plan.js';
import type { ReadOnlyFileSystem, WritableFileSystem } from '../fs/types.js';

export interface ApplyOptions {
  readonly dryRun: boolean;
  /**
   * Take ownership of files Rulegate did not generate, backing each one up under
   * `.rulegate/backup/` first. Without an opt-in like this there is no way to onboard
   * a repository that already has a `CLAUDE.md` — which is every repository worth
   * onboarding. `force` never widens to hand-edited generated files or to deletion.
   */
  readonly force?: boolean;
}

/** Why a planned artifact was not written, or a recorded one was not deleted. */
export type SkipReason =
  /** Rulegate generated it, and the bytes on disk have since changed. */
  | 'hand-edited'
  /** Rulegate never generated it, and somebody else's bytes are already there. */
  | 'unmanaged'
  /**
   * No enabled adapter produces it any more, so it is a deletion candidate — but the
   * bytes on disk are no longer the bytes we wrote. Somebody edited it after we
   * generated it, and deleting an edit is the one outcome worse than leaving a stale
   * file behind. Refused, and its `state.json` entry is kept so the next run can still
   * recognise it as ours (T073).
   */
  | 'orphan-hand-edited';

export interface ApplyReport {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  /** Planned files left alone rather than clobbered, and orphans left alone rather than deleted. */
  readonly skipped: readonly { readonly path: string; readonly reason: SkipReason }[];
  /** Repo-relative paths of originals copied under `.rulegate/backup/` before overwrite or delete. */
  readonly backedUp: readonly string[];
  /** Repo-relative paths of generated files removed because no adapter produces them any more. */
  readonly deleted: readonly string[];
  readonly stateWritten: boolean;
  /** Conditions that changed how the run was interpreted without stopping it. */
  readonly warnings: readonly RulegateError[];
}

/** `CLAUDE.md` -> `.rulegate/backup/CLAUDE.md`. Stays inside the repo by construction. */
export function backupPathFor(relPath: string): string {
  return `${BACKUP_DIR}/${relPath}`;
}

/** The inverse. `undefined` for a path that is not under `.rulegate/backup/`. */
export function restoreTargetFor(backupRelPath: string): string | undefined {
  const prefix = `${BACKUP_DIR}/`;
  if (!backupRelPath.startsWith(prefix)) return undefined;
  const target = backupRelPath.slice(prefix.length);
  // A backup of a backup would restore onto itself. Nothing produces one today; this
  // is here so that a future caller cannot make the loop by accident.
  return target === '' || target.startsWith(prefix) ? undefined : target;
}

/**
 * What became of each file that `state.json` records and no adapter produces any more.
 *
 * Separated from the write loop because the two have opposite polarity — one is driven
 * by the plan, the other by the previous state — and because `reconcileState` has to
 * treat them differently: a deleted orphan leaves state, a refused one stays in it.
 */
interface OrphanOutcome {
  readonly deleted: readonly string[];
  /** Recorded but already gone from disk: nothing to delete, and the record is stale. */
  readonly vanished: readonly string[];
  /** Edited since we generated it. Left on disk, kept in state. */
  readonly refused: readonly string[];
  readonly backedUp: readonly string[];
}

/**
 * `state.json` must describe what Rulegate actually owns, not what it wished it had
 * written. `plan.state` covers every planned artifact, including the ones this run
 * refused to touch, so writing it verbatim would claim ownership of a file we
 * deliberately left alone — and since `compareToDisk` derives deletion candidates
 * from state alone, that claim is exactly what would arm orphan deletion against a
 * file Rulegate never generated.
 *
 * Unmanaged skips are therefore dropped: we do not own them. Hand-edited skips keep
 * their *previous* record, because we do own them and the recorded hash is what makes
 * the next run report the edit rather than silently adopt it.
 *
 * The mirror-image rule is `retainOrphans`, and it is T073's second defect. `plan.state`
 * holds only *currently planned* artifacts, so a file we generated and no longer
 * generate falls out of state simply by not being mentioned — Rulegate forgets it
 * wrote it, deletion is disarmed against exactly the files it exists to reclaim, and a
 * later run calls its own artifact `1 file rulegate did not generate`, which is false.
 * An orphan leaves state only when this run actually deleted it or found it already
 * gone.
 */
function reconcileState(
  planned: StateFile,
  previous: StateFile,
  skipped: readonly { readonly path: string; readonly reason: SkipReason }[],
  retainOrphans: readonly string[],
  key: PathKey,
): StateFile {
  const reasons = new Map(skipped.map((s) => [s.path, s.reason]));
  const artifacts: StateArtifact[] = [];

  for (const entry of planned.artifacts) {
    const reason = reasons.get(entry.path);
    if (reason === undefined) {
      artifacts.push(entry);
      continue;
    }
    if (reason === 'unmanaged') continue;
    const prior = findArtifact(previous, entry.path, key);
    if (prior !== undefined) artifacts.push(prior);
  }

  for (const path of retainOrphans) {
    const prior = findArtifact(previous, path, key);
    if (prior !== undefined) artifacts.push(prior);
  }

  // `buildState` sorts by path and `serializeState` preserves array order, so an
  // unsorted append here would make state.json's bytes depend on which files happened
  // to be orphaned — nondeterminism reaching a committed file.
  artifacts.sort((a, b) => compareCodepoint(a.path, b.path));
  return { schemaVersion: planned.schemaVersion, artifacts };
}

/**
 * The only function in the codebase that writes or deletes files.
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
  const { state: previous, warning: stateWarning } = await loadState(fs);
  const comparison = await compareToDisk(previous, plan.artifacts, fs);
  // The comparison already asked the filesystem whether it folds case; reuse its answer
  // rather than probing again, so every layer of one run identifies paths identically
  // (T085). Two layers disagreeing is how a file gets refused as somebody else's by the
  // write loop and deleted as ours by the orphan loop, in the same run.
  const key = pathKeyFor(comparison.caseInsensitive);
  const handEdited = new Set(comparison.changed);
  const unmanaged = new Set(comparison.unmanaged);
  const force = options.force === true;
  const backupEnabled = plan.canonical.manifest.options.backup;

  const written: string[] = [];
  const unchanged: string[] = [];
  const backedUp: string[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];

  for (const artifact of plan.artifacts) {
    const onDisk = await fs.tryReadFile(artifact.path);
    if (onDisk !== undefined && hashContents(onDisk) === hashContents(artifact.contents)) {
      // Skip the write entirely rather than rewriting identical bytes: this preserves
      // mtimes, keeps file watchers and build caches quiet, and makes "a second run
      // rewrites nothing" literally true.
      //
      // Checked before the ownership questions below on purpose. A file whose bytes
      // already equal the render is not a conflict whoever wrote them — the same rule
      // `compareToDisk` applies to unmanaged files — so a hand-edit that happens to match
      // what the rule now says is adopted (and its record refreshed) rather than refused.
      // `check` calls that file clean, and `sync` must agree (T021).
      unchanged.push(artifact.path);
      continue;
    }

    if (handEdited.has(artifact.path) && !force) {
      // Users hand-edit generated files; that habit will not be broken by punishing
      // it. Stopping and pointing at a recovery that works keeps their edit.
      skipped.push({ path: artifact.path, reason: 'hand-edited' });
      continue;
    }

    if (handEdited.has(artifact.path) && onDisk !== undefined && backupEnabled) {
      // T075's remaining half. `--force` covered only `unmanaged` paths, so a hand-edited
      // generated file had no flag-based escape hatch at all — the only way forward was to
      // delete the file by hand, and nothing in the output said so. Widening it waited for
      // the backup (T020) and for a recovery that keeps the edit (`--import`, T051), so
      // that discarding one is now a choice between two stated options rather than the
      // only door.
      if (!options.dryRun) await fs.copyFile(artifact.path, backupPathFor(artifact.path));
      backedUp.push(artifact.path);
    }

    if (unmanaged.has(artifact.path) && !force) {
      // A file Rulegate never generated is not ours to overwrite. `state.json` is the
      // only record of what we own, and this path is absent from it.
      skipped.push({ path: artifact.path, reason: 'unmanaged' });
      continue;
    }

    if (unmanaged.has(artifact.path) && onDisk !== undefined && backupEnabled) {
      // Ordering matters: the copy has to land before the overwrite, or `--force` is
      // just data loss with extra steps.
      if (!options.dryRun) await fs.copyFile(artifact.path, backupPathFor(artifact.path));
      backedUp.push(artifact.path);
    }

    if (!options.dryRun) await fs.writeFile(artifact.path, artifact.contents);
    written.push(artifact.path);
  }

  const orphans = await reclaimOrphans(comparison.orphaned, previous, fs, {
    dryRun: options.dryRun,
    backup: backupEnabled,
    key,
  });
  backedUp.push(...orphans.backedUp);
  for (const path of orphans.refused) skipped.push({ path, reason: 'orphan-hand-edited' });

  const nextState = serializeState(
    reconcileState(plan.state, previous, skipped, orphans.refused, key),
  );
  const currentState = await fs.tryReadFile(STATE_PATH);
  const stateNeedsWrite = currentState !== nextState;

  if (stateNeedsWrite && !options.dryRun) await fs.writeFile(STATE_PATH, nextState);

  return {
    written: written.sort(compareCodepoint),
    unchanged: unchanged.sort(compareCodepoint),
    skipped: [...skipped].sort((a, b) => compareCodepoint(a.path, b.path)),
    backedUp: backedUp.sort(compareCodepoint),
    deleted: [...orphans.deleted].sort(compareCodepoint),
    stateWritten: stateNeedsWrite,
    warnings: stateWarning === undefined ? [] : [stateWarning],
  };
}

/**
 * The last gate in front of `deleteFile`: a path is deletable only if `state.json`
 * records it as ours, and the record is what says which bytes we are entitled to remove.
 *
 * Exported so it can be tested against the input that reaches it. Today the only caller
 * derives its candidates from the very state this consults, so the throw is unreachable
 * through `applyPlan` — the same shape as `E_ADAPTER_API_VERSION`, and for the same
 * reason: the type system does not cover a future caller that builds the candidate list
 * some other way, and the cost of being wrong here is destroying somebody's file. An
 * unreachable refusal is still worth having; an *untestable* one is not, which is why
 * this is a function rather than an inline branch.
 */
export function assertDeletable(
  path: string,
  previous: StateFile,
  key: PathKey = (p) => p,
): StateArtifact {
  const record = findArtifact(previous, path, key);
  if (record !== undefined) return record;
  throw new RulegateError({
    code: 'E_DELETE_UNRECORDED',
    message: `refusing to delete ${path}: state.json does not record it as generated by rulegate`,
    source: { file: path },
    hint: 'state.json is the only record of ownership; a path absent from it is somebody else’s file',
  });
}

/**
 * Remove the generated files that no enabled adapter produces any more.
 *
 * The candidate list is `DiskComparison.orphaned` and nothing else — that is, paths
 * `state.json` records as ours. That single sourcing is what makes "never delete a file
 * Rulegate did not generate" a structural property rather than a promise: a path
 * Rulegate never recorded cannot reach `deleteFile`, because nothing else produces a
 * candidate.
 *
 * Before this existed, deleting a rule left its `.cursor/rules/*.mdc` on disk at exit 0
 * with nothing printed, so Cursor kept loading a rule the user had deleted — a wrong
 * answer, not a missing one (T073).
 */
async function reclaimOrphans(
  candidates: readonly string[],
  previous: StateFile,
  fs: WritableFileSystem,
  options: { readonly dryRun: boolean; readonly backup: boolean; readonly key: PathKey },
): Promise<OrphanOutcome> {
  const deleted: string[] = [];
  const vanished: string[] = [];
  const refused: string[] = [];
  const backedUp: string[] = [];

  for (const path of candidates) {
    const record = assertDeletable(path, previous, options.key);
    const onDisk = await fs.tryReadFile(path);
    if (onDisk === undefined) {
      vanished.push(path);
      continue;
    }

    if (hashContents(onDisk) !== record.hash) {
      refused.push(path);
      continue;
    }

    if (options.backup) {
      if (!options.dryRun) await fs.copyFile(path, backupPathFor(path));
      backedUp.push(path);
    }
    if (!options.dryRun) await fs.deleteFile(path);
    deleted.push(path);
  }

  return { deleted, vanished, refused, backedUp };
}

export interface RestoreCandidate {
  /** Where the original is kept, e.g. `.rulegate/backup/CLAUDE.md`. */
  readonly from: string;
  /** Where it would be put back, e.g. `CLAUDE.md`. */
  readonly to: string;
  /** True when the bytes on disk already equal the backup: restoring is a no-op. */
  readonly identical: boolean;
  /** True when nothing is at the destination, so restoring cannot lose anything. */
  readonly missing: boolean;
}

export interface RestoreReport {
  readonly restored: readonly string[];
  readonly unchanged: readonly string[];
  readonly candidates: readonly RestoreCandidate[];
}

/** Every file kept under `.rulegate/backup/`, sorted, with what restoring it would do. */
export async function planRestore(
  fs: ReadOnlyFileSystem,
  only: readonly string[] = [],
): Promise<readonly RestoreCandidate[]> {
  const wanted = new Set(only);
  const candidates: RestoreCandidate[] = [];

  for (const from of await listFilesUnder(fs, BACKUP_DIR)) {
    const to = restoreTargetFor(from);
    if (to === undefined) continue;
    if (wanted.size > 0 && !wanted.has(to) && !wanted.has(from)) continue;

    // Raw bytes, not `tryReadFile`. Reads are BOM-stripped and EOL-normalized, so a
    // CRLF backup and an LF file on disk compare *equal* through the text path — and
    // this comparison decides whether the restore is skipped as a no-op. Skipping there
    // would leave the CRLF original permanently unrestorable.
    const missing = !(await fs.exists(to));
    const identical = missing
      ? false
      : sameBytes(await fs.readFileRaw(to), await fs.readFileRaw(from));
    candidates.push({ from, to, identical, missing });
  }

  candidates.sort((a, b) => compareCodepoint(a.to, b.to));
  return candidates;
}

/**
 * Put the originals in `.rulegate/backup/` back where they came from.
 *
 * `copyFile`, never read-then-write: reads are BOM-stripped and EOL-normalized, so a
 * read-then-write restore would quietly convert a CRLF original to LF, and a restore
 * that does not reproduce the original bytes is not a restore.
 *
 * There are no ownership rules to apply. Everything under `.rulegate/backup/` is there
 * because Rulegate took the original over, so putting it back is an undo of Rulegate's
 * own act. A restored file that Rulegate currently generates simply reads as
 * hand-edited to the next `sync`, which is the correct description of what just
 * happened.
 */
export async function restoreFromBackup(
  candidates: readonly RestoreCandidate[],
  fs: WritableFileSystem,
  options: { readonly dryRun: boolean },
): Promise<RestoreReport> {
  const restored: string[] = [];
  const unchanged: string[] = [];

  for (const candidate of candidates) {
    if (candidate.identical) {
      unchanged.push(candidate.to);
      continue;
    }
    if (!options.dryRun) await fs.copyFile(candidate.from, candidate.to);
    restored.push(candidate.to);
  }

  return { restored, unchanged, candidates };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Recursive listing, rooted at one directory. Returns [] when the directory is absent. */
async function listFilesUnder(fs: ReadOnlyFileSystem, dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.listDir(current)) {
      const child = `${current}/${entry.name}`;
      if (entry.kind === 'dir') {
        await walk(child);
        continue;
      }
      if (entry.kind === 'file') out.push(child);
    }
  };
  await walk(dir);
  out.sort(compareCodepoint);
  return out;
}

/** One `.rulegate/` file `init` proposes to write, and what writing it would do. */
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
 * Write the `.rulegate/` files `init` computed.
 *
 * Here rather than in `init/` because `packages/core/test/invariants.test.ts` allows
 * filesystem writes in exactly three places, and `pipeline/apply.ts` is the only one of
 * them that is a command's apply step. Giving `init` its own writer would have meant
 * widening a P0 allowlist so that a second function could write files — which is the
 * shape of the change that later makes "applyPlan is the only writer" untrue.
 *
 * Unlike `applyPlan` this has no ownership rules to apply: `.rulegate/` is Rulegate's
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

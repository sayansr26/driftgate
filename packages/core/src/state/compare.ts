import { hashContents, type StateFile } from './state.js';
import { compareCodepoint } from '../render/order.js';
import type { Artifact } from '../adapter/artifact.js';
import { pathKeyFor, probeCaseInsensitive } from '../fs/case.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface DiskComparison {
  /** On disk and matching what we would generate. */
  readonly unchanged: readonly string[];
  /** Recorded as generated, but the bytes on disk no longer match: hand-edited. */
  readonly changed: readonly string[];
  /** Recorded as generated, but gone from disk. */
  readonly missing: readonly string[];
  /** We would write it, it is not in state, and nothing is on disk: a genuinely new file. */
  readonly untracked: readonly string[];
  /**
   * We would write it, it is not in state, and different bytes are already on disk.
   *
   * Somebody else's file stands where our output goes. Distinguishing this from
   * `untracked` is what stops a first `sync` in a repo that already has a `CLAUDE.md`
   * from destroying it: `untracked` is safe to write by definition, this never is
   * without consent. A pre-existing file whose bytes already equal our render is not
   * listed here — it lands in `unchanged` and is adopted into state, because writing
   * identical bytes is a no-op and refusing it would make idempotency depend on
   * whether `state.json` happens to exist.
   */
  readonly unmanaged: readonly string[];
  /**
   * In state but no longer produced by any adapter.
   *
   * This is the *only* source of deletion candidates anywhere in the codebase. That is
   * what makes "never delete a file Rulegate did not generate" enforceable rather than
   * aspirational: a path Rulegate never recorded can never reach a delete call.
   */
  readonly orphaned: readonly string[];
  /**
   * Whether this filesystem resolves two names differing only in case to one file.
   *
   * Carried on the result so `verifyPlan` and `applyPlan` identify paths the same way
   * this comparison did, rather than each probing again and risking a different answer
   * mid-run. Two layers disagreeing about which paths are the same file is how one of
   * them refuses to write a file the other deletes.
   */
  readonly caseInsensitive: boolean;
}

export async function compareToDisk(
  state: StateFile,
  artifacts: readonly Artifact[],
  fs: ReadOnlyFileSystem,
): Promise<DiskComparison> {
  const unchanged: string[] = [];
  const changed: string[] = [];
  const missing: string[] = [];
  const untracked: string[] = [];
  const unmanaged: string[] = [];

  // Asked once per comparison, of the filesystem in hand. On APFS and NTFS a recorded
  // `CLAUDE.md` and a planned `claude.md` are one physical file, and keying these two
  // exactly is what made that file `unmanaged` (so `sync` refused to write it) *and*
  // `orphaned` (so the same run deleted it). See fs/case.ts (T085).
  const caseInsensitive = await probeCaseInsensitive(fs);
  const key = pathKeyFor(caseInsensitive);

  const planned = new Set(artifacts.map((a) => key(a.path)));
  const recorded = new Map(state.artifacts.map((a) => [key(a.path), a]));

  for (const artifact of artifacts) {
    const onDisk = await fs.tryReadFile(artifact.path);
    const record = recorded.get(key(artifact.path));

    if (onDisk === undefined) {
      (record === undefined ? untracked : missing).push(artifact.path);
      continue;
    }

    const diskHash = hashContents(onDisk);
    if (record === undefined) {
      // Identical bytes are not a conflict; adopt them rather than block on them.
      (diskHash === hashContents(artifact.contents) ? unchanged : unmanaged).push(artifact.path);
    } else if (diskHash !== record.hash) {
      changed.push(artifact.path);
    } else {
      unchanged.push(artifact.path);
    }
  }

  const orphaned = state.artifacts.map((a) => a.path).filter((p) => !planned.has(key(p)));

  return {
    unchanged: unchanged.sort(compareCodepoint),
    changed: changed.sort(compareCodepoint),
    missing: missing.sort(compareCodepoint),
    untracked: untracked.sort(compareCodepoint),
    unmanaged: unmanaged.sort(compareCodepoint),
    orphaned: [...orphaned].sort(compareCodepoint),
    caseInsensitive,
  };
}

/** True when the on-disk bytes already equal what we would write. */
export async function isUpToDate(artifact: Artifact, fs: ReadOnlyFileSystem): Promise<boolean> {
  const onDisk = await fs.tryReadFile(artifact.path);
  return onDisk !== undefined && hashContents(onDisk) === hashContents(artifact.contents);
}

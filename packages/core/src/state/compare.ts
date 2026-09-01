import { hashContents, type StateFile } from './state.js';
import { compareCodepoint } from '../render/order.js';
import type { Artifact } from '../adapter/artifact.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface DiskComparison {
  /** On disk and matching what we would generate. */
  readonly unchanged: readonly string[];
  /** Recorded as generated, but the bytes on disk no longer match: hand-edited. */
  readonly changed: readonly string[];
  /** Recorded as generated, but gone from disk. */
  readonly missing: readonly string[];
  /** We would write it, and it is not in state: new, or pre-existing and unmanaged. */
  readonly untracked: readonly string[];
  /**
   * In state but no longer produced by any adapter.
   *
   * This is the *only* source of deletion candidates anywhere in the codebase. That is
   * what makes "never delete a file Driftgate did not generate" enforceable rather than
   * aspirational: a path Driftgate never recorded can never reach a delete call.
   */
  readonly orphaned: readonly string[];
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

  const planned = new Set(artifacts.map((a) => a.path));
  const recorded = new Map(state.artifacts.map((a) => [a.path, a]));

  for (const artifact of artifacts) {
    const onDisk = await fs.tryReadFile(artifact.path);
    const record = recorded.get(artifact.path);

    if (onDisk === undefined) {
      (record === undefined ? untracked : missing).push(artifact.path);
      continue;
    }

    const diskHash = hashContents(onDisk);
    if (record === undefined) {
      untracked.push(artifact.path);
    } else if (diskHash !== record.hash) {
      changed.push(artifact.path);
    } else {
      unchanged.push(artifact.path);
    }
  }

  const orphaned = state.artifacts.map((a) => a.path).filter((p) => !planned.has(p));

  return {
    unchanged: unchanged.sort(compareCodepoint),
    changed: changed.sort(compareCodepoint),
    missing: missing.sort(compareCodepoint),
    untracked: untracked.sort(compareCodepoint),
    orphaned: [...orphaned].sort(compareCodepoint),
  };
}

/** True when the on-disk bytes already equal what we would write. */
export async function isUpToDate(artifact: Artifact, fs: ReadOnlyFileSystem): Promise<boolean> {
  const onDisk = await fs.tryReadFile(artifact.path);
  return onDisk !== undefined && hashContents(onDisk) === hashContents(artifact.contents);
}

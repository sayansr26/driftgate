import { hashContents, loadState } from '../state/state.js';
import { compareToDisk } from '../state/compare.js';
import { compareCodepoint } from '../render/order.js';
import type { DriftgateError } from '../model/errors.js';
import type { Plan } from './plan.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

/**
 * Why a path is out of sync. The vocabulary is `sync`'s (`SkipReason` plus the two
 * outcomes `sync` would not stop for), so `check` can hand the user the same recovery
 * hint `sync` would.
 */
export type VerifyStatus =
  /** Ours, untouched since we wrote it, and the canonical source has moved on. `sync` would write it. */
  | 'stale'
  /** Ours, and the bytes on disk are no longer the bytes we wrote. `sync` would refuse it. */
  | 'hand-edited'
  /** Not ours: nothing in `state.json`, and different bytes already there. `sync` would refuse without `--force`. */
  | 'unmanaged'
  /** Should exist and does not. `sync` would write it. */
  | 'missing'
  /** Ours, and no enabled adapter produces it any more. `sync` would delete it. */
  | 'orphaned'
  /** An orphan somebody edited after we wrote it. `sync` would refuse to delete it. */
  | 'orphan-hand-edited';

export interface VerifyEntry {
  readonly path: string;
  readonly status: VerifyStatus;
  /** What canonical would generate. Absent for an orphan, which nothing generates. */
  readonly expected?: string;
  /** What is on disk, EOL-normalized. Absent for a missing file. */
  readonly actual?: string;
}

export interface VerifyReport {
  readonly clean: boolean;
  /** Every out-of-sync path, sorted by path. Empty exactly when `clean`. */
  readonly entries: readonly VerifyEntry[];
  /** Planned paths that exist and differ from the render: `stale`, `hand-edited`, `unmanaged`. */
  readonly drifted: readonly string[];
  /** Planned paths that do not exist. */
  readonly missing: readonly string[];
  /** Conditions that changed how the answer was reached without stopping it. */
  readonly warnings: readonly DriftgateError[];
}

/**
 * Compare what is on disk against what the plan says should be there. Reads only.
 *
 * `driftgate check` (T023) is this function plus an exit code. It consumes the identical
 * `Plan.artifacts` array that `sync` applies, so it is structurally incapable of verifying
 * something `sync` would not produce — and the rule for `clean` is the other half of that
 * promise: **clean means `sync` would write nothing and delete nothing.** A path is out of
 * sync if the bytes on disk differ from the render, or if `state.json` records a file no
 * adapter produces any more and it is still on disk.
 *
 * That is two comparisons, not one. `compareToDisk` answers the ownership question — is
 * this path ours, and are the bytes still the ones we wrote? — which is what `sync` needs
 * to decide whether it *may* write. It does not answer whether it *would*: a rule edited
 * without a `sync` leaves its artifact matching the recorded hash and differing from the
 * render, which `compareToDisk` files under `unchanged` and which is the case `check`
 * exists for. So ownership comes from `compareToDisk` and the verdict comes from the
 * render hash, per planned path.
 *
 * Two things are deliberately *not* drift. A `state.json` that would be rewritten (an
 * orphan already gone from disk, a stale record for bytes that already match) — state is
 * regenerable, never authoritative. And a CRLF copy of a clean artifact: reads are
 * EOL-normalized, `hashContents` is EOL-blind, and `sync` would not rewrite it, so
 * `check` must not fail a Windows checkout for a difference `sync` does not see.
 */
export async function verifyPlan(plan: Plan, fs: ReadOnlyFileSystem): Promise<VerifyReport> {
  const { state, warning } = await loadState(fs);
  const comparison = await compareToDisk(state, plan.artifacts, fs);
  const handEdited = new Set(comparison.changed);
  const unmanaged = new Set(comparison.unmanaged);
  const recorded = new Map(state.artifacts.map((a) => [a.path, a.hash]));

  const entries: VerifyEntry[] = [];

  for (const artifact of plan.artifacts) {
    const actual = await fs.tryReadFile(artifact.path);
    if (actual === undefined) {
      entries.push({ path: artifact.path, status: 'missing', expected: artifact.contents });
      continue;
    }
    if (hashContents(actual) === hashContents(artifact.contents)) continue;

    const status: VerifyStatus = unmanaged.has(artifact.path)
      ? 'unmanaged'
      : handEdited.has(artifact.path)
        ? 'hand-edited'
        : 'stale';
    entries.push({ path: artifact.path, status, expected: artifact.contents, actual });
  }

  for (const path of comparison.orphaned) {
    const actual = await fs.tryReadFile(path);
    // Already gone: the record is stale, and dropping a record is not a change to the repo.
    if (actual === undefined) continue;
    const status: VerifyStatus =
      hashContents(actual) === recorded.get(path) ? 'orphaned' : 'orphan-hand-edited';
    entries.push({ path, status, actual });
  }

  // Planned paths and orphans interleave, so one sort over the merged list is the only
  // way the output order is a property of the paths rather than of which loop ran first.
  entries.sort((a, b) => compareCodepoint(a.path, b.path));

  const missing = entries.filter((e) => e.status === 'missing').map((e) => e.path);
  const drifted = entries
    .filter((e) => e.status === 'stale' || e.status === 'hand-edited' || e.status === 'unmanaged')
    .map((e) => e.path);

  return {
    clean: entries.length === 0,
    entries,
    drifted,
    missing,
    warnings: warning === undefined ? [] : [warning],
  };
}

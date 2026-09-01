import { hashContents } from '../state/state.js';
import { compareCodepoint } from '../render/order.js';
import type { Plan } from './plan.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface VerifyReport {
  readonly clean: boolean;
  /** On disk but different from what canonical would generate. */
  readonly drifted: readonly string[];
  /** Should exist and does not. */
  readonly missing: readonly string[];
}

/**
 * Compare what is on disk against what the plan says should be there. Reads only.
 *
 * `driftgate check` (T023) is this function plus an exit code. It is written now,
 * before that command exists, because it is ten lines and because writing it here
 * makes the shared-rendering-path constraint physically true from the start: `check`
 * consumes the identical `Plan.artifacts` array that `sync` applies, so it is
 * structurally incapable of verifying something `sync` would not produce.
 */
export async function verifyPlan(plan: Plan, fs: ReadOnlyFileSystem): Promise<VerifyReport> {
  const drifted: string[] = [];
  const missing: string[] = [];

  for (const artifact of plan.artifacts) {
    const onDisk = await fs.tryReadFile(artifact.path);
    if (onDisk === undefined) {
      missing.push(artifact.path);
      continue;
    }
    if (hashContents(onDisk) !== hashContents(artifact.contents)) drifted.push(artifact.path);
  }

  drifted.sort(compareCodepoint);
  missing.sort(compareCodepoint);

  return { clean: drifted.length === 0 && missing.length === 0, drifted, missing };
}

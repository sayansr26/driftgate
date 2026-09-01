import { STATE_PATH } from '../model/paths.js';
import { hashContents, parseState, serializeState, EMPTY_STATE } from '../state/state.js';
import { compareToDisk } from '../state/compare.js';
import { compareCodepoint } from '../render/order.js';
import type { Plan } from './plan.js';
import type { WritableFileSystem } from '../fs/types.js';

export interface ApplyOptions {
  readonly dryRun: boolean;
}

export interface ApplyReport {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  /** Generated files that were hand-edited; left alone rather than clobbered. */
  readonly skipped: readonly { readonly path: string; readonly reason: 'hand-edited' }[];
  readonly stateWritten: boolean;
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

  const written: string[] = [];
  const unchanged: string[] = [];
  const skipped: { path: string; reason: 'hand-edited' }[] = [];

  for (const artifact of plan.artifacts) {
    if (handEdited.has(artifact.path)) {
      // Users hand-edit generated files; that habit will not be broken by punishing
      // it. Stopping and pointing at `--import` (T051) keeps their edit.
      skipped.push({ path: artifact.path, reason: 'hand-edited' });
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

    if (!options.dryRun) await fs.writeFile(artifact.path, artifact.contents);
    written.push(artifact.path);
  }

  const nextState = serializeState(plan.state);
  const currentState = await fs.tryReadFile(STATE_PATH);
  const stateNeedsWrite = currentState !== nextState;

  if (stateNeedsWrite && !options.dryRun) await fs.writeFile(STATE_PATH, nextState);

  return {
    written: written.sort(compareCodepoint),
    unchanged: unchanged.sort(compareCodepoint),
    skipped: [...skipped].sort((a, b) => compareCodepoint(a.path, b.path)),
    stateWritten: stateNeedsWrite,
  };
}

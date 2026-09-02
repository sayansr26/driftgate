import { findRepoRoot, resolveRepoRoot } from '@driftgate/core';

export interface ResolvedCwd {
  /** The repository root every command should act on. */
  readonly root: string;
  /** True when the root was discovered by walking up rather than named by the user. */
  readonly searched: boolean;
}

/**
 * An explicit `--cwd` is taken literally. Searching upward from a directory the user
 * named would make `--cwd packages/core` unable to mean what it says, and would give
 * `init` (T019) the wrong root the day it lands. Without the flag we behave like git
 * and walk up (T074).
 */
export function resolveGlobalCwd(explicit: string | undefined): ResolvedCwd {
  if (explicit !== undefined) return { root: resolveRepoRoot(explicit), searched: false };
  const here = process.cwd();
  const root = findRepoRoot(here);
  return { root, searched: root !== here };
}

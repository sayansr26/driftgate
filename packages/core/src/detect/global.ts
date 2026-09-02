import { dirnamePosix } from '../fs/paths.js';
import type { GlobalProbeKind } from './types.js';

/** The `~/` marker that `AdapterDocs` uses for a user-level path. */
const HOME_PREFIX = '~/';

export interface GlobalPatternPlan {
  readonly kind: Exclude<GlobalProbeKind, 'skipped'>;
  /** Home-relative POSIX path to `exists()`. Set only for `literal`. */
  readonly literal?: string;
  /** Home-relative directory to `listDir()`, plus the segment glob. For `one-level-glob`. */
  readonly dir?: string;
  readonly segment?: string;
}

/**
 * Decide how a declared global pattern may be probed — without touching a filesystem.
 *
 * The refusals matter more than the successes. A global filesystem is rooted at the
 * user's home directory, so `glob()` on it would walk *everything they own*: slow, noisy
 * with permission errors, and nondeterministic in a way no amount of sorting fixes. So a
 * pattern is either one `exists()` call or one `listDir()` of a named directory, and
 * anything needing a recursive walk is recorded as `unsupported` rather than attempted.
 *
 * No entry in any shipped adapter needs `**` today. The refusal exists so that adding one
 * is a visible decision instead of a silent home-directory crawl.
 */
export function parseGlobalPattern(pattern: string): GlobalPatternPlan {
  if (!pattern.startsWith(HOME_PREFIX)) return { kind: 'unsupported' };

  const rel = pattern.slice(HOME_PREFIX.length);
  // `..` would climb out of the home root. `escapesRoot` in the fs layer would refuse it
  // anyway; catching it here means the report says *why* rather than surfacing an error.
  if (rel === '' || rel.includes('**') || rel.split('/').includes('..')) {
    return { kind: 'unsupported' };
  }

  const star = rel.indexOf('*');
  if (star === -1) return { kind: 'literal', literal: rel };

  // A `*` is supported only in the final segment: anything earlier needs a walk.
  const dir = dirnamePosix(rel);
  const segment = rel.slice(dir === '' ? 0 : dir.length + 1);
  if (segment.includes('/') || dir.includes('*')) return { kind: 'unsupported' };

  return { kind: 'one-level-glob', dir, segment };
}

/** Re-attach the `~/` marker so nothing absolute reaches the report. */
export function toDisplayPath(homeRelative: string): string {
  return `${HOME_PREFIX}${homeRelative}`;
}

import type { DirEntry, ReadOnlyFileSystem } from './types.js';

/**
 * Path identity on a case-insensitive filesystem (T085).
 *
 * `computePlan` has case-folded its artifact-path conflict key since T069, because two
 * artifacts differing only in case are two entries for **one physical file** on APFS and
 * NTFS. Nothing downstream agreed: `state.json` lookups and `compareToDisk` matched paths
 * exactly, so a recorded `CLAUDE.md` and a planned `claude.md` were treated as two files —
 * which made `sync` refuse to write one of them as `unmanaged` *and* delete the other as an
 * orphan, both being the same file on disk.
 *
 * Two rules keep this from becoming a general "paths are case-insensitive" policy, which
 * would be wrong:
 *
 * 1. **Fold the lookup key, never the stored value.** A `StateArtifact.path` is written
 *    into a committed file and is what every message names; lower-casing it would put a
 *    spurious diff in every adopted repository and report a filename nobody has. Only map
 *    and set keys are folded.
 * 2. **Fold only where the filesystem actually folds.** On ext4 `CLAUDE.md` and
 *    `claude.md` are two real files, and treating them as one would leave a stale artifact
 *    on disk at exit 0 — the exact wrong answer T073 exists to fix. So the answer comes
 *    from `probeCaseInsensitive`, which asks the filesystem, rather than from
 *    `process.platform`, which is not evidence: a case-sensitive volume can be mounted on
 *    macOS and a case-insensitive one on Linux.
 *
 * Folding for *identity* is not folding for *order*. Every sort stays on
 * `compareCodepoint`; see `docs/determinism.md`.
 */

/** Case-fold a repo-relative path for use as an identity key. Never a stored value. */
export function foldPath(relPath: string): string {
  // `toLowerCase`, not `toLocaleLowerCase`: the locale-sensitive form makes the answer
  // depend on the host's locale, which `invariants.test.ts` bans for the same reason it
  // bans `.localeCompare`. `plan.ts` already folds this way.
  return relPath.toLowerCase();
}

/** How to key a path for lookup. Identity where the filesystem distinguishes case. */
export type PathKey = (relPath: string) => string;

export function pathKeyFor(caseInsensitive: boolean): PathKey {
  return caseInsensitive ? foldPath : (relPath) => relPath;
}

/** The same name with every cased character flipped. Unchanged if it has none. */
function flipCase(name: string): string {
  let flipped = '';
  for (const char of name) {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    flipped += char === lower ? upper : lower;
  }
  return flipped;
}

/**
 * Does this filesystem resolve two names differing only in case to one file?
 *
 * Read-only, and asked of the filesystem it is given rather than of the platform, so a
 * `MemoryFileSystem` and the git index view behind `check --staged` both answer "no" on
 * their own account — which is correct for the index, where git genuinely tracks
 * `CLAUDE.md` and `claude.md` as two entries.
 *
 * A directory that already lists both spellings is skipped rather than believed: the
 * second file is real there, not an alias for the first, so it proves nothing either way.
 */
export async function probeCaseInsensitive(fs: ReadOnlyFileSystem): Promise<boolean> {
  let entries: readonly DirEntry[];
  try {
    entries = await fs.listDir('');
  } catch {
    return false;
  }

  const listed = new Set(entries.map((e) => e.name));
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const flipped = flipCase(entry.name);
    // Skip any candidate the directory already lists. That covers both ways this question
    // goes unanswerable, which is why it is one check rather than two: a name with no
    // cased character flips to itself and is trivially listed, and a directory genuinely
    // holding both spellings has a real second file there — its existence is not evidence
    // of folding. An explicit "no cased character" branch ahead of this one was written
    // first and deleted: no input could reach it, which makes it a comment, not a guard.
    if (listed.has(flipped)) continue;
    return await fs.exists(flipped);
  }

  // Nothing at the root could answer. Assume case-sensitive, which is the behaviour
  // Rulegate had before this existed: a probe that cannot tell must not start folding.
  return false;
}

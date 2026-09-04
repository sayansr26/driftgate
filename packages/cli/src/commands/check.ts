import {
  StagedFileSystem,
  computePlan,
  createReadOnlyFileSystem,
  diffLines,
  formatHunks,
  gitTopLevel,
  resolveRepoRoot,
  verifyPlan,
  type ReadOnlyFileSystem,
  type VerifyEntry,
  type VerifyStatus,
} from '@driftgate/core';
import { ADAPTERS } from '../registry.js';
import { createOutput, formatErrors, pluralize } from '../ui/report.js';
import { renderDiff } from '../ui/diff.js';
import {
  HINT_HAND_EDITED,
  HINT_ORPHAN_HAND_EDITED,
  HINT_SYNC,
  HINT_UNMANAGED,
} from '../ui/hints.js';
import { ExitCode, type ExitCodeValue } from '../ui/exit.js';

export interface CheckOptions {
  readonly cwd: string;
  /** Name the repository root in the output; set only when the root was found by walking up (T074). */
  readonly announceRoot?: boolean;
  readonly quiet?: boolean;
  readonly color?: boolean;
  /**
   * Check the git **index** instead of the working tree — what a pre-commit hook needs
   * (T052), and its only consumer.
   *
   * Both sides come from the index. The question being asked is "if this commit lands, is
   * the repository in sync?", so canonical is read from the index too; rendering from the
   * working tree and comparing against the index would block a commit over a rule edited
   * but not staged, which is a correct answer to a question nobody asked.
   */
  readonly staged?: boolean;
}

/**
 * `sync`'s read-only twin: regenerate in memory, compare to disk, exit 1 on drift.
 *
 * It consumes the same `Plan` that `sync` applies — `computePlan` is the only renderer
 * in the codebase — so it cannot pass on a tree `sync` would change or fail on one it
 * would leave alone. The filesystem it holds has no write methods on it at all
 * (`createReadOnlyFileSystem`), and `invariants.test.ts` scans this file for the name of
 * the one function that writes; "read-only by construction" is meant literally.
 *
 * Output: for each out-of-sync path, a `status  path` line on stdout in the same style
 * as `sync`'s `wrote  path`, followed by a unified diff from what is on disk to what
 * canonical would generate — so `+` lines are what `sync` would write. The summary and
 * the recovery hints go to stderr, so `-q` leaves only the exit code and the advice.
 * CI reads the code: 0 in sync, 1 drift, and a usage mistake exits 2 elsewhere and never
 * here.
 */
export async function runCheck(options: CheckOptions): Promise<ExitCodeValue> {
  const out = createOutput({
    ...(options.quiet === undefined ? {} : { quiet: options.quiet }),
    ...(options.color === undefined ? {} : { color: options.color }),
  });
  const repoRoot = resolveRepoRoot(options.cwd);

  let fs: ReadOnlyFileSystem;
  if (options.staged === true) {
    // Refused rather than quietly falling back to the working tree. A hook author who
    // asked for the index must not be told the commit is clean on the strength of files
    // that are not in it — the same reasoning that made `--staged` exit 2 rather than be
    // accepted and ignored while it was unimplemented (T023).
    if ((await gitTopLevel(repoRoot)) === undefined) {
      out.error('--staged needs a git working tree, and this is not one.');
      out.error('hint: run driftgate check without --staged to check the working tree');
      return ExitCode.Failure;
    }
    fs = new StagedFileSystem(repoRoot);
  } else {
    fs = createReadOnlyFileSystem(repoRoot);
  }

  if (options.announceRoot === true) out.log(`repo  ${repoRoot}`);

  const plan = await computePlan({ repoRoot, fs, adapters: ADAPTERS });

  for (const warning of plan.warnings) out.error(warning.format());

  if (plan.errors.length > 0) {
    // A broken canonical source is not "in sync"; it is a repository nobody can render.
    // Exit 1 like `sync` does, and say what was not done.
    out.error(formatErrors(plan.errors));
    out.error(`\n${pluralize(plan.errors.length, 'error')}; nothing was checked.`);
    return ExitCode.Failure;
  }

  const report = await verifyPlan(plan, fs);
  for (const warning of report.warnings) out.error(warning.format());

  if (report.clean) {
    const what = options.staged === true ? ' staged' : '';
    out.log(`in sync (${pluralize(plan.artifacts.length, 'artifact')}${what})`);
    return ExitCode.Ok;
  }

  const width = Math.max(...report.entries.map((e) => e.status.length));
  for (const entry of report.entries) {
    out.log(`${entry.status.padEnd(width)}  ${entry.path}`);
    for (const line of diffFor(entry, out.c)) out.log(line);
  }

  const statuses = new Set<VerifyStatus>(report.entries.map((e) => e.status));
  out.error('');
  out.error(`${pluralize(report.entries.length, 'file')} out of sync.`);
  // One hint per situation present, in the order `sync` would meet them. The first is
  // the common case and the only one `sync` fixes on its own; the others name the file
  // `sync` would refuse and say what to do about it.
  if (statuses.has('stale') || statuses.has('missing') || statuses.has('orphaned')) {
    out.error(HINT_SYNC);
  }
  if (statuses.has('hand-edited')) out.error(HINT_HAND_EDITED);
  if (statuses.has('orphan-hand-edited')) out.error(HINT_ORPHAN_HAND_EDITED);
  if (statuses.has('unmanaged')) out.error(HINT_UNMANAGED);

  return ExitCode.Failure;
}

/**
 * The hunks for an entry that has both sides. A missing file and an orphan get only their
 * status line: a full-file diff of something that is entirely absent, or entirely due for
 * deletion, is noise about content the reader already knows.
 */
function diffFor(entry: VerifyEntry, c: Parameters<typeof renderDiff>[1]): string[] {
  if (entry.expected === undefined || entry.actual === undefined) return [];
  return renderDiff(formatHunks(diffLines(entry.actual, entry.expected)), c);
}

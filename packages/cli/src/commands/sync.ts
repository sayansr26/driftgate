import {
  applyCanonicalFiles,
  applyPlan,
  computeMergePlan,
  computePlan,
  diffLines,
  verifyPlan,
  formatHunks,
  NodeFileSystem,
  resolveRepoRoot,
} from '@rulegate/core';
import { ADAPTERS } from '../registry.js';
import { createOutput, formatErrors, pluralize } from '../ui/report.js';
import { renderDiff } from '../ui/diff.js';
import {
  HINT_HAND_EDITED,
  HINT_IMPORT,
  HINT_ORPHAN_HAND_EDITED,
  HINT_UNMANAGED,
} from '../ui/hints.js';
import { ExitCode, type ExitCodeValue } from '../ui/exit.js';
import type { Output } from '../ui/report.js';
import type { MergePlan } from '@rulegate/core';

export interface SyncOptions {
  readonly cwd: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  /**
   * Merge hand-edits on generated files back into `.rulegate/` (T051).
   *
   * Prints the merge and writes nothing without `--yes`, like `init` and `restore`. It is
   * a separate mode rather than a fallback inside an ordinary `sync` because recovering
   * an edit rewrites the user's canonical source, and that is never something to do
   * because a run happened to encounter a refusal.
   */
  readonly import?: boolean;
  /** Apply the merge `--import` printed. Meaningless without it. */
  readonly yes?: boolean;
  /**
   * Name the repository root in the output. Set only when the root was found by walking
   * up (T074): artifact paths are repo-relative, so from a subdirectory `wrote CLAUDE.md`
   * is ambiguous without an anchor. Running at the root prints exactly what it always did.
   */
  readonly announceRoot?: boolean;
  readonly quiet?: boolean;
  readonly color?: boolean;
}

export async function runSync(options: SyncOptions): Promise<ExitCodeValue> {
  const out = createOutput({
    ...(options.quiet === undefined ? {} : { quiet: options.quiet }),
    ...(options.color === undefined ? {} : { color: options.color }),
  });
  const repoRoot = resolveRepoRoot(options.cwd);
  const fs = new NodeFileSystem(repoRoot);

  // Mirrors `git rev-parse --show-toplevel`. On the log channel, so -q ("only print
  // errors") still means only errors.
  if (options.announceRoot === true) out.log(`repo  ${repoRoot}`);

  const plan = await computePlan({ repoRoot, fs, adapters: ADAPTERS });

  for (const warning of plan.warnings) out.error(warning.format());

  if (plan.errors.length > 0) {
    out.error(formatErrors(plan.errors));
    out.error(`\n${pluralize(plan.errors.length, 'error')}; nothing was written.`);
    return ExitCode.Failure;
  }

  if (options.import === true) {
    return runImport(plan, fs, out, options);
  }

  const report = await applyPlan(plan, fs, {
    dryRun: options.dryRun === true,
    force: options.force === true,
  });

  for (const warning of report.warnings) out.error(warning.format());

  const handEdited = report.skipped.filter((s) => s.reason === 'hand-edited');
  const unmanaged = report.skipped.filter((s) => s.reason === 'unmanaged');
  const staleOrphans = report.skipped.filter((s) => s.reason === 'orphan-hand-edited');

  if (report.skipped.length > 0) {
    for (const { path, reason } of report.skipped) {
      out.error(`${reason.padEnd(11)}  ${path}`);
    }
    out.error('');

    // The hints live in `ui/hints.ts` because `check` reports the same outcomes and must
    // give the same next step; the reasoning behind each wording is recorded there.
    if (handEdited.length > 0) {
      out.error(
        `${pluralize(handEdited.length, 'generated file')} changed by hand; nothing was overwritten.`,
      );
      out.error(HINT_HAND_EDITED);
      out.error(HINT_IMPORT);
    }

    if (staleOrphans.length > 0) {
      out.error(
        `${pluralize(staleOrphans.length, 'file')} no rule produces any more, changed by hand; nothing was deleted.`,
      );
      out.error(HINT_ORPHAN_HAND_EDITED);
    }

    if (unmanaged.length > 0) {
      out.error(
        `${pluralize(unmanaged.length, 'file')} rulegate did not generate; nothing was overwritten.`,
      );
      out.error(HINT_UNMANAGED);
    }
    return ExitCode.Failure;
  }

  const dry = options.dryRun === true;
  for (const path of report.backedUp) out.log(`backed up  .rulegate/backup/${path}`);
  // Deletions before writes: that is the order they happened in, and a user scanning
  // the output for what left the repository should not have to read past what entered it.
  for (const path of report.deleted) out.log(`${dry ? 'would delete' : 'deleted'}  ${path}`);
  for (const path of report.written) out.log(`${dry ? 'would write' : 'wrote'}  ${path}`);

  if (report.written.length === 0 && report.deleted.length === 0) {
    out.log(`up to date (${pluralize(plan.artifacts.length, 'artifact')})`);
  }

  return ExitCode.Ok;
}

/**
 * `sync --import`: recover hand-edits into `.rulegate/`, then stop.
 *
 * It deliberately does not go on to write artifacts. The merge changes the canonical
 * source, and what the user should see next is `sync` rendering *from what they now have*
 * — reported as its own run, with its own plan, rather than folded into the output of a
 * command that has just rewritten their rules.
 */
async function runImport(
  plan: Awaited<ReturnType<typeof computePlan>>,
  fs: NodeFileSystem,
  out: Output,
  options: SyncOptions,
): Promise<ExitCodeValue> {
  // `verifyPlan` rather than a second scan: `check` already answers "which generated files
  // no longer hold the bytes we wrote", and a merge that decided that question its own way
  // could offer to import a file `check` calls clean.
  const verify = await verifyPlan(plan, fs);
  const handEdited = verify.entries.filter((e) => e.status === 'hand-edited').map((e) => e.path);

  if (handEdited.length === 0) {
    out.log('no hand-edited generated files; nothing to import.');
    return ExitCode.Ok;
  }

  const merge: MergePlan = await computeMergePlan({
    repoRoot: fs.repoRoot,
    fs,
    adapters: ADAPTERS,
    canonical: plan.canonical,
    plan,
    handEdited,
  });

  for (const error of merge.errors) out.error(error.format());

  for (const m of merge.merges) {
    out.log(`${options.yes === true ? 'merged' : 'would merge'}  ${m.path}`);
    out.log(`  ${m.from.join(', ')}`);
    for (const line of renderDiff(formatHunks(diffLines(m.before, m.after)), out.c)) out.log(line);
  }

  // Refusals go to stderr and are never silent: a file this command declined to touch is
  // the one thing a user running it must not have to notice for themselves.
  for (const refusal of merge.refusals) {
    out.error('');
    out.error(`${refusal.reason.padEnd(14)}  ${refusal.path}`);
    out.error(`  ${refusal.detail}`);
  }

  if (merge.merges.length === 0) {
    out.error('');
    out.error('nothing could be imported; .rulegate/ is unchanged.');
    return ExitCode.Failure;
  }

  if (options.yes !== true) {
    out.log('');
    out.log(`run again with --yes to apply (${pluralize(merge.merges.length, 'rule')}).`);
    return ExitCode.Ok;
  }

  // `applyCanonicalFiles` is `init`'s writer, so the write allowlist and the three-file
  // pin in `pipeline/` are both unchanged by this command existing.
  await applyCanonicalFiles(merge.files, fs, { dryRun: options.dryRun === true });
  out.log('');
  out.log(`imported ${pluralize(merge.merges.length, 'rule')} into .rulegate/`);
  out.log('hint: run: rulegate sync');
  return merge.refusals.length > 0 ? ExitCode.Failure : ExitCode.Ok;
}

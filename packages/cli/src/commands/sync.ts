import { applyPlan, computePlan, NodeFileSystem, resolveRepoRoot } from '@driftgate/core';
import { ADAPTERS } from '../registry.js';
import { createOutput, formatErrors, pluralize } from '../ui/report.js';
import { ExitCode, type ExitCodeValue } from '../ui/exit.js';

export interface SyncOptions {
  readonly cwd: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
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

  const report = await applyPlan(plan, fs, {
    dryRun: options.dryRun === true,
    force: options.force === true,
  });

  const handEdited = report.skipped.filter((s) => s.reason === 'hand-edited');
  const unmanaged = report.skipped.filter((s) => s.reason === 'unmanaged');
  const staleOrphans = report.skipped.filter((s) => s.reason === 'orphan-hand-edited');

  if (report.skipped.length > 0) {
    for (const { path, reason } of report.skipped) {
      out.error(`${reason.padEnd(11)}  ${path}`);
    }
    out.error('');

    if (handEdited.length > 0) {
      out.error(
        `${pluralize(handEdited.length, 'generated file')} changed by hand; nothing was overwritten.`,
      );
      // Clobbering someone's edit is the one outcome worse than doing nothing.
      //
      // This hint names only what exists today. It used to advertise `sync --import`,
      // which is T051 and unimplemented, so following our own advice produced usage help
      // and exit 2 — the code that means the *user* made a mistake (T075).
      out.error(
        'hint: re-apply your edit in .driftgate/, then delete the generated file so sync' +
          ' can rewrite it. There is no in-place merge yet.',
      );
    }

    if (staleOrphans.length > 0) {
      // A third case, and reusing either message above would be wrong. This file is
      // ours — state.json records it — but no rule produces it any more, so "re-apply
      // your edit in .driftgate/" names a file that no longer has a rule to go back to.
      out.error(
        `${pluralize(staleOrphans.length, 'file')} no rule produces any more, changed by hand; nothing was deleted.`,
      );
      out.error(
        'hint: delete the file yourself to accept the removal, or restore the rule that' +
          ' generated it in .driftgate/rules/',
      );
    }

    if (unmanaged.length > 0) {
      // Different problem, different fix: this file is not a stale copy of our output,
      // it is the user's own writing. Telling them to "re-apply it in .driftgate/" as
      // though driftgate had authored it is how a tool talks its way into deleting work.
      out.error(
        `${pluralize(unmanaged.length, 'file')} driftgate did not generate; nothing was overwritten.`,
      );
      out.error(
        'hint: move the file aside to keep it, or run: driftgate sync --force' +
          ' (originals are copied to .driftgate/backup/ first)',
      );
    }
    return ExitCode.Failure;
  }

  const dry = options.dryRun === true;
  for (const path of report.backedUp) out.log(`backed up  .driftgate/backup/${path}`);
  // Deletions before writes: that is the order they happened in, and a user scanning
  // the output for what left the repository should not have to read past what entered it.
  for (const path of report.deleted) out.log(`${dry ? 'would delete' : 'deleted'}  ${path}`);
  for (const path of report.written) out.log(`${dry ? 'would write' : 'wrote'}  ${path}`);

  if (report.written.length === 0 && report.deleted.length === 0) {
    out.log(`up to date (${pluralize(plan.artifacts.length, 'artifact')})`);
  }

  return ExitCode.Ok;
}

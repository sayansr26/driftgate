import { applyPlan, computePlan, NodeFileSystem, resolveRepoRoot } from '@driftgate/core';
import { ADAPTERS } from '../registry.js';
import { createOutput, formatErrors, pluralize } from '../ui/report.js';
import { HINT_HAND_EDITED, HINT_ORPHAN_HAND_EDITED, HINT_UNMANAGED } from '../ui/hints.js';
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
    }

    if (staleOrphans.length > 0) {
      out.error(
        `${pluralize(staleOrphans.length, 'file')} no rule produces any more, changed by hand; nothing was deleted.`,
      );
      out.error(HINT_ORPHAN_HAND_EDITED);
    }

    if (unmanaged.length > 0) {
      out.error(
        `${pluralize(unmanaged.length, 'file')} driftgate did not generate; nothing was overwritten.`,
      );
      out.error(HINT_UNMANAGED);
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

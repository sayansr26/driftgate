import { applyPlan, computePlan, NodeFileSystem, resolveRepoRoot } from '@driftgate/core';
import { ADAPTERS } from '../registry.js';
import { createOutput, formatErrors, pluralize } from '../ui/report.js';
import { ExitCode, type ExitCodeValue } from '../ui/exit.js';

export interface SyncOptions {
  readonly cwd: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
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
      out.error('hint: re-apply your edit in .driftgate/, or run: driftgate sync --import');
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

  const verb = options.dryRun === true ? 'would write' : 'wrote';
  for (const path of report.backedUp) out.log(`backed up  .driftgate/backup/${path}`);
  for (const path of report.written) out.log(`${verb}  ${path}`);

  if (report.written.length === 0) {
    out.log(`up to date (${pluralize(plan.artifacts.length, 'artifact')})`);
  }

  return ExitCode.Ok;
}

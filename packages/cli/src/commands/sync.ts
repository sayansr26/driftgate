import { applyPlan, computePlan, NodeFileSystem, resolveRepoRoot } from '@driftgate/core';
import { ADAPTERS } from '../registry.js';
import { createOutput, formatErrors, pluralize } from '../ui/report.js';
import { ExitCode, type ExitCodeValue } from '../ui/exit.js';

export interface SyncOptions {
  readonly cwd: string;
  readonly dryRun?: boolean;
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

  const report = await applyPlan(plan, fs, { dryRun: options.dryRun === true });

  if (report.skipped.length > 0) {
    for (const { path } of report.skipped) {
      out.error(`hand-edited  ${path}`);
    }
    out.error(
      `\n${pluralize(report.skipped.length, 'generated file')} changed by hand; nothing was overwritten.`,
    );
    // Clobbering someone's edit is the one outcome worse than doing nothing.
    out.error('hint: re-apply your edit in .driftgate/, or run: driftgate sync --import');
    return ExitCode.Failure;
  }

  const verb = options.dryRun === true ? 'would write' : 'wrote';
  for (const path of report.written) out.log(`${verb}  ${path}`);

  if (report.written.length === 0) {
    out.log(`up to date (${pluralize(plan.artifacts.length, 'artifact')})`);
  }

  return ExitCode.Ok;
}

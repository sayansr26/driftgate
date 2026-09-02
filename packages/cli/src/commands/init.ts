import {
  NodeFileSystem,
  applyCanonicalFiles,
  applyPlan,
  computeInitPlan,
  resolveRepoRoot,
} from '@driftgate/core';
import { ADAPTERS } from '../registry.js';
import { createOutput, formatErrors, pluralize } from '../ui/report.js';
import { ExitCode, type ExitCodeValue } from '../ui/exit.js';

export interface InitOptions {
  readonly cwd: string;
  /** Apply the plan. Without it `init` prints and writes nothing. */
  readonly yes?: boolean;
  readonly announceRoot?: boolean;
  readonly quiet?: boolean;
  readonly color?: boolean;
}

/**
 * The first command anybody runs, on a repository Driftgate did not write.
 *
 * It prints the whole plan and stops. Nothing is written without `--yes`, and the plan it
 * prints is the plan that `--yes` applies — computed by `computePlan`, the same renderer
 * `sync` and `check` use, so `init` cannot promise something the first `sync` then does
 * not do.
 */
export async function runInit(options: InitOptions): Promise<ExitCodeValue> {
  const out = createOutput({
    ...(options.quiet === undefined ? {} : { quiet: options.quiet }),
    ...(options.color === undefined ? {} : { color: options.color }),
  });
  const repoRoot = resolveRepoRoot(options.cwd);
  const fs = new NodeFileSystem(repoRoot);

  if (options.announceRoot === true) out.log(`repo  ${repoRoot}`);

  const init = await computeInitPlan({ repoRoot, fs, adapters: ADAPTERS });

  if (init.adopted) {
    out.log('.driftgate/ already exists; nothing to import.');
    out.log(`run: driftgate sync  (${pluralize(init.plan.artifacts.length, 'artifact')})`);
    return ExitCode.Ok;
  }

  if (init.errors.length > 0) {
    out.error(formatErrors(init.errors));
    out.error(`\n${pluralize(init.errors.length, 'error')}; nothing was written.`);
    return ExitCode.Failure;
  }

  if (init.detected.length === 0) {
    out.log('no AI tool configuration found in this repository.');
    out.log('hint: create .driftgate/rules/*.md by hand, then run: driftgate sync');
    return ExitCode.Ok;
  }

  out.log(`detected  ${init.detected.join(', ')}`);
  out.log(`imported  ${pluralize(init.canonical.rules.length, 'rule')}`);
  out.log('');

  for (const file of init.canonicalFiles) out.log(`${verb(file.kind, options)}  ${file.path}`);

  // What happens to the user's existing files is the question they actually have, and it
  // is answered before anything is written rather than discovered on the next command.
  if (init.plan.artifacts.length > 0) {
    out.log('');
    out.log(
      `then \`driftgate sync\` would write ${pluralize(init.plan.artifacts.length, 'file')}:`,
    );
    for (const artifact of init.plan.artifacts) out.log(`  ${artifact.path}`);
  }

  for (const warning of init.warnings) {
    out.error('');
    out.error(warning.format());
  }

  if (init.conflicts.length > 0) {
    out.error('');
    out.error(
      `${pluralize(init.conflicts.length, 'pair')} of rules look like the same rule with different content:`,
    );
    for (const conflict of init.conflicts) {
      const where = conflict.variants
        .map((v) => `${v.rule.source.file} (${v.tools.join(', ')})`)
        .join('  vs  ');
      out.error(`  ${where}`);
    }
    // Kept, both of them, and said out loud. Merging them would mean deleting one of two
    // things the user wrote on the strength of a similarity score; the honest move is to
    // import both and point at them.
    out.error('  both were imported. review them in .driftgate/rules/ and merge by hand.');
  }

  if (options.yes !== true) {
    out.log('');
    out.log('nothing was written. re-run with --yes to apply.');
    return ExitCode.Ok;
  }

  const canonicalWritten = await applyCanonicalFiles(init.canonicalFiles, fs, { dryRun: false });

  // `force` because every file this plan touches is one `init` just imported *from*.
  // Taking ownership is exactly what the user asked for, and `applyPlan` copies each
  // original into `.driftgate/backup/` before overwriting it — which is the difference
  // between taking ownership and taking someone's work.
  const report = await applyPlan(init.plan, fs, { dryRun: false, force: true });

  out.log('');
  for (const path of canonicalWritten.written) out.log(`wrote  ${path}`);
  for (const path of report.backedUp) out.log(`backed up  .driftgate/backup/${path}`);
  for (const path of report.written) out.log(`wrote  ${path}`);

  if (report.skipped.length > 0) {
    for (const { path, reason } of report.skipped) out.error(`${reason.padEnd(11)}  ${path}`);
    out.error(`\n${pluralize(report.skipped.length, 'file')} was left alone.`);
    return ExitCode.Failure;
  }

  out.log('');
  out.log('done. edit .driftgate/rules/ and run: driftgate sync');
  return ExitCode.Ok;
}

function verb(kind: 'create' | 'modify' | 'leave-alone', options: InitOptions): string {
  const applying = options.yes === true;
  if (kind === 'leave-alone') return 'unchanged';
  if (kind === 'create') return applying ? 'create   ' : 'would create';
  return applying ? 'modify   ' : 'would modify';
}

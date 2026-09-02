import { NodeFileSystem, planRestore, resolveRepoRoot, restoreFromBackup } from '@driftgate/core';
import { createOutput, pluralize } from '../ui/report.js';
import { ExitCode, type ExitCodeValue } from '../ui/exit.js';

export interface RestoreOptions {
  readonly cwd: string;
  /** Restore only these repo-relative paths. Empty means everything in the backup. */
  readonly only?: readonly string[];
  readonly yes?: boolean;
  readonly announceRoot?: boolean;
  readonly quiet?: boolean;
  readonly color?: boolean;
}

/**
 * Put back the originals Driftgate copied into `.driftgate/backup/`.
 *
 * Writes nothing without `--yes`, which is `init`'s idiom rather than a second one:
 * restoring overwrites files that currently exist, so it is a destructive operation and
 * the invariant says those are dry-run by default. Printing the plan first is also the
 * only way a user can tell whether the backup still holds what they think it does.
 */
export async function runRestore(options: RestoreOptions): Promise<ExitCodeValue> {
  const out = createOutput({
    ...(options.quiet === undefined ? {} : { quiet: options.quiet }),
    ...(options.color === undefined ? {} : { color: options.color }),
  });
  const repoRoot = resolveRepoRoot(options.cwd);
  const fs = new NodeFileSystem(repoRoot);

  if (options.announceRoot === true) out.log(`repo  ${repoRoot}`);

  const candidates = await planRestore(fs, options.only ?? []);

  if (candidates.length === 0) {
    const scoped = (options.only ?? []).length > 0;
    out.log(
      scoped
        ? 'nothing in .driftgate/backup/ matches those paths'
        : '.driftgate/backup/ is empty; there is nothing to restore',
    );
    return ExitCode.Ok;
  }

  const apply = options.yes === true;

  for (const candidate of candidates) {
    if (candidate.identical) {
      out.log(`identical  ${candidate.to}`);
      continue;
    }
    const verb = apply ? 'restored' : 'would restore';
    const note = candidate.missing ? '' : ' (overwrites the current file)';
    out.log(`${verb}  ${candidate.to}${note}`);
  }

  if (!apply) {
    out.log('');
    out.log(`nothing was written. run: driftgate restore --yes`);
    return ExitCode.Ok;
  }

  const report = await restoreFromBackup(candidates, fs, { dryRun: false });

  out.log('');
  out.log(`restored ${pluralize(report.restored.length, 'file')} from .driftgate/backup/`);
  if (report.restored.length > 0) {
    // Saying so is the difference between a surprise and a stated consequence: a
    // restored file that driftgate still generates now differs from what `sync` would
    // write, which is exactly what "hand-edited" means.
    out.log(
      'note: any restored file driftgate still generates will read as hand-edited to the next sync',
    );
  }

  return ExitCode.Ok;
}

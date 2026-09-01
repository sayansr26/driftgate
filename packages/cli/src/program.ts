import { Command } from 'commander';
import { readVersion } from './version.js';
import { runSync } from './commands/sync.js';
import { ExitCode } from './ui/exit.js';

export { ExitCode };

export function buildProgram(): Command {
  const program = new Command()
    .name('driftgate')
    .description('One source of truth for your AI coding agents.')
    .version(readVersion())
    .option('--cwd <dir>', 'repository root', process.cwd())
    .option('--no-color', 'disable color output')
    .option('-q, --quiet', 'only print errors')
    .showHelpAfterError()
    .exitOverride((err) => {
      // Commander exits 1 for usage errors by default, which is indistinguishable
      // from drift. CI reads the code, not the message, so a typo in a workflow file
      // must not be reported as configuration drift.
      if (err.code === 'commander.version' || err.code === 'commander.helpDisplayed') {
        process.exit(ExitCode.Ok);
      }
      process.exit(err.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage);
    });

  program
    .command('sync')
    .description('Regenerate every enabled tool config from .driftgate/')
    .option('--dry-run', 'report what would change without writing')
    .action(async (opts: { dryRun?: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ cwd: string; quiet?: boolean; color?: boolean }>();
      const code = await runSync({
        cwd: globals.cwd,
        ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
        ...(globals.quiet === undefined ? {} : { quiet: globals.quiet }),
        ...(globals.color === undefined ? {} : { color: globals.color }),
      });
      process.exitCode = code;
    });

  return program;
}

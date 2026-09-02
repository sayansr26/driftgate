import { Command } from 'commander';
import { readVersion } from './version.js';
import { runInit } from './commands/init.js';
import { runSync } from './commands/sync.js';
import { runDoctor } from './commands/doctor.js';
import { resolveGlobalCwd } from './cwd.js';
import { ExitCode } from './ui/exit.js';

export { ExitCode };

export function buildProgram(): Command {
  const program = new Command()
    .name('driftgate')
    .description('One source of truth for your AI coding agents.')
    .version(readVersion())
    // No default: commander evaluates one at build time, which makes an explicit --cwd
    // indistinguishable from the default and leaks the invoking machine's path into --help.
    .option('--cwd <dir>', 'repository root; without it, search upward for one')
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

  // Registered before `sync` because it is the first command a new repository needs, and
  // because two error messages and RFC §8 have been telling users to run it since M0
  // while it did not exist — following our own advice exited 2 (T077).
  program
    .command('init')
    .description(
      'Import existing tool configs into .driftgate/ (prints a plan; writes nothing without --yes)',
    )
    .option('--yes', 'apply the plan instead of only printing it')
    .action(async (opts: { yes?: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ cwd?: string; quiet?: boolean; color?: boolean }>();
      const { root, searched } = resolveGlobalCwd(globals.cwd);
      const code = await runInit({
        cwd: root,
        ...(searched ? { announceRoot: true } : {}),
        ...(opts.yes === undefined ? {} : { yes: opts.yes }),
        ...(globals.quiet === undefined ? {} : { quiet: globals.quiet }),
        ...(globals.color === undefined ? {} : { color: globals.color }),
      });
      process.exitCode = code;
    });

  program
    .command('sync')
    .description('Regenerate every enabled tool config from .driftgate/')
    .option('--dry-run', 'report what would change without writing')
    .option(
      '--force',
      'take ownership of files driftgate did not generate, backing each up to .driftgate/backup/ first',
    )
    .action(async (opts: { dryRun?: boolean; force?: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ cwd?: string; quiet?: boolean; color?: boolean }>();
      const { root, searched } = resolveGlobalCwd(globals.cwd);
      const code = await runSync({
        cwd: root,
        ...(searched ? { announceRoot: true } : {}),
        ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
        ...(opts.force === undefined ? {} : { force: opts.force }),
        ...(globals.quiet === undefined ? {} : { quiet: globals.quiet }),
        ...(globals.color === undefined ? {} : { color: globals.color }),
      });
      process.exitCode = code;
    });

  program
    .command('doctor')
    .description('Report which tools are configured, what they load, and what it costs')
    .option('--no-global', 'skip user-level files; read nothing outside the repository')
    .option('--json', 'emit the full report as JSON')
    .action(async (opts: { global?: boolean; json?: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ cwd?: string; quiet?: boolean; color?: boolean }>();
      const { root, searched } = resolveGlobalCwd(globals.cwd);
      const code = await runDoctor({
        cwd: root,
        ...(searched ? { announceRoot: true } : {}),
        // commander stores --no-global as `global: false`.
        ...(opts.global === false ? { noGlobal: true } : {}),
        ...(opts.json === undefined ? {} : { json: opts.json }),
        ...(globals.quiet === undefined ? {} : { quiet: globals.quiet }),
        ...(globals.color === undefined ? {} : { color: globals.color }),
      });
      process.exitCode = code;
    });

  return program;
}

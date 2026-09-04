import { Command } from 'commander';
import { readVersion } from './version.js';
import { runInit } from './commands/init.js';
import { runSync } from './commands/sync.js';
import { runCheck } from './commands/check.js';
import { runDoctor } from './commands/doctor.js';
import { runRestore } from './commands/restore.js';
import { runAdapterNew } from './commands/adapter/index.js';
import { resolveGlobalCwd } from './cwd.js';
import { ExitCode } from './ui/exit.js';

export { ExitCode };

export function buildProgram(): Command {
  const program = new Command()
    .name('rulegate')
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
      'Import existing tool configs into .rulegate/ (prints a plan; writes nothing without --yes)',
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
    .description('Regenerate every enabled tool config from .rulegate/')
    .option('--dry-run', 'report what would change without writing')
    .option(
      '--force',
      'overwrite hand-edited and unowned files, backing each up to .rulegate/backup/ first',
    )
    // `--import` is the non-destructive half of the same problem: `--force` discards the
    // edit (after a backup), this recovers it. Both exist so that meeting a hand-edited
    // file is a choice rather than a dead end (T051, T075).
    .option('--import', 'merge hand-edits on generated files back into .rulegate/')
    .option('--yes', 'apply the merge --import printed')
    .action(
      async (
        opts: { dryRun?: boolean; force?: boolean; import?: boolean; yes?: boolean },
        cmd: Command,
      ) => {
        const globals = cmd.optsWithGlobals<{ cwd?: string; quiet?: boolean; color?: boolean }>();
        const { root, searched } = resolveGlobalCwd(globals.cwd);
        const code = await runSync({
          cwd: root,
          ...(searched ? { announceRoot: true } : {}),
          ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
          ...(opts.force === undefined ? {} : { force: opts.force }),
          ...(opts.import === undefined ? {} : { import: opts.import }),
          ...(opts.yes === undefined ? {} : { yes: opts.yes }),
          ...(globals.quiet === undefined ? {} : { quiet: globals.quiet }),
          ...(globals.color === undefined ? {} : { color: globals.color }),
        });
        process.exitCode = code;
      },
    );

  // Directly after `sync` because it is `sync`'s read-only twin: same plan, same
  // vocabulary, and --help should show the pair together. `--staged` arrived with T052:
  // it reads the git index, which is the one place in shipped source that spawns a
  // process, and the pre-commit hook is its only consumer.
  program
    .command('check')
    .description('Verify generated tool configs match .rulegate/ (read-only; exits 1 on drift)')
    .option('--staged', 'check the git index instead of the working tree (for pre-commit hooks)')
    .action(async (opts: { staged?: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ cwd?: string; quiet?: boolean; color?: boolean }>();
      const { root, searched } = resolveGlobalCwd(globals.cwd);
      const code = await runCheck({
        cwd: root,
        ...(searched ? { announceRoot: true } : {}),
        ...(opts.staged === undefined ? {} : { staged: opts.staged }),
        ...(globals.quiet === undefined ? {} : { quiet: globals.quiet }),
        ...(globals.color === undefined ? {} : { color: globals.color }),
      });
      process.exitCode = code;
    });

  // After `sync` because it is `sync --force`'s and orphan deletion's undo, and a reader
  // scanning --help should meet the operation before its reversal.
  program
    .command('restore')
    .description(
      'Put back originals kept in .rulegate/backup/ (prints a plan; writes nothing without --yes)',
    )
    .argument('[path...]', 'restore only these repo-relative paths; omit for everything')
    .option('--yes', 'apply the plan instead of only printing it')
    .action(async (paths: string[], opts: { yes?: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ cwd?: string; quiet?: boolean; color?: boolean }>();
      const { root, searched } = resolveGlobalCwd(globals.cwd);
      const code = await runRestore({
        cwd: root,
        only: paths,
        ...(searched ? { announceRoot: true } : {}),
        ...(opts.yes === undefined ? {} : { yes: opts.yes }),
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

  // Last, and grouped under its own noun, because it is the only command aimed at
  // contributors rather than at users: it writes into a checkout of this monorepo, not
  // into the repository being managed.
  const adapter = program
    .command('adapter')
    .description('Adapter authoring helpers for contributors to the rulegate repo');

  adapter
    .command('new')
    .argument('<tool>', 'adapter id, lowercase kebab-case (e.g. kiro)')
    .description('Scaffold an adapter, its fixtures and its tests (writes nothing without --yes)')
    .option('--yes', 'apply the plan instead of only printing it')
    .action(async (tool: string, opts: { yes?: boolean }, cmd: Command) => {
      const globals = cmd.optsWithGlobals<{ cwd?: string; quiet?: boolean; color?: boolean }>();
      const { root, searched } = resolveGlobalCwd(globals.cwd);
      const code = await runAdapterNew({
        cwd: root,
        tool,
        ...(searched ? { announceRoot: true } : {}),
        ...(opts.yes === undefined ? {} : { yes: opts.yes }),
        ...(globals.quiet === undefined ? {} : { quiet: globals.quiet }),
        ...(globals.color === undefined ? {} : { color: globals.color }),
      });
      process.exitCode = code;
    });

  return program;
}

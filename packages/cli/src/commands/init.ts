import {
  NodeFileSystem,
  applyCanonicalFiles,
  applyPlan,
  computeInitPlan,
  resolveRepoRoot,
  type McpTransport,
} from '@rulegate/core';
import { ADAPTERS } from '../registry.js';
import { INTEROP } from '@rulegate/interop';
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
 * The first command anybody runs, on a repository Rulegate did not write.
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

  const init = await computeInitPlan({ repoRoot, fs, adapters: ADAPTERS, interop: INTEROP });

  if (init.adopted) {
    out.log('.rulegate/ already exists; nothing to import.');
    out.log(`run: rulegate sync  (${pluralize(init.plan.artifacts.length, 'artifact')})`);
    return ExitCode.Ok;
  }

  if (init.errors.length > 0) {
    out.error(formatErrors(init.errors));
    out.error(`\n${pluralize(init.errors.length, 'error')}; nothing was written.`);
    return ExitCode.Failure;
  }

  if (init.detected.length === 0) {
    out.log('no AI tool configuration found in this repository.');
    out.log('hint: create .rulegate/rules/*.md by hand, then run: rulegate sync');
    return ExitCode.Ok;
  }

  out.log(`detected  ${init.detected.join(', ')}`);
  if (init.interop.length > 0) {
    // Named separately from `detected`: these are tools Rulegate is taking over *from*,
    // not tools it will generate for, and printing them in one list would suggest a
    // `ruler` config is about to be maintained.
    out.log(`migrating from  ${init.interop.join(', ')}`);
  }
  out.log(
    `imported  ${pluralize(init.canonical.rules.length, 'rule')}` +
      (init.canonical.mcpServers.length > 0
        ? `, ${pluralize(init.canonical.mcpServers.length, 'MCP server')}`
        : ''),
  );
  out.log('');

  for (const file of init.canonicalFiles) out.log(`${verb(file.kind, options)}  ${file.path}`);

  // What happens to the user's existing files is the question they actually have, and it
  // is answered before anything is written rather than discovered on the next command.
  if (init.plan.artifacts.length > 0) {
    out.log('');
    out.log(`then \`rulegate sync\` would write ${pluralize(init.plan.artifacts.length, 'file')}:`);
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
    out.error('  both were imported. review them in .rulegate/rules/ and merge by hand.');
  }

  if (init.mcpConflicts.length > 0) {
    out.error('');
    out.error(
      `${pluralize(init.mcpConflicts.length, 'MCP server')} defined differently by different tools:`,
    );
    for (const conflict of init.mcpConflicts) {
      out.error(`  ${conflict.id}`);
      for (const variant of conflict.variants) {
        const taken = variant === conflict.variants[0] ? '  <- taken' : '';
        out.error(`    ${describeServer(variant.server)}  (${variant.tools.join(', ')})${taken}`);
      }
    }
    // Unlike a rule conflict this one has to be resolved here: `servers:` is a mapping and
    // the id is the key, so two definitions cannot both survive. Importing neither would be
    // worse than picking — the first `sync` would then remove the server from every tool
    // config and break a setup that worked five minutes ago.
    out.error('  one definition was taken. review it in .rulegate/mcp/servers.yaml.');
  }

  if (options.yes !== true) {
    out.log('');
    out.log('nothing was written. re-run with --yes to apply.');
    return ExitCode.Ok;
  }

  const canonicalWritten = await applyCanonicalFiles(init.canonicalFiles, fs, { dryRun: false });

  // `force` because every file this plan touches is one `init` just imported *from*.
  // Taking ownership is exactly what the user asked for, and `applyPlan` copies each
  // original into `.rulegate/backup/` before overwriting it — which is the difference
  // between taking ownership and taking someone's work.
  const report = await applyPlan(init.plan, fs, { dryRun: false, force: true });

  out.log('');
  for (const path of canonicalWritten.written) out.log(`wrote  ${path}`);
  for (const path of report.backedUp) out.log(`backed up  .rulegate/backup/${path}`);
  for (const path of report.written) out.log(`wrote  ${path}`);

  if (report.skipped.length > 0) {
    for (const { path, reason } of report.skipped) out.error(`${reason.padEnd(11)}  ${path}`);
    out.error(`\n${pluralize(report.skipped.length, 'file')} was left alone.`);
    return ExitCode.Failure;
  }

  out.log('');
  out.log('done. edit .rulegate/rules/ and run: rulegate sync');
  return ExitCode.Ok;
}

function verb(kind: 'create' | 'modify' | 'leave-alone', options: InitOptions): string {
  const applying = options.yes === true;
  if (kind === 'leave-alone') return 'unchanged';
  if (kind === 'create') return applying ? 'create   ' : 'would create';
  return applying ? 'modify   ' : 'would modify';
}

/** One line describing what a server connects to, for the conflict report. */
function describeServer(server: { readonly transport: McpTransport }): string {
  const t = server.transport;
  return t.kind === 'stdio' ? [t.command, ...t.args].join(' ') : `${t.kind} ${t.url}`;
}

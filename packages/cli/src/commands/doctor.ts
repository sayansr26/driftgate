import {
  NodeFileSystem,
  buildDoctorReport,
  createHomeFileSystem,
  resolveRepoRoot,
} from '@driftgate/core';
import { ADAPTERS } from '../registry.js';
import { createOutput, formatErrors, formatTokens, pluralize } from '../ui/report.js';
import { formatTable } from '../ui/table.js';
import { ExitCode, type ExitCodeValue } from '../ui/exit.js';
import type { Colors, Output } from '../ui/report.js';
import type { DoctorReport, FileDiagnosis, ToolDiagnosis } from '@driftgate/core';

export interface DoctorOptions {
  readonly cwd: string;
  /** Skip the user-level probe entirely; nothing outside the repository is read. */
  readonly noGlobal?: boolean;
  /** Emit the report as JSON for scripting, instead of the table. */
  readonly json?: boolean;
  readonly announceRoot?: boolean;
  readonly quiet?: boolean;
  readonly color?: boolean;
}

/** Terminals narrower than this are treated as 80: below it, nothing helps. */
const MIN_WIDTH = 80;

/**
 * Report what each detected tool will actually load, and what it costs.
 *
 * Exits 0 even with warnings. `check` owns exit 1 for drift, and that is CI's whole
 * contract — two commands returning the same code for materially different conditions is
 * exactly the confusion the exit-code table exists to prevent. Several of doctor's findings
 * (Copilot's additive mechanisms, say) are also permanent and correct, and a gate that
 * fails on a correct permanent condition is a gate people mute. Exit 1 is reserved for
 * doctor being unable to report at all.
 */
export async function runDoctor(options: DoctorOptions): Promise<ExitCodeValue> {
  const out = createOutput({
    ...(options.quiet === undefined ? {} : { quiet: options.quiet }),
    ...(options.color === undefined ? {} : { color: options.color }),
  });
  const repoRoot = resolveRepoRoot(options.cwd);
  const fs = new NodeFileSystem(repoRoot);
  const globalFs = options.noGlobal === true ? undefined : createHomeFileSystem();

  const report = await buildDoctorReport({
    repoRoot,
    fs,
    adapters: ADAPTERS,
    ...(globalFs === undefined ? {} : { globalFs }),
  });

  if (report.errors.length > 0) {
    out.error(formatErrors(report.errors));
    out.error(`\n${pluralize(report.errors.length, 'error')}; the report may be incomplete.`);
    return ExitCode.Failure;
  }

  if (options.json === true) {
    out.log(JSON.stringify(report, null, 2));
    return ExitCode.Ok;
  }

  if (options.announceRoot === true) out.log(`repo  ${repoRoot}`);
  printReport(out, report);
  return ExitCode.Ok;
}

function printReport(out: Output, report: DoctorReport): void {
  const width = Math.max(MIN_WIDTH, process.stdout.columns ?? MIN_WIDTH);
  const c = out.c;

  if (!report.adopted) {
    out.log('');
    out.log(c.dim('no .driftgate/ here — reporting what these tools load today.'));
  }

  const present = report.tools.filter((t) => t.detected);
  if (present.length === 0) {
    out.log('');
    out.log('no supported tools detected in this repository.');
    return;
  }

  for (const tool of present) {
    out.log('');
    out.log(`${c.bold(tool.toolName)}  ${c.dim(summary(tool))}`);
    for (const line of fileLines(tool, width, c)) out.log(`  ${line}`);
  }

  const undetected = report.tools.filter((t) => !t.detected).map((t) => t.name);
  if (undetected.length > 0) {
    out.log('');
    out.log(c.dim(`not detected: ${undetected.join(', ')}`));
  }
  if (!report.globalProbed) {
    // "Did not look" is not "found nothing", and a report that omits the difference invites
    // the reader to conclude their user-level config is absent.
    out.log(c.dim('user-level files were not probed.'));
  }

  // Warnings go to stderr so `-q` ("only print errors") still surfaces them, and so a
  // piped table stays a clean table.
  for (const w of report.warnings) {
    out.error('');
    out.error(`${c.yellow('!')} ${w.tool === undefined ? '' : `${w.tool}: `}${w.message}`);
    for (const line of listPaths(w.paths)) out.error(`  ${c.dim(line)}`);
    if (w.source !== undefined) out.error(`  ${c.dim(`${w.source.title} — ${w.source.url}`)}`);
  }
}

/** Show enough paths to act on, then a count. A hundred paths is not evidence, it is noise. */
const MAX_LISTED_PATHS = 5;

function listPaths(paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const shown = paths.slice(0, MAX_LISTED_PATHS).map((p) => p);
  if (paths.length > MAX_LISTED_PATHS) {
    shown.push(`… and ${paths.length - MAX_LISTED_PATHS} more`);
  }
  return shown;
}

function summary(tool: ToolDiagnosis): string {
  const files = pluralize(tool.loadedCount, 'file');
  const enabled = tool.enabled ? '' : ', not enabled in .driftgate/';
  return `will load ${files} ${formatTokens(tool.loadedTokens)} tokens${enabled}`;
}

function fileLines(tool: ToolDiagnosis, width: number, c: Colors): string[] {
  const rows = tool.files.map((f) => [
    describePath(f),
    f.status,
    f.status === 'absent' || f.status === 'not-probed' ? '' : formatTokens(f.tokens),
    annotate(f, tool),
  ]);

  return formatTable(
    [{ priority: 0 }, { priority: 3 }, { align: 'right', priority: 2 }, { priority: 1 }],
    rows,
    // Two leading spaces of indent are spent by the caller.
    width - 2,
  ).map((line, i) => (tool.files[i]?.loaded === true ? line : c.dim(line)));
}

function describePath(f: FileDiagnosis): string {
  if (f.paths.length === 0) return f.pattern;
  if (f.paths.length === 1) return f.paths[0] ?? f.pattern;
  // Name the declared path and count the rest. Listing every nested copy inline turns a
  // repository with test fixtures into a wall of paths and buries the row that matters.
  if (!f.paths.includes(f.pattern)) return `${f.pattern} (${f.paths.length})`;
  return `${f.pattern} +${f.paths.length - 1} nested`;
}

function annotate(f: FileDiagnosis, tool: ToolDiagnosis): string {
  const notes: string[] = [];
  if (f.role !== 'instructions') notes.push(f.role);
  if (f.shadowed) notes.push('shadowed');
  if (f.managedBy !== undefined && f.managedBy !== tool.name) notes.push(`from ${f.managedBy}`);
  return notes.join(', ');
}

import { computePlan } from '../pipeline/plan.js';
import { detectTools } from '../detect/engine.js';
import { compareToDisk } from '../state/compare.js';
import { EMPTY_STATE, parseState } from '../state/state.js';
import { STATE_PATH } from '../model/paths.js';
import { SymlinkProbe, resolveTool } from './resolve.js';
import {
  buildManagedByIndex,
  duplicateLoadWarnings,
  orphanWarnings,
  overLimitWarnings,
  sortWarnings,
  symlinkWarnings,
  toolNoteWarnings,
} from './warnings.js';
import type { Adapter } from '../adapter/adapter.js';
import type { FileResolution } from '../adapter/docs.js';
import type { DriftgateError } from '../model/errors.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';
import type { DoctorReport, DoctorWarning, ToolDiagnosis } from './types.js';

export interface DoctorInput {
  readonly repoRoot: string;
  /** Rooted at the repository. */
  readonly fs: ReadOnlyFileSystem;
  readonly adapters: readonly Adapter[];
  /**
   * Rooted at the user's home directory, when the caller chooses to supply one.
   *
   * A parameter rather than something this module constructs, for the reasons `DetectInput`
   * gives at length: it keeps `node:fs` and `node:os` out of the algorithm, keeps the whole
   * thing unit-testable against `MemoryFileSystem`, and inherits containment from
   * `escapesRoot` rather than reimplementing it.
   */
  readonly globalFs?: ReadOnlyFileSystem;
}

/**
 * What will each tool read, what does it cost, and what is wrong with it?
 *
 * Reads only, and never throws for anything a repository could contain. It runs on
 * repositories that have never adopted Driftgate — that is its primary audience, and the
 * first thing `init` will ask of it — so a missing canonical source sets `adopted: false`
 * and is not an error. Only a canonical source that exists and cannot be parsed is.
 *
 * The algorithm lives in core and the roster is a parameter, the same split `detectTools`
 * and `computePlan` already use: core must contain no tool-specific logic, and the test
 * that runs the five real adapters therefore lives in `packages/cli/test/`.
 */
export async function buildDoctorReport(input: DoctorInput): Promise<DoctorReport> {
  const { repoRoot, fs, adapters, globalFs } = input;

  const plan = await computePlan({ repoRoot, fs, adapters });
  const adopted = !plan.errors.some((e) => e.code === 'E_NO_CANONICAL_SOURCE');
  const errors: readonly DriftgateError[] = plan.errors.filter(
    (e) => e.code !== 'E_NO_CANONICAL_SOURCE',
  );

  const detection = await detectTools({
    repoRoot,
    fs,
    canonical: plan.canonical,
    adapters,
    ...(globalFs === undefined ? {} : { globalFs }),
  });

  const comparison = await compareToDisk(
    parseState(await fs.tryReadFile(STATE_PATH)) ?? EMPTY_STATE,
    plan.artifacts,
    fs,
  );

  const managedBy = buildManagedByIndex(adapters);
  const byName = new Map(adapters.map((a) => [a.name, a]));
  const symlinks = new SymlinkProbe(fs);

  const tools: ToolDiagnosis[] = [];
  const warnings: DoctorWarning[] = [];

  // Sequentially, never `Promise.all`. `detect/engine.ts` records the reason: a loop that
  // appends in settle order produces a different report on a slow disk, which is a
  // nondeterminism bug that only shows up on somebody else's machine.
  for (const detected of detection.tools) {
    const adapter = byName.get(detected.name);
    if (adapter === undefined) continue;
    const docs = adapter.docs;
    const resolution: FileResolution = docs.resolution ?? 'override';

    const resolved = await resolveTool(docs, {
      fs,
      ...(globalFs === undefined ? {} : { globalFs }),
      detection: detected,
      comparison,
      managedBy,
      symlinks,
    });

    const diagnosis: ToolDiagnosis = {
      name: detected.name,
      toolName: docs.toolName,
      detected: detected.detected,
      enabled: plan.enabledAdapters.includes(detected.name),
      evidence: detected.evidence,
      resolution,
      files: resolved.files,
      loadedCount: resolved.loaded.length,
      loadedBytes: resolved.loaded.reduce((n, m) => n + m.bytes, 0),
      loadedTokens: resolved.loaded.reduce((n, m) => n + m.tokens, 0),
      ...(detected.failed === undefined ? {} : { failed: detected.failed }),
    };
    tools.push(diagnosis);

    warnings.push(...duplicateLoadWarnings(diagnosis, resolved.loaded));
    warnings.push(...overLimitWarnings(diagnosis, docs, resolved.loaded));
    warnings.push(...toolNoteWarnings(diagnosis, docs));
  }

  warnings.push(...symlinkWarnings(symlinks.found()));
  warnings.push(...(await orphanWarnings(fs, comparison, adapters, tools)));

  return {
    repoRoot,
    adopted,
    globalProbed: detection.globalProbed,
    tools,
    warnings: sortWarnings(warnings),
    errors,
  };
}

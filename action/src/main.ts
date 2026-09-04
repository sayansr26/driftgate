import { gatherCheck, reportCheck } from 'rulegate';
import { renderAnnotations } from './annotate.js';
import { joinWorkspace, readBooleanInput, readInput } from './inputs.js';

/**
 * GitHub Action wrapper for `rulegate check`: exit 1 when a generated agent config has
 * drifted from `.rulegate/`, with the drift marked inline on the pull request's diff.
 *
 * Invoked at module top level on purpose. The original stub exported a `main()` that
 * nothing called, so `node dist/main.js` loaded a module, did nothing, and exited 0 — an
 * Action that reported "no drift" for the whole of M1 without ever looking. Only a
 * spawned process can prove otherwise, which is why the dist lane spawns it.
 *
 * `check` runs in-process rather than spawning the CLI: no subprocess anywhere in shipped
 * source is a mechanical invariant, and the exit code is the CLI's own.
 *
 * One gathering pass feeds both outputs. The Action deliberately does **not** call
 * `computePlan`/`verifyPlan` itself — it consumes the same `CheckResult` the CLI renders,
 * so the annotations on a PR and the log beneath them cannot disagree about which files
 * are in sync.
 */
const options = {
  cwd: joinWorkspace(readInput('working-directory')),
  // Actions logs are not a TTY, and picocolors force-enables colour under `CI`.
  color: false,
};

const result = await gatherCheck(options);

// Before the log, so the annotations are on the stream whatever the log does with it.
if (readBooleanInput('annotations', true) && result.kind === 'verified') {
  for (const line of renderAnnotations(result.report)) process.stdout.write(`${line}\n`);
}

process.exitCode = reportCheck(result, options);

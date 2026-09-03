import { runCheck } from 'driftgate';

/**
 * GitHub Action wrapper for `driftgate check`: exit 1 when a generated agent config has
 * drifted from `.driftgate/`. The versioned marketplace Action with a committed build and
 * annotated diffs is T053; this is the composite the workspace runs.
 *
 * Invoked at module top level on purpose. The previous stub exported a `main()` that
 * nothing called, so `node dist/main.js` loaded a module, did nothing, and exited 0 — an
 * Action that reported "no drift" for the whole of M1 without ever looking. `check` runs
 * in-process rather than spawning the CLI: no subprocess anywhere in shipped source is a
 * mechanical invariant, and the exit code is the CLI's own.
 */
process.exitCode = await runCheck({
  cwd: process.env['GITHUB_WORKSPACE'] ?? process.cwd(),
  // Actions logs are not a TTY, and picocolors force-enables colour under `CI`.
  color: false,
});

import path from 'node:path';

/**
 * Read an `action.yml` input.
 *
 * The runner passes inputs as `INPUT_<NAME>` environment variables, uppercased with
 * spaces turned into underscores. Hand-rolled rather than taken from `@actions/core`:
 * the runtime dependency allowlist is `yaml`, `commander`, `picocolors` and
 * `invariants.test.ts` applies it to `action/package.json` too, so a fourth runtime
 * dependency for three lines of `process.env` lookup is not a trade this project makes.
 */
export function readInput(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return (env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] ?? '').trim();
}

/**
 * A boolean input, per the YAML 1.2 core schema the runner documents for them.
 *
 * Anything else falls back to the default rather than being read as false: a workflow
 * that says `annotations: yes` meant yes, and silently turning that into "off" is a
 * feature quietly disabling itself.
 */
export function readBooleanInput(
  name: string,
  fallback: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = readInput(name, env).toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

/**
 * Where to check, resolved against the checkout.
 *
 * `GITHUB_WORKSPACE` is the checkout root on a runner and absent everywhere else, so a
 * local `node dist/main.js` still checks the current directory. A relative
 * `working-directory` is resolved against the workspace, never against the process's cwd,
 * because on a runner those are the same only by accident.
 */
export function joinWorkspace(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const workspace = env['GITHUB_WORKSPACE'] ?? process.cwd();
  if (dir === '') return workspace;
  return path.resolve(workspace, dir);
}

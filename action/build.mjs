import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Bundle the Action into the single file GitHub runs.
 *
 * A published Action gets no `npm install`: the runner checks the repository out and runs
 * `dist/main.js` as it stands. It bundles the CLI through its `exports` map, so the input
 * is `packages/cli/dist` and this must run after `pnpm build`. `driftgate` and its six workspace packages resolve only
 * through the pnpm workspace symlink, so the tsc output that served the in-repo composite
 * cannot work for a consumer. Everything is bundled and the result is committed.
 *
 * A script rather than a flag string in `package.json` because of the banner. `commander`
 * is CommonJS, and esbuild's ESM output replaces `require` with a stub that throws
 * `Dynamic require of "node:events" is not supported` — on the first line of the first
 * command, so the failure is total and invisible until the bundle is run from outside the
 * workspace. Defining a real `require` fixes it, and the banner's quotes cannot be spelled
 * portably in a `package.json` script: POSIX shells and `cmd.exe` disagree about single
 * quotes, and CI runs three platforms.
 */
const BANNER = 'import{createRequire}from"node:module";var require=createRequire(import.meta.url);';

const outfile = fileURLToPath(new URL('dist/main.js', import.meta.url));

const result = await build({
  entryPoints: [fileURLToPath(new URL('src/main.ts', import.meta.url))],
  // Pinned, not inherited. esbuild writes each bundled module's path into the output as a
  // comment, relative to the working directory — so without this the bundle's bytes depend
  // on the directory it was invoked from: `pnpm build` (cwd `action/`) and
  // `node action/build.mjs` (cwd the repo root) produced files 624 bytes apart. A
  // committed artifact whose contents depend on how you invoked the build is exactly the
  // nondeterminism `docs/determinism.md` calls a P0, and the freshness gate would have
  // flapped forever.
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  legalComments: 'none',
  banner: { js: BANNER },
  // Written by this script, not by esbuild, so `--check` can compare without touching
  // the committed file.
  write: false,
  outfile,
});

const [output] = result.outputFiles;
if (output === undefined) throw new Error('esbuild produced no output');

/**
 * `--check` is the CI gate. A committed build rots the moment somebody edits `src/` and
 * forgets to rebuild, and a stale bundle is worse than no bundle: the Action keeps
 * working and keeps reporting the behaviour of an older commit. Same discipline as
 * `pnpm fixtures:update` reporting `fixtures are up to date`.
 */
if (process.argv.includes('--check')) {
  const committed = await readFile(outfile, 'utf8').catch(() => undefined);
  if (committed === output.text) {
    console.log('action/dist/main.js is up to date');
    process.exit(0);
  }
  console.error('action/dist/main.js is stale: it does not match a fresh build of action/src.');
  console.error('run: pnpm --filter @driftgate/action build   and commit the result');
  process.exit(1);
}

await writeFile(outfile, output.text);
console.log(`action/dist/main.js  ${String(output.text.length)} bytes`);

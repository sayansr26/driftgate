#!/usr/bin/env node
/**
 * End-to-end smoke: pack every workspace package, install the CLI the way a user would,
 * and run `init` -> `sync` -> `check` on a throwaway repository (T029).
 *
 * This is the only thing that exercises the *published* artifact rather than the source
 * tree: `pnpm test` aliases `@rulegate/*` to source, and even the `RULEGATE_TEST_DIST=1`
 * lane runs `dist/` from inside the workspace, where a missing file in `files` or a wrong
 * path in `exports` still resolves. A package that installs but cannot be imported is a
 * launch-day failure, and it is invisible until somebody installs it.
 *
 * `npx rulegate` proper cannot be smoked before the package exists on the registry
 * (T037): the CLI depends on six workspace packages that nobody can download yet. What
 * this does instead is the same install through npm — tarballs, `overrides` pinning each
 * `@rulegate/*` to its tarball, `node_modules/.bin/rulegate` — which is the identical
 * resolution path with the registry swapped out.
 *
 * Spawning processes is why this lives in `scripts/` rather than in `packages/`:
 * `invariants.test.ts` scans shipped source for `child_process` and finds none.
 *
 * Usage: pnpm build && node scripts/smoke.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const isWindows = process.platform === 'win32';
const bin = (name) => (isWindows ? `${name}.cmd` : name);

const PACKAGES = [
  'rulegate',
  '@rulegate/core',
  '@rulegate/adapter-kit',
  '@rulegate/adapter-claude-code',
  '@rulegate/adapter-codex',
  '@rulegate/adapter-copilot',
  '@rulegate/adapter-cline',
  '@rulegate/adapter-aider',
  '@rulegate/adapter-cursor',
  '@rulegate/adapter-roo-code',
  '@rulegate/adapter-zed',
  '@rulegate/interop',
  '@rulegate/adapter-windsurf',
  '@rulegate/adapter-gemini',
];

/** `@rulegate/adapter-claude-code` -> `rulegate-adapter-claude-code-0.0.0.tgz`. */
const tarballName = (name) => `${name.replace('@', '').replace('/', '-')}-0.0.0.tgz`;

const failures = [];
function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === '' ? '' : `\n      ${detail}`}`);
  if (!ok) failures.push(what);
}

/**
 * `shell: true` on Windows is not a convenience: since Node 20.12, spawning a `.cmd`
 * without a shell throws EINVAL, and `pnpm`, `npm` and the installed `rulegate` are all
 * `.cmd` shims there. Arguments that contain a space are quoted, because passing them
 * through a shell is what makes that possible in the first place.
 */
function run(cmd, args, options = {}) {
  const quoted = isWindows ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  const result = spawnSync(cmd, quoted, { encoding: 'utf8', shell: isWindows, ...options });
  if (result.error) throw result.error;
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const work = mkdtempSync(path.join(tmpdir(), 'rulegate-smoke-'));
const tarballs = path.join(work, 'tarballs');
const project = path.join(work, 'project');
const repo = path.join(work, 'repo');
mkdirSync(tarballs);
mkdirSync(project);
mkdirSync(path.join(repo, '.cursor/rules'), { recursive: true });

try {
  // 1. Pack. `pnpm pack` rewrites `workspace:*` to the real version, which is exactly the
  //    rewrite that will be published — and exactly the one no test would otherwise see.
  const packed = run(
    bin('pnpm'),
    ['-r', '--filter', './packages/**', 'exec', 'pnpm', 'pack', '--pack-destination', tarballs],
    { cwd: repoRoot },
  );
  check(packed.code === 0, 'pnpm pack', packed.stderr.trim().slice(0, 400));

  for (const name of PACKAGES) {
    check(existsSync(path.join(tarballs, tarballName(name))), `packed ${name}`);
  }

  // 2. Install, resolving every `@rulegate/*` to its tarball rather than to the registry.
  const overrides = Object.fromEntries(
    PACKAGES.map((name) => [
      name,
      `file:${path.join(tarballs, tarballName(name)).replace(/\\/g, '/')}`,
    ]),
  );
  writeFileSync(
    path.join(project, 'package.json'),
    `${JSON.stringify(
      {
        name: 'rulegate-smoke',
        private: true,
        version: '1.0.0',
        dependencies: { rulegate: overrides['rulegate'] },
        overrides,
      },
      null,
      2,
    )}\n`,
  );

  const installStart = Date.now();
  const install = run(bin('npm'), ['install', '--no-audit', '--no-fund'], { cwd: project });
  const installSeconds = (Date.now() - installStart) / 1000;
  check(install.code === 0, 'npm install from tarballs', install.stderr.trim().slice(0, 600));

  const rulegate = path.join(project, 'node_modules', '.bin', bin('rulegate'));
  const dg = (args, cwd = repo) => run(rulegate, args, { cwd });

  // 3. A cold run of the installed binary. NFR2 asks for under 10 seconds; the install
  //    itself is reported rather than asserted, since it is npm's clock, not ours.
  const coldStart = Date.now();
  const version = dg(['--version']);
  const coldSeconds = (Date.now() - coldStart) / 1000;
  check(version.code === 0, 'installed binary runs', version.stdout.trim());
  check(coldSeconds < 10, `cold start under 10s (${coldSeconds.toFixed(2)}s)`);
  console.log(`      install took ${installSeconds.toFixed(1)}s`);

  // 4. A repository that has never heard of Rulegate: two tools' native config, no
  //    `.rulegate/`. This is `init`'s whole reason to exist.
  writeFileSync(
    path.join(repo, 'CLAUDE.md'),
    '# House rules\n\n## Style\n\nPrefer small modules.\n',
  );
  writeFileSync(
    path.join(repo, '.cursor/rules/testing.mdc'),
    '---\ndescription: Testing\nglobs:\nalwaysApply: true\n---\n\nColocate tests.\n',
  );

  const plan = dg(['init']);
  check(plan.code === 0, 'init prints a plan', plan.stdout.trim().split('\n').slice(-1)[0]);
  check(!existsSync(path.join(repo, '.rulegate')), 'init writes nothing without --yes');

  const init = dg(['init', '--yes']);
  check(init.code === 0, 'init --yes', init.stderr.trim().slice(0, 400));
  check(existsSync(path.join(repo, '.rulegate/rulegate.yaml')), 'init created the manifest');

  const sync = dg(['sync']);
  check(sync.code === 0, 'sync', sync.stderr.trim().slice(0, 400));

  const clean = dg(['check']);
  check(clean.code === 0, 'check is clean after sync', clean.stdout.trim());

  // 5. The differentiator, end to end: a hand-edited artifact must fail with a diff.
  const claude = path.join(repo, 'CLAUDE.md');
  writeFileSync(claude, `${readFileSync(claude, 'utf8')}\nhand-edited\n`);
  const drift = dg(['check']);
  check(drift.code === 1, 'check exits 1 on drift');
  check(/hand-edited/.test(drift.stdout + drift.stderr), 'check shows the drifted line');

  const doctor = dg(['doctor', '--no-global']);
  check(doctor.code === 0, 'doctor exits 0', doctor.stdout.trim().split('\n')[0]);

  // 6. Usage errors are exit 2, never 1. CI reads the code, and a typo in a workflow file
  //    must not be reported as configuration drift.
  check(dg(['nonesuch']).code === 2, 'an unknown command exits 2');
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nsmoke ok');

#!/usr/bin/env node
/**
 * File the seeded `good first adapter` issues in `.github/adapter-requests/` on GitHub.
 *
 * The issues are checked in rather than written straight into the tracker because an issue
 * body cannot be reviewed, diffed or corrected once filed, and because these were written
 * before the repository was public. This script is the one-way door between the two.
 *
 * Lives at the repo root for the same reason `update-fixtures.mjs` does: it spawns a
 * process, and `packages/core/test/invariants.test.ts` scans shipped source for
 * `child_process` and must keep finding none.
 *
 * Usage: node scripts/seed-issues.mjs [tool] [--yes] [--repo owner/name]
 *
 * Without `--yes` it prints what it would file and creates nothing.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const requestsDir = path.join(repoRoot, '.github/adapter-requests');

// Same guard as fixtures:update, for the same reason in a different direction: a workflow
// that could open ten issues on every push is a workflow that will, once.
if (process.env['CI'] !== undefined && process.env['CI'] !== '') {
  console.error('seed-issues must never run in CI — filing issues is a deliberate act.');
  process.exit(2);
}

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const repoIndex = args.indexOf('--repo');
const repo = repoIndex === -1 ? undefined : args[repoIndex + 1];
const only = args.filter((a, i) => !a.startsWith('--') && i !== repoIndex + 1);

/** `--- title / labels --- body`. Hand-rolled: `yaml` is a runtime dependency of the tool,
 *  and a dev script does not get to add one. */
function parse(file, text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) throw new Error(`${file}: no frontmatter block`);
  const [, head, body] = match;
  const fields = new Map();
  for (const line of head.split('\n')) {
    const at = line.indexOf(':');
    if (at === -1) throw new Error(`${file}: cannot parse frontmatter line: ${line}`);
    fields.set(
      line.slice(0, at).trim(),
      line
        .slice(at + 1)
        .trim()
        // Both quote styles: the seeds use single quotes, because a YAML title containing
        // `: ` must be quoted and `'adapter: Kiro'` is what an author naturally writes.
        // Stripping only `"` filed the quotes as part of the issue title.
        .replace(/^(['"])([\s\S]*)\1$/, '$2'),
    );
  }
  const title = fields.get('title');
  if (title === undefined || title === '') throw new Error(`${file}: no title`);
  const labels = (fields.get('labels') ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (body.trim() === '') throw new Error(`${file}: empty body`);
  return { title, labels, body };
}

/**
 * Has this adapter already been written?
 *
 * Every seed says "<tool> is not supported yet", which stops being true the moment the
 * adapter lands — and the file cannot know that, because it was written months earlier.
 * Filing one anyway asks a stranger to build something that ships, which reads as an
 * unmaintained tracker. Five of the original ten were already stale by the time the
 * repository went public, so this is the common case, not the edge one.
 *
 * The directory listing is the source of truth for the same reason `registry.test.ts`
 * pins `ADAPTERS` to it: a hand-kept list is a list that goes stale exactly here.
 */
async function alreadyShipped(id) {
  try {
    return (await stat(path.join(repoRoot, 'packages/adapters', id))).isDirectory();
  } catch {
    return false;
  }
}

const candidates = (await readdir(requestsDir))
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .filter((f) => only.length === 0 || only.includes(path.basename(f, '.md')))
  .sort();

const files = [];
const shipped = [];
for (const f of candidates) {
  const id = path.basename(f, '.md');
  ((await alreadyShipped(id)) ? shipped : files).push(f);
}

for (const f of shipped) {
  console.log(
    `skip      ${path.basename(f, '.md')} — packages/adapters/${path.basename(f, '.md')} exists`,
  );
}
if (shipped.length > 0) console.log('');

if (files.length === 0) {
  console.error(
    shipped.length > 0
      ? `nothing to file: every match is already implemented (${shipped.length} skipped)`
      : only.length === 0
        ? 'no issue files found'
        : `no issue file matched ${only.join(', ')}`,
  );
  // Not an error when the reason is that the work is done — a script that exits non-zero
  // for "you already built these" is one a future release workflow has to special-case.
  process.exit(shipped.length > 0 ? 0 : 2);
}

const issues = [];
for (const file of files) {
  issues.push({ file, ...parse(file, await readFile(path.join(requestsDir, file), 'utf8')) });
}

for (const issue of issues) {
  const lines = issue.body.trim().split('\n').length;
  console.log(`${apply ? 'file' : 'would file'}  ${issue.title}`);
  console.log(`          ${issue.file} · ${lines} lines · labels: ${issue.labels.join(', ')}`);
}

if (!apply) {
  console.log(`\n${issues.length} issue${issues.length === 1 ? '' : 's'}. Nothing was created.`);
  console.log('re-run with --yes to file them, and --repo owner/name to pick the repository.');
  process.exit(0);
}

// `gh` is required rather than an HTTP call, because this script must not become the only
// place in the project that holds a token. Zero network calls is the tool's invariant; this
// is a dev script, and it borrows the credentials the maintainer already has.
try {
  await run('gh', ['--version']);
} catch {
  console.error('gh is not installed or not on PATH: https://cli.github.com');
  process.exit(1);
}

/**
 * Titles already open or closed on the tracker.
 *
 * Without this, a second `--yes` files every seed again: the files stay checked in after
 * filing, so "already done" is invisible to the script. Matching on title rather than on a
 * marker in the file keeps the tracker as the source of truth — someone may have filed one
 * by hand, or closed it, and neither shows up in the repository.
 */
const existing = new Set();
try {
  const listArgs = ['issue', 'list', '--state', 'all', '--limit', '200', '--json', 'title'];
  if (repo !== undefined) listArgs.push('--repo', repo);
  const { stdout } = await run('gh', listArgs, { cwd: repoRoot });
  for (const { title } of JSON.parse(stdout)) existing.add(title);
} catch (error) {
  console.error(
    `could not read existing issues, refusing to risk duplicates: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

let filed = 0;
let skippedExisting = 0;
for (const issue of issues) {
  if (existing.has(issue.title)) {
    console.log(`exists    ${issue.title} — already on the tracker, not filed again`);
    skippedExisting += 1;
    continue;
  }
  const argv = ['issue', 'create', '--title', issue.title, '--body', issue.body];
  for (const label of issue.labels) argv.push('--label', label);
  if (repo !== undefined) argv.push('--repo', repo);
  try {
    const { stdout } = await run('gh', argv, { cwd: repoRoot });
    console.log(`filed  ${issue.title}  ${stdout.trim()}`);
    filed += 1;
  } catch (error) {
    // Keep going: a missing label fails one issue, and stopping would leave the rest
    // unfiled with no record of which succeeded.
    console.error(
      `failed ${issue.title}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const attempted = issues.length - skippedExisting;
console.log(
  `\n${filed}/${attempted} filed` +
    (skippedExisting > 0 ? `, ${skippedExisting} already on the tracker.` : '.'),
);
process.exitCode = filed === attempted ? 0 : 1;

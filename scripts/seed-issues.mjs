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
import { readdir, readFile } from 'node:fs/promises';
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
        .replace(/^"|"$/g, ''),
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

const files = (await readdir(requestsDir))
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .filter((f) => only.length === 0 || only.includes(path.basename(f, '.md')))
  .sort();

if (files.length === 0) {
  console.error(
    only.length === 0 ? 'no issue files found' : `no issue file matched ${only.join(', ')}`,
  );
  process.exit(2);
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

let filed = 0;
for (const issue of issues) {
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

console.log(`\n${filed}/${issues.length} filed.`);
process.exitCode = filed === issues.length ? 0 : 1;

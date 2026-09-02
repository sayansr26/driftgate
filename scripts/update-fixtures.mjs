#!/usr/bin/env node
/**
 * Regenerate `fixtures/<tool>/expected/` from the current adapters.
 *
 * Lives at the repo root, not in `packages/`, and that is deliberate:
 * `packages/core/test/invariants.test.ts` allows filesystem writes only in
 * `core/src/io/`, `pipeline/apply.ts` and `fs/types.ts`, and it scans `packages/`. Putting
 * a writer inside `adapter-kit` would have meant widening that allowlist — weakening a
 * P0 invariant to make a dev script convenient. A published package that adapters depend
 * on should not contain a filesystem writer, for the same reason `AdapterContext` has no
 * writer.
 *
 * Regenerating is never a substitute for hand-authoring a new golden. A fixture written
 * by the adapter it is supposed to check proves only that the adapter agrees with itself;
 * `expected/` is hand-written from the tool's documented behavior first, and this script
 * exists for the case where an intended change touches many fixtures at once.
 *
 * Usage: pnpm build && pnpm fixtures:update [tool] [--yes]
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const fixturesRoot = path.join(repoRoot, 'fixtures');

// Refusing under CI is one of three independent guards; the others are that nothing in
// `pnpm test` or `pnpm verify` imports this file, and that it writes nothing without
// --yes. A fixture silently regenerated in CI would turn every adapter regression green.
if (process.env['CI'] !== undefined && process.env['CI'] !== '') {
  console.error(
    'fixtures:update must never run in CI — a regenerated golden hides the regression it exists to catch.',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const only = args.filter((a) => !a.startsWith('--'));

const { ADAPTERS } = await import(path.join(repoRoot, 'packages/cli/dist/registry.js')).catch(
  () => {
    console.error('build first: pnpm build && pnpm fixtures:update');
    process.exit(2);
  },
);
const { renderFixture } = await import(
  path.join(repoRoot, 'packages/adapter-kit/dist/testing/index.js')
);

/** Every `fixtures/<dir>` that has both `input/` and `expected/`. */
async function writeFixtures() {
  const entries = await readdir(fixturesRoot, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const names = await readdir(path.join(fixturesRoot, entry.name)).catch(() => []);
    if (names.includes('input') && names.includes('expected')) out.push(entry.name);
  }
  return out.sort();
}

function adapterFor(fixture) {
  // `cursor-legacy` is the cursor adapter with an option set; the longest matching
  // adapter name wins so `claude-code` is not mistaken for a prefix of something else.
  return [...ADAPTERS]
    .filter((a) => fixture === a.name || fixture.startsWith(`${a.name}-`))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

async function existingExpected(dir) {
  const out = new Map();
  const walk = async (abs, prefix) => {
    for (const entry of await readdir(abs, { withFileTypes: true }).catch(() => [])) {
      const child = path.join(abs, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, rel);
      else out.set(rel, await readFile(child, 'utf8'));
    }
  };
  await walk(dir, '');
  return out;
}

const changes = [];
for (const fixture of await writeFixtures()) {
  if (only.length > 0 && !only.includes(fixture)) continue;
  const adapter = adapterFor(fixture);
  if (adapter === undefined) {
    console.error(`no adapter matches fixture \`${fixture}\``);
    process.exit(1);
  }

  const rendered = await renderFixture(fixture, adapter);
  const expectedDir = path.join(fixturesRoot, fixture, 'expected');
  const current = await existingExpected(expectedDir);

  for (const [rel, contents] of rendered) {
    if (current.get(rel) !== contents) {
      changes.push({ kind: current.has(rel) ? 'update' : 'create', fixture, rel, contents });
    }
  }
  for (const rel of current.keys()) {
    // A golden left behind after an adapter stops producing it is how a deleted artifact
    // escapes notice: every run keeps asserting a file nothing generates any more.
    if (!rendered.has(rel)) changes.push({ kind: 'delete', fixture, rel });
  }
}

if (changes.length === 0) {
  console.log('fixtures are up to date');
  process.exit(0);
}

for (const { kind, fixture, rel } of changes) {
  console.log(`${kind.padEnd(6)} fixtures/${fixture}/expected/${rel}`);
}

if (!apply) {
  console.log(
    `\n${String(changes.length)} change(s); nothing was written. re-run with --yes to apply.`,
  );
  process.exit(0);
}

for (const change of changes) {
  const target = path.join(fixturesRoot, change.fixture, 'expected', change.rel);
  // Scoped by construction rather than by intent: this script deletes files, and the
  // repository's central promise is that Driftgate never deletes what it did not generate.
  const prefix = path.join(fixturesRoot, change.fixture, 'expected') + path.sep;
  if (!path.resolve(target).startsWith(prefix)) {
    console.error(`refusing to touch a path outside the fixture: ${target}`);
    process.exit(1);
  }
  if (change.kind === 'delete') {
    await rm(target);
    continue;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, change.contents, 'utf8');
}
console.log(`\napplied ${String(changes.length)} change(s)`);

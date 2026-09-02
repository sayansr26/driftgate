import { compareCodepoint } from '@driftgate/core';
import { formatDifference } from './diff.js';

/**
 * Comparing a rendered fixture against its golden `expected/` tree.
 *
 * Pure: no filesystem, no assertion library. The kit's runtime dependency allowlist is
 * `yaml`, `commander`, `picocolors` — pulling a test framework into a *published* package
 * is exactly what that invariant exists to prevent — so failures are reported by returning
 * a value here and thrown as a plain `Error` in `assert.ts`. That also makes an adapter
 * scaffolded by T028 runner-agnostic.
 */

export interface FixtureReport {
  readonly ok: boolean;
  /** In `expected/`, absent from the render. Sorted. */
  readonly missing: readonly string[];
  /** Rendered, absent from `expected/`. Sorted. */
  readonly unexpected: readonly string[];
  /** Present in both, differing bytes. Sorted by path. */
  readonly differing: readonly { readonly path: string; readonly detail: string }[];
}

export function compareFixture(
  actual: ReadonlyMap<string, string>,
  expected: ReadonlyMap<string, string>,
): FixtureReport {
  const missing: string[] = [];
  const differing: { path: string; detail: string }[] = [];

  for (const [path, contents] of expected) {
    const rendered = actual.get(path);
    if (rendered === undefined) {
      missing.push(path);
      continue;
    }
    if (rendered !== contents) {
      differing.push({ path, detail: formatDifference(contents, rendered) });
    }
  }

  const unexpected = [...actual.keys()].filter((path) => !expected.has(path));

  missing.sort(compareCodepoint);
  unexpected.sort(compareCodepoint);
  differing.sort((a, b) => compareCodepoint(a.path, b.path));

  return {
    ok: missing.length === 0 && unexpected.length === 0 && differing.length === 0,
    missing,
    unexpected,
    differing,
  };
}

export function formatFixtureReport(fixture: string, report: FixtureReport): string {
  if (report.ok) return '';
  const out = [`fixture \`${fixture}\` does not match its golden output`];
  if (report.missing.length > 0) {
    out.push('', 'expected but not produced:', ...report.missing.map((p) => `  - ${p}`));
  }
  if (report.unexpected.length > 0) {
    out.push('', 'produced but not expected:', ...report.unexpected.map((p) => `  + ${p}`));
  }
  for (const { path, detail } of report.differing) {
    out.push('', `${path}:`, detail);
  }
  out.push(
    '',
    'if this change is intended, regenerate with: pnpm fixtures:update --yes',
    'if it is not, the adapter changed its output — that is an adapter regression (P0).',
  );
  return out.join('\n');
}

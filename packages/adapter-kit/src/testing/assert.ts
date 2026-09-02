import { MARKER_TEXT, type Adapter } from '@driftgate/core';
import { compareFixture, formatFixtureReport } from './compare.js';
import {
  importContextFor,
  importFixture,
  importFixtureRules,
  readExpected,
  readInput,
  renderFixture,
} from './fixture.js';

/**
 * The two assertions every adapter's write tests need, so they stop being copied.
 *
 * They throw a plain `Error` rather than calling an assertion library: see `compare.ts`
 * for why the kit must not depend on a test framework.
 */

/** Renders `fixtures/<fixture>/input` and asserts it matches `fixtures/<fixture>/expected` byte for byte. */
export async function expectFixtureMatch(fixture: string, adapter: Adapter): Promise<void> {
  const report = compareFixture(await renderFixture(fixture, adapter), await readExpected(fixture));
  if (!report.ok) throw new Error(formatFixtureReport(fixture, report));
}

/**
 * Renders repeatedly and asserts every run is byte-identical.
 *
 * Determinism is a contract (NFR4), and the cheap way it breaks is a `Map`, `Set` or
 * `readdir` order that happens to be stable within one run.
 */
export async function expectIdempotent(
  fixture: string,
  adapter: Adapter,
  iterations = 10,
): Promise<void> {
  const first = [...(await renderFixture(fixture, adapter))];
  for (let i = 1; i <= iterations; i += 1) {
    const again = [...(await renderFixture(fixture, adapter))];
    if (JSON.stringify(again) !== JSON.stringify(first)) {
      throw new Error(
        `fixture \`${fixture}\` rendered differently on run ${String(i + 1)} of ${String(iterations + 1)} — rendering is not deterministic`,
      );
    }
  }
}

/**
 * Imports `fixtures/<tool>-import/input` and asserts the canonical rules it produces match
 * `fixtures/<tool>-import/expected` byte for byte.
 */
export async function expectImportMatch(tool: string, adapter: Adapter): Promise<void> {
  const report = compareFixture(
    await importFixtureRules(tool, adapter),
    await readExpected(`${tool}-import`),
  );
  if (!report.ok) throw new Error(formatFixtureReport(`${tool}-import`, report));
}

/**
 * T017's stated validation: import loses zero user content.
 *
 * Every non-blank line of every named source file must be findable in the imported
 * rules — in a body, a description, a glob, or a preserved unknown key. Lines are
 * reduced before the search because the renderer's own syntax legitimately does not
 * survive: `## Style` becomes a description of `Style`, and a backticked glob loses its
 * backticks. What is *not* allowed to vanish is the text itself.
 *
 * Four line shapes are exempt, and each is a fact about the format rather than a
 * convenience: the frontmatter fences, our own generated-by marker, and `alwaysApply`,
 * which is derived from `globs` on the way out and so must not be stored on the way back
 * in. Anything else missing is content loss, which is the failure this asserts against.
 */
/** Copilot quotes its scalars, and a doubled quote is YAML's only escape in that style. */
function unquote(value: string): string {
  return value.startsWith("'") && value.endsWith("'") && value.length >= 2
    ? value.slice(1, -1).replace(/''/g, "'")
    : value;
}

export async function expectContentCovered(
  tool: string,
  adapter: Adapter,
  files: readonly string[],
): Promise<void> {
  const dir = importFixture(tool).input;
  const rules = (await adapter.read(importContextFor(dir))).rules ?? [];

  const haystack = rules
    .flatMap((rule) => [
      rule.body,
      rule.frontmatter.description ?? '',
      rule.frontmatter.globs.join('\n'),
      Object.values(rule.frontmatter.unknown)
        .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
        .join('\n'),
    ])
    .join('\n')
    .normalize('NFC');

  const input = await readInput(dir);
  const missing: string[] = [];

  for (const file of files) {
    const contents = input.get(file);
    if (contents === undefined) {
      throw new Error(`coverage source \`${file}\` is not in fixture \`${dir}\``);
    }
    for (const raw of contents.replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.replace(/^\uFEFF/, '').trim();
      if (line === '' || line === '---' || line === '...') continue;
      if (line.includes(MARKER_TEXT)) continue;
      if (/^alwaysApply\s*:/.test(line)) continue;
      // A frontmatter key with nothing after it — Cursor's empty `globs:` — carries no
      // content to lose. It is the *absence* of globs, and the import represents that
      // absence as an empty array.
      if (/^[A-Za-z_][A-Za-z0-9_-]*:$/.test(line)) continue;

      const candidates = [
        line,
        line.replace(/^#+\s*/, ''),
        line.replace(/^\*\*Applies to:\*\*\s*/, '').replace(/`/g, ''),
        unquote(line.replace(/^[^:\s][^:]*:\s*/, '')),
      ];

      // Comma-joined values are split because both dialects that carry lists carry them
      // that way — Cursor's `globs: a,b` and Copilot's `applyTo: 'a,b'` — and canonical
      // holds them as separate entries. Every part must survive, not merely one.
      const covered = candidates.some((candidate) => {
        const parts = candidate
          .split(',')
          .map((part) => part.trim().normalize('NFC'))
          .filter((part) => part !== '');
        return parts.length > 0 && parts.every((part) => haystack.includes(part));
      });

      if (!covered) missing.push(`${file}: ${line}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `import of \`${dir}\` lost ${String(missing.length)} line(s) of user content:\n` +
        missing.map((m) => `  ${m}`).join('\n'),
    );
  }
}

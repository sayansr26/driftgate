import type { Adapter } from '@driftgate/core';
import { compareFixture, formatFixtureReport } from './compare.js';
import { readExpected, renderFixture } from './fixture.js';

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

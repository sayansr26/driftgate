export type { InteropImporter, InteropResult } from './types.js';
export { ruler, splitRulerOutput } from './ruler.js';
export { rulesync, parseFrontmatter } from './rulesync.js';

import { ruler } from './ruler.js';
import { rulesync } from './rulesync.js';
import type { InteropImporter } from './types.js';

/**
 * Every interop importer this build ships.
 *
 * Kept separate from `ADAPTERS` on purpose, and a test asserts the two sets are disjoint:
 * an id appearing in both would put a tool Driftgate never generates for into
 * `driftgate.yaml`, `doctor`'s table and every rule's `tools:` selector.
 */
export const INTEROP: readonly InteropImporter[] = [ruler, rulesync];

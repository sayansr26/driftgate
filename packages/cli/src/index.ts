export { buildProgram, ExitCode } from './program.js';
export { runSync } from './commands/sync.js';
export {
  gatherCheck,
  reportCheck,
  runCheck,
  type CheckOptions,
  type CheckResult,
} from './commands/check.js';
export { runDoctor } from './commands/doctor.js';
export { runAdapterNew } from './commands/adapter/index.js';
export { ADAPTERS, ADAPTER_NAMES } from './registry.js';

/**
 * What the GitHub Action (T053) needs to turn a `CheckResult` into inline annotations,
 * re-exported here rather than depended on directly.
 *
 * `action/` declares exactly one dependency, `rulegate`, so that the set of packages
 * allowed to import `@rulegate/core` stays `cli` and `adapter-kit` — the boundary that
 * keeps core's deliberately wide surface (it carries no compatibility guarantee) out of
 * anything else's import graph.
 */
export { diffLines, type DiffLine, type Hunk } from '@rulegate/core';
export type { VerifyEntry, VerifyReport, VerifyStatus } from '@rulegate/core';
export {
  HINT_HAND_EDITED,
  HINT_IMPORT,
  HINT_ORPHAN_HAND_EDITED,
  HINT_SYNC,
  HINT_UNMANAGED,
} from './ui/hints.js';

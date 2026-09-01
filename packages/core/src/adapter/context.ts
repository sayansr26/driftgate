import type { JsonValue } from '../model/ids.js';
import type { Canonical } from '../model/canonical.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export const ADAPTER_API_VERSION = 1 as const;

/**
 * Everything an adapter is given. Note what is absent: no writer, no network client,
 * no process spawner. An adapter can read the repo and read the canonical model, and
 * that is all.
 */
export interface AdapterContext {
  /** Absolute, normalized, native separators, no trailing separator. */
  readonly repoRoot: string;
  readonly canonical: Canonical;
  readonly fs: ReadOnlyFileSystem;
  /** This adapter's `ToolConfig.options`; an empty object when unspecified. */
  readonly options: Readonly<Record<string, JsonValue>>;
  /** Lets an adapter branch if the contract is ever bumped. */
  readonly apiVersion: typeof ADAPTER_API_VERSION;
}

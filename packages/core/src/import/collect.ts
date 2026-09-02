import { DriftgateError } from '../model/errors.js';
import { ADAPTER_API_VERSION } from '../adapter/context.js';
import { emptyCanonical } from '../model/canonical.js';
import type { Adapter } from '../adapter/adapter.js';
import type { Canonical } from '../model/canonical.js';
import type { JsonValue } from '../model/ids.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';
import type { ImportSource } from './dedupe.js';

export interface CollectOptions {
  readonly repoRoot: string;
  readonly fs: ReadOnlyFileSystem;
  readonly adapters: readonly Adapter[];
  /**
   * Defaults to an empty model, which is what `init` has: it runs on a repository with no
   * `.driftgate/`, so there is nothing to parse. Pass a real one only to honour an
   * existing manifest's `canonicalSources`.
   */
  readonly canonical?: Canonical;
  readonly options?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
}

export interface CollectResult {
  /** One entry per adapter, including adapters that found nothing. */
  readonly sources: readonly ImportSource[];
  readonly errors: readonly DriftgateError[];
}

/**
 * Run every adapter's `read()` over one repository.
 *
 * Adapters that find nothing still get an entry, because "this tool was read and had no
 * rules" is different from "this tool was not read" — `dedupeImported` decides whether a
 * rule is `tools: all` by comparing against the tools that participated, and an adapter
 * missing from the list would silently narrow every selector.
 *
 * A failing adapter is recorded and skipped rather than aborting, the same rule
 * `computePlan` follows: one broken adapter must not hide what the others would have
 * found, least of all during `init`, where the alternative is a new user's first command
 * failing with somebody else's bug.
 */
export async function collectImports(options: CollectOptions): Promise<CollectResult> {
  const canonical = options.canonical ?? emptyCanonical({ file: '<import>' });
  const sources: ImportSource[] = [];
  const errors: DriftgateError[] = [];

  for (const adapter of options.adapters) {
    try {
      const partial = await adapter.read({
        repoRoot: options.repoRoot,
        canonical,
        fs: options.fs,
        options: options.options?.[adapter.name] ?? {},
        apiVersion: ADAPTER_API_VERSION,
      });
      sources.push({ tool: adapter.name, rules: partial.rules ?? [] });
    } catch (error) {
      sources.push({ tool: adapter.name, rules: [] });
      errors.push(
        error instanceof DriftgateError
          ? error
          : new DriftgateError({
              code: 'E_ADAPTER_FAILED',
              message: `adapter \`${adapter.name}\` failed while importing: ${String(error)}`,
              cause: error,
            }),
      );
    }
  }

  return { sources, errors };
}

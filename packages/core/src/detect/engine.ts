import { DriftgateError } from '../model/errors.js';
import { ADAPTER_API_VERSION } from '../adapter/context.js';
import { compareCodepoint } from '../render/order.js';
import { joinPosix } from '../fs/paths.js';
import { matchesGlob } from '../fs/glob.js';
import { parseGlobalPattern, toDisplayPath } from './global.js';
import type { GlobalPatternPlan } from './global.js';
import type { Adapter } from '../adapter/adapter.js';
import type { Canonical } from '../model/canonical.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';
import type { DetectionReport, GlobalFileStatus, ToolDetection } from './types.js';

export interface DetectInput {
  readonly repoRoot: string;
  /** Rooted at the repository. Handed to each adapter unchanged. */
  readonly fs: ReadOnlyFileSystem;
  readonly canonical: Canonical;
  readonly adapters: readonly Adapter[];
  /**
   * Rooted at the user's home directory, when the caller chooses to supply one.
   *
   * It is a *parameter* rather than something this module constructs, and that is the
   * whole design. `AdapterContext.fs` is repo-sandboxed, so adapters structurally cannot
   * see `~/.claude/CLAUDE.md`; reaching it is therefore the host's job, not theirs. Taking
   * it as an argument keeps `node:fs` and `node:os` out of this file entirely — the engine
   * is unit-testable against `MemoryFileSystem`, and the eslint boundary confining
   * filesystem access to `core/src/io/` is never approached.
   *
   * It is a `ReadOnlyFileSystem`, so `escapesRoot` already contains it: `~/../.ssh` is
   * refused by code that exists and is already tested, rather than by a new guard.
   */
  readonly globalFs?: ReadOnlyFileSystem;
}

/**
 * Which tools does this repository use, and what user-level files will they also load?
 *
 * Reads only. Writes nothing, anywhere — that is not merely true today, it is the point:
 * detection runs on repositories that have not adopted Driftgate, and is the first thing
 * `init` (T019) does. A tool that modified a repo while deciding whether it could help
 * would be unusable for exactly that.
 */
export async function detectTools(input: DetectInput): Promise<DetectionReport> {
  const { repoRoot, fs, canonical, adapters, globalFs } = input;
  const tools: ToolDetection[] = [];

  // Sequential, not `Promise.all`. Five elements make the concurrency worthless, and a
  // loop that appends in settle order is a determinism bug waiting for a slow disk.
  for (const adapter of adapters) {
    tools.push(await detectOne(adapter, { repoRoot, fs, canonical, globalFs }));
  }

  return {
    repoRoot,
    tools: tools.sort((a, b) => compareCodepoint(a.name, b.name)),
    globalProbed: globalFs !== undefined,
  };
}

interface OneInput {
  readonly repoRoot: string;
  readonly fs: ReadOnlyFileSystem;
  readonly canonical: Canonical;
  readonly globalFs: ReadOnlyFileSystem | undefined;
}

async function detectOne(adapter: Adapter, input: OneInput): Promise<ToolDetection> {
  const { repoRoot, fs, canonical, globalFs } = input;
  const global = await probeGlobals(adapter, globalFs);

  // Mirrors `computePlan`: an adapter built against a different kit is reported, not run.
  // Unreachable from TypeScript for our own adapters, which is exactly why it is here.
  if (adapter.apiVersion !== ADAPTER_API_VERSION) {
    return {
      name: adapter.name,
      detected: false,
      evidence: [],
      global,
      failed: new DriftgateError({
        code: 'E_ADAPTER_API_VERSION',
        message: `adapter \`${adapter.name}\` targets adapter API v${String(adapter.apiVersion)}, but this build speaks v${String(ADAPTER_API_VERSION)}`,
        hint: `upgrade the adapter, or pin driftgate to a version that speaks v${String(adapter.apiVersion)}`,
      }),
    };
  }

  const options = canonical.manifest.tools.find((t) => t.id === adapter.name)?.options ?? {};

  try {
    const result = await adapter.detect({
      repoRoot,
      canonical,
      fs,
      options,
      apiVersion: ADAPTER_API_VERSION,
    });
    return { name: adapter.name, detected: result.detected, evidence: result.evidence, global };
  } catch (cause) {
    // One broken adapter must not take down `doctor`. The user still needs to see the
    // other four, and which one failed.
    return {
      name: adapter.name,
      detected: false,
      evidence: [],
      global,
      failed:
        cause instanceof DriftgateError
          ? cause
          : new DriftgateError({
              code: 'E_ADAPTER_FAILED',
              message: `adapter \`${adapter.name}\` failed during detection: ${describe(cause)}`,
              cause,
            }),
    };
  }
}

async function probeGlobals(
  adapter: Adapter,
  globalFs: ReadOnlyFileSystem | undefined,
): Promise<readonly GlobalFileStatus[]> {
  const declared = adapter.docs.files.filter((f) => f.scope === 'global');
  const out: GlobalFileStatus[] = [];

  for (const entry of declared) {
    if (globalFs === undefined) {
      out.push({
        pattern: entry.pattern,
        role: entry.role,
        present: false,
        matches: [],
        probe: 'skipped',
      });
      continue;
    }

    const plan = parseGlobalPattern(entry.pattern);
    const matches = await resolve(plan, globalFs);
    out.push({
      pattern: entry.pattern,
      role: entry.role,
      present: matches.length > 0,
      matches,
      probe: plan.kind,
    });
  }

  // Declared order is preserved deliberately — see `ToolDetection.global`.
  return out;
}

async function resolve(
  plan: GlobalPatternPlan,
  globalFs: ReadOnlyFileSystem,
): Promise<readonly string[]> {
  const { literal, dir, segment } = plan;
  try {
    if (literal !== undefined) {
      return (await globalFs.exists(literal)) ? [toDisplayPath(literal)] : [];
    }
    if (dir !== undefined && segment !== undefined) {
      const entries = await globalFs.listDir(dir);
      return entries
        .filter((e) => matchesGlob(e.name, segment))
        .map((e) => toDisplayPath(joinPosix(dir, e.name)))
        .sort(compareCodepoint);
    }
    return [];
  } catch {
    // A home directory we cannot stat or list is "nothing here", never a crash — the same
    // rule `findRepoRoot`'s own probe follows. EACCES on a locked-down home is ordinary.
    return [];
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

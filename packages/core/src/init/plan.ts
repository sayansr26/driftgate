import { formatterWarnings } from './formatters.js';
import type { DriftgateError } from '../model/errors.js';
import {
  CANONICAL_SCHEMA_VERSION,
  DEFAULT_MANIFEST_OPTIONS,
  emptyCanonical,
} from '../model/canonical.js';
import { MANIFEST_PATH } from '../model/paths.js';
import { serializeCanonical } from '../model/serialize.js';
import { compareCodepoint } from '../render/order.js';
import { detectTools } from '../detect/engine.js';
import { collectImports } from '../import/collect.js';
import { dedupeImported, type ImportConflict } from '../import/dedupe.js';
import { computePlan, type Plan } from '../pipeline/plan.js';
import type { CanonicalFile } from '../pipeline/apply.js';
import type { Adapter } from '../adapter/adapter.js';
import type { Canonical, ToolConfig } from '../model/canonical.js';
import type { ToolId } from '../model/ids.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface InitInput {
  readonly repoRoot: string;
  readonly fs: ReadOnlyFileSystem;
  readonly adapters: readonly Adapter[];
}

export interface InitPlan {
  /** True when the repository already has a `.driftgate/`. Then there is nothing to do. */
  readonly adopted: boolean;
  readonly detected: readonly ToolId[];
  readonly canonical: Canonical;
  /** The `.driftgate/` files init would write. */
  readonly canonicalFiles: readonly CanonicalFile[];
  /**
   * The artifact plan the first `sync` will apply, computed here from the same renderer.
   *
   * `init` shows it rather than only promising it, because the interesting question a
   * user has at this moment is not "what goes in `.driftgate/`" but "what happens to my
   * `CLAUDE.md`".
   */
  readonly plan: Plan;
  readonly conflicts: readonly ImportConflict[];
  readonly warnings: readonly DriftgateError[];
  readonly errors: readonly DriftgateError[];
}

/**
 * Detect -> import -> dedupe -> a plan of every file that would be created, modified or
 * left alone.
 *
 * Computes and writes nothing. Whether to apply it is the caller's decision and the
 * user's, which is the point: `init` is the first command anyone runs, on a repository
 * whose contents Driftgate did not write, and a first command that changes files before
 * showing what it will change is how a tool loses a user in one step.
 */
export async function computeInitPlan(input: InitInput): Promise<InitPlan> {
  const { repoRoot, fs, adapters } = input;
  const errors: DriftgateError[] = [];
  const warnings: DriftgateError[] = [];

  if (await fs.exists(MANIFEST_PATH)) {
    // Not an error. Running `init` twice is a reasonable thing to do, and the answer is
    // "you already have one" rather than a failure — and the repository now parses, so
    // the plan shown is the real one `sync` would apply.
    const adoptedPlan = await computePlan({ repoRoot, fs, adapters });
    return {
      adopted: true,
      detected: adoptedPlan.enabledAdapters,
      canonical: adoptedPlan.canonical,
      canonicalFiles: [],
      plan: adoptedPlan,
      conflicts: [],
      warnings: adoptedPlan.warnings,
      errors: adoptedPlan.errors,
    };
  }

  const detection = await detectTools({
    repoRoot,
    fs,
    adapters,
    canonical: emptyCanonical({ file: MANIFEST_PATH }),
  });
  const detected = detection.tools.filter((t) => t.detected).map((t) => t.name);
  const present = adapters.filter((a) => detected.includes(a.name));

  const collected = await collectImports({ repoRoot, fs, adapters: present });
  errors.push(...collected.errors);

  const { rules, conflicts } = dedupeImported(collected.sources);
  const canonical = canonicalFrom(rules, detected);

  const plan = await computePlan({ repoRoot, fs, adapters, canonical });
  errors.push(...plan.errors);
  warnings.push(...plan.warnings);

  const canonicalFiles = await classify(serializeCanonical(canonical), fs);
  warnings.push(...(await formatterWarnings({ fs, generated: plan.artifacts.map((a) => a.path) })));

  return { adopted: false, detected, canonical, canonicalFiles, plan, conflicts, warnings, errors };
}

function canonicalFrom(rules: Canonical['rules'], detected: readonly ToolId[]): Canonical {
  const source = { file: MANIFEST_PATH };
  const tools: ToolConfig[] = [...detected]
    .sort(compareCodepoint)
    .map((id) => ({ id, enabled: true, options: {}, source }));

  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    manifest: {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      tools,
      options: DEFAULT_MANIFEST_OPTIONS,
      // Deliberately empty. The native files a user already has are what init just
      // imported *from*; from here they are generated output, and listing one as a
      // canonical source would freeze it as hand-maintained forever — the opposite of
      // what somebody running `init` asked for.
      canonicalSources: [],
      source,
    },
    rules,
    mcpServers: [],
    skills: [],
  };
}

async function classify(
  files: ReadonlyMap<string, string>,
  fs: ReadOnlyFileSystem,
): Promise<readonly CanonicalFile[]> {
  const out: CanonicalFile[] = [];
  for (const [path, contents] of files) {
    const existing = await fs.tryReadFile(path);
    out.push({
      path,
      contents,
      kind: existing === undefined ? 'create' : existing === contents ? 'leave-alone' : 'modify',
    });
  }
  return out.sort((a, b) => compareCodepoint(a.path, b.path));
}

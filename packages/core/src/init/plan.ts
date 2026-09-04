import { formatterWarnings } from './formatters.js';
import { DriftgateError } from '../model/errors.js';
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
import { maskPaths } from '../fs/mask.js';
import { ADAPTER_API_VERSION } from '../adapter/context.js';
import { dedupeImported, type ImportConflict } from '../import/dedupe.js';
import { dedupeMcpServers, type McpImportConflict } from '../import/dedupe-mcp.js';
import { computePlan, type Plan } from '../pipeline/plan.js';
import type { CanonicalFile } from '../pipeline/apply.js';
import type { Adapter } from '../adapter/adapter.js';
import type { AdapterContext } from '../adapter/context.js';
import type { RuleDocument } from '../model/rule.js';
import type { Canonical, ToolConfig } from '../model/canonical.js';
import type { ToolId } from '../model/ids.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface InitInput {
  readonly repoRoot: string;
  readonly fs: ReadOnlyFileSystem;
  readonly adapters: readonly Adapter[];
  /**
   * Read-only importers for competing rule-sync tools (T054).
   *
   * A separate list from `adapters`, and never merged into one: an adapter is a tool
   * Driftgate *generates for*, an interop importer is a tool it takes over *from*. Passing
   * ruler as an adapter would put it in `driftgate.yaml`, in `doctor`'s table and in every
   * rule's `tools:` selector — asserting Driftgate maintains a ruler config, which it must
   * never do. Optional, so every existing caller is unaffected.
   */
  readonly interop?: readonly InteropLike[];
}

/**
 * The shape `computeInitPlan` needs from an interop importer.
 *
 * Structural rather than an import of `@driftgate/interop`: `packages/core` depends on no
 * adapter and on no importer, and the dependency direction is what keeps core free of
 * tool-specific knowledge.
 */
export interface InteropLike {
  readonly name: string;
  readonly displayName: string;
  detect(ctx: AdapterContext): Promise<boolean>;
  read(ctx: AdapterContext): Promise<{
    readonly rules: readonly RuleDocument[];
    readonly generated: readonly string[];
    readonly notImported: readonly string[];
  }>;
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
  /**
   * Server ids one tool defined differently from another (T048).
   *
   * Separate from `conflicts` because the two are resolved differently and a caller must
   * not print them the same way: a rule conflict keeps both variants and asks, while a
   * server id is a mapping key and can only have one definition, so one is taken and the
   * divergence is reported.
   */
  readonly mcpConflicts: readonly McpImportConflict[];
  /** Competing rule-sync tools found in the repository and imported from (T054). */
  readonly interop: readonly string[];
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
      mcpConflicts: [],
      interop: [],
      warnings: adoptedPlan.warnings,
      errors: adoptedPlan.errors,
    };
  }

  // Interop runs first, and its results shape the adapter pass. ruler and rulesync generate
  // the files the adapters import from, so without masking the observed outputs every rule
  // arrives twice — once from the source the user edits, once from the copy built out of it.
  const interopRules: RuleDocument[] = [];
  const generated = new Set<string>();
  const interopFound: string[] = [];
  for (const importer of input.interop ?? []) {
    const ctx = {
      repoRoot,
      canonical: emptyCanonical({ file: MANIFEST_PATH }),
      fs,
      options: {},
      apiVersion: ADAPTER_API_VERSION,
    };
    if (!(await importer.detect(ctx))) continue;
    const found = await importer.read(ctx);
    interopRules.push(...found.rules);
    for (const path of found.generated) generated.add(path);
    interopFound.push(importer.displayName);
    for (const path of found.notImported) {
      warnings.push(
        new DriftgateError({
          code: 'W_INTEROP_NOT_IMPORTED',
          message: `${importer.displayName}: \`${path}\` was found and not imported. Driftgate imports rules only; copy anything else across by hand before removing it.`,
        }),
      );
    }
  }

  const detection = await detectTools({
    repoRoot,
    fs,
    adapters,
    canonical: emptyCanonical({ file: MANIFEST_PATH }),
  });
  const detected = detection.tools.filter((t) => t.detected).map((t) => t.name);
  const present = adapters.filter((a) => detected.includes(a.name));

  const collected = await collectImports({
    repoRoot,
    fs: generated.size === 0 ? fs : maskPaths(fs, generated),
    adapters: present,
  });
  errors.push(...collected.errors);

  const { rules: adapterRules, conflicts } = dedupeImported(collected.sources);
  // Interop rules first: they are the source a user edits, and document order becomes
  // canonical `order` (T018), so putting the generated copies ahead of them would rank a
  // derived file above its own source.
  const rules = [...interopRules, ...adapterRules];
  const { servers: mcpServers, conflicts: mcpConflicts } = dedupeMcpServers(collected.sources);
  const canonical = canonicalFrom(rules, mcpServers, detected);

  // Import warnings are warnings and never errors. `runInit` returns without writing while
  // `errors` is non-empty, so one odd server in somebody's `.mcp.json` would otherwise make
  // a new user's very first command fail on a file Driftgate merely read — T077's shape.
  for (const source of collected.sources) {
    for (const message of source.mcpWarnings) {
      warnings.push(new DriftgateError({ code: 'W_MCP_IMPORT', message }));
    }
  }

  const plan = await computePlan({ repoRoot, fs, adapters, canonical });
  errors.push(...plan.errors);
  warnings.push(...plan.warnings);

  const canonicalFiles = await classify(serializeCanonical(canonical), fs);
  warnings.push(...(await formatterWarnings({ fs, generated: plan.artifacts.map((a) => a.path) })));

  return {
    adopted: false,
    detected,
    canonical,
    canonicalFiles,
    plan,
    conflicts,
    mcpConflicts,
    interop: interopFound,
    warnings,
    errors,
  };
}

function canonicalFrom(
  rules: Canonical['rules'],
  mcpServers: Canonical['mcpServers'],
  detected: readonly ToolId[],
): Canonical {
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
    mcpServers,
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

import type { JsonValue, SourceRef, ToolId } from './ids.js';
import type { McpServer } from './mcp.js';
import type { RuleDocument } from './rule.js';
import type { Skill } from './skill.js';

export const CANONICAL_SCHEMA_VERSION = 1;

export interface ManifestOptions {
  /** Inject the generated-by marker wherever the target format supports comments. */
  readonly marker: boolean;
  /**
   * Only 'lf' in v0. The field exists so that v1 can add 'crlf' without a schema
   * break; Rulegate itself always writes \n.
   */
  readonly eol: 'lf';
  /** Copy originals into `.rulegate/backup/` before overwriting (T020). */
  readonly backup: boolean;
  /**
   * Repo-relative POSIX globs `doctor` will not treat as instruction files (T081).
   *
   * Narrow on purpose: it suppresses nothing Rulegate generates and nothing `state.json`
   * records — those are ours, and hiding them is how a tool comes to forget a file it
   * owns. It exists for the directories that hold instruction *files as data*, a golden
   * fixture tree above all, where `CLAUDE.md` is test input rather than a rule anything
   * loads. `sync` and `check` ignore this key entirely.
   */
  readonly ignore: readonly string[];
}

export const DEFAULT_MANIFEST_OPTIONS: ManifestOptions = {
  marker: true,
  eol: 'lf',
  backup: true,
  ignore: [],
};

export interface ToolConfig {
  readonly id: ToolId;
  readonly enabled: boolean;
  /** Adapter-specific. Opaque to core; validated by the adapter that owns it. */
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly source: SourceRef;
}

export interface RulegateManifest {
  readonly schemaVersion: number;
  /** Declared tools in authored order. Rendering order is decided by the renderer. */
  readonly tools: readonly ToolConfig[];
  readonly options: ManifestOptions;
  /**
   * Repo-relative POSIX paths that are canonical *input*. No adapter may emit an
   * artifact at any of these paths.
   *
   * This is the self-reference guard, and it is generic on purpose. `AGENTS.md` is
   * both a valid canonical source and the Codex adapter's output (T014); without this
   * list, a repo using AGENTS.md as its source is one adapter away from having that
   * source overwritten by its own generated output. PRD §11 rates exactly that class
   * of failure as trust-fatal, so it is encoded here rather than in the adapter that
   * happens to trip over it first.
   */
  readonly canonicalSources: readonly string[];
  readonly source: SourceRef;
}

/**
 * The whole canonical model.
 *
 * Invariant: no absolute paths, no timestamps, no hostnames, no machine state. The
 * model must serialize and re-parse identically on any machine, and anything
 * environment-specific would leak into generated output. `repoRoot` lives on
 * `AdapterContext`, never here.
 */
export interface Canonical {
  readonly schemaVersion: number;
  readonly manifest: RulegateManifest;
  /** As parsed, unsorted. The renderer owns ordering — never rely on array order. */
  readonly rules: readonly RuleDocument[];
  readonly mcpServers: readonly McpServer[];
  readonly skills: readonly Skill[];
}

export function emptyManifest(source: SourceRef): RulegateManifest {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    tools: [],
    options: DEFAULT_MANIFEST_OPTIONS,
    canonicalSources: [],
    source,
  };
}

export function emptyCanonical(source: SourceRef): Canonical {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    manifest: emptyManifest(source),
    rules: [],
    mcpServers: [],
    skills: [],
  };
}

export function enabledTools(manifest: RulegateManifest): readonly ToolId[] {
  return manifest.tools.filter((t) => t.enabled).map((t) => t.id);
}

export function toolConfig(manifest: RulegateManifest, id: ToolId): ToolConfig | undefined {
  return manifest.tools.find((t) => t.id === id);
}

/** True when an adapter must not write to this path because it is canonical input. */
export function isCanonicalSource(manifest: RulegateManifest, relPath: string): boolean {
  return manifest.canonicalSources.includes(relPath);
}

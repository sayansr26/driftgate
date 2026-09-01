import type { RuleId, ToolId } from '../model/ids.js';

export type ArtifactKind = 'rules' | 'mcp' | 'skill' | 'command' | 'subagent' | 'other';

/**
 * A file an adapter says *should* exist, with its complete contents.
 *
 * Adapters return these; they never write. That is the mechanism behind the project's
 * single most important structural constraint: `sync` applies the artifacts and
 * `check` compares against them, so the two commands consume byte-identical output
 * from one rendering pass and cannot drift apart. If an adapter could write directly,
 * `check` would be verifying something other than what `sync` produces — and `check`
 * would be lying.
 */
export interface Artifact {
  /** Repo-relative POSIX. Must not be one of `manifest.canonicalSources`. */
  readonly path: string;
  /** Full file contents: \n only, exactly one trailing \n, no BOM. */
  readonly contents: string;
  readonly adapter: ToolId;
  readonly kind: ArtifactKind;
  /** Which canonical rules contributed. Powers `doctor` (T026) and merge (T051). */
  readonly provenance?: { readonly ruleIds: readonly RuleId[] };
}

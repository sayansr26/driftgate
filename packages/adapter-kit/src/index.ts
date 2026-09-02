/**
 * The public adapter contract. **Frozen at T011** (2026-09-02): external contributors
 * write against these exports, so a change here breaks them. See `README.md` in this
 * package for the compatibility policy, and `packages/adapter-kit/test/surface.test.ts`
 * plus `api/adapter-kit.api.d.ts` for the two guards that enforce it.
 *
 * The definitions live in `@driftgate/core`; this package re-exports them, which keeps
 * the declared dependency direction (adapter-kit -> core) intact. The test of whether
 * this surface is the right one is mechanical: an adapter must be writable against this
 * package alone, and the two shipped adapters are the proof — no adapter source file may
 * import `@driftgate/core` at all, enforced by eslint and by an invariant scan.
 *
 * When in doubt, leave a symbol out. Adding an export later is additive; removing one is
 * a breaking change that costs an `apiVersion` bump.
 */

// The contract itself.
export type {
  Adapter,
  AdapterContext,
  AdapterDocs,
  Artifact,
  ArtifactKind,
  DetectResult,
  DirEntry,
  DocNote,
  PrecedenceEntry,
  ReadOnlyFileSystem,
  SourceLink,
  VerifiedAgainst,
} from '@driftgate/core';

export { ADAPTER_API_VERSION, detected, NOT_DETECTED } from '@driftgate/core';

// The model an adapter reads. `Canonical.mcpServers` and `.skills` are T043/T057 stubs:
// the freeze covers their presence as arrays, not their element shapes. See README.
export type {
  Canonical,
  DriftgateManifest,
  JsonValue,
  ManifestOptions,
  RuleDocument,
  RuleFrontmatter,
  RuleId,
  SourceRef,
  ToolConfig,
  ToolId,
  ToolSelector,
} from '@driftgate/core';

// Rendering. These exist so that every adapter produces byte-identical output for the
// same input without reimplementing normalization, ordering, or the generated-file
// marker — determinism is a contract (NFR4), not a per-adapter aspiration.
export type { ArtifactDraft, SectionOptions } from '@driftgate/core';
export {
  DEFAULT_SECTION_OPTIONS,
  HASH_MARKER,
  HTML_MARKER,
  MARKER_TEXT,
  finalizeArtifact,
  renderConcatenated,
  renderRuleSection,
  sortRules,
  withHashMarker,
  withHtmlMarker,
} from '@driftgate/core';

// Determinism primitives, exported because the alternative is illegal rather than merely
// discouraged. `.localeCompare` is lint-banned repo-wide, so an adapter that needs to sort
// has no other lawful option than `compareCodepoint`; and `node:path` is banned in adapter
// source because `path.join` emits backslashes on Windows, which would land in
// `Artifact.path` and hash straight into `state.json`. A ban is only honest once the legal
// alternative ships with the contract.
export { basenamePosix, compareCodepoint, dirnamePosix, joinPosix, toPosix } from '@driftgate/core';

// Selection and predicates: which rules this tool takes, and which paths are off limits.
export {
  ALL_TOOLS,
  DEFAULT_RULE_ORDER,
  appliesRepoWide,
  isCanonicalSource,
  matchesGlob,
  ruleHeading,
  selects,
  slugForId,
} from '@driftgate/core';

// Errors. An adapter reports a problem the same way core does, so the CLI can format it
// with file:line:column and a hint rather than printing a stack.
export type { DriftgateErrorCode, DriftgateErrorInit } from '@driftgate/core';
export { DriftgateError, isDriftgateError } from '@driftgate/core';

// The fixture harness is deliberately NOT re-exported here. It reads the filesystem, so
// re-exporting it would put `node:fs` and a concrete filesystem into the import graph of
// every adapter — through the package whose contract says adapters cannot touch the disk —
// and would put `renderFixture` in an adapter author's autocomplete next to `write()`.
// It lives behind the `@driftgate/adapter-kit/testing` subpath instead.

/**
 * The public adapter contract. **Frozen at T011** (2026-09-02): external contributors
 * write against these exports, so a change here breaks them. See `README.md` in this
 * package for the compatibility policy, and `packages/adapter-kit/test/public-api.test.ts`
 * (the export list) plus `test/contract-shape.test.ts` (the shape of each export) for the
 * two guards that enforce it.
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
  FileResolution,
  PrecedenceEntry,
  ReadOnlyFileSystem,
  SourceLink,
  VerifiedAgainst,
} from '@driftgate/core';

export { ADAPTER_API_VERSION, detected, NOT_DETECTED } from '@driftgate/core';

// The model an adapter reads. `Canonical.skills` is still a T057 stub: the freeze covers
// its presence as an array, not its element shape. `Canonical.mcpServers` is no longer one
// — T043 settled `McpServer` and it is exported below. See README.
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

// MCP (T043/T045). No `Adapter` signature changed and `ADAPTER_API_VERSION` did not move:
// `read()` already returns `Partial<Canonical>` and `write()` already returns artifacts,
// so an MCP-capable adapter returns `{ mcpServers }` from one and an `Artifact` with
// `kind: 'mcp'` from the other. A rules-only adapter needs no edit at all, which is T045's
// stated validation.
//
// `SecretValue` is `EnvRef` and nothing else, which is what makes "never write a literal
// secret" a property an adapter cannot violate rather than a rule it has to remember.
export type { EnvRef, McpScope, McpServer, McpTransport, SecretValue } from '@driftgate/core';
export { DEFAULT_MCP_SCOPE, envRef, formatEnvRef, parseEnvRef } from '@driftgate/core';
// `selectMcpServers` is here for the reason `slugForId` is (T011): which servers a tool
// gets is one rule made of three refusals — disabled, `scope: global`, and the `tools`
// selector — and two adapters restating it independently is how one of them ends up
// writing a server the other was told to skip.
export { selectMcpServers } from '@driftgate/core';

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
  // JSON output, for MCP artifacts. `stableJsonStringify` is the only JSON writer in the
  // codebase and adapters cannot import core, so without it here an adapter reaching for
  // bare `JSON.stringify` inherits whatever order its object was built in — a filesystem
  // walk's order, hashed straight into `state.json`.
  JSON_MARKER_KEY,
  stableJsonStringify,
  withJsonMarker,
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

// Import: native config -> canonical, the inverse of the renderers above. Shared here
// rather than per adapter because three of the five shipped adapters read the identical
// concatenated Markdown shape, and two importers that disagree about where a section ends
// is how one tool's rules quietly go missing on a first run. The per-format dialects stay
// in the adapters that own them.
export type { ImportConcatenatedOptions, ImportedRuleInit } from '@driftgate/core';
export {
  claimRuleId,
  importConcatenated,
  importRuleId,
  importedRule,
  stripMarker,
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

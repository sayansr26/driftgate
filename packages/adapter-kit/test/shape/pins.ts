/**
 * Structural pins for the frozen v1 contract.
 *
 * Not a `.test.ts` on purpose: vitest transpiles without type-checking, so a type-level
 * assertion placed in a test file would be silently inert. `contract-shape.test.ts`
 * compiles this file with the TypeScript API and asserts zero semantic diagnostics, so
 * every `Exact<>` below is genuinely checked.
 *
 * These catch what the export-name golden cannot: a widened return type, a narrowed
 * parameter, a field that became optional, or a new required member — none of which
 * changes a single export name. `DetectResult.evidence` is the concrete case the project
 * has already lived through (see the T006 change note in
 * `memory-bank/07-api-documentation.md`).
 *
 * A pin is deliberately a hand-written copy, not a reference to the real type. Comparing
 * a type to itself proves nothing; the duplication is the assertion.
 */
import type {
  Adapter,
  AdapterContext,
  Artifact,
  ArtifactKind,
  EnvRef,
  McpScope,
  McpServer,
  McpTransport,
  SecretValue,
  Canonical,
  DetectResult,
  JsonValue,
  ReadOnlyFileSystem,
  ToolId,
  RuleId,
} from '../../src/index.js';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const pin = <T extends true>(): T => true as T;

interface PinnedDetectResult {
  readonly detected: boolean;
  readonly evidence: readonly string[];
}
pin<Exact<DetectResult, PinnedDetectResult>>();
// `Exact<>` alone cannot see an added *optional* member: an interface with an extra
// optional field is mutually assignable with one without it. That addition is
// non-breaking by policy, but it must still be *noticed* — so every pin also fixes its
// key set, and a new member of any kind fails here until the pin is updated deliberately.
pin<Exact<keyof DetectResult, 'detected' | 'evidence'>>();

interface PinnedArtifact {
  readonly path: string;
  readonly contents: string;
  readonly adapter: ToolId;
  readonly kind: ArtifactKind;
  readonly provenance?: { readonly ruleIds: readonly RuleId[] };
}
pin<Exact<Artifact, PinnedArtifact>>();
pin<Exact<keyof Artifact, 'path' | 'contents' | 'adapter' | 'kind' | 'provenance'>>();

interface PinnedAdapterContext {
  readonly repoRoot: string;
  readonly canonical: Canonical;
  readonly fs: ReadOnlyFileSystem;
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly apiVersion: 1;
}
pin<Exact<AdapterContext, PinnedAdapterContext>>();
pin<Exact<keyof AdapterContext, 'repoRoot' | 'canonical' | 'fs' | 'options' | 'apiVersion'>>();

pin<Exact<ArtifactKind, 'rules' | 'mcp' | 'skill' | 'command' | 'subagent' | 'other'>>();

// MCP (T043/T045). `McpServer` came off the forbidden list once T043 settled its shape,
// so from here it is frozen like everything else and its fields are pinned key-for-key.
//
// `SecretValue` is the load-bearing one: it is `EnvRef` and never `string`, which is what
// makes "never write a literal secret" something an adapter cannot do rather than
// something it must remember not to do. Widening it to `string | EnvRef` would compile
// everywhere and fail here.
pin<Exact<SecretValue, EnvRef>>();
pin<Exact<keyof EnvRef, 'kind' | 'name'>>();
pin<Exact<McpScope, 'project' | 'global'>>();
pin<Exact<McpTransport['kind'], 'stdio' | 'http' | 'sse'>>();
pin<
  Exact<
    keyof McpServer,
    'id' | 'transport' | 'env' | 'headers' | 'tools' | 'scope' | 'enabled' | 'unknown' | 'source'
  >
>();
pin<Exact<McpServer['env'], Readonly<Record<string, SecretValue>>>>();
pin<Exact<McpServer['headers'], Readonly<Record<string, SecretValue>>>>();

// The four members of the contract, and their exact signatures. `write` returning a
// value rather than writing is what makes `check` and `sync` structurally unable to
// disagree, so its return type is load-bearing rather than incidental.
pin<Exact<keyof Adapter, 'name' | 'apiVersion' | 'detect' | 'read' | 'write' | 'docs'>>();
pin<Exact<Adapter['apiVersion'], 1>>();
pin<Exact<Adapter['detect'], (ctx: AdapterContext) => Promise<DetectResult>>>();
pin<Exact<Adapter['read'], (ctx: AdapterContext) => Promise<Partial<Canonical>>>>();
pin<Exact<Adapter['write'], (ctx: AdapterContext) => Promise<readonly Artifact[]>>>();

// `ctx.fs` must stay read-only. If a write method ever appears here, an adapter can
// bypass `applyPlan` and `check` starts verifying something `sync` did not produce.
pin<
  Exact<
    keyof ReadOnlyFileSystem,
    'readFile' | 'tryReadFile' | 'readFileRaw' | 'exists' | 'listDir' | 'glob'
  >
>();

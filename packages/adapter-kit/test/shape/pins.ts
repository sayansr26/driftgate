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

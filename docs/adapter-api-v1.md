# Adapter API v1

The contract external adapters are written against is **`@driftgate/adapter-kit`**, and it
is **frozen** as of T011 (2026-09-02). This document is normative: it lists the frozen
surface, defines what counts as a breaking change, and says how a v2 would arrive.

`@driftgate/core` is **not** the contract. It is published because the kit depends on it,
but it carries no compatibility guarantee and its shape will change. Adapter source may not
import it — enforced by `eslint.config.js` and by an invariant scan in
`packages/core/test/invariants.test.ts`.

## What an adapter is

```ts
interface Adapter {
  readonly name: ToolId; // stable kebab-case id, e.g. "claude-code"
  readonly apiVersion: 1;
  detect(ctx: AdapterContext): Promise<DetectResult>; // is this tool used here?
  read(ctx: AdapterContext): Promise<Partial<Canonical>>; // native → canonical
  write(ctx: AdapterContext): Promise<readonly Artifact[]>; // canonical → native
  readonly docs: AdapterDocs; // precedence rules, source links, verified-against
}
```

Adapters are pure: no network, no process spawning, no global state, and **no writes**.
`AdapterContext.fs` is a `ReadOnlyFileSystem`; `write()` returns artifacts rather than
producing them. That is what makes `check` and `sync` structurally incapable of
disagreeing — both consume one rendering pass, and only the pipeline's apply step touches
the disk. `write()` must be deterministic, and `read()` must be lossless.

## Two entry points

| Import                           | Contents                                                               | Frozen? |
| -------------------------------- | ---------------------------------------------------------------------- | ------- |
| `@driftgate/adapter-kit`         | The contract: types, render helpers, determinism primitives, errors    | **Yes** |
| `@driftgate/adapter-kit/testing` | The fixture harness (`renderFixture`, `readExpected`, `contextFor`, …) | No      |

They are separate because the harness reads the filesystem. Re-exporting it from the
contract entry would put `node:fs` and a concrete filesystem into the import graph of every
adapter, through the package whose central rule is that adapters do not touch the disk.

## The frozen surface

Asserted by `packages/adapter-kit/test/public-api.test.ts`, which compares the compiled
export list — types _and_ values — against a literal. Shapes are asserted separately by
`packages/adapter-kit/test/shape/pins.ts`, because a widened return type or a new required
field changes no export name.

**Contract types** — `Adapter`, `AdapterContext`, `AdapterDocs`, `Artifact`, `ArtifactKind`,
`ArtifactDraft`, `DetectResult`, `DirEntry`, `DocNote`, `PrecedenceEntry`,
`ReadOnlyFileSystem`, `SourceLink`, `VerifiedAgainst`.

**Model types** — `Canonical`, `DriftgateManifest`, `ManifestOptions`, `ToolConfig`,
`RuleDocument`, `RuleFrontmatter`, `ToolSelector`, `ToolId`, `RuleId`, `JsonValue`,
`SourceRef`.

**Rendering** — `finalizeArtifact`, `renderConcatenated`, `renderRuleSection`,
`SectionOptions`, `DEFAULT_SECTION_OPTIONS`, `sortRules`, `withHtmlMarker`,
`withHashMarker`, `MARKER_TEXT`, `HTML_MARKER`, `HASH_MARKER`.

**Determinism primitives** — `compareCodepoint`, `toPosix`, `joinPosix`, `dirnamePosix`,
`basenamePosix`. These are exported because the alternatives are _banned_, not merely
discouraged: `.localeCompare` is lint-banned repo-wide, and `node:path` is banned in adapter
source because `path.join` emits backslashes on Windows, which would land in `Artifact.path`
and hash straight into `state.json`. A ban is only honest once the lawful alternative ships.

**Selection and predicates** — `selects`, `ALL_TOOLS`, `appliesRepoWide`, `ruleHeading`,
`DEFAULT_RULE_ORDER`, `isCanonicalSource`, `matchesGlob`.

**Errors** — `DriftgateError`, `isDriftgateError`, `DriftgateErrorCode`,
`DriftgateErrorInit`. Throw these rather than a bare `Error`, or the CLI prints a stack
trace instead of `file:line:column` and a hint.

**Values** — `ADAPTER_API_VERSION`, `detected`, `NOT_DETECTED`.

### Deliberately excluded

The pipeline (`computePlan`, `applyPlan`, `verifyPlan`), all state handling, the parser,
`serializeCanonical`, the concrete filesystems (`NodeFileSystem`, `MemoryFileSystem`),
repo-root resolution, and `WritableFileSystem`. An adapter that needs one of these is doing
something the contract forbids. `WritableFileSystem` in particular was removed at T011 while
removal was still free: it is the type someone would reach for to write
`ctx.fs as WritableFileSystem` and cast past the invariant the design exists to protect.

### Reserved

`Canonical.mcpServers` and `Canonical.skills` are stubs for MCP (T043) and skills (T057).
Their **element types are not part of the frozen surface** and may change without a major
bump until those land; `McpServer` and `Skill` are deliberately not exported, so an adapter
cannot declare against a shape that is not settled. The fields themselves — present, and
arrays — are frozen. Reading them is allowed and unsupported.

`RuleFrontmatter.unknown` is the forward-compatibility channel for rule metadata: any
frontmatter key Driftgate does not recognize is preserved there verbatim.

## Compatibility policy

**Breaking** — requires an `ADAPTER_API_VERSION` bump and a major on the kit:

- removing or renaming any export;
- adding a required member to `Adapter`;
- changing the parameter or return type of `detect`, `read`, or `write`;
- changing or removing any required member of `Artifact`, `AdapterContext`, `DetectResult`,
  or `AdapterDocs`, including dropping a `readonly`;
- narrowing any value the contract accepts.

**Non-breaking** — a minor on the kit, `apiVersion` unchanged:

- adding a new export;
- adding an _optional_ member to `AdapterDocs`, `Artifact`, or `RuleFrontmatter`;
- adding a member to `AdapterContext`. Adapters _consume_ contexts, so a new field cannot
  break them — but anything that _constructs_ one (a host, the fixture harness) does break,
  so this still requires a kit minor and a note here.

The asymmetry is the thing to remember: **adding an export costs nothing, removing one costs
a major.** When a symbol's inclusion is arguable, leave it out and add it when an adapter
actually needs it.

## How v2 would arrive

`ADAPTER_API_VERSION` becomes `2` and `@driftgate/adapter-kit` majors. The host reads
`adapter.apiVersion` before calling `write()` — `packages/core/src/pipeline/plan.ts` — and a
mismatch produces `E_ADAPTER_API_VERSION` naming both versions, without taking down the rest
of the run. That branch is unreachable from TypeScript today, which is the point: it exists
for a plain-JS adapter and for a `node_modules` holding an adapter built against a different
kit, and it is the mechanism by which a v2 host would keep running v1 adapters for at least
one minor after v2 ships.

`@driftgate/core` is explicitly outside all of this and versions independently.

## Writing an adapter

Fixture-first. Hand-write `fixtures/<tool>/expected/` from the tool's documented behavior
_before_ implementing `detect` → `read` → `write`, then make the fixture pass byte-exact.
Encode the tool's precedence rules in `docs`, each with a source URL and the tool version
verified against — that data powers `driftgate doctor` and the per-tool documentation pages.
Finally, confirm the generated config actually loads in the real tool, and record that you
did.

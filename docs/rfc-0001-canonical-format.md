# RFC-0001 — The canonical format

|                    |                                 |
| ------------------ | ------------------------------- |
| **Status**         | Accepted                        |
| **Author**         | Sayan Choudhury                 |
| **Date**           | 2026-09-01                      |
| **Schema version** | 1                               |
| **Supersedes**     | none                            |
| **Extended by**    | MCP servers (v0.2), skills (v1) |

> **Extend this document; never fork it.** When MCP and skills land they add sections
> here. A competing spec would fragment the very thing this project exists to prevent.

---

## 1. Motivation

Developers run several AI coding agents at once, and every agent reads a different
file: `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`,
`GEMINI.md`. Keeping them in agreement by hand is tedious, and — more importantly —
there is no way to _know_ when they have fallen out of agreement.

Driftgate generates all of them from one source. This document specifies that source:
the `.driftgate/` directory, its manifest, its rule files, and the guarantees the
format makes.

## 2. Design principles

1. **Plain text, git-committable.** No binary formats, no lockfiles, no databases.
2. **Minimal frontmatter, additive later.** Every field here earns its place. Adding
   fields is cheap; removing them is a breaking change.
3. **Superset of AGENTS.md.** A bare `AGENTS.md` with no frontmatter is a valid
   canonical source. Adoption must never require starting from scratch.
4. **Unknown keys are preserved, never dropped.** A parser that rejected unrecognized
   frontmatter would make every future feature a breaking change, and would silently
   destroy whatever a user was experimenting with.
5. **No lockfile semantics.** `state.json` is regenerable. Losing it is never fatal.
6. **Determinism is part of the format contract**, not an implementation detail. See §9.

## 3. Directory layout

```
.driftgate/
  driftgate.yaml      manifest: enabled tools and options        v0
  rules/*.md          instructions, Markdown + YAML frontmatter  v0
  mcp/servers.yaml    MCP server definitions                     reserved (v0.2)
  skills/             skill definitions                          reserved (v1)
  state.json          generated-artifact hashes                  generated
  backup/             pre-overwrite copies                       generated
```

`rules/` may nest: `rules/frontend/react.md` is valid and yields the rule id
`frontend/react`.

Everything under `.driftgate/` except `state.json` and `backup/` is hand-authored and
belongs in version control. `state.json` is also committed — `driftgate check` needs it
to detect hand-edits in CI — but see §10 on merge conflicts.

## 4. `driftgate.yaml`

```yaml
schemaVersion: 1

tools:
  - claude-code
  - id: cursor
    options:
      legacy: false
  - id: copilot
    enabled: false

options:
  marker: true
  backup: true

canonicalSources: []
```

| Key                | Type     | Required | Default | Meaning                                                                               | Error when wrong     |
| ------------------ | -------- | -------- | ------- | ------------------------------------------------------------------------------------- | -------------------- |
| `schemaVersion`    | integer  | no       | `1`     | Format version this file targets.                                                     | `E_MANIFEST_INVALID` |
| `tools`            | list     | no       | `[]`    | Tools to generate for. See below.                                                     | `E_MANIFEST_INVALID` |
| `options.marker`   | boolean  | no       | `true`  | Inject the generated-by marker where the format allows comments.                      | `E_MANIFEST_INVALID` |
| `options.backup`   | boolean  | no       | `true`  | Copy originals to `.driftgate/backup/` before overwriting.                            | `E_MANIFEST_INVALID` |
| `canonicalSources` | string[] | no       | `[]`    | Repo-relative paths that are canonical _input_. No adapter may write to them. See §8. | `E_MANIFEST_INVALID` |

A `tools` entry is either a **bare string** (the tool id, enabled, no options) or a
**mapping**:

| Key       | Type    | Required | Default | Meaning                                                            |
| --------- | ------- | -------- | ------- | ------------------------------------------------------------------ |
| `id`      | string  | **yes**  | —       | Adapter id, e.g. `claude-code`.                                    |
| `enabled` | boolean | no       | `true`  | When false, the tool is declared but not generated.                |
| `options` | mapping | no       | `{}`    | Adapter-specific. Opaque to core; the owning adapter validates it. |

Declaring the same `id` twice is an error. An unrecognized `id` is `E_UNKNOWN_TOOL`.

## 5. `rules/*.md`

Each file is Markdown with optional YAML frontmatter.

**Rule id** is the path under `rules/`, minus the `.md` extension, with `/` separators
and Unicode NFC normalization: `.driftgate/rules/frontend/react.md` → `frontend/react`.

NFC normalization is normative, not an implementation detail. macOS returns decomposed
(NFD) filenames while Linux returns composed (NFC); without normalization a rule named
`café.md` carries a different id on each platform, and since ids break ordering ties,
the same repository would generate different bytes on macOS and Linux.

Two files that normalize to the same id are `E_RULE_ID_CONFLICT`. Non-`.md` files under
`rules/` are ignored with a warning.

## 6. Frontmatter schema

**Exactly five keys.** Everything else is preserved and ignored.

```yaml
---
description: TypeScript conventions
globs:
  - 'src/**/*.ts'
  - 'test/**/*.ts'
tools: [claude-code, cursor]
order: 10
---
Rule body in Markdown.
```

| Key           | Type      | Default     | Meaning                                                                        |
| ------------- | --------- | ----------- | ------------------------------------------------------------------------------ |
| `description` | string    | —           | One line. Used as the rendered section heading, and as Cursor's `description`. |
| `globs`       | string[]  | `[]`        | Paths this rule is scoped to. Empty means repo-wide.                           |
| `tools`       | see below | all enabled | Which adapters receive this rule.                                              |
| `order`       | integer   | `100`       | Lower renders first. Ties broken by `id`.                                      |

### 6.1 `tools` — three forms, no others

```yaml
tools: [claude-code, cursor] # include only these
tools: { exclude: [cursor] } # everything except these
# omitted                           # every enabled tool
```

A mapping without an `exclude` key is an error rather than a guess: silently
misreading a selector would route a rule to the wrong tools, which is worse than
refusing to proceed.

### 6.2 Normative notes

- **Quote globs beginning with `*`.** Bare `globs: *.ts` is a YAML _alias_, not a
  string, and is a syntax error. Write `globs: ['*.ts']`. Driftgate detects this
  specific failure and emits the hint `quote glob patterns that start with '*'`.
- `order` collisions are broken by `id` ascending, deterministically — never by
  filesystem order.
- A single string is accepted where a list is expected (`globs: 'src/**'`).
- **Any other top-level key is retained verbatim** and re-emitted on serialization.
  It is not an error. This is what makes the format forward-compatible: an experiment
  today is not destroyed by a Driftgate that predates it.

## 7. `description` and rendering

`description` is a **single line**. It becomes a heading in concatenated formats and a
frontmatter value in per-file formats. Multi-line descriptions are rejected rather than
escaped, because the one-line form is the contract every target format assumes.

Where a rule has no `description`, its `id` is used as the heading.

## 8. Bare `AGENTS.md` mode

If there is no `.driftgate/`, a repository-root `AGENTS.md` is a valid canonical source.
This satisfies US7 and means adoption costs nothing.

Discovery order:

1. `.driftgate/driftgate.yaml` exists → mode `driftgate-dir`.
2. `.driftgate/rules/` exists without a manifest → mode `rules-only`, with a warning
   that every detected tool is assumed enabled.
3. Repository-root `AGENTS.md` → mode `bare-agents-md`.
4. Otherwise `E_NO_CANONICAL_SOURCE`, hinting `run: driftgate init`.

In `bare-agents-md` mode the whole file becomes one rule with id `agents`, and a
synthetic manifest is created with every known tool enabled.

### 8.1 The self-reference guard — normative

In `bare-agents-md` mode, `canonicalSources` is set to `['AGENTS.md']`.

**No adapter may emit an artifact at a path listed in `canonicalSources`.** An artifact
that does is `E_ARTIFACT_OVERWRITES_SOURCE` and the run fails.

This exists because `AGENTS.md` is simultaneously a valid canonical _input_ and the
Codex adapter's _output_. Without the guard, a repository using `AGENTS.md` as its
source is one enabled adapter away from having that source overwritten by output
generated from it — destroying the original. The guard is generic rather than
special-cased in one adapter, so every future adapter inherits it.

## 9. Rendering contract — normative

Identical canonical input **must** produce byte-identical output on every run,
platform, Node version, locale, and filesystem. Nondeterminism is a defect, not a
quirk. Concretely:

1. **Ordering.** Rules sort by `order` ascending, then `id` by Unicode codepoint.
   Never by locale-sensitive comparison, never by filesystem order.
2. **Line endings.** Output is `\n` only. Input is normalized on read, so a CRLF
   checkout and an LF checkout produce identical output.
3. **Trailing newline.** Exactly one, unless the content is empty — an adapter signals
   "emit no file" by producing no artifact rather than an empty one.
4. **Encoding.** UTF-8 without a BOM. BOMs are stripped on read.
5. **Marker.** Where the target format supports comments, output begins with:

   ```
   <!-- generated by driftgate; edit .driftgate/ instead -->
   ```

   Formats that require other content first (Cursor's `.mdc`, whose frontmatter must
   be the first bytes) place the marker immediately after that content.

6. **No environment in output.** No timestamps, tool versions, hostnames, usernames,
   absolute paths, or random values may appear in a generated byte. A path inside
   generated content uses `/` separators regardless of host.

See `docs/determinism.md` for the implementation checklist.

## 10. `state.json`

```json
{
  "schemaVersion": 1,
  "artifacts": [
    { "adapter": "claude-code", "hash": "sha256:…", "kind": "rules", "path": "CLAUDE.md" }
  ]
}
```

Records, per generated artifact: its path, a SHA-256 hash of its **normalized**
contents, the adapter that produced it, and a schema version. Entries are sorted by
path.

- **Hashes cover normalized content, not raw bytes.** Otherwise every Windows user with
  `core.autocrlf=true` would see every generated file report as hand-edited on every
  checkout, and `driftgate check` would fail CI on Windows for every repository.
- **No timestamps or version stamps.** A `generatedAt` field would mean deleting and
  regenerating `state.json` never reproduces the original, and every Driftgate upgrade
  would produce a spurious diff in every repository.
- **It is never authoritative.** A corrupt, truncated, or merge-conflicted `state.json`
  degrades to "no prior state" with a warning — never a crash.
- **Merge conflicts:** resolve with `rm .driftgate/state.json && driftgate sync`. This
  is always safe, because the file is regenerable by construction. Do not install a
  git merge driver for it.

## 11. Reserved: `mcp/servers.yaml` (v0.2)

Canonical MCP server definitions — command/args/transport, environment references,
per-tool enable/disable, and project versus global scope — generated into Claude Code's
`.mcp.json`, Cursor's `.cursor/mcp.json`, VS Code/Copilot's `mcp.json`, and Codex's
`config.toml`.

**Secrets are references only.** The syntax is `env:GITHUB_TOKEN`. Driftgate refuses to
write a literal secret under any flag, and warns when one is found during import,
converting it to a reference. Generated configs are git-committed; a literal token in
one is the worst failure this tool could produce. This is enforced in the type system:
the model's secret type is an environment reference, not a string.

Specified fully when T043 lands. This section will be extended, not replaced.

## 12. Reserved: `skills/` (v1)

Canonical skill definitions, a superset of `SKILL.md` frontmatter plus whatever
Cursor's `.mdc` and `.github/skills` require. Specified when T057 lands.

## 13. Explicitly deferred

Resolving PRD §12 Q2 at the minimal end. Each of these was considered and left out.
The escape hatch in every case is §6.2: unknown keys are preserved, so experimenting
costs nothing and loses nothing.

| Deferred                                                         | Why                                                                                                                                                                        | What would bring it in                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Per-mode scoping** (Cursor's "Agent Requested" / manual modes) | Only one tool has modes, and its taxonomy is still moving. Encoding it now would bake one vendor's model into the canonical format.                                        | A second tool ships a comparable concept.                       |
| **Rule inheritance / `extends`**                                 | Adds a resolution order users must hold in their heads, to save duplication that is rare at v0 rule counts.                                                                | Real repositories show substantial duplication across rules.    |
| **Conditional rules** (branch, env, OS)                          | Makes output depend on the environment, which directly contradicts §9. `check` could pass locally and fail in CI for correct reasons, which destroys the value of `check`. | A design that keeps generated bytes environment-independent.    |
| **Templating / variable interpolation**                          | Turns a config format into a language, with the escaping and debugging burden that follows.                                                                                | Demonstrated need that partials cannot meet.                    |
| **Per-tool body overrides**                                      | The 90% case is per-tool _inclusion_, already covered by `tools`. Divergent bodies per tool undercut the premise that there is one source of truth.                        | Users are demonstrably forking rules by hand to work around it. |
| **Priority weights beyond one integer**                          | `order` plus an id tiebreak is total and predictable. Multi-key precedence is harder to reason about and no more expressive.                                               | A concrete case `order` cannot express.                         |
| **Nested `.driftgate/`** (monorepos)                             | Needs nearest-file-wins semantics matching how each _target_ tool resolves nesting — which must be researched per tool first.                                              | T061, after the precedence rules of T025 exist.                 |

## 14. Worked example

Given this canonical source:

```
.driftgate/
  driftgate.yaml
  rules/10-style.md
  rules/20-testing.md
  rules/30-frontend.md
```

**`.driftgate/driftgate.yaml`**

```yaml
schemaVersion: 1
tools:
  - claude-code
  - cursor
```

**`.driftgate/rules/10-style.md`**

```markdown
---
description: Style
order: 10
---

Use tabs. Never `any`.
```

**`.driftgate/rules/20-testing.md`**

```markdown
---
description: Testing
order: 20
---

Vitest. Colocate tests beside the code they cover.
```

**`.driftgate/rules/30-frontend.md`**

```markdown
---
description: Frontend
globs:
  - 'src/components/**/*.tsx'
order: 30
---

Prefer server components.
```

`driftgate sync` produces:

**`CLAUDE.md`** — concatenated, because Claude Code reads one file:

```markdown
<!-- generated by driftgate; edit .driftgate/ instead -->

## Style

Use tabs. Never `any`.

## Testing

Vitest. Colocate tests beside the code they cover.

## Frontend

**Applies to:** `src/components/**/*.tsx`

Prefer server components.
```

The `**Applies to:**` line is a **documented lossy mapping**: Claude Code has no native
per-glob scoping, so the scope is stated in prose rather than silently dropped.

**`.cursor/rules/style.mdc`** — one file per rule, because Cursor scopes natively:

```
---
description: Style
globs:
alwaysApply: true
---
<!-- generated by driftgate; edit .driftgate/ instead -->

Use tabs. Never `any`.
```

**`.cursor/rules/frontend.mdc`**

```
---
description: Frontend
globs: src/components/**/*.tsx
alwaysApply: false
---
<!-- generated by driftgate; edit .driftgate/ instead -->

Prefer server components.
```

Note Cursor's `.mdc` dialect: `globs` is a bare comma-joined string rather than a YAML
list, an empty `globs` is written as a bare key, and `alwaysApply` is _derived_ (true
exactly when the rule is repo-wide) rather than stored in canonical.

## 15. Compatibility and versioning

`schemaVersion` is an integer, currently `1`.

**Breaking** (requires a version bump): removing a field, changing a field's type or
default, changing rule id derivation, changing sort order, or changing the marker text.

**Non-breaking** (no bump): adding an optional field with a default, adding a `tools`
selector form, adding a reserved directory, or improving an error message.

Driftgate refuses to parse a `schemaVersion` newer than it understands, and says which
version it needs, rather than guessing at semantics it does not have.

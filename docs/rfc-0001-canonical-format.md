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

Rulegate generates all of them from one source. This document specifies that source:
the `.rulegate/` directory, its manifest, its rule files, and the guarantees the
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
.rulegate/
  rulegate.yaml      manifest: enabled tools and options        v0
  rules/*.md          instructions, Markdown + YAML frontmatter  v0
  mcp/servers.yaml    MCP server definitions                     v0.2
  skills/             skill definitions                          reserved (v1)
  state.json          generated-artifact hashes                  generated
  backup/             pre-overwrite copies                       generated
```

`rules/` may nest: `rules/frontend/react.md` is valid and yields the rule id
`frontend/react`.

Everything under `.rulegate/` except `state.json` and `backup/` is hand-authored and
belongs in version control. `state.json` is also committed — `rulegate check` needs it
to detect hand-edits in CI — but see §10 on merge conflicts.

## 4. `rulegate.yaml`

```yaml
schemaVersion: 1

tools:
  - claude-code
  - id: cursor
    options:
      legacy: false
    enabled: true

options:
  marker: true
  backup: true
  ignore: []

canonicalSources: []
```

| Key                | Type     | Required | Default | Meaning                                                                               | Error when wrong     |
| ------------------ | -------- | -------- | ------- | ------------------------------------------------------------------------------------- | -------------------- |
| `schemaVersion`    | integer  | no       | `1`     | Format version this file targets.                                                     | `E_MANIFEST_INVALID` |
| `tools`            | list     | no       | `[]`    | Tools to generate for. See below.                                                     | `E_MANIFEST_INVALID` |
| `options.marker`   | boolean  | no       | `true`  | Inject the generated-by marker where the format allows comments.                      | `E_MANIFEST_INVALID` |
| `options.backup`   | boolean  | no       | `true`  | Copy originals to `.rulegate/backup/` before overwriting or deleting.                 | `E_MANIFEST_INVALID` |
| `options.ignore`   | string[] | no       | `[]`    | Repo-relative globs `doctor` does not treat as instruction files. See below.          | `E_MANIFEST_INVALID` |
| `canonicalSources` | string[] | no       | `[]`    | Repo-relative paths that are canonical _input_. No adapter may write to them. See §8. | `E_MANIFEST_INVALID` |

`options.ignore` is narrower than its name suggests, and deliberately so. It suppresses one
thing: `doctor`'s scan for files that have the _shape_ of a tool instruction file and sit
where no detected tool looks. That scan cannot tell a rule from test data, and a golden
fixture tree full of `CLAUDE.md` files is data. It does **not** suppress a file recorded in
`state.json`, and `sync` and `check` ignore the key entirely — a path Rulegate generated is
Rulegate's whether or not the manifest mentions it, and a key that could hide one is a key
that can make the tool forget what it owns.

A `tools` entry is either a **bare string** (the tool id, enabled, no options) or a
**mapping**:

| Key       | Type    | Required | Default | Meaning                                                            |
| --------- | ------- | -------- | ------- | ------------------------------------------------------------------ |
| `id`      | string  | **yes**  | —       | Adapter id, e.g. `claude-code`.                                    |
| `enabled` | boolean | no       | `true`  | When false, the tool is declared but not generated.                |
| `options` | mapping | no       | `{}`    | Adapter-specific. Opaque to core; the owning adapter validates it. |

Declaring the same `id` twice is an error. An unrecognized `id` is `E_UNKNOWN_TOOL`.

### 4.1 Tool ids

An id names an adapter, and only adapters that ship can be enabled. As of this revision
the shipped ids are:

| Id            | Writes                                                                      |
| ------------- | --------------------------------------------------------------------------- |
| `aider`       | `AIDER.md`                                                                  |
| `claude-code` | `CLAUDE.md`                                                                 |
| `cline`       | `CLINE.md`                                                                  |
| `codex`       | `AGENTS.md`                                                                 |
| `copilot`     | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` |
| `cursor`      | `.cursor/rules/*.mdc`                                                       |
| `gemini`      | `GEMINI.md`                                                                 |
| `roo-code`    | `ROO-CODE.md`                                                               |
| `windsurf`    | `WINDSURF.md`                                                               |
| `zed`         | `ZED.md`                                                                    |

The **authoritative** list is the adapter registry, not this table: `E_UNKNOWN_TOOL`
enumerates every known id in its hint, so `rulegate sync` always tells you the true set.
An id for an adapter that does not exist yet is `E_UNKNOWN_TOOL` even with
`enabled: false`, because the manifest is validated before anything is generated. Declare
a tool when its adapter lands, not before.

## 5. `rules/*.md`

Each file is Markdown with optional YAML frontmatter.

**Rule id** is the path under `rules/`, minus the `.md` extension, with `/` separators
and Unicode NFC normalization: `.rulegate/rules/frontend/react.md` → `frontend/react`.

NFC normalization is normative, not an implementation detail. macOS returns decomposed
(NFD) filenames while Linux returns composed (NFC); without normalization a rule named
`café.md` carries a different id on each platform, and since ids break ordering ties,
the same repository would generate different bytes on macOS and Linux.

Two files that normalize to the same id are `E_RULE_ID_CONFLICT`. Non-`.md` files under
`rules/` are ignored with a warning.

### 5.1 From rule id to artifact path — normative

A **concatenating** target (one file for every rule, such as `CLAUDE.md`) renders the id
only as section text; the id never reaches a filename.

A **per-file** target derives one artifact per rule, and its filename comes from the id —
not from the rule's `description`, and not with the ordering prefix stripped. The id is
**flattened**: lowercased, with every run of characters outside `[a-z0-9]` replaced by a
single `-`, and leading and trailing `-` removed.

```
rules/10-style.md        -> id `10-style`       -> <dir>/10-style.<ext>
rules/frontend/react.md  -> id `frontend/react` -> <dir>/frontend-react.<ext>
```

Flattening is why a per-file target cannot nest: the id separator `/` is not a path
separator in the output. It follows that `frontend/react` and a rule literally named
`frontend-react` produce the same filename; that is `E_ARTIFACT_PATH_CONFLICT`, which
names both rules and fails the run rather than letting one silently win.

The directory and extension belong to the target — Cursor writes `.cursor/rules/*.mdc` —
but the flattening rule above is the format's, so every per-file adapter agrees on it.

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
  string, and is a syntax error. Write `globs: ['*.ts']`. Rulegate detects this
  specific failure and emits the hint `quote glob patterns that start with '*'`.
- `order` collisions are broken by `id` ascending, deterministically — never by
  filesystem order.
- A single string is accepted where a list is expected (`globs: 'src/**'`).
- **Any other top-level key is retained verbatim** and re-emitted on serialization.
  It is not an error. This is what makes the format forward-compatible: an experiment
  today is not destroyed by a Rulegate that predates it.

## 7. `description` and rendering

`description` is a **single line**. It becomes a heading in concatenated formats and a
frontmatter value in per-file formats. Multi-line descriptions are rejected rather than
escaped, because the one-line form is the contract every target format assumes.

Where a rule has no `description`, its `id` is used as the heading.

## 8. Bare `AGENTS.md` mode

If there is no `.rulegate/`, a repository-root `AGENTS.md` is a valid canonical source.
This satisfies US7 and means adoption costs nothing.

Discovery order:

1. `.rulegate/rulegate.yaml` exists → mode `rulegate-dir`.
2. `.rulegate/rules/` exists without a manifest → mode `rules-only`, with a warning
   that every detected tool is assumed enabled.
3. Repository-root `AGENTS.md` → mode `bare-agents-md`.
4. Otherwise `E_NO_CANONICAL_SOURCE`, hinting `run: rulegate init`.

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
   <!-- generated by rulegate; edit .rulegate/ instead -->
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
  checkout, and `rulegate check` would fail CI on Windows for every repository.
- **No timestamps or version stamps.** A `generatedAt` field would mean deleting and
  regenerating `state.json` never reproduces the original, and every Rulegate upgrade
  would produce a spurious diff in every repository.
- **It is never authoritative.** A corrupt, truncated, or merge-conflicted `state.json`
  degrades to "no prior state" with a warning (`E_STATE_INVALID`) — never a crash.
- **`rulegate check` reads it for ownership, not for the verdict.** `check` is clean
  exactly when `sync` would write nothing and delete nothing. Whether a planned file is
  out of sync is decided by comparing disk to the render; `state.json` only decides what
  to call the difference (`stale`, `hand-edited`, or `unmanaged`) and which recorded
  files no adapter produces any more. An orphan still on disk is drift, because `sync`
  would delete it; an orphan already gone is not, because dropping its record changes
  nothing but this file.
- **Merge conflicts:** resolve with `rm .rulegate/state.json && rulegate sync`. The
  file is regenerable by construction, so nothing is lost — but the recovery is only
  _uneventful_ while every generated file still matches what Rulegate would render. A
  generated file whose bytes still match is silently re-adopted. A **hand-edited** one is
  not: with state gone there is nothing left to say Rulegate ever wrote it, so instead of
  the `hand-edited` report you get `unmanaged` — "a file rulegate did not generate" —
  and `sync` refuses the path until you move it aside or pass `--force`, which copies the
  original to `.rulegate/backup/` first. Reconcile hand-edits into `.rulegate/` before
  deleting state, not after. Do not install a git merge driver for it.
- **Deleting it also forfeits every deletion Rulegate could still make.** `state.json` is
  the only record of what Rulegate generated, and the deletion candidates are exactly the
  paths it records that no enabled adapter produces any more. With the file gone, an
  artifact whose rule you delete afterwards is not an orphan Rulegate can reclaim — it is
  a file nobody has any record of, and it stays on disk being loaded by the tool it was
  written for. `rulegate doctor` still finds it by shape; `sync` cannot.

## 11. `mcp/servers.yaml` (v0.2)

Canonical MCP server definitions, generated into Claude Code's `.mcp.json`, Cursor's
`.cursor/mcp.json`, VS Code/Copilot's `.vscode/mcp.json`, and Codex's `.codex/config.toml`.

The file is optional. A repository with no `.rulegate/mcp/servers.yaml` has no MCP
servers, which is not an error.

```yaml
schemaVersion: 1
servers:
  github:
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: env:GITHUB_TOKEN
  linear:
    url: https://mcp.linear.app/sse
    transport: sse
    headers:
      Authorization: env:LINEAR_API_KEY
    tools: [claude-code, cursor]
  local-notes:
    command: ./scripts/notes-server
    scope: global
    enabled: false
```

### 11.1 `servers`

A **mapping**, not a list. The key is the server id, and it is the name every target
format writes the server under, so a mapping makes a duplicate id impossible in the file
itself rather than something Rulegate has to detect. Servers are rendered in codepoint
order of their ids regardless of the order they appear in.

| key         | type                       | default    | meaning                                            |
| ----------- | -------------------------- | ---------- | -------------------------------------------------- |
| `command`   | string                     | —          | executable for a local (stdio) server              |
| `args`      | list of strings            | `[]`       | arguments to `command`                             |
| `url`       | string                     | —          | endpoint for a remote server                       |
| `transport` | `stdio` \| `http` \| `sse` | inferred   | only needed to say `sse`                           |
| `env`       | mapping of references      | `{}`       | process environment for a stdio server             |
| `headers`   | mapping of references      | `{}`       | HTTP headers for a remote server                   |
| `tools`     | selector (§7)              | every tool | which tools get this server                        |
| `scope`     | `project` \| `global`      | `project`  | see §11.3                                          |
| `enabled`   | boolean                    | `true`     | `false` keeps the definition and generates nothing |

Every other key is preserved verbatim, exactly as unknown rule frontmatter is (§6).

### 11.2 Transport is inferred from the shape

`command` means stdio; `url` means http. `transport` is only required to distinguish
`sse` from `http`, since both are a bare `url`.

Declaring both `command` and `url` is **`E_MCP_INVALID`**. They describe different
servers, and choosing one by precedence would silently generate a config that connects
somewhere the author did not ask for. A `transport` that contradicts the shape — `stdio`
beside a `url` — is refused for the same reason.

### 11.3 Scope: `global` is read, never written

`scope: global` describes a server the user has configured for themselves, machine-wide.
Rulegate **reports** those and never generates them: `sync` writes nothing outside the
repository (§9), and there is no lawful path for a user-level file to be written to.
`doctor` shows them so that "why can my agent see that server" has an answer; `sync`
skips them.

### 11.4 Secrets are references only

The syntax is `env:GITHUB_TOKEN`: the literal prefix `env:` followed by an environment
variable name. It is the **only** accepted value in `env` and `headers`. Anything else is
`E_LITERAL_SECRET`, and the error names the key and never the value — a message that
quoted the offending string would print the secret into CI logs, which is the failure
this rule exists to prevent, committed to a different file.

Rulegate refuses to write a literal secret under any flag, and warns when one is found
during import, converting it to a reference. Generated configs are git-committed; a
literal token in one is the worst failure this tool could produce.

This is enforced in three places, not one, because the type system alone is not enough:
the model's secret type is an environment reference rather than a string, so an adapter
cannot be handed a literal; the parser refuses one, so it cannot enter the model; and a
scan over generated output refuses to write one, so it cannot arrive through a key
Rulegate does not interpret. The third exists because preserved unknown keys carry
strings and are re-emitted verbatim.

### 11.5 What each tool gets (v0.2)

The canonical file is one description of a set of servers; each adapter renders it into the
shape its own tool documents. Two of those differences are not cosmetic.

| tool            | generated path       | environment reference                       | remote transport                    |
| --------------- | -------------------- | ------------------------------------------- | ----------------------------------- |
| Claude Code     | `.mcp.json`          | `${NAME}`                                   | `type: "http"` / `type: "sse"`      |
| Cursor          | `.cursor/mcp.json`   | `${env:NAME}`                               | bare `url`; no `type` key exists    |
| VS Code/Copilot | `.vscode/mcp.json`   | `${env:NAME}`                               | `type: "http"` / `type: "sse"`      |
| Codex           | `.codex/config.toml` | `env_vars` / `bearer_token_env_var` (a key) | bare `url`; no discriminator exists |

The servers are written under `mcpServers` by Claude Code and Cursor, under **`servers`**
by VS Code, and as `[mcp_servers.<id>]` tables by Codex.

**An `env:NAME` reference is rewritten into the destination's own substitution syntax.**
Rulegate's `env:` prefix is a canonical spelling, not a wire format — no tool expands it —
so writing it through unchanged would hand the server the literal text as its credential.
The two spellings above are one character apart, which is why copying a generated
`.mcp.json` into `.cursor/mcp.json` by hand produces a file that looks correct and does not
resolve.

**Cursor cannot express `transport: sse`.** It documents `url` plus optional `headers` and
no discriminator, so an SSE endpoint and a streamable-HTTP one render identically there
while Claude Code keeps the distinction. This is a lossy mapping of the same kind as §8's
prose `**Applies to:**` line: recorded in the adapter's `docs`, and visible in `doctor`,
rather than left for a user to find.

**Codex has no variable substitution at all**, and that makes it the one target where an
`env:` reference is not a re-spelling. There is no value it can be written as, so it has to
become a _different key_: `env: { NAME: env:NAME }` renders as `env_vars = ["NAME"]`, which
whitelists the variable for forwarding, and an `Authorization` header renders as
`bearer_token_env_var`. Those are the only two keys Codex resolves from the environment, so
a reference neither can express — a variable named differently from the key that reads it,
or a credential in any other header — **cannot be written there at all**.

Such a server is **omitted from `.codex/config.toml`, and named in it**:

```toml
# generated by rulegate; edit .rulegate/ instead

# omitted: `github` — env.API_KEY reads a differently-named variable, and Codex has no
#   variable substitution.
#   rename the variable to API_KEY, or exclude codex from this server with a `tools:` selector

[mcp_servers.memory]
command = "npx"
```

It does **not** fail the run, and that changed in T083. Failing was the obvious reading of
"refuse where the loss is silent" and it was too blunt by a wide margin: `sync` writes
nothing while any error stands, so one server Codex could not express produced no
`CLAUDE.md`, no `AGENTS.md`, no `.mcp.json` and no `.codex/config.toml` — on a repository
where four of those five were perfectly expressible. The loss is not silent, which is the
actual requirement: it is written into the artifact, so it is committed, it appears in the
diff `check` prints, and a reader of `.codex/config.toml` finds out why a server they
configured is missing. If **every** server is unrepresentable the file is not written at all,
because a file of nothing but omissions is an artifact `check` has to reason about.

That is the difference between the two kinds of loss in this section, stated once. A
mapping that is lossy and still _works_ is degraded and recorded in the adapter's `docs`:
`transport: sse` on Cursor and on Codex renders as a bare `url`, and the server runs. A
mapping that would silently produce a **wrong** answer is refused: a credential that never
arrives is a server that starts and fails to authenticate, which is a bug report filed
against the wrong tool.

**Rulegate owns the whole of `.codex/config.toml`.** Unlike the other three, it is not an
MCP-only file — it is where every Codex setting lives — and there is no way to generate part
of a file. The ordinary ownership rules make that safe rather than special: `state.json` is
the only record of authorship (§10), so a `.codex/config.toml` Rulegate did not write is
somebody else's and is refused until `--force` backs it up, and a setting added by hand
afterwards is a hand-edit `sync --import` can recover.

Generated MCP files carry the marker as a top-level `"//"` key (§5), since JSON has no
comments. TOML does have comments, so `.codex/config.toml` carries the ordinary `#` form.
Keys Rulegate does not interpret are re-emitted verbatim, which is the path a literal
secret could take into generated output — the reason for the third enforcement point in
§11.4. TOML narrows what can be re-emitted at all: it has no `null`, and a nested table
under an uninterpreted key would have to move to a different place in the file, so both are
refused rather than guessed at.

### 11.6 Import (v0.2)

`rulegate init` reads each detected tool's MCP file back into `servers.yaml`. Four formats
invert to one model, and the round trip is not total — these are the cases where it is not,
and what happens in each.

**Deduplication is keyed by server id, not by content**, which is the opposite of the rules
pass (§9). A rule's id does not survive rendering, so rules are grouped by content and a
shared heading is only a hint. A server's id _is_ the key every target format writes it
under, so two `github` entries are two definitions of one server whatever their bodies say —
and `servers:` is a mapping, so they cannot both survive. One definition is taken and the
divergence is **reported**; importing neither would let the first `sync` remove the server
from every tool config and break a setup that worked a moment earlier.

The `tools:` selector is reconstructed from which tools defined the server, exactly as a
rule's is. A tool whose format has no project-level MCP file — Gemini today — is not counted
as a tool that declined: it was never asked, and counting it would narrow every imported
server away from `all` for a reason about Rulegate's roster rather than the user's config.

**Refused rather than half-imported.** A server is dropped whole, with a message naming the
file and the key, when it holds any of:

| Input                                | Why canonical cannot hold it                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env: { NODE_ENV: "production" }`    | `env` is `Record<string, EnvRef>`. Converting would silently repoint the server at the user's shell; dropping the key would lose content.                                 |
| `"Authorization": "Bearer ${TOKEN}"` | A header value is a _bare_ reference. The surrounding text has nowhere to live, and importing the token without its scheme sends a credential that will not authenticate. |
| `${NAME:-default}`                   | The default has no canonical form, and a variable that may resolve to nothing is a server that starts and fails.                                                          |
| `${input:id}`                        | An input **prompts the user**; `env:NAME` names a variable. Different behaviour, not a different spelling.                                                                |
| `type: "ws"`                         | There is no WebSocket transport arm. Importing it as `http` would point a streamable-HTTP client at a WebSocket endpoint.                                                 |

Every one of these follows §11.5's split: a loss that still works is a note, a loss that
silently produces a wrong answer is a refusal. All of them are **warnings**, never errors —
`init` writes nothing while errors are outstanding, and one odd server in somebody else's
file must not make a new user's first command fail on a file Rulegate merely read.

**A literal credential is converted, not refused.** It becomes a reference named after the
key it was found under (`GITHUB_TOKEN: "ghp_…"` → `env:GITHUB_TOKEN`), and the message says
so **without ever quoting the value** — a scanner that prints what it found commits the
secret to a different file. Case is preserved: the Codex writer can only express
`env_vars = ["NAME"]`, one string that is both the key and the variable, so upper-casing the
name would make the secret-handling feature itself refuse to render.

**Codex is the awkward one on the way in too.** `env_vars = ["NAME"]` inverts to
`env: { NAME: env:NAME }` and `bearer_token_env_var = "X"` to
`headers: { Authorization: env:X }`. Tables outside `mcp_servers.*` are reported and not
imported: Rulegate owns that whole file once it writes it (§11.5), so a `[tui]` table will
not survive the first `sync`, and saying so during `init` is the difference between a warning
and a surprise.

**JSONC.** VS Code's MCP reference does not state whether `.vscode/mcp.json` permits
comments and trailing commas, and its own examples are plain JSON — but VS Code's other
configuration files accept them, and `JSON.parse` throws where the tool itself would load the
file. Comments are therefore stripped, string-aware, before parsing all three JSON formats;
this is a no-op on plain JSON. Recorded here as **unverified against the vendor** rather than
presented as a documented fact.

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
| **Nested `.rulegate/`** (monorepos)                              | Needs nearest-file-wins semantics matching how each _target_ tool resolves nesting — which must be researched per tool first.                                              | T061, after the precedence rules of T025 exist.                 |

## 14. Worked example

Given this canonical source:

```
.rulegate/
  rulegate.yaml
  rules/10-style.md
  rules/20-testing.md
  rules/30-frontend.md
```

**`.rulegate/rulegate.yaml`**

```yaml
schemaVersion: 1
tools:
  - claude-code
  - cursor
```

**`.rulegate/rules/10-style.md`**

```markdown
---
description: Style
order: 10
---

Use tabs. Never `any`.
```

**`.rulegate/rules/20-testing.md`**

```markdown
---
description: Testing
order: 20
---

Vitest. Colocate tests beside the code they cover.
```

**`.rulegate/rules/30-frontend.md`**

```markdown
---
description: Frontend
globs:
  - 'src/components/**/*.tsx'
order: 30
---

Prefer server components.
```

`rulegate sync` produces:

**`CLAUDE.md`** — concatenated, because Claude Code reads one file:

```markdown
<!-- generated by rulegate; edit .rulegate/ instead -->

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

**`.cursor/rules/10-style.mdc`** — one file per rule, because Cursor scopes natively:

```
---
description: Style
globs:
alwaysApply: true
---
<!-- generated by rulegate; edit .rulegate/ instead -->

Use tabs. Never `any`.
```

**`.cursor/rules/30-frontend.mdc`**

```
---
description: Frontend
globs: src/components/**/*.tsx
alwaysApply: false
---
<!-- generated by rulegate; edit .rulegate/ instead -->

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

Rulegate refuses to parse a `schemaVersion` newer than it understands, and says which
version it needs, rather than guessing at semantics it does not have.

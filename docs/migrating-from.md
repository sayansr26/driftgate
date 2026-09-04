# Migrating from ruler or rulesync

`rulegate init` reads an existing **ruler** or **rulesync** setup and imports it into
`.rulegate/`. Nothing about it is one-directional in the other sense: Rulegate never
writes a `.ruler/` or `.rulesync/` config, and never will. Interop is a way in, not a
two-way sync.

Run it the way you would on any repository:

```
rulegate init          # prints everything it would do, writes nothing
rulegate init --yes    # applies it, backing up every file it takes ownership of
```

## What comes across

| From                            | Becomes                     | Notes                                                                 |
| ------------------------------- | --------------------------- | --------------------------------------------------------------------- |
| `.ruler/*.md`                   | one canonical rule per file | The sources you edit, not the files ruler generated from them.        |
| `.rulesync/rules/*.md`          | one canonical rule per file | `description` and `globs` map straight across.                        |
| `targets:` (rulesync)           | `tools:`                    | `["*"]` becomes every tool; a named list becomes a `tools:` selector. |
| Per-tool frontmatter (rulesync) | preserved in `unknown`      | Not interpreted, not lost.                                            |

## The part worth understanding: your generated files are not imported twice

ruler and rulesync **generate the same files Rulegate's adapters import from** —
`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*`. A naive import would read both the source and
the copy built out of it, and write every rule into `.rulegate/` twice.

So `init` hides each tool's observed output from the adapter pass. Two details matter:

- **ruler is detected precisely.** Its output carries `<!-- Source: … -->` markers, so
  Rulegate can tell a file ruler wrote from one you wrote by hand. A `CLAUDE.md` with no
  marker is imported normally, because it is yours.
- **rulesync is detected less precisely,** and this is stated rather than hidden: rulesync
  writes no marker of its own, so the only available signal is that the repository is a
  rulesync repository and the file is one of rulesync's known outputs. In a repository that
  uses rulesync _and_ keeps a hand-written `CLAUDE.md` at a path rulesync also targets, that
  file will not be imported. Check the plan `init` prints before applying it.

## What does not come across

Rulegate imports **rules**. Anything else is reported by name and left alone:

- `ruler.toml` — including its MCP configuration. Rulegate has no TOML parser outside the
  Codex adapter's own scoped one, and guessing at a config format is how an import loses
  something quietly.
- `.rulesync/mcp.jsonc`, `.rulesync/commands/`, `.rulesync/subagents/`, `.rulesync/skills/`
- `.ruler/skills/`, `.ruler/agents/`

`init` prints each of these as a `W_INTEROP_NOT_IMPORTED` warning. Copy them across by hand
before you delete the old directory — being told now is the point of the warning, rather
than finding out when an MCP server stops working.

Skills and subagents are canonical models Rulegate has not built yet (T057–T060). When they
land, these importers gain them.

## After importing

Your `.ruler/` or `.rulesync/` directory is still there and still works; Rulegate has not
touched it. Once `rulegate check` reports the repository in sync, removing the old
directory and its tool is a separate, reversible decision.

---

_Formats verified 2026-09-04 against `intellectronica/ruler`
(`src/constants.ts`, `src/core/RuleProcessor.ts`, `src/core/FileSystemUtils.ts`) and
`dyoshikawa/rulesync` (`src/constants/rulesync-paths.ts`,
`src/features/rules/rulesync-rule.ts`), read from source rather than from documentation._

# Rulegate

<!-- hero GIF (T035): edit one canonical rule → five tool configs update → a hand-edit fails CI with a diff -->

**One source of truth for your AI coding agents — and proof it stayed true.**

Rulegate generates `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/*.mdc` and
`.github/copilot-instructions.md` from one canonical `.rulegate/` directory. Other tools
do that much. What Rulegate adds is the half that makes it trustworthy:

- **`rulegate check`** — regenerate every artifact **in memory**, diff it against disk,
  exit 1 with a unified diff when they differ. Read-only by construction. This is the
  command you put in CI: it catches the **drift** that appears the moment somebody edits a
  generated file by hand, or forgets to re-run `sync`.
- **`rulegate doctor`** — which tools this repository is configured for, which files each
  one will actually load, in what order, and roughly what they cost in tokens.
- **`rulegate sync`** — the generation itself, sharing one rendering path with `check`,
  so `check` structurally cannot lie about what `sync` would write.

**Zero network calls. Zero telemetry.** Not a setting — a test that fails the build if a
network primitive appears anywhere in shipped source, including every dependency.

> **Status: pre-release.** The adapter API is frozen (`docs/adapter-api-v1.md`), ten
> adapters ship, and this repository generates its own agent config with them. `rulegate` is
> on npm and the commands below work — but `0.0.0` is an early placeholder, not an announced
> release. Expect the docs and the CLI's rough edges to move before `0.1.0`.

## The problem

Every tool reads a different file, in a different format, with different precedence rules.

| Tool           | Reads                                                                                                                                                            | Format                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Claude Code    | `CLAUDE.md`, `CLAUDE.local.md`, nested `CLAUDE.md`, `~/.claude/CLAUDE.md`                                                                                        | Markdown; nearest file wins                   |
| Codex          | `AGENTS.md`, nested `AGENTS.md`, `~/.codex/AGENTS.md`                                                                                                            | Markdown; merged, 32 KiB cap                  |
| GitHub Copilot | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `AGENTS.md`, `CLAUDE.md`                                                            | Markdown + YAML frontmatter; additive         |
| Cursor         | `.cursor/rules/*.mdc`, legacy `.cursorrules`                                                                                                                     | MDC — looks like YAML, is not                 |
| Gemini CLI     | `GEMINI.md`, nested `GEMINI.md`, `~/.gemini/GEMINI.md`                                                                                                           | Markdown; everything concatenated             |
| Aider          | `CONVENTIONS.md` — but only if `.aider.conf.yml` names it                                                                                                        | Markdown; loaded by config, not by convention |
| Cline          | `.clinerules/*.md`, plus `.cursorrules`, `.windsurfrules`, `AGENTS.md`                                                                                           | Markdown; additive, not an override chain     |
| Roo Code       | `.roo/rules/*.md`, `.roorules`, `.clinerules`, `AGENTS.md`                                                                                                       | Markdown; all merged                          |
| Windsurf       | `.windsurf/rules/*.md`, `.windsurfrules`, `AGENTS.md`, `.devin/rules/*.md`                                                                                       | Markdown; Devin's rules win                   |
| Zed            | the **first** of `.rules`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`, `AGENT.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` | Markdown; first match wins, rest never opened |

Ten copies in step by hand is a chore. Not noticing they have diverged is the actual
failure: your agents keep answering from a rule you deleted three weeks ago, and nothing
tells you.

And the divergence is not always yours to see. Copilot reads
`.github/copilot-instructions.md`, `AGENTS.md` and `CLAUDE.md` _additively_, not as an
override chain — so enabling the `copilot`, `codex` and `claude-code` adapters together sends
Copilot the same rules three times. Zed goes the other way: it opens whichever of nine files
it finds first and never looks at the rest, so a generated `CLAUDE.md` can be dead weight
because a stale `.cursorrules` outranks it. `rulegate doctor` reports both.

## Quickstart

```bash
npx rulegate init     # import existing configs into .rulegate/ (prints a plan first)
npx rulegate sync     # generate every enabled tool's config
npx rulegate check    # verify they match — exit 1 on drift. Put this in CI.
```

`init` writes nothing without `--yes`, backs up every file it takes ownership of into
`.rulegate/backup/`, and `rulegate restore` puts them back.

### What `check` catches

```text
$ rulegate check
hand-edited  GEMINI.md
@@ -167,5 +167,3 @@
   `memory-bank/05-progress-log.md` on every completion or phase gate. If they are not
   there, nothing is missing: everything a contributor needs is in `README.md`,
   `CONTRIBUTING.md`, and `docs/`.
-
-hand edited line

1 file out of sync.
hint: re-apply your edit in .rulegate/, then delete the generated file so sync can rewrite it.
```

Exit codes are `0` ok, `1` drift or failure, `2` usage — because CI reads the code, not the
message, and a typo in a workflow file must never be reported as drift.

### What `doctor` shows

```text
$ rulegate doctor
Claude Code  will load 12 files ~3,288 tokens
  CLAUDE.local.md        absent
  CLAUDE.md +10 nested   generated  ~2,922
  ~/.claude/CLAUDE.md    unmanaged    ~366
  .claude/settings.json  absent             settings

Cursor  will load 5 files ~2,619 tokens
  .cursor/rules/*.mdc (5)  generated  ~2,619
  .cursorrules             absent
  ~/.cursor/rules          absent

! copilot: GitHub Copilot will load 9 files ~7685 tokens, of which 2 are duplicates of
  another adapter's output (AGENTS.md from codex, CLAUDE.md from claude-code) — about
  4980 tokens are paid twice.
```

That last warning is the kind of thing nobody has written down anywhere else: Copilot's
three instruction mechanisms are **additive**, not an override chain, so enabling Copilot,
Codex and Claude Code together sends Copilot the same rules three times. Every precedence
claim Rulegate makes carries a source URL and the tool version it was verified against.

`doctor` is read-only and **exits 0 even when it warns** — `check` owns exit 1, and a
command that reports a correct permanent condition as a CI failure is one people mute.

## If you hand-edit a generated file

You will, and Rulegate does not punish it. `sync` refuses to overwrite the file and offers
two ways out:

```sh
rulegate sync --import   # recover the edit into .rulegate/ (prints the merge; --yes to apply)
rulegate sync --force    # discard it, after copying the original to .rulegate/backup/
```

`--import` reverses the edit through the same adapter that generated the file. It refuses,
rather than guessing, when the canonical source has changed too — `state.json` records a
hash, not the old text, so in that case the version you edited cannot be reconstructed from
anything and both sides are shown instead.

## Gate drift on a pull request

The GitHub Action runs `rulegate check` and marks every drifted region **inline on the
pull request diff**, so a reviewer sees which lines are wrong without opening the log.

```yaml
# .github/workflows/rulegate.yml
name: rulegate
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: sayansr26/rulegate/action@v1
```

| input               | default           |                                             |
| ------------------- | ----------------- | ------------------------------------------- |
| `working-directory` | the checkout root | where to check, for a monorepo subdirectory |
| `annotations`       | `true`            | set `false` for the log output only         |

It is the same `check` the CLI runs — one rendering pass, one verdict — so the annotations
on the diff and the log beneath them cannot disagree. Like every other form of `check` it
is read-only and needs no permissions beyond the default `contents: read`.

## Catch drift before it is committed

`rulegate check --staged` verifies the **git index** instead of the working tree, which is
what a commit hook needs: it answers "if this commit lands, will the generated files still
match `.rulegate/`?" Both sides come from the index, so an edit you have not staged yet
never blocks a commit, and staged artifacts that are stale never slip through one.

With [pre-commit](https://pre-commit.com):

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/sayansr26/rulegate
    rev: v0.1.0
    hooks:
      - id: rulegate-check
```

With husky:

```sh
# .husky/pre-commit
npx rulegate check --staged
```

It adds well under 500 ms to a commit, and it is read-only like every other form of
`check` — a failing hook tells you to run `rulegate sync`, it does not run it for you.

Outside a git working tree `--staged` **refuses** rather than quietly checking the working
tree instead. Being told a commit was verified against an index nobody read is worse than
being told it could not be verified.

## How it compares

|                                                               | ruler   | rulesync | symlinks / `@import` | **Rulegate**  |
| ------------------------------------------------------------- | ------- | -------- | -------------------- | ------------- |
| Generate rules for many tools                                 | ✅      | ✅       | crude                | ✅            |
| MCP servers, skills                                           | ✅      | ✅       | ❌                   | planned       |
| **Verify — fail CI on drift**                                 | ❌      | ❌       | ❌                   | ✅ `check`    |
| **Inspect — what does each tool load, and what does it cost** | ❌      | ❌       | ❌                   | ✅ `doctor`   |
| Never overwrites a file it did not generate                   | partial | partial  | n/a                  | ✅ enforced   |
| Tools supported                                               | 30+     | 30+      | —                    | 5, API frozen |

Incumbents are generators. Rulegate is a control plane: **generate ▸ verify ▸ inspect**.
The tool count is the honest gap, and it is the one thing outside contributors can close
fastest — which is why the scaffold below exists.

## Add an adapter in about 20 lines

```bash
rulegate adapter new kiro --yes    # from a clone of this repo
pnpm install && pnpm test           # green as generated
```

The scaffold writes a working adapter, its three fixture layouts, its tests, and its
registration — the registry, the CLI's dependencies, the Vitest alias, and RFC-0001 §4.1.
What is left is the part only you can write: the file path the tool really reads, the
precedence rules in `src/docs.ts`, and a golden hand-written from the tool's documentation.

Adapters are pure modules — `{ detect, read, write, docs }` — that return artifacts and
never touch the disk. That is what makes `check` and `sync` incapable of diverging.
[`docs/writing-an-adapter.md`](docs/writing-an-adapter.md) is the full walkthrough, and
[`docs/adapter-api-v1.md`](docs/adapter-api-v1.md) is the frozen contract. Ten tools are
seeded as `good first adapter` issues, each naming the files that tool really reads.

## Generated output is not formatter territory

Every path Rulegate generates belongs in your formatter's ignore file. A formatter and a
generator cannot both own a file: reformat a generated one and the next `sync` correctly
reports it as hand-edited and refuses to write it — which looks, reasonably, like Rulegate
being broken. Format `.rulegate/rules/` instead and re-run `sync`. This repository keeps
its own generated paths in `.prettierignore` for exactly that reason.

## Guarantees

These are tests, not intentions, and they run on macOS, Linux and Windows across Node 20
and 22:

- **Never writes over a file it did not generate.** `state.json` is the only record of
  ownership; `--force` may take ownership, but only after copying the original to
  `.rulegate/backup/`.
- **Never deletes a file it did not generate**, and refuses to delete an orphan whose bytes
  changed since Rulegate wrote them.
- **Deterministic output** — byte-identical across runs, platforms and Node versions.
  Nondeterminism is a P0 bug (`docs/determinism.md`), because it is what would make `check`
  cry wolf.
- **Never writes a literal secret.** MCP secrets are references (`env:GITHUB_TOKEN`) under
  every flag.
- **Never writes outside the repository.**

## Documentation

- `CONTRIBUTING.md` — setup, the commands, the invariants a PR must not break
- `docs/writing-an-adapter.md` — the adapter walkthrough, start to finish
- `docs/rfc-0001-canonical-format.md` — the canonical format
- `docs/adapter-api-v1.md` — the frozen adapter contract
- `docs/determinism.md` — the rules that keep output byte-identical
- `fixtures/README.md` — how the golden fixtures work

MIT licensed.

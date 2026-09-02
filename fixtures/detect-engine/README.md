# `detect-engine` fixtures

Whole repositories, like the `<tool>-detect/` fixtures and unlike the `<tool>/` write
fixtures — there is no `expected/` directory. These four exercise the **aggregate**
detection engine (T016) rather than one adapter's `detect()`.

| Directory | Tools present |
|---|---|
| `none/` | none |
| `one/` | cursor only |
| `all/` | all five |
| `home/` | *not a repository* — a stand-in home directory |

## Why these are not composed from the per-tool detect fixtures

The per-tool fixtures are not mutually exclusive: `copilot-detect/negative/` deliberately
contains a `.github/`, and `claude-code-detect/positive/` contains a `.claude/`. Building a
"five tools" case by unioning directories at runtime would produce a fixture with no fixed
bytes on disk, which is the one thing a fixture may not be. The engine also asks a
different question than any single adapter does — *given one repository, what does the
whole shipped set report* — and that question has no per-tool answer.

## `home/`

A directory that stands in for `$HOME`, so no test ever reads the machine's real home
directory. It holds Claude Code's and Gemini's user-level files and **not** Cursor's or
Codex's, so the assertion covers `present: true` and `present: false` in one run and
cannot pass by returning a constant.

## Two traps, deliberately preserved

**1. `none/` is adversarial, not empty.** It contains a `.github/` directory (nearly every
repository has one, so a detector keyed on it reports Copilot everywhere), a `.vscode/`,
and a `docs/CLAUDE.md` that is *nested rather than root*. An empty directory would let a
badly-scoped detector pass.

**2. No filename here is a case variant of a detected file — and that is load-bearing.**
macOS APFS and Windows NTFS are case-insensitive by default, so `stat('CLAUDE.md')`
succeeds for a file named `claude.md`. A negative fixture containing `claude.md`,
`agents.md` or `gemini.md` in any casing would therefore be negative **only on Linux**:
CI on ubuntu would stay green forever while every maintainer's laptop failed, or the
reverse. Nothing here relies on case to be a non-match, and nothing added later should.

`all/AGENTS.md` makes that fixture's canonical source `AGENTS.md`, so `parse()` reads rules
out of it. That is harmless — detection never touches `canonical` — but it is the kind of
coincidence someone later "tidies up", which changes what the fixture tests.

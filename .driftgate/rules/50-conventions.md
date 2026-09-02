---
description: Working conventions
order: 50
---

- **Adapter work is fixture-first:** hand-write `fixtures/<tool>/expected/` from the
  tool's documented behavior _before_ implementing `detect` → `read` → `write`. Adapter
  regressions are P0; a `format-changed` issue jumps the queue.
- **Two adapter traps.** Codex's `AGENTS.md` is both a valid canonical _input_ and that
  adapter's _output_ — guard the self-reference. Copilot has three competing instruction
  mechanisms, so document which one we write and how they rank.
- **This repo dogfoods itself.** Root `CLAUDE.md` and `.cursor/rules/*.mdc` are
  generated artifacts. Edit `.driftgate/rules/` and run `driftgate sync`; never edit the
  generated files, and commit them alongside the rule change.
- **Generated output is not formatter territory.** `CLAUDE.md` and `.cursor/rules/` are
  listed in `.prettierignore` deliberately: a formatter and a generator cannot both own a
  file. Reformat one and the next `driftgate sync` correctly reports it as hand-edited and
  refuses to write it. Format `.driftgate/rules/` instead.
- Prefer the smallest change that is still correct, and match the surrounding code's
  comment density and idiom. Comments in this codebase explain _why_ a constraint
  exists, not what a line does.
- **Maintainer working notes are not in this repository.** If your checkout happens to
  contain `memory-bank/` and `task-breakdown.md`, they are git-ignored internal notes —
  read them first, keep task statuses current, and append to
  `memory-bank/05-progress-log.md` on every completion or phase gate. If they are not
  there, nothing is missing: everything a contributor needs is in `README.md`,
  `CONTRIBUTING.md`, and `docs/`.

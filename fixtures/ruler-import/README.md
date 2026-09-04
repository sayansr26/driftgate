# `ruler-import`

A repository mid-migration from **ruler**: `.ruler/` holds the sources, and `AGENTS.md` and
`CLAUDE.md` are what ruler generated from them.

The fixture exists to pin two behaviours that pull in opposite directions.

**The generated copies must not be imported.** They are the same rules again, so without
masking every rule lands in `.rulegate/` three times — once from the source the user edits
and once from each generated file. `AGENTS.md` and `CLAUDE.md` both carry ruler's
`<!-- Source: … -->` markers, which is how Rulegate knows ruler wrote them.

**`GEMINI.md` must survive.** It is a filename ruler is *known* to write and it carries no
marker, because a person wrote it. Masking it because a `.ruler/` directory happens to exist
would lose a file the user authored — the exact failure the masking exists to prevent,
arriving through the fix for it. An earlier version of this fixture omitted `GEMINI.md`
entirely, and the mutation that masks every known output unconditionally passed against it.

There is no `expected/` consumed by `pnpm fixtures:update`: interop importers are not
adapters, so that script cannot drive them and skips this directory by name. The assertions
live in `packages/cli/test/interop-import.test.ts`.

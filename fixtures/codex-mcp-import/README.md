# `codex-mcp-import`

A repository whose canonical source is a bare `AGENTS.md` **and** which has MCP servers in
`.codex/config.toml`.

It exists for one branch. `read()`'s rules half returns early when `AGENTS.md` is the
canonical source — the parser has already read it, and importing it again would duplicate
every rule. The MCP half must **not** share that guard: a repository adopting Rulegate
through a bare `AGENTS.md` is this tool's most common first contact, and suppressing MCP
import there is the exact mirror of the write-side bug T046 found, where one early return
covered the whole adapter.

There is no `expected/` directory: the assertion is about which halves of `read()` ran, not
about serialized bytes, so it lives in `test/mcp-read.test.ts` rather than in a golden.

# `claude-code-mcp`

The MCP half of the Claude Code adapter (T046). Separate from `claude-code/` rather than
folded into it because the input is deliberately rules-free: a repository whose only
canonical content is `.driftgate/mcp/servers.yaml` is what catches a `write()` that returns
early when there is nothing to render as rules.

`expected/.mcp.json` was hand-written from
<https://code.claude.com/docs/en/mcp> (read 2026-09-04) before the writer existed, per the
fixture-first rule in `CONTRIBUTING.md`.

Four of the six servers in the input are expected to survive. The other two are the
refusals: `disabled-server` is `enabled: false`, `user-global` is `scope: global` (no lawful
write path, RFC-0001 §11.3), and `cursor-only` belongs to the other adapter.

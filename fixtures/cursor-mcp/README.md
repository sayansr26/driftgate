# `cursor-mcp`

The MCP half of the Cursor adapter (T046). Same input as `claude-code-mcp/`, different
expectations, and the difference is the point:

- Cursor's documented interpolation is `${env:NAME}`; Claude Code's is `${NAME}`.
- Cursor has **no `type` key**, so a canonical `transport: sse` and a `transport: http`
  render identically here. That loss is recorded in the adapter's `docs.notes`.
- `cursor-only` is `tools: [cursor]`, so it appears here and not in `claude-code-mcp/`.

`expected/.cursor/mcp.json` was hand-written from <https://cursor.com/docs/context/mcp>
(read 2026-09-04) before the writer existed.

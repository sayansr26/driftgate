# `copilot-mcp`

The MCP half of the Copilot adapter (T047). `input/` is byte-identical to
`claude-code-mcp/` and `cursor-mcp/` apart from `driftgate.yaml`, deliberately: the three
goldens are meant to be read side by side, because what differs between them is the whole
point of having three adapters.

What VS Code does that neither of the other two does:

- The top-level key is **`servers`**, not `mcpServers`. This is not a cosmetic difference.
  A `.mcp.json` copied to `.vscode/mcp.json` parses cleanly and VS Code loads **no servers
  at all** from it — the same class of trap as Cursor's one-character `${env:}`.
- `type` is written for a **stdio** server too. Claude Code omits it there and Cursor has
  no `type` key at all.
- `transport: sse` survives, because VS Code documents `"type": "sse"`. Cursor loses it.
- Interpolation is `${env:NAME}` — the same spelling as Cursor, and one character away
  from Claude Code's.

`expected/.vscode/mcp.json` was hand-written from
<https://code.visualstudio.com/docs/agents/reference/mcp-configuration> (read 2026-09-04)
before the writer existed.

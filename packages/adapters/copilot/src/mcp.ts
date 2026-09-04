import {
  selectMcpServers,
  stableJsonStringify,
  withJsonMarker,
  type JsonValue,
  type McpServer,
  type SecretValue,
} from '@driftgate/adapter-kit';

/**
 * The workspace file. VS Code also keeps a user-profile `mcp.json`, reachable only through
 * the *MCP: Open User Configuration* command — outside the repository, so there is no
 * lawful path to it (RFC-0001 §11.3).
 */
export const MCP_FILE = '.vscode/mcp.json';

/**
 * The top-level key is `servers`, and this is the divergence that matters.
 *
 * Claude Code and Cursor both write `mcpServers`. VS Code writes `servers`, so a
 * `.mcp.json` copied to `.vscode/mcp.json` is valid JSON, loads without complaint, and
 * supplies **no servers at all**. That is the `${env:}` trap again in a different key: a
 * config that looks right and does nothing.
 *
 * Source: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
 * (read 2026-09-04).
 */
const SERVERS_KEY = 'servers';

/**
 * `${env:NAME}` — the same spelling as Cursor, one character from Claude Code's.
 *
 * VS Code's MCP reference says predefined variables may be used in a server
 * configuration, and its variables reference defines `${env:Name}`.
 *
 * The vendor's own recommendation for a credential is `${input:id}` with an `inputs`
 * array, and Driftgate deliberately does not generate that: an input **prompts the user**,
 * which is not what a canonical `env:NAME` reference means. Recorded as an `info` note
 * rather than left as an unexplained gap.
 *
 * Sources: https://code.visualstudio.com/docs/agents/reference/mcp-configuration and
 * https://code.visualstudio.com/docs/reference/variables-reference (both read 2026-09-04).
 */
function reference(value: SecretValue): string {
  return `\${env:${value.name}}`;
}

function secretMap(map: Readonly<Record<string, SecretValue>>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(map)) out[key] = reference(map[key]!);
  return out;
}

function serverJson(server: McpServer): JsonValue {
  // Unknown keys first, interpreted keys second — see the same comment in the Claude Code
  // writer. A preserved key must never be able to override one Driftgate computed.
  const body: Record<string, JsonValue> = { ...server.unknown };

  const { transport } = server;
  // `type` is written for every arm, stdio included. Claude Code omits it on a stdio
  // server and Cursor has no `type` key at all; VS Code documents it as required, and it
  // is the discriminator for all three shapes rather than only the remote two.
  body['type'] = transport.kind;
  if (transport.kind === 'stdio') {
    body['command'] = transport.command;
    if (transport.args.length > 0) body['args'] = [...transport.args];
    if (Object.keys(server.env).length > 0) body['env'] = secretMap(server.env);
  } else {
    // Unlike Cursor, `sse` survives here: VS Code documents `"type": "sse"` beside
    // `"type": "http"`, so the canonical distinction is not lost.
    body['url'] = transport.url;
    if (Object.keys(server.headers).length > 0) body['headers'] = secretMap(server.headers);
  }

  return body;
}

/** `.vscode/mcp.json` for the servers this tool gets. Empty selection renders nothing. */
export function renderMcpJson(servers: readonly McpServer[], marker: boolean): string {
  const selected = selectMcpServers(servers, 'copilot');
  if (selected.length === 0) return '';

  const servers_: Record<string, JsonValue> = {};
  for (const server of selected) servers_[server.id] = serverJson(server);

  return stableJsonStringify(withJsonMarker({ [SERVERS_KEY]: servers_ }, marker));
}

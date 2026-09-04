import {
  selectMcpServers,
  stableJsonStringify,
  withJsonMarker,
  type JsonValue,
  type McpServer,
  type SecretValue,
} from '@driftgate/adapter-kit';

/** Project scope. `~/.claude.json` holds the local and user scopes and is never written. */
export const MCP_FILE = '.mcp.json';

/**
 * Claude Code expands `${NAME}` (and `${NAME:-default}`) in `command`, `args`, `url`, and
 * in `env` and `headers` values.
 *
 * Cursor spells the same thing `${env:NAME}`, which is why this lives in the adapter rather
 * than in the kit: the renderer speaks the destination's language, exactly as the `.mdc`
 * and `.instructions.md` frontmatter dialects do. Emitting Driftgate's own `env:NAME` would
 * hand the server a credential that is the literal string `env:NAME`.
 *
 * Source: https://code.claude.com/docs/en/mcp (read 2026-09-04).
 */
function reference(value: SecretValue): string {
  return `\${${value.name}}`;
}

function secretMap(map: Readonly<Record<string, SecretValue>>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(map)) out[key] = reference(map[key]!);
  return out;
}

function serverJson(server: McpServer): JsonValue {
  // Unknown keys first, interpreted keys second. A collision is impossible today — the
  // parser strips the nine interpreted keys before building `unknown` — but ordering it
  // this way means widening that list later cannot let a preserved key quietly win.
  const body: Record<string, JsonValue> = { ...server.unknown };

  const { transport } = server;
  if (transport.kind === 'stdio') {
    body['command'] = transport.command;
    if (transport.args.length > 0) body['args'] = [...transport.args];
    if (Object.keys(server.env).length > 0) body['env'] = secretMap(server.env);
  } else {
    // `type` is what tells Claude Code an endpoint speaks SSE rather than streamable HTTP;
    // both are a bare `url`, so omitting it silently downgrades an sse server.
    body['type'] = transport.kind;
    body['url'] = transport.url;
    if (Object.keys(server.headers).length > 0) body['headers'] = secretMap(server.headers);
  }

  return body;
}

/** `.mcp.json` for the servers this tool gets. Empty selection renders nothing. */
export function renderMcpJson(servers: readonly McpServer[], marker: boolean): string {
  const selected = selectMcpServers(servers, 'claude-code');
  if (selected.length === 0) return '';

  const mcpServers: Record<string, JsonValue> = {};
  for (const server of selected) mcpServers[server.id] = serverJson(server);

  // The marker is added to the *value*, never spliced into rendered text: JSON has no
  // comments, so a generated file declares itself with a top-level `"//"` key, and it
  // sorts ahead of every ordinary key under `compareCodepoint` with no special case.
  return stableJsonStringify(withJsonMarker({ mcpServers }, marker));
}

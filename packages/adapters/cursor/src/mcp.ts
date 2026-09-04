import {
  envRef,
  importMcpJson,
  selectMcpServers,
  stableJsonStringify,
  withJsonMarker,
  type JsonValue,
  type ImportedMcpResult,
  type McpServer,
  type ReferenceParse,
  type SecretValue,
} from '@rulegate/adapter-kit';

/** Project scope. `~/.cursor/mcp.json` is the global one and is never written. */
export const MCP_FILE = '.cursor/mcp.json';

/**
 * Cursor's documented interpolation is `${env:NAME}` — not Claude Code's `${NAME}`.
 *
 * One character of difference, and it decides whether the server receives a credential or
 * the unexpanded text. This is the `.mdc` lesson in a second file format: the two tools
 * look like they share a config schema and do not quite.
 *
 * Source: https://cursor.com/docs/context/mcp (read 2026-09-04).
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
  // writer. A preserved key must never be able to override one Rulegate computed.
  const body: Record<string, JsonValue> = { ...server.unknown };

  const { transport } = server;
  if (transport.kind === 'stdio') {
    body['command'] = transport.command;
    if (transport.args.length > 0) body['args'] = [...transport.args];
    if (Object.keys(server.env).length > 0) body['env'] = secretMap(server.env);
  } else {
    // No `type` key: Cursor's documented remote shape is `url` plus optional `headers`,
    // and it publishes no way to say "this endpoint speaks SSE". So a canonical
    // `transport: sse` and a `transport: http` render identically here. That is a lossy
    // mapping, recorded in `docs.notes` — the same treatment the prose `**Applies to:**`
    // degradation gets, and for the same reason: a loss nobody wrote down is a bug report.
    body['url'] = transport.url;
    if (Object.keys(server.headers).length > 0) body['headers'] = secretMap(server.headers);
  }

  return body;
}

/** `.cursor/mcp.json` for the servers this tool gets. Empty selection renders nothing. */
export function renderMcpJson(servers: readonly McpServer[], marker: boolean): string {
  const selected = selectMcpServers(servers, 'cursor');
  if (selected.length === 0) return '';

  const mcpServers: Record<string, JsonValue> = {};
  for (const server of selected) mcpServers[server.id] = serverJson(server);

  return stableJsonStringify(withJsonMarker({ mcpServers }, marker));
}

/**
 * Cursor spells it `${env:NAME}` — one character from Claude Code's, and the inverse of
 * the divergence the writer documents.
 *
 * Source: https://cursor.com/docs/context/mcp (read 2026-09-04).
 */
function parseReference(raw: string): ReferenceParse | undefined {
  const m = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
  return m === null ? undefined : { kind: 'ref', ref: envRef(m[1]!) };
}

/** The inverse of `renderMcpJson`. Never throws: a file it cannot read is warned about. */
export function importMcpConfig(contents: string, file = MCP_FILE): ImportedMcpResult {
  return importMcpJson(contents, { serversKey: 'mcpServers', parseReference, file });
}

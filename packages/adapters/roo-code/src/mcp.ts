import {
  envRef,
  importMcpJson,
  selectMcpServers,
  stableJsonStringify,
  withJsonMarker,
  type ImportedMcpResult,
  type JsonValue,
  type McpServer,
  type ReferenceParse,
  type SecretValue,
} from '@rulegate/adapter-kit';

/**
 * Project scope. Roo also keeps a global config in its VS Code extension storage, which is
 * outside the repository and is never written (RFC-0001 §11.3).
 *
 * Project-level entries take precedence over global ones when a server name appears in both.
 *
 * Source: https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo (read
 * 2026-09-04).
 */
export const MCP_FILE = '.roo/mcp.json';

/**
 * **`streamable-http`, not `http`** — the Roo-shaped version of the divergence T046 found
 * between Claude Code and Cursor.
 *
 * Every target so far spells streamable HTTP `http` (Claude Code, VS Code) or omits the
 * discriminator entirely (Cursor). Roo spells it out in full, and writing `http` here would
 * produce a config that parses cleanly and selects no transport Roo recognizes — the same
 * shape of failure as VS Code's `servers` key: valid JSON that supplies nothing.
 *
 * `sse` is spelled the same way it is everywhere else, so only one arm diverges.
 */
function transportType(kind: 'http' | 'sse'): string {
  return kind === 'http' ? 'streamable-http' : 'sse';
}

/**
 * Roo documents no variable substitution for `.roo/mcp.json`, so a reference cannot be
 * expanded into a value here.
 *
 * Unlike Codex — which has no substitution *and* offers `env_vars` / `bearer_token_env_var`
 * as a different key — Roo offers no such key either. So a canonical `env:` reference is
 * written as Rulegate's own `env:NAME` spelling: it is preserved losslessly for a round
 * trip, and it is inert rather than wrong, because a literal credential is the one thing
 * this project will not write into a git-committed file under any flag. Recorded as a
 * `warn` note, because a server that starts and fails to authenticate is otherwise a bug
 * report filed against the wrong tool.
 */
function reference(value: SecretValue): string {
  return `env:${value.name}`;
}

function secretMap(map: Readonly<Record<string, SecretValue>>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(map)) out[key] = reference(map[key]!);
  return out;
}

function serverJson(server: McpServer): JsonValue {
  // Unknown keys first, interpreted keys second — the same ordering as every other writer,
  // so a preserved key can never override one Rulegate computed.
  const body: Record<string, JsonValue> = { ...server.unknown };

  const { transport } = server;
  if (transport.kind === 'stdio') {
    body['type'] = 'stdio';
    body['command'] = transport.command;
    if (transport.args.length > 0) body['args'] = [...transport.args];
    if (Object.keys(server.env).length > 0) body['env'] = secretMap(server.env);
  } else {
    body['type'] = transportType(transport.kind);
    body['url'] = transport.url;
    if (Object.keys(server.headers).length > 0) body['headers'] = secretMap(server.headers);
  }

  return body;
}

/** `.roo/mcp.json` for the servers this tool gets. Empty selection renders nothing. */
export function renderMcpJson(servers: readonly McpServer[], marker: boolean): string {
  const selected = selectMcpServers(servers, 'roo-code');
  if (selected.length === 0) return '';

  const mcpServers: Record<string, JsonValue> = {};
  for (const server of selected) mcpServers[server.id] = serverJson(server);

  return stableJsonStringify(withJsonMarker({ mcpServers }, marker));
}

/** Rulegate's own `env:NAME`, since Roo documents no interpolation of its own. */
function parseReference(raw: string): ReferenceParse | undefined {
  const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
  return m === null ? undefined : { kind: 'ref', ref: envRef(m[1]!) };
}

/** The inverse of `renderMcpJson`. Never throws: a file it cannot read is warned about. */
export function importMcpConfig(contents: string, file = MCP_FILE): ImportedMcpResult {
  return importMcpJson(contents, { serversKey: 'mcpServers', parseReference, file });
}

import {
  DriftgateError,
  selectMcpServers,
  withHashMarker,
  type JsonValue,
  type McpServer,
} from '@driftgate/adapter-kit';
import { tomlTable } from './toml.js';

/**
 * The project-level config. Codex loads it only for a project the user has trusted; the
 * user-level `~/.codex/config.toml` is outside the repository and is never written
 * (RFC-0001 §11.3).
 *
 * **Driftgate owns this whole file.** Unlike `.mcp.json` and `.cursor/mcp.json`, it is not
 * an MCP-only file — it is where every Codex setting lives. Taking it over wholesale is a
 * deliberate decision rather than an oversight, and it is safe for the reason every other
 * artifact is: `state.json` is the only record of ownership, so a `.codex/config.toml`
 * Driftgate did not write is somebody else's and is refused until `--force` backs it up,
 * and a setting added by hand afterwards is reported as a hand-edit that `sync --import`
 * can recover. Recorded as a `warn` note, because a settings file a tool claims in full is
 * a first-run surprise otherwise.
 *
 * Source: https://learn.chatgpt.com/docs/config-file/config-reference (read 2026-09-04).
 */
export const MCP_FILE = '.codex/config.toml';

const TABLE = 'mcp_servers';

function unrepresentable(server: McpServer, what: string, hint: string): DriftgateError {
  return new DriftgateError({
    code: 'E_MCP_UNREPRESENTABLE',
    message: `server \`${server.id}\` cannot be written to Codex's config.toml: ${what}`,
    source: server.source,
    hint,
  });
}

/**
 * The stress case, and the reason T047 exists.
 *
 * **Codex has no variable substitution anywhere.** Every other target expands something —
 * `${NAME}`, `${env:NAME}` — so an `env:` reference is a re-spelling. Here it is not a
 * value at all: the reference has to become a *different key*, and only two keys exist
 * that can hold one.
 *
 * - `env: { NAME: env:NAME }` becomes `env_vars = ["NAME"]`, which whitelists the variable
 *   for forwarding from Codex's own environment. That works only because the map key and
 *   the variable name are the same string. A **renamed** reference — `API_KEY: env:MY_TOKEN`
 *   — has no form here: `[mcp_servers.x.env]` takes literal values, and writing the
 *   reference through would hand the server the text `env:MY_TOKEN` as its credential.
 * - `headers: { Authorization: env:X }` becomes `bearer_token_env_var = "X"`. That is the
 *   only header Codex resolves from the environment; `http_headers` holds static values.
 *
 * Both inexpressible cases are **refused** rather than dropped, on the split this codebase
 * already uses: a loss that is still functional is a `warn` note (Cursor's `sse`), and a
 * loss that silently produces a wrong answer is a refusal (Cursor's comma-in-a-glob). A
 * credential that never arrives is the second kind — the server starts and fails to
 * authenticate, which is a bug report about the wrong tool.
 *
 * Source: https://learn.chatgpt.com/docs/config-file/config-reference and
 * https://learn.chatgpt.com/docs/extend/mcp (both read 2026-09-04).
 */
function serverTable(server: McpServer): Record<string, JsonValue> {
  // Unknown keys first, interpreted keys second — the same ordering as the two JSON
  // writers, so a preserved key can never override one Driftgate computed.
  const body: Record<string, JsonValue> = { ...server.unknown };

  const { transport } = server;
  if (transport.kind === 'stdio') {
    body['command'] = transport.command;
    if (transport.args.length > 0) body['args'] = [...transport.args];

    const forwarded: string[] = [];
    for (const key of Object.keys(server.env)) {
      const ref = server.env[key]!;
      if (ref.name !== key) {
        throw unrepresentable(
          server,
          `\`env.${key}\` reads a differently-named variable, and Codex has no variable substitution`,
          `rename the variable to ${key}, or exclude codex from this server with a \`tools:\` selector`,
        );
      }
      forwarded.push(key);
    }
    // Already in the parser's codepoint order; sorted again so this line does not depend
    // on that, since the bytes are a contract.
    if (forwarded.length > 0) body['env_vars'] = forwarded.sort();
  } else {
    // `transport: sse` has no representation: Codex documents streamable HTTP only, with
    // no discriminator to carry the distinction. Rendered as a bare `url` — lossy but
    // still a working server, so it is a `warn` note in `docs` rather than a refusal.
    body['url'] = transport.url;

    for (const key of Object.keys(server.headers)) {
      if (key.toLowerCase() !== 'authorization') {
        throw unrepresentable(
          server,
          `header \`${key}\` cannot hold an environment reference; Codex resolves only \`Authorization\`, as \`bearer_token_env_var\``,
          'move the credential to the Authorization header, or exclude codex from this server with a `tools:` selector',
        );
      }
      body['bearer_token_env_var'] = server.headers[key]!.name;
    }
  }

  return body;
}

/**
 * `.codex/config.toml` for the servers this tool gets. Empty selection renders nothing.
 *
 * TOML tables have no canonical order, so the render order *is* the file order here and
 * nothing downstream re-sorts it — unlike `stableJsonStringify`, which sorts every key
 * deeply. T046 expected that to make `selectMcpServers`' sort visible to a golden at last.
 * It does not: `parseMcpServers` already sorts by id at parse time, so every fixture
 * arrives ordered and deleting the sort changes no generated byte. The sort still matters
 * for a caller that builds servers rather than parsing them, and its guards are the two
 * unit tests that reverse the input by hand.
 */
export function renderConfigToml(servers: readonly McpServer[], marker: boolean): string {
  const selected = selectMcpServers(servers, 'codex');
  if (selected.length === 0) return '';

  const tables = selected.map((server) => tomlTable([TABLE, server.id], serverTable(server)));
  return withHashMarker(tables.join('\n\n'), marker);
}

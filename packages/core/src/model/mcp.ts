import type { JsonValue, SourceRef } from './ids.js';
import type { ToolSelector } from './selector.js';

/** A reference to an environment variable. Never a literal value. */
export interface EnvRef {
  readonly kind: 'env';
  readonly name: string;
}

/**
 * Anywhere a secret could appear, the type is `EnvRef` rather than `string`.
 *
 * That makes "never write a literal secret" (T044, and a hard constraint in the
 * project brief) a property the compiler enforces, instead of a runtime check that
 * some future adapter forgets to call. Generated MCP configs are git-committed; a
 * literal token in one is the worst failure this tool could produce.
 */
export type SecretValue = EnvRef;

/**
 * How a client reaches the server.
 *
 * A discriminated union rather than a `type` string beside optional `command`/`url`
 * fields, so "stdio with a url and no command" cannot be constructed at all. The three
 * arms are the three the MCP specification defines and every target format supports.
 */
export type McpTransport =
  | { readonly kind: 'stdio'; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: 'http'; readonly url: string }
  | { readonly kind: 'sse'; readonly url: string };

/** A server as `.driftgate/mcp/servers.yaml` describes it (T043, RFC-0001 §11). */
export interface McpServer {
  /** The key under `servers:`. Unique, and the name every target format writes it under. */
  readonly id: string;
  readonly transport: McpTransport;
  /** Process environment for a stdio server. References only — see `SecretValue`. */
  readonly env: Readonly<Record<string, SecretValue>>;
  /** HTTP headers for an http/sse server. References only. */
  readonly headers: Readonly<Record<string, SecretValue>>;
  /** Which tools get this server. Same three forms as a rule's `tools` (RFC §7). */
  readonly tools: ToolSelector;
  /**
   * `global` servers are **read and reported, never written**: `escapesRoot` refuses any
   * path outside the repository and `AdapterContext` has no home directory, so there is
   * no lawful path for one. `doctor` explains them; `sync` skips them.
   */
  readonly scope: McpScope;
  readonly enabled: boolean;
  /** Keys Driftgate does not interpret, preserved verbatim so a round trip loses nothing. */
  readonly unknown: Readonly<Record<string, JsonValue>>;
  readonly source: SourceRef;
}

export type McpScope = 'project' | 'global';

export const DEFAULT_MCP_SCOPE: McpScope = 'project';

export function envRef(name: string): EnvRef {
  return { kind: 'env', name };
}

/** `env:GITHUB_TOKEN` — the only accepted secret syntax. */
export function parseEnvRef(raw: string): EnvRef | undefined {
  const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
  return m ? envRef(m[1]!) : undefined;
}

export function formatEnvRef(ref: EnvRef): string {
  return `env:${ref.name}`;
}

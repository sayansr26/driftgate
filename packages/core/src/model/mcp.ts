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

export type McpTransport =
  | { readonly kind: 'stdio'; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: 'http'; readonly url: string }
  | { readonly kind: 'sse'; readonly url: string };

/** Stub for v0.2 (T043). Present now so later phases extend rather than rewrite. */
export interface McpServer {
  readonly id: string;
  readonly transport: McpTransport;
  readonly env: Readonly<Record<string, SecretValue>>;
  readonly headers: Readonly<Record<string, SecretValue>>;
  readonly tools: ToolSelector;
  readonly scope: 'project' | 'global';
  readonly enabled: boolean;
  readonly unknown: Readonly<Record<string, JsonValue>>;
  readonly source: SourceRef;
}

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

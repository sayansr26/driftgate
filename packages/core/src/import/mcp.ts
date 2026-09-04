import { ALL_TOOLS } from '../model/selector.js';
import { DEFAULT_MCP_SCOPE, envRef, parseEnvRef } from '../model/mcp.js';
import { isLiteralSecret, literalToEnvRef } from '../render/secrets.js';
import type { EnvRef, McpServer, McpTransport, SecretValue } from '../model/mcp.js';
import type { JsonValue, SourceRef } from '../model/ids.js';

export interface ImportedServerInit {
  readonly id: string;
  readonly transport: McpTransport;
  readonly env?: Readonly<Record<string, SecretValue>>;
  readonly headers?: Readonly<Record<string, SecretValue>>;
  readonly unknown?: Readonly<Record<string, JsonValue>>;
  readonly source: SourceRef;
}

/**
 * Build a canonical MCP server from imported content.
 *
 * `tools` is `ALL_TOOLS` for the same reason an imported rule's is: a server found in
 * `.mcp.json` proves Claude Code has it and says nothing about the other three. Narrowing
 * needs the cross-adapter view, which is `dedupeMcpServers`' job, not an adapter's.
 *
 * `scope` is always `project`. A global server lives outside the repository, and nothing
 * an adapter can read from `AdapterContext` is outside the repository — so an importer
 * that produced one would be describing a file it cannot have seen.
 */
export function importedServer(init: ImportedServerInit): McpServer {
  return {
    id: init.id,
    transport: init.transport,
    env: init.env ?? {},
    headers: init.headers ?? {},
    tools: ALL_TOOLS,
    scope: DEFAULT_MCP_SCOPE,
    enabled: true,
    unknown: init.unknown ?? {},
    source: init.source,
  };
}

/** What a dialect makes of one `env`/`headers` value. */
export type ReferenceParse =
  | { readonly kind: 'ref'; readonly ref: EnvRef }
  /** The value is a reference this dialect has and canonical cannot express. */
  | { readonly kind: 'unrepresentable'; readonly why: string };

/**
 * Read one native reference spelling.
 *
 * Each adapter supplies its own: `${NAME}` for Claude Code, `${env:NAME}` for Cursor and
 * VS Code, a separate *key* entirely for Codex. Driftgate's own `env:NAME` is accepted by
 * all of them, because a hand-written file is a thing people have.
 */
export type ParseReference = (raw: string) => ReferenceParse | undefined;

/**
 * `${NAME:-default}` and `${input:id}`, the two shapes that look like references and are
 * not importable.
 *
 * Both are refused rather than degraded, on the split RFC §11.5 states: a loss that still
 * works is a note, a loss that silently produces a wrong answer is a refusal. Dropping a
 * default leaves a variable that may resolve to nothing, and an `input` **prompts the
 * user** — neither is what a bare `env:NAME` means, and both fail at connection time as a
 * bug report filed against the wrong tool.
 */
export function unrepresentableReference(raw: string): { readonly why: string } | undefined {
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*:[-=?+]/.test(raw)) {
    return { why: 'uses a shell-style default (`${NAME:-...}`), which canonical has no form for' };
  }
  if (/^\$\{input:/.test(raw)) {
    return {
      why: 'refers to an `${input:...}` variable, which prompts the user rather than naming an environment variable',
    };
  }
  return undefined;
}

/** `env:NAME` — Driftgate's own spelling, valid in a hand-written native file. */
export function canonicalReference(raw: string): ReferenceParse | undefined {
  const ref = parseEnvRef(raw);
  return ref === undefined ? undefined : { kind: 'ref', ref };
}

export interface ImportedMcpResult {
  readonly servers: readonly McpServer[];
  /**
   * Human-readable, one per dropped or converted server. **Never quotes a value** — a
   * message naming the secret would print it into a CI log, which is the failure the rule
   * exists to prevent, committed to a different file (T044).
   */
  readonly warnings: readonly string[];
}

export interface ImportMcpJsonOptions {
  /** `mcpServers` for Claude Code and Cursor, `servers` for VS Code. */
  readonly serversKey: string;
  readonly parseReference: ParseReference;
  /** The native file, for messages and `SourceRef`. */
  readonly file: string;
}

type Outcome =
  | { readonly kind: 'ok'; readonly map: Record<string, SecretValue> }
  | { readonly kind: 'refuse'; readonly why: string };

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function importSecrets(
  raw: JsonValue | undefined,
  what: string,
  options: ImportMcpJsonOptions,
  warnings: string[],
  serverId: string,
): Outcome {
  if (raw === undefined) return { kind: 'ok', map: {} };
  if (!isObject(raw)) return { kind: 'refuse', why: `\`${what}\` is not an object` };

  const map: Record<string, SecretValue> = {};
  for (const key of Object.keys(raw).sort()) {
    const value = raw[key];
    if (typeof value !== 'string') {
      return { kind: 'refuse', why: `\`${what}.${key}\` is not a string` };
    }

    const bad = unrepresentableReference(value);
    if (bad !== undefined) return { kind: 'refuse', why: `\`${what}.${key}\` ${bad.why}` };

    const parsed = options.parseReference(value) ?? canonicalReference(value);
    if (parsed !== undefined) {
      if (parsed.kind === 'unrepresentable') {
        return { kind: 'refuse', why: `\`${what}.${key}\` ${parsed.why}` };
      }
      map[key] = parsed.ref;
      continue;
    }

    // A literal. Two cases, and only one of them is safe to rewrite.
    if (isLiteralSecret(key, value)) {
      // T044's stated conversion: the credential becomes a reference named after the key
      // it was found under, so nothing is written back into a git-committed file.
      map[key] = literalToEnvRef(key);
      warnings.push(
        `${options.file}: server \`${serverId}\` had a literal credential under \`${what}.${key}\`; imported as \`env:${literalToEnvRef(key).name}\`. Set that variable before running the server.`,
      );
      continue;
    }

    // A reference with text around it — `Authorization: "Bearer ${TOKEN}"`, which is how
    // almost every real file spells that header. Canonical models a header value as an
    // `EnvRef` and nothing else, so the prefix has nowhere to live: importing it would
    // send the server the token without its scheme, and dropping the header would send
    // no credential at all. Named specifically rather than folded into the generic
    // literal message, because the fix a user needs to hear is different.
    if (/\$\{[^}]+\}/.test(value)) {
      return {
        kind: 'refuse',
        why: `\`${what}.${key}\` embeds a variable reference inside other text, and canonical MCP servers hold a bare reference (the surrounding text has nowhere to go)`,
      };
    }

    // A plain literal that is not a credential — `NODE_ENV: production` and its kind.
    // Canonical models `env` as `Record<string, EnvRef>`, so there is no way to say this
    // at all. Converting it would silently change behaviour (the server would start
    // reading the user's shell instead of a pinned value) and dropping the key would lose
    // content, so the whole server is refused, matching `parseServer`'s rule that a server
    // is dropped whole rather than half-built. Widening the model is filed separately.
    return {
      kind: 'refuse',
      why: `\`${what}.${key}\` is a literal value rather than an environment-variable reference, and canonical MCP servers can only hold references`,
    };
  }
  return { kind: 'ok', map };
}

const INTERPRETED = new Set(['command', 'args', 'url', 'type', 'env', 'headers']);

function importTransport(body: Record<string, JsonValue>): McpTransport | { readonly why: string } {
  const command = body['command'];
  const url = body['url'];

  if (typeof command === 'string' && typeof url === 'string') {
    return { why: 'declares both `command` and `url`' };
  }

  if (typeof command === 'string') {
    const rawArgs = body['args'];
    if (rawArgs !== undefined && !Array.isArray(rawArgs)) return { why: '`args` is not an array' };
    const args = rawArgs ?? [];
    if (!args.every((a): a is string => typeof a === 'string')) {
      return { why: '`args` contains a non-string entry' };
    }
    return { kind: 'stdio', command, args };
  }

  if (typeof url !== 'string') return { why: 'has neither `command` nor `url`' };

  const declared = body['type'];
  if (declared !== undefined && typeof declared !== 'string') {
    return { why: '`type` is not a string' };
  }
  // `streamable-http` is the MCP spec's name for what Claude Code and VS Code both call
  // `http`; Roo Code writes only the long form. Treated as the same transport rather than
  // as unknown, because they are.
  if (declared === undefined || declared === 'http' || declared === 'streamable-http') {
    return { kind: 'http', url };
  }
  if (declared === 'sse') return { kind: 'sse', url };
  // `ws` is documented by Claude Code and canonical has no arm for it. Refusing beats
  // importing it as `http`, which would generate a config pointing a streamable-HTTP
  // client at a WebSocket endpoint.
  return { why: `\`type: ${declared}\` has no canonical transport` };
}

/**
 * Invert a `{ "<serversKey>": { id: {...} } }` MCP config into canonical servers.
 *
 * Three of the four target formats are this shape, differing only in the top-level key
 * and the reference spelling — the same argument that put `importConcatenated` in the kit
 * at T017. Codex's TOML is the fourth and has its own reader.
 *
 * Never throws on user input: a file that is not JSON, or a server that cannot be
 * understood, produces a warning and is skipped. `init` runs this on a repository nobody
 * has prepared, and one odd server must not be a new user's first command failing.
 */
export function importMcpJson(contents: string, options: ImportMcpJsonOptions): ImportedMcpResult {
  const warnings: string[] = [];

  let root: unknown;
  try {
    root = JSON.parse(stripJsonc(contents)) as unknown;
  } catch (error) {
    return {
      servers: [],
      warnings: [`${options.file}: could not be parsed as JSON (${String(error)}); skipped`],
    };
  }

  if (!isObject(root)) return { servers: [], warnings };

  if (root['inputs'] !== undefined) {
    // A top-level array, so there is nowhere in `McpServer.unknown` to keep it and it is
    // lost. Said out loud rather than dropped quietly: the servers referring to it are
    // refused above, so a silent drop here would leave the user with neither the input nor
    // an explanation.
    warnings.push(
      `${options.file}: the top-level \`inputs\` array is not imported — canonical MCP servers name environment variables rather than prompting.`,
    );
  }

  const servers = root[options.serversKey];
  if (!isObject(servers)) return { servers: [], warnings };

  const out: McpServer[] = [];
  // Sorted so the import does not depend on key order in somebody's file.
  for (const id of Object.keys(servers).sort()) {
    if (id === '//') continue; // Driftgate's own generated marker.
    const body = servers[id];
    if (!isObject(body)) {
      warnings.push(`${options.file}: server \`${id}\` is not an object; skipped`);
      continue;
    }

    const transport = importTransport(body);
    if (!('kind' in transport)) {
      warnings.push(`${options.file}: server \`${id}\` ${transport.why}; skipped`);
      continue;
    }

    const env = importSecrets(body['env'], 'env', options, warnings, id);
    if (env.kind === 'refuse') {
      warnings.push(`${options.file}: server \`${id}\` skipped — ${env.why}`);
      continue;
    }
    const headers = importSecrets(body['headers'], 'headers', options, warnings, id);
    if (headers.kind === 'refuse') {
      warnings.push(`${options.file}: server \`${id}\` skipped — ${headers.why}`);
      continue;
    }

    const unknown: Record<string, JsonValue> = {};
    for (const key of Object.keys(body).sort()) {
      if (!INTERPRETED.has(key)) unknown[key] = body[key]!;
    }

    out.push(
      importedServer({
        id,
        transport,
        env: env.map,
        headers: headers.map,
        unknown,
        source: { file: options.file },
      }),
    );
  }

  return { servers: out, warnings };
}

/**
 * Remove `//` and block comments and trailing commas, string-aware.
 *
 * VS Code's MCP reference does not say whether `.vscode/mcp.json` is JSONC, and its own
 * examples are plain JSON — but VS Code's other configuration files accept comments, and
 * `JSON.parse` on a commented file throws where the tool it belongs to loads it happily.
 * Stripping first is safe for a plain JSON file, which is why it runs for all three JSON
 * dialects rather than being a per-adapter option. Recorded as unverified in `docs`.
 */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // Trailing commas, once comments are gone and only outside strings. Done as a second
  // pass over the stripped text so a comma inside a string literal is untouched.
  return dropTrailingCommas(out);
}

function dropTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** Re-exported so an adapter can name a variable without importing the render layer. */
export { envRef };

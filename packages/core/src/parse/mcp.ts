import { isMap, isScalar, type Node, type YAMLMap } from 'yaml';
import { RulegateError } from '../model/errors.js';
import { CANONICAL_SCHEMA_VERSION } from '../model/canonical.js';
import {
  DEFAULT_MCP_SCOPE,
  parseEnvRef,
  type McpScope,
  type McpServer,
  type SecretValue,
} from '../model/mcp.js';
import { MCP_SERVERS_PATH } from '../model/paths.js';
import { ALL_TOOLS, type ToolSelector } from '../model/selector.js';
import { compareCodepoint } from '../render/order.js';
import { findLiteralSecrets } from '../render/secrets.js';
import { parseYaml } from './yaml.js';
import { Validator } from './validate.js';
import type { JsonValue, SourceRef } from '../model/ids.js';

export interface ParsedMcpServers {
  readonly servers: readonly McpServer[];
  readonly errors: readonly RulegateError[];
}

/** Keys this parser understands. Everything else is preserved in `unknown`. */
const KNOWN_KEYS = new Set([
  'command',
  'args',
  'url',
  'transport',
  'env',
  'headers',
  'tools',
  'scope',
  'enabled',
]);

/**
 * Read `.rulegate/mcp/servers.yaml` into canonical MCP servers.
 *
 * Like every other parser here it **never throws on user input** — it accumulates, so a
 * file with four broken servers produces four messages in one run. A server that could
 * not be understood is dropped rather than half-built: `sync` refuses to proceed while
 * `errors` is non-empty, and a partially-parsed server is how a generated config ends up
 * missing the header that made it work.
 *
 * `servers` is a mapping rather than a list because the id is the key every target format
 * writes the server under, and a mapping makes duplicate ids a YAML-level impossibility
 * instead of a validation Rulegate has to perform.
 */
export function parseMcpServers(raw: string, file = MCP_SERVERS_PATH): ParsedMcpServers {
  const parsed = parseYaml(raw, file);
  if (!parsed.ok) return { servers: [], errors: [parsed.error] };

  const v = new Validator(file, parsed.value, 'E_MCP_INVALID');
  const root = parsed.value.doc.contents as Node | null;
  const map = root === null ? undefined : v.asMap(root, 'mcp');

  // Read but not enforced, matching the manifest: refusing to parse on a version bump
  // would make a forward-compatible file unreadable by the tool that has to report it.
  v.integer(v.get(map, 'schemaVersion'), 'schemaVersion', CANONICAL_SCHEMA_VERSION);

  const serversNode = v.get(map, 'servers');
  if (serversNode === undefined) return { servers: [], errors: v.errors };

  const servers = v.asMap(serversNode, 'servers');
  if (servers === undefined) return { servers: [], errors: v.errors };

  const out: McpServer[] = [];
  for (const item of servers.items) {
    if (!isScalar(item.key)) continue;
    const id = String(item.key.value);
    const server = parseServer(v, id, item.value as Node | null, file);
    if (server !== undefined) out.push(server);
  }

  // Sorted here, not by the renderer, so that two runs over the same file agree whatever
  // order the YAML happened to list them in.
  out.sort((a, b) => compareCodepoint(a.id, b.id));
  return { servers: out, errors: v.errors };
}

function parseServer(
  v: Validator,
  id: string,
  node: Node | null,
  file: string,
): McpServer | undefined {
  const field = `servers.${id}`;
  const source = v.yaml.posAt(node?.range?.[0], field);

  if (node === null || !isMap(node)) {
    v.fail(node, field, `\`${field}\` must be a mapping`, 'e.g. command: npx');
    return undefined;
  }

  const transport = parseTransport(v, node, field);
  if (transport === undefined) return undefined;

  return {
    id,
    transport,
    env: parseSecretMap(v, v.get(node, 'env'), `${field}.env`, file),
    headers: parseSecretMap(v, v.get(node, 'headers'), `${field}.headers`, file),
    tools: parseTools(v, v.get(node, 'tools'), `${field}.tools`),
    scope: parseScope(v, v.get(node, 'scope'), `${field}.scope`),
    enabled: v.boolean(v.get(node, 'enabled'), `${field}.enabled`, true),
    unknown: collectUnknown(v, node, field),
    source,
  };
}

/**
 * `command` means stdio, `url` means http unless `transport` says `sse`.
 *
 * Inferring rather than requiring a `transport` key is what makes the common case one
 * line, and an explicit `transport` still wins so an http server that a client insists on
 * calling `sse` can say so. Declaring both `command` and `url` is refused rather than
 * resolved by precedence: the two describe different servers, and picking one silently
 * generates a config that connects somewhere the author did not ask for.
 */
function parseTransport(v: Validator, node: YAMLMap, field: string) {
  const command = v.string(v.get(node, 'command'), `${field}.command`);
  const url = v.string(v.get(node, 'url'), `${field}.url`);
  const declared = v.string(v.get(node, 'transport'), `${field}.transport`);

  if (command !== undefined && url !== undefined) {
    v.fail(
      v.get(node, 'url'),
      `${field}.url`,
      `\`${field}\` declares both \`command\` and \`url\``,
      'a server is either a local process (command) or a remote endpoint (url), not both',
    );
    return undefined;
  }

  if (declared !== undefined && !['stdio', 'http', 'sse'].includes(declared)) {
    v.fail(
      v.get(node, 'transport'),
      `${field}.transport`,
      `\`${field}.transport\` must be stdio, http or sse`,
    );
    return undefined;
  }

  if (command !== undefined) {
    if (declared !== undefined && declared !== 'stdio') {
      v.fail(
        v.get(node, 'transport'),
        `${field}.transport`,
        `\`${field}\` has a \`command\`, so its transport is stdio, not ${declared}`,
      );
      return undefined;
    }
    return {
      kind: 'stdio' as const,
      command,
      args: v.stringArray(v.get(node, 'args'), `${field}.args`),
    };
  }

  if (url !== undefined) {
    if (declared === 'stdio') {
      v.fail(
        v.get(node, 'transport'),
        `${field}.transport`,
        `\`${field}\` has a \`url\`, so its transport cannot be stdio`,
      );
      return undefined;
    }
    return declared === 'sse' ? { kind: 'sse' as const, url } : { kind: 'http' as const, url };
  }

  v.fail(
    node,
    field,
    `\`${field}\` has neither \`command\` nor \`url\``,
    'a stdio server needs `command`; a remote server needs `url`',
  );
  return undefined;
}

/**
 * `env` and `headers` accept **`env:NAME` references and nothing else** (T044).
 *
 * The refusal is here, at the parser, rather than at the writer, because by the time a
 * literal reaches an adapter it has already been through the model — and the model's type
 * is `EnvRef`, so an adapter cannot be handed one. This is what keeps that type honest.
 *
 * The error names the key and never the value. A message that quotes the offending string
 * prints the secret into CI logs, which is the failure the rule exists to prevent,
 * committed to a different file.
 */
function parseSecretMap(
  v: Validator,
  node: Node | undefined,
  field: string,
  file: string,
): Record<string, SecretValue> {
  const out: Record<string, SecretValue> = {};
  const map = v.asMap(node, field);
  if (map === undefined) return out;

  for (const item of map.items) {
    if (!isScalar(item.key)) continue;
    const key = String(item.key.value);
    const value = v.string(item.value as Node | undefined, `${field}.${key}`);
    if (value === undefined) continue;

    const ref = parseEnvRef(value);
    if (ref === undefined) {
      v.errors.push(
        new RulegateError({
          code: 'E_LITERAL_SECRET',
          message: `\`${field}.${key}\` is a literal value, not an environment reference`,
          source: sourceOf(v, item.value as Node | undefined, `${field}.${key}`, file),
          hint: `use \`${key}: env:${envNameFor(key)}\` and set that variable where the tool runs`,
        }),
      );
      continue;
    }
    out[key] = ref;
  }
  return out;
}

function sourceOf(v: Validator, node: Node | undefined, field: string, file: string): SourceRef {
  return node === undefined ? { file, field } : v.yaml.posAt(node.range?.[0], field);
}

/** A plausible variable name for the hint, so the fix can be pasted rather than invented. */
function envNameFor(key: string): string {
  const upper = key.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return /^[A-Za-z_]/.test(upper) ? upper : `_${upper}`;
}

function parseTools(v: Validator, node: Node | undefined, field: string): ToolSelector {
  if (node === undefined) return ALL_TOOLS;
  if (isMap(node)) {
    const exclude = v.stringArray(v.get(node, 'exclude'), `${field}.exclude`);
    return { kind: 'exclude', tools: exclude };
  }
  return { kind: 'include', tools: v.stringArray(node, field) };
}

function parseScope(v: Validator, node: Node | undefined, field: string): McpScope {
  const raw = v.string(node, field);
  if (raw === undefined) return DEFAULT_MCP_SCOPE;
  if (raw === 'project' || raw === 'global') return raw;
  v.fail(node, field, `\`${field}\` must be project or global`);
  return DEFAULT_MCP_SCOPE;
}

/**
 * Keys Rulegate does not interpret, kept verbatim — and checked for secrets on the way
 * through (T044).
 *
 * This is the hole the `SecretValue` type cannot close. `unknown` is what makes import
 * lossless, and it carries plain strings that are re-emitted into generated, git-committed
 * output without ever passing a typed secret. Losslessness and "no literal secrets" pull
 * against each other exactly here, and the secret rule wins: the value is still preserved
 * in the model, but the run fails, so nothing is written until the author fixes it.
 */
function collectUnknown(v: Validator, node: YAMLMap, field: string): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const key of v.keys(node).sort(compareCodepoint)) {
    if (KNOWN_KEYS.has(key)) continue;
    const value = v.plain(v.get(node, key));
    for (const path of findLiteralSecrets(value, `${field}.${key}`)) {
      v.errors.push(
        new RulegateError({
          code: 'E_LITERAL_SECRET',
          message: `\`${path}\` looks like a literal credential`,
          source: v.yaml.posAt(v.get(node, key)?.range?.[0], `${field}.${key}`),
          hint: `replace it with \`env:NAME\` and set that variable where the tool runs`,
        }),
      );
    }
    out[key] = value;
  }
  return out;
}

import { stringify as stringifyYaml } from 'yaml';
import { compareCodepoint } from '../render/order.js';
import { ensureSingleTrailingNewline } from '../render/eol.js';
import { CANONICAL_SCHEMA_VERSION, DEFAULT_MANIFEST_OPTIONS } from './canonical.js';
import { DEFAULT_RULE_ORDER } from './rule.js';
import { MANIFEST_PATH, MCP_SERVERS_PATH, ruleIdToPath } from './paths.js';
import { DEFAULT_MCP_SCOPE, formatEnvRef, type McpServer, type SecretValue } from './mcp.js';
import type { Canonical } from './canonical.js';
import type { RuleDocument } from './rule.js';
import type { JsonValue } from './ids.js';

/**
 * Canonical model -> the on-disk `.rulegate/` representation, as path -> contents.
 *
 * Used by the round-trip test, and by `init` (T019) to write canonical after import.
 * Defaults are omitted rather than written out: a hand-authored `.rulegate/` should
 * look like something a person would write, and the parser restores defaults anyway,
 * so the model still round-trips.
 */
export function serializeCanonical(canonical: Canonical): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  out.set(MANIFEST_PATH, serializeManifest(canonical));
  for (const rule of canonical.rules) {
    out.set(rule.path === '' ? ruleIdToPath(rule.id) : rule.path, serializeRule(rule));
  }
  // Written only when there is something to write. An empty `servers:` file in every
  // repository that has never configured MCP is a file the user has to wonder about.
  if (canonical.mcpServers.length > 0) {
    out.set(MCP_SERVERS_PATH, serializeMcpServers(canonical.mcpServers));
  }
  return new Map([...out].sort(([a], [b]) => compareCodepoint(a, b)));
}

function serializeManifest(canonical: Canonical): string {
  const { manifest } = canonical;
  const doc: Record<string, JsonValue> = { schemaVersion: manifest.schemaVersion };

  doc['tools'] = manifest.tools.map((tool) => {
    const hasOptions = Object.keys(tool.options).length > 0;
    if (tool.enabled && !hasOptions) return tool.id;
    const entry: Record<string, JsonValue> = { id: tool.id };
    if (!tool.enabled) entry['enabled'] = false;
    if (hasOptions) entry['options'] = { ...tool.options };
    return entry;
  });

  const options: Record<string, JsonValue> = {};
  if (manifest.options.marker !== DEFAULT_MANIFEST_OPTIONS.marker) {
    options['marker'] = manifest.options.marker;
  }
  if (manifest.options.backup !== DEFAULT_MANIFEST_OPTIONS.backup) {
    options['backup'] = manifest.options.backup;
  }
  if (Object.keys(options).length > 0) doc['options'] = options;

  if (manifest.canonicalSources.length > 0) {
    doc['canonicalSources'] = [...manifest.canonicalSources];
  }

  return ensureSingleTrailingNewline(stringifyYaml(doc, { lineWidth: 0 }));
}

function serializeRule(rule: RuleDocument): string {
  const fm = rule.frontmatter;
  const doc: Record<string, JsonValue> = {};

  if (fm.description !== undefined) doc['description'] = fm.description;
  if (fm.globs.length > 0) doc['globs'] = [...fm.globs];
  if (fm.tools.kind === 'include') doc['tools'] = [...fm.tools.tools];
  else if (fm.tools.kind === 'exclude') doc['tools'] = { exclude: [...fm.tools.tools] };
  if (fm.order !== DEFAULT_RULE_ORDER) doc['order'] = fm.order;

  // Unknown keys are re-emitted verbatim so that a round trip through Rulegate never
  // costs a user content it did not understand.
  for (const key of Object.keys(fm.unknown).sort(compareCodepoint)) {
    doc[key] = fm.unknown[key] as JsonValue;
  }

  const body = ensureSingleTrailingNewline(rule.body);
  if (Object.keys(doc).length === 0) return body;

  const yaml = ensureSingleTrailingNewline(stringifyYaml(doc, { lineWidth: 0 }));
  return `---\n${yaml}---\n\n${body}`;
}

/**
 * Canonical MCP servers -> `.rulegate/mcp/servers.yaml` (T043, RFC-0001 §11).
 *
 * Defaults are omitted, like the manifest's: `scope: project`, `enabled: true` and
 * `tools` meaning every tool are what you get by saying nothing, and writing them out
 * would make a hand-authored file look nothing like what a person would write. The
 * parser restores them, so the model still round-trips.
 *
 * Secrets go back as `env:NAME` because that is the only form the model can hold — a
 * literal cannot reach here, since `SecretValue` is `EnvRef` and the parser refuses
 * anything else (T044).
 */
export function serializeMcpServers(servers: readonly McpServer[]): string {
  const doc: Record<string, JsonValue> = { schemaVersion: CANONICAL_SCHEMA_VERSION };
  const out: Record<string, JsonValue> = {};

  for (const server of [...servers].sort((a, b) => compareCodepoint(a.id, b.id))) {
    const entry: Record<string, JsonValue> = {};

    switch (server.transport.kind) {
      case 'stdio':
        entry['command'] = server.transport.command;
        if (server.transport.args.length > 0) entry['args'] = [...server.transport.args];
        break;
      case 'http':
        entry['url'] = server.transport.url;
        break;
      case 'sse':
        // The only transport that cannot be inferred from the shape of the entry: an
        // `sse` server and an `http` one both have nothing but a `url`.
        entry['url'] = server.transport.url;
        entry['transport'] = 'sse';
        break;
    }

    const env = serializeSecrets(server.env);
    if (env !== undefined) entry['env'] = env;
    const headers = serializeSecrets(server.headers);
    if (headers !== undefined) entry['headers'] = headers;

    if (server.tools.kind === 'include') entry['tools'] = [...server.tools.tools];
    else if (server.tools.kind === 'exclude') entry['tools'] = { exclude: [...server.tools.tools] };

    if (server.scope !== DEFAULT_MCP_SCOPE) entry['scope'] = server.scope;
    if (!server.enabled) entry['enabled'] = false;

    for (const key of Object.keys(server.unknown).sort(compareCodepoint)) {
      entry[key] = server.unknown[key] as JsonValue;
    }

    out[server.id] = entry;
  }

  doc['servers'] = out;
  return ensureSingleTrailingNewline(stringifyYaml(doc, { lineWidth: 0 }));
}

function serializeSecrets(
  map: Readonly<Record<string, SecretValue>>,
): Record<string, JsonValue> | undefined {
  const keys = Object.keys(map).sort(compareCodepoint);
  if (keys.length === 0) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const key of keys) out[key] = formatEnvRef(map[key]!);
  return out;
}

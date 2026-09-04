import { compareCodepoint, DriftgateError, type JsonValue } from '@driftgate/adapter-kit';

/**
 * A TOML emitter, scoped to exactly what an `McpServer` can contain.
 *
 * Hand-written for the same two reasons `mdc.ts` and `instructions.ts` are. An adapter may
 * declare exactly one dependency — `@driftgate/adapter-kit`, pinned by
 * `invariants.test.ts` — so a TOML library cannot be added here at all. And a destination's
 * dialect is tool knowledge: the renderer speaks the destination's language, which is why
 * the `${NAME}` / `${env:NAME}` split lives in the two JSON writers rather than in core.
 *
 * It is deliberately not a general TOML writer. Everything it cannot represent **throws**
 * rather than guessing, because a config that looks right and is subtly wrong is the worst
 * output this project can produce.
 *
 * Reference: https://toml.io/en/v1.0.0 (read 2026-09-04).
 */

/** TOML bare keys are `A-Za-z0-9_-`. Anything else has to be quoted. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function unrepresentable(what: string, where: string): DriftgateError {
  return new DriftgateError({
    code: 'E_MCP_UNREPRESENTABLE',
    message: `${where} cannot be written to Codex's config.toml: ${what}`,
    hint: 'remove the value, or exclude this server from codex with a `tools:` selector in .driftgate/mcp/servers.yaml',
  });
}

/**
 * A TOML basic string.
 *
 * Only `"` and `\` and the control characters need escaping; everything else is written
 * through, so a URL keeps its slashes and a Windows-shaped command keeps its bytes. A
 * literal string (`'...'`) would avoid escaping entirely and is deliberately not used: it
 * cannot represent a value containing a single quote, so it moves the failure rather than
 * removing it.
 */
export function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

export function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : tomlString(key);
}

/**
 * A value on the right of `=`.
 *
 * `null` has no TOML spelling at all — the format's answer to "no value" is to omit the
 * key, and there is no way to say "present and empty". A `JsonValue` from a preserved
 * unknown key can be null, so this is a real input rather than a defensive branch.
 */
function tomlValue(value: JsonValue, where: string): string {
  if (value === null) throw unrepresentable('TOML has no null; omit the key instead', where);
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw unrepresentable('a non-finite number', where);
    // `Number.prototype.toString` renders an integral float as `1`, which TOML reads back
    // as an integer. That round-trips for every value an MCP config carries (timeouts and
    // ports), and the alternative — deciding a float is intended — would be a guess.
    return String(value);
  }
  if (Array.isArray(value)) {
    // A TOML array may hold mixed types since 1.0, but an array of tables or of nulls has
    // no inline form worth emitting, so only scalars are accepted here.
    const items = value.map((item, i) => {
      if (item !== null && typeof item === 'object') {
        throw unrepresentable(
          'an array holding a table or another array',
          `${where}[${String(i)}]`,
        );
      }
      return tomlValue(item, `${where}[${String(i)}]`);
    });
    return `[${items.join(', ')}]`;
  }
  // A nested object would have to become a sub-table, which changes where the key appears
  // in the file rather than only how it is written. Refused rather than relocated.
  throw unrepresentable('a nested table under a key Driftgate does not interpret', where);
}

/** One `[header]` table. Keys are emitted in codepoint order — the bytes are a contract. */
export function tomlTable(header: readonly string[], entries: Readonly<Record<string, JsonValue>>) {
  const path = header.map((part) => tomlKey(part)).join('.');
  const lines = [`[${path}]`];
  for (const key of Object.keys(entries).sort(compareCodepoint)) {
    lines.push(`${tomlKey(key)} = ${tomlValue(entries[key]!, `${path}.${key}`)}`);
  }
  return lines.join('\n');
}

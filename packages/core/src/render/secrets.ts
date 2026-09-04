import { envRef, type EnvRef } from '../model/mcp.js';
import { compareCodepoint } from './order.js';
import type { JsonValue } from '../model/ids.js';

/**
 * Never write a literal secret (T044). This is the third of three enforcement points.
 *
 * The first is the type system — `SecretValue` is `EnvRef`, so an adapter cannot be
 * *handed* a literal. The second is the parser, which refuses one in `env` or `headers`.
 * Neither closes the hole this module exists for: `McpServer.unknown` holds arbitrary
 * `JsonValue`, preserved verbatim so a round trip loses nothing, and a string in there
 * reaches generated output without passing a single `SecretValue`. Losslessness and "no
 * literal secrets" pull in opposite directions exactly here, and this is where the second
 * one wins.
 *
 * **Nothing in this module ever returns or logs the offending value.** Every result is a
 * key path. A scanner that quoted what it found would print the secret into CI logs,
 * which is the failure it exists to prevent, committed to a different file.
 */

/**
 * Keys whose value is a secret by convention.
 *
 * Matching on the key rather than on the value's entropy is what keeps this usable: a
 * generic high-entropy scan fires on git hashes, base64 assets and minified code, and a
 * check people learn to override is not a check. The entropy test still runs, but only
 * where the key has already said the value is a credential.
 */
const SECRET_WORDS: readonly string[] = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'accesskey',
  'privatekey',
  'auth',
  'credential',
  'bearer',
];

/**
 * Keys that name an environment variable rather than hold a value.
 *
 * Codex's `bearer_token_env_var = "LINEAR_API_KEY"` is a correct, secret-free line that
 * every other rule here condemns: the key flattens to `bearertokenenvvar`, which contains
 * both `bearer` and `token`, and an environment variable name long enough is disordered
 * enough to look generated. `bearer_token_env_var = "DOCS_API_KEY_PRODUCTION"` was
 * reported as a literal credential and failed `sync` on a config that contained no
 * credential at all — and a check that fires on a correct repository is one people mute
 * (the T072 lesson, reached from a different direction).
 *
 * This is not a per-tool exception. `env_var`, `env_variable` and `envvar` all mean the
 * same thing wherever they appear, and the value under one of them is a *name*, which is
 * exactly what an `env:NAME` reference is. Matched as a suffix rather than a substring so
 * that a key which merely mentions the environment somewhere in the middle is untouched.
 */
const ENV_VAR_NAME_SUFFIXES: readonly string[] = ['envvar', 'envvariable', 'envvarname'];

function namesEnvVar(flatKey: string): boolean {
  return ENV_VAR_NAME_SUFFIXES.some((suffix) => flatKey.endsWith(suffix));
}

/**
 * Match on the key with its separators removed, so one list covers `authToken`,
 * `auth_token`, `AUTH-TOKEN` and `auth.token` without three spellings of each word.
 * Written this way after `authToken` slipped through a word-boundary regex: `auth` is
 * followed by `T`, which is neither a boundary nor a separator.
 */
function keySuggestsSecret(key: string): boolean {
  const flat = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (namesEnvVar(flat)) return false;
  return SECRET_WORDS.some((word) => flat.includes(word));
}

/**
 * Values that are a credential whatever key they sit under.
 *
 * Vendor-issued prefixes only — each one is a published, unambiguous format, so a match
 * is a fact rather than a guess. Ordered by how commonly they appear in an MCP config.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}/, // GitHub personal access / OAuth / server / refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, // GitHub fine-grained PAT
  /\bsk-[A-Za-z0-9-_]{16,}/, // OpenAI and lookalikes
  /\bsk-ant-[A-Za-z0-9-_]{16,}/, // Anthropic
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bglpat-[A-Za-z0-9-_]{16,}/, // GitLab
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z\-_]{35}\b/, // Google API key
  /\bnpm_[A-Za-z0-9]{36}\b/, // npm
];

/**
 * A reference rather than a value.
 *
 * `env:NAME` is Driftgate's own syntax. The `${...}` forms are what the target formats
 * use — VS Code writes `${env:NAME}` and `${input:name}`, Claude Code and Cursor accept
 * `${NAME}` — so a config that already defers to the environment must not be reported as
 * a literal just because it spells it the destination's way.
 */
function isReference(value: string): boolean {
  return (
    /^env:/.test(value) || /^\$\{[^}]+\}$/.test(value) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)
  );
}

/**
 * Shannon entropy per character, in bits.
 *
 * Only consulted for a value whose key already claims it is a credential, so the
 * threshold can be generous without becoming noisy.
 */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Long and disordered enough that no human typed it as prose. */
function looksGenerated(value: string): boolean {
  return value.length >= 16 && entropy(value) >= 3.2 && !value.includes(' ');
}

export function isLiteralSecret(key: string, value: string): boolean {
  if (isReference(value)) return false;
  if (TOKEN_PATTERNS.some((re) => re.test(value))) return true;
  return keySuggestsSecret(key) && looksGenerated(value);
}

/**
 * Every key path under `value` that holds a literal secret. Paths only, never values.
 *
 * @param value a `JsonValue` — in practice `McpServer.unknown`.
 * @param prefix the path to report matches under, e.g. `servers.github`.
 */
export function findLiteralSecrets(value: JsonValue, prefix: string): string[] {
  const found: string[] = [];

  const walk = (node: JsonValue, path: string, key: string): void => {
    if (typeof node === 'string') {
      if (isLiteralSecret(key, node)) found.push(path);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        // An array element inherits its parent's key: `args: ['--token', 'ghp_...']`
        // is a credential under a key called `args`, and the vendor prefixes catch it
        // regardless.
        walk(item, `${path}[${String(i)}]`, key);
      });
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const k of Object.keys(node).sort(compareCodepoint)) {
        walk((node as Record<string, JsonValue>)[k] as JsonValue, `${path}.${k}`, k);
      }
    }
  };

  walk(value, prefix, prefix.split('.').at(-1) ?? prefix);
  return found;
}

/**
 * Scan rendered text — the last gate, for artifacts an adapter produced itself.
 *
 * Line-oriented and format-agnostic on purpose: it has to work on JSON, on TOML and on
 * whatever the next MCP format turns out to be, and it runs after rendering, where no
 * structure is left to walk. Returns `line: n` labels, never the matching text.
 */
export function scanTextForSecrets(text: string): string[] {
  const found: string[] = [];
  text.split('\n').forEach((line, i) => {
    const label = `line ${String(i + 1)}`;
    if (TOKEN_PATTERNS.some((re) => re.test(line))) {
      found.push(label);
      return;
    }
    // `"authToken": "…"` in JSON, `auth_token = "…"` in TOML, `token: …` in YAML.
    //
    // The value alternatives are ordered quoted-first and the unquoted one stops at a
    // delimiter. A single class like `[^"',}\s]+` truncates `"${env:TOKEN}"` at the
    // closing brace, and the fragment left over is no longer recognizable as a reference
    // — so the one value that is unambiguously *correct* gets reported as a literal.
    const pair = /["']?([A-Za-z0-9_\-.]+)["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,}\]]+))/.exec(
      line,
    );
    const value = pair?.[2] ?? pair?.[3] ?? pair?.[4];
    if (pair && value !== undefined && isLiteralSecret(pair[1]!, value)) found.push(label);
  });
  return found;
}

/**
 * The conversion T044 asks import to perform: a literal becomes a reference named after
 * the key it was found under.
 *
 * Exported now and wired up by MCP import (T048), which is where a literal can first
 * arrive from somebody else's config file.
 */
export function literalToEnvRef(key: string): EnvRef {
  const upper = key.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return envRef(/^[A-Za-z_]/.test(upper) ? upper : `_${upper}`);
}

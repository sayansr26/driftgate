import { describe, expect, it } from 'vitest';
import { RulegateError, type JsonValue } from '@rulegate/adapter-kit';
import { tomlKey, tomlString, tomlTable } from '../src/toml.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof RulegateError ? e.code : `not a RulegateError: ${String(e)}`;
  }
};

describe('the TOML emitter (T047)', () => {
  it('escapes only what TOML requires, and writes the rest through', () => {
    // A URL keeps its slashes and colons; a Windows-shaped command keeps its bytes.
    expect(tomlString('https://mcp.example.com/mcp')).toBe('"https://mcp.example.com/mcp"');
    expect(tomlString('C:\\tools\\server.exe')).toBe('"C:\\\\tools\\\\server.exe"');
    expect(tomlString('say "hi"')).toBe('"say \\"hi\\""');
    expect(tomlString('a\nb\tc')).toBe('"a\\nb\\tc"');
    // A control character has no literal form at all — it must become an escape, or the
    // file is not parseable TOML.
    expect(tomlString('a\u0001b')).toBe('"a\\u0001b"');
  });

  it('leaves non-ASCII alone rather than escaping it', () => {
    // TOML basic strings are UTF-8. Escaping here would change bytes `state.json` hashes
    // for no reason, and would make a Japanese server id unreadable in the file.
    expect(tomlString('サーバー')).toBe('"サーバー"');
  });

  it('quotes a key only when it is not a bare key', () => {
    expect(tomlKey('bearer_token_env_var')).toBe('bearer_token_env_var');
    expect(tomlKey('alpha-http')).toBe('alpha-http');
    expect(tomlKey('my server')).toBe('"my server"');
    expect(tomlKey('a.b')).toBe('"a.b"');
  });

  it('writes table keys in codepoint order, because the bytes are a contract', () => {
    expect(tomlTable(['mcp_servers', 'x'], { url: 'u', args: ['a'], command: 'c' })).toBe(
      ['[mcp_servers.x]', 'args = ["a"]', 'command = "c"', 'url = "u"'].join('\n'),
    );
  });

  it('writes numbers and booleans unquoted', () => {
    // Quoting a timeout would change the type Codex reads back.
    expect(tomlTable(['t'], { n: 600000, b: true, f: 1.5 })).toBe(
      ['[t]', 'b = true', 'f = 1.5', 'n = 600000'].join('\n'),
    );
  });

  it('refuses null, which TOML cannot say at all', () => {
    // A preserved unknown key really can be null, so this is a reachable input rather
    // than a defensive branch. TOML's answer to "no value" is to omit the key, and there
    // is no way to write "present and empty" — so guessing either would be wrong.
    expect(codeOf(() => tomlTable(['t'], { k: null }))).toBe('E_MCP_UNREPRESENTABLE');
  });

  it('refuses a nested table under an uninterpreted key', () => {
    // Refused rather than relocated: turning it into a sub-table changes *where* the key
    // appears in the file, not only how it is written.
    const nested: Record<string, JsonValue> = { a: { b: 1 } };
    expect(codeOf(() => tomlTable(['t'], nested))).toBe('E_MCP_UNREPRESENTABLE');
  });

  it('refuses an array holding a table', () => {
    const withTable: Record<string, JsonValue> = { k: [{ a: 1 }] };
    expect(codeOf(() => tomlTable(['t'], withTable))).toBe('E_MCP_UNREPRESENTABLE');
  });

  it('accepts the shapes it does support, so the refusals above mean something', () => {
    // The control for all four refusals: a function that throws for everything passes
    // every "it throws" assertion (T020).
    expect(
      codeOf(() => tomlTable(['t'], { s: 'x', n: 1, b: false, a: ['p', 'q'] })),
    ).toBeUndefined();
    expect(tomlTable(['t'], { a: ['p', 'q'] })).toContain('a = ["p", "q"]');
  });

  it('names the key path and never the value it refused', () => {
    // The T044 rule, applied to a code path that did not exist when it was written: an
    // unknown key can hold a credential, and this error is raised while rendering one.
    // A message that echoed the offending value would print it into CI logs — the exact
    // failure the rule exists to prevent, committed to a different file.
    const secret = 'ghp_0123456789abcdefghijklmnop';
    const nested: Record<string, JsonValue> = { auth: { token: secret } };
    try {
      tomlTable(['mcp_servers', 'x'], nested);
      expect.unreachable('should have refused');
    } catch (e) {
      const err = e as RulegateError;
      expect(err.message).toContain('mcp_servers.x.auth');
      expect(err.message).not.toContain(secret);
      expect(err.hint ?? '').not.toContain(secret);
    }
  });
});

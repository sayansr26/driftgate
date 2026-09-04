import { describe, expect, it } from 'vitest';
import { importContextFor } from '@rulegate/adapter-kit/testing';
import { codex } from '../src/index.js';
import { importConfigToml, renderConfigToml } from '../src/mcp.js';
import { parseToml } from '../src/toml-read.js';

const FILE = '.codex/config.toml';

describe('parseToml — T048', () => {
  it('reads tables, strings, arrays, numbers and booleans', () => {
    const tables = parseToml(
      [
        'model = "gpt-5"',
        '',
        '# a comment',
        '[mcp_servers.memory]',
        'command = "npx"',
        'args = ["-y", "server-memory"]  # trailing comment',
        'timeout = 30',
        'enabled = true',
      ].join('\n'),
    );
    const top = tables.find((t) => t.path.length === 0);
    expect(top?.entries).toEqual({ model: 'gpt-5' });
    const server = tables.find((t) => t.path.join('.') === 'mcp_servers.memory');
    expect(server?.entries).toEqual({
      command: 'npx',
      args: ['-y', 'server-memory'],
      timeout: 30,
      enabled: true,
    });
  });

  it('does not treat a `#` or a comma inside a string as syntax', () => {
    const tables = parseToml('[mcp_servers.s]\nurl = "https://x.test/a,b#frag"\n');
    const table = tables.find((t) => t.path.join('.') === 'mcp_servers.s');
    expect(table?.entries['url']).toBe('https://x.test/a,b#frag');
  });

  it('reports a value it cannot represent instead of guessing at it', () => {
    // A datetime is real TOML and nothing an MCP config carries. Reading it as a string
    // would put a value in `unknown` that the emitter then writes back quoted, silently
    // changing its type.
    const tables = parseToml('[mcp_servers.s]\ncommand = "x"\nsince = 1979-05-27T07:32:00Z\n');
    const table = tables.find((t) => t.path.join('.') === 'mcp_servers.s');
    expect(table?.unreadable).toEqual(['since']);
    expect(table?.entries['since']).toBeUndefined();
  });
});

describe('importConfigToml — T048', () => {
  it('inverts env_vars and bearer_token_env_var back into references', () => {
    const { servers } = importConfigToml(
      [
        '[mcp_servers.gh]',
        'url = "https://api.githubcopilot.com/mcp"',
        'bearer_token_env_var = "GITHUB_TOKEN"',
        '',
        '[mcp_servers.pg]',
        'command = "uvx"',
        'env_vars = ["PGPASSWORD"]',
      ].join('\n'),
      FILE,
    );
    expect(servers.map((s) => s.id)).toEqual(['gh', 'pg']);
    expect(servers[0]!.headers['Authorization']).toEqual({ kind: 'env', name: 'GITHUB_TOKEN' });
    expect(servers[1]!.env['PGPASSWORD']).toEqual({ kind: 'env', name: 'PGPASSWORD' });
  });

  it('round-trips what the writer produces', () => {
    // The strongest available check that reader and writer agree, and the one that would
    // catch either drifting from the other.
    const { servers } = importConfigToml(
      ['[mcp_servers.gh]', 'url = "https://x.test/mcp"', 'bearer_token_env_var = "TOKEN"'].join(
        '\n',
      ),
      FILE,
    );
    const rendered = renderConfigToml(servers, false);
    expect(importConfigToml(rendered, FILE).servers).toEqual(servers);
  });

  it('warns that non-MCP tables will not survive the first sync', () => {
    // Rulegate owns this whole file once it writes it. Saying so during `init` is the
    // difference between a warning and a surprise.
    const { warnings } = importConfigToml(
      '[tui]\ntheme = "dark"\n\n[mcp_servers.s]\ncommand = "x"\n',
      FILE,
    );
    expect(warnings.join('\n')).toContain('tui');
    expect(warnings.join('\n')).toContain('will not survive');
  });
});

describe('codex read() — the AGENTS.md guard is for rules only (T048)', () => {
  it('imports MCP servers even when AGENTS.md is the canonical source', async () => {
    // The mirror of the write-side bug T046 found. `read()` returned early whenever
    // AGENTS.md was canonical — correct for rules, and it would have silently suppressed
    // MCP import on every repository that adopts Rulegate through a bare AGENTS.md,
    // which is this tool's most common first contact.
    const ctx = importContextFor('codex-mcp-import/input');
    const result = await codex.read({
      ...ctx,
      canonical: {
        ...ctx.canonical,
        manifest: { ...ctx.canonical.manifest, canonicalSources: ['AGENTS.md'] },
      },
    });

    // No rules — AGENTS.md is canonical and the parser has already read it.
    expect(result.rules).toBeUndefined();
    // But the servers are still imported.
    expect(result.mcpServers?.map((s) => s.id)).toEqual(['memory']);
  });
});

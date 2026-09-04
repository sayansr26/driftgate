import { describe, expect, it } from 'vitest';
import { expectFixtureMatch } from '@rulegate/adapter-kit/testing';
import { rooCode } from '../src/index.js';
import { importMcpConfig, renderMcpJson } from '../src/mcp.js';

describe('roo-code MCP', () => {
  it('matches the golden .roo/mcp.json byte for byte', async () => {
    await expectFixtureMatch('roo-code-mcp', rooCode);
  });

  it('writes `streamable-http`, not `http`', () => {
    // The Roo-shaped version of the divergence T046 found. Every other target spells
    // streamable HTTP `http` or omits the discriminator; Roo spells it in full, and `http`
    // here would parse cleanly and select no transport Roo recognizes — the `servers` key
    // trap again: valid JSON that supplies nothing.
    const rendered = renderMcpJson(
      [
        {
          id: 's',
          transport: { kind: 'http', url: 'https://x.test/mcp' },
          env: {},
          headers: {},
          tools: { kind: 'all' },
          scope: 'project',
          enabled: true,
          unknown: {},
          source: { file: 'test' },
        },
      ],
      false,
    );
    expect(rendered).toContain('"streamable-http"');
    expect(rendered).not.toContain('"type": "http"');
  });

  it('round-trips what it writes', () => {
    const servers = importMcpConfig(
      JSON.stringify({
        mcpServers: {
          remote: { type: 'streamable-http', url: 'https://x.test', headers: { A: 'env:TOKEN' } },
          local: { type: 'stdio', command: 'npx', args: ['-y', 'srv'] },
        },
      }),
    ).servers;

    // `streamable-http` must come back as canonical `http`, or a re-render would not be
    // idempotent and `check` would report permanent drift on a file it just wrote.
    expect(servers.find((s) => s.id === 'remote')?.transport).toEqual({
      kind: 'http',
      url: 'https://x.test',
    });
    expect(importMcpConfig(renderMcpJson(servers, false)).servers).toEqual(servers);
  });
});

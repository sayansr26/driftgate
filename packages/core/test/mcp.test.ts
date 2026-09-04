import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/io/memory.js';
import { serializeCanonical, serializeMcpServers } from '../src/model/serialize.js';
import { parse } from '../src/parse/index.js';
import { parseMcpServers } from '../src/parse/mcp.js';
import { CANONICAL_SCHEMA_VERSION, DEFAULT_MANIFEST_OPTIONS } from '../src/model/canonical.js';
import { ALL_TOOLS } from '../src/model/selector.js';
import { envRef } from '../src/model/mcp.js';
import { MANIFEST_PATH, MCP_SERVERS_PATH } from '../src/model/paths.js';
import type { Canonical } from '../src/model/canonical.js';
import type { McpServer } from '../src/model/mcp.js';

function server(over: Partial<McpServer> & Pick<McpServer, 'id' | 'transport'>): McpServer {
  return {
    env: {},
    headers: {},
    tools: ALL_TOOLS,
    scope: 'project',
    enabled: true,
    unknown: {},
    source: { file: MCP_SERVERS_PATH },
    ...over,
  };
}

/** T043's validation: five servers, covering every field and all three transports. */
const fiveServers: readonly McpServer[] = [
  server({
    id: 'github',
    transport: {
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    },
    env: { GITHUB_TOKEN: envRef('GITHUB_TOKEN') },
  }),
  server({
    id: 'linear',
    transport: { kind: 'sse', url: 'https://mcp.linear.app/sse' },
    headers: { Authorization: envRef('LINEAR_API_KEY') },
    tools: { kind: 'include', tools: ['claude-code', 'cursor'] },
  }),
  server({
    id: 'notion',
    transport: { kind: 'http', url: 'https://mcp.notion.com/mcp' },
    tools: { kind: 'exclude', tools: ['copilot'] },
  }),
  server({
    id: 'personal-notes',
    transport: { kind: 'stdio', command: './scripts/notes', args: [] },
    scope: 'global',
  }),
  server({
    id: 'retired',
    transport: { kind: 'stdio', command: 'old-server', args: [] },
    enabled: false,
    // A key Driftgate has never heard of. It must survive the round trip.
    unknown: { experimentalTimeout: 30, note: 'kept for the migration' },
  }),
];

const model: Canonical = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  manifest: {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    tools: [{ id: 'claude-code', enabled: true, options: {}, source: { file: MANIFEST_PATH } }],
    options: DEFAULT_MANIFEST_OPTIONS,
    canonicalSources: [],
    source: { file: MANIFEST_PATH },
  },
  rules: [],
  mcpServers: fiveServers,
  skills: [],
};

function stripSources(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v: unknown) => (key === 'source' ? undefined : v)),
  ) as unknown;
}

describe('mcp round trip', () => {
  it('survives model -> serialize -> parse unchanged, for five servers', async () => {
    const result = await parse({ fs: new MemoryFileSystem(serializeCanonical(model)) });

    expect(result.errors).toEqual([]);
    expect(stripSources(result.canonical.mcpServers)).toEqual(stripSources(fiveServers));
  });

  it('reaches a fixed point on a second pass', async () => {
    const once = await parse({ fs: new MemoryFileSystem(serializeCanonical(model)) });
    const twice = await parse({ fs: new MemoryFileSystem(serializeCanonical(once.canonical)) });

    expect(twice.canonical.mcpServers).toEqual(once.canonical.mcpServers);
  });

  it('serializes deterministically across repeated runs', () => {
    const first = serializeMcpServers(fiveServers);
    for (let i = 0; i < 20; i += 1) expect(serializeMcpServers(fiveServers)).toBe(first);
  });

  it('orders servers by id whatever order they were written in', () => {
    expect(serializeMcpServers([...fiveServers].reverse())).toBe(serializeMcpServers(fiveServers));
  });

  it('writes no servers.yaml when there are none', () => {
    expect(serializeCanonical({ ...model, mcpServers: [] }).has(MCP_SERVERS_PATH)).toBe(false);
  });

  it('lists servers.yaml among the files it read', async () => {
    const result = await parse({ fs: new MemoryFileSystem(serializeCanonical(model)) });

    // `sourceFiles` is what `doctor` reports and what state records; a file read but
    // not listed is one nobody can be told about.
    expect(result.sourceFiles).toContain(MCP_SERVERS_PATH);
  });

  it('omits every default, so the file reads like one a person would write', () => {
    const yaml = serializeMcpServers([
      server({ id: 'plain', transport: { kind: 'stdio', command: 'npx', args: [] } }),
    ]);

    expect(yaml).not.toContain('scope:');
    expect(yaml).not.toContain('enabled:');
    expect(yaml).not.toContain('tools:');
    expect(yaml).not.toContain('args:');
    // Anti-vacuity: the one thing that is not a default is written.
    expect(yaml).toContain('command: npx');
  });
});

describe('mcp transport inference', () => {
  it('reads a bare command as stdio and a bare url as http', () => {
    const { servers, errors } = parseMcpServers(
      'servers:\n  a:\n    command: npx\n  b:\n    url: https://example.com/mcp\n',
    );

    expect(errors).toEqual([]);
    expect(servers.map((s) => s.transport.kind)).toEqual(['stdio', 'http']);
  });

  it('sorts a hand-written file by id, whatever order the author listed them in', () => {
    // The serializer already emits sorted, so a round-trip fixture reaches the parser
    // in order and proves nothing about this — deleting the sort passed every other
    // test in this file. A hand-written `servers.yaml` is the only input that supplies
    // it, and rendering order has to be deterministic whoever typed the file.
    const { servers } = parseMcpServers(
      'servers:\n  zebra:\n    command: z\n  alpha:\n    command: a\n  middle:\n    command: m\n',
    );

    expect(servers.map((s) => s.id)).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('needs `transport: sse` to tell sse from http, since both are a bare url', () => {
    const { servers } = parseMcpServers(
      'servers:\n  a:\n    url: https://example.com/sse\n    transport: sse\n',
    );

    expect(servers[0]?.transport.kind).toBe('sse');
  });

  it('refuses a server with both a command and a url', () => {
    // Not resolved by precedence: the two describe different servers, and picking one
    // silently generates a config that connects somewhere nobody asked for.
    const { servers, errors } = parseMcpServers(
      'servers:\n  a:\n    command: npx\n    url: https://example.com/mcp\n',
    );

    expect(servers).toEqual([]);
    expect(errors[0]?.code).toBe('E_MCP_INVALID');
    expect(errors[0]?.message).toContain('both');
  });

  it('refuses a transport that contradicts the shape', () => {
    const { errors } = parseMcpServers(
      'servers:\n  a:\n    url: https://example.com/mcp\n    transport: stdio\n',
    );

    expect(errors[0]?.code).toBe('E_MCP_INVALID');
  });

  it('refuses a server with neither a command nor a url', () => {
    const { errors } = parseMcpServers('servers:\n  a:\n    env:\n      X: env:X\n');

    expect(errors[0]?.code).toBe('E_MCP_INVALID');
    expect(errors[0]?.hint).toContain('command');
  });

  it('names the file, line and field on a broken server', () => {
    const { errors } = parseMcpServers('servers:\n  a:\n    transport: carrier-pigeon\n');

    expect(errors[0]?.source?.file).toBe(MCP_SERVERS_PATH);
    expect(errors[0]?.source?.line).toBe(3);
    expect(errors[0]?.source?.field).toBe('servers.a.transport');
  });

  it('accumulates rather than stopping at the first broken server', () => {
    // Three broken servers must produce three messages in one run, not a game of
    // whack-a-mole. Same rule as every other parser here (T004).
    const { errors } = parseMcpServers('servers:\n  a: {}\n  b: {}\n  c: {}\n');

    expect(errors).toHaveLength(3);
  });

  it('keeps the servers it understood when another one is broken', () => {
    const { servers, errors } = parseMcpServers('servers:\n  good:\n    command: npx\n  bad: {}\n');

    expect(servers.map((s) => s.id)).toEqual(['good']);
    expect(errors).toHaveLength(1);
  });

  it('is not an error to have no servers.yaml at all', async () => {
    const files = new Map(serializeCanonical({ ...model, mcpServers: [] }));
    const result = await parse({ fs: new MemoryFileSystem(files) });

    expect(result.errors).toEqual([]);
    expect(result.canonical.mcpServers).toEqual([]);
  });
});

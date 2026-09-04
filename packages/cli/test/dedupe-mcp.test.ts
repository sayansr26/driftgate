import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFileSystem, collectImports, computeInitPlan, dedupeMcpServers } from '@driftgate/core';
import { ADAPTERS } from '../src/registry.js';

const fixtures = path.resolve(import.meta.dirname, '../../../fixtures');

async function collect(name: string) {
  const repoRoot = path.join(fixtures, 'import-dedupe', name);
  const fs = new NodeFileSystem(repoRoot);
  return collectImports({ repoRoot, fs, adapters: ADAPTERS });
}

/**
 * The whole command, not just the dedupe pass.
 *
 * `collectImports` takes whatever adapters it is handed, but `init` hands it only the
 * *detected* ones — so a test that calls `collectImports` directly proves nothing about
 * detection, and the mutation removing `.mcp.json` from claude-code's `DETECTION_PATHS`
 * passed against the first version of this file. Going through `computeInitPlan` is what
 * makes the detection widening load-bearing here.
 */
async function initPlan(name: string) {
  const repoRoot = path.join(fixtures, 'import-dedupe', name);
  return computeInitPlan({ repoRoot, fs: new NodeFileSystem(repoRoot), adapters: ADAPTERS });
}

describe('MCP import — T048', () => {
  it('imports the same three servers in four formats as three canonical servers', async () => {
    const init = await initPlan('mcp-four-formats');

    // All four MCP-carrying tools must actually be detected, or the count below is met by
    // fewer files than the test claims to be exercising.
    for (const tool of ['claude-code', 'codex', 'copilot', 'cursor']) {
      expect(init.detected).toContain(tool);
    }

    // The premise is pinned before the conclusion, the way T018's ten-for-two is: without
    // this the test would pass just as happily if three of the four adapters read nothing.
    const collected = await collect('mcp-four-formats');
    expect(collected.sources.flatMap((s) => s.mcpServers)).toHaveLength(12);

    expect(init.canonical.mcpServers.map((s) => s.id)).toEqual(['github', 'memory', 'postgres']);
    expect(init.mcpConflicts).toEqual([]);
  });

  it('never narrows a selector because a tool that carries no MCP was read', async () => {
    // Gemini has no MCP format at all, so it is not a tool that declined — it was never
    // asked. Counting it would narrow every imported server for a reason about Driftgate's
    // roster rather than about the user's configuration.
    //
    // The fixture holds four formats and the roster now has five MCP-carrying tools, so
    // these servers are correctly *not* `all` — roo-code genuinely does not get them. That
    // makes the assertion sharper than the original `all` check, which would have passed
    // for the wrong reason the moment a fifth MCP adapter shipped.
    const collected = await collect('mcp-four-formats');
    expect(collected.sources.find((s) => s.tool === 'gemini')?.carriesMcp).toBe(false);

    const { servers } = dedupeMcpServers(collected.sources);
    for (const server of servers) {
      expect(server.tools.kind).toBe('include');
      const tools = server.tools.kind === 'include' ? server.tools.tools : [];
      // The four that defined it, and gemini is absent because it was never asked —
      // not because it declined.
      expect([...tools].sort()).toEqual(['claude-code', 'codex', 'copilot', 'cursor']);
      expect(tools).not.toContain('gemini');
    }
  });

  it('does not depend on the order the adapters were read in', async () => {
    const collected = await collect('mcp-four-formats');
    const forward = dedupeMcpServers(collected.sources);
    const backward = dedupeMcpServers([...collected.sources].reverse());

    expect(backward.servers.map((s) => s.id)).toEqual(forward.servers.map((s) => s.id));
    for (const [i, server] of backward.servers.entries()) {
      expect(server.tools).toEqual(forward.servers[i]!.tools);
      expect(server.transport).toEqual(forward.servers[i]!.transport);
    }
  });

  it('surfaces a divergent definition as a conflict rather than a silent pick', async () => {
    const collected = await collect('mcp-divergent');
    const { servers, conflicts } = dedupeMcpServers(collected.sources);

    // One server, because `servers:` is a mapping and the id is the key — two definitions
    // cannot both survive. The divergence is reported instead of resolved quietly.
    expect(servers.map((s) => s.id)).toEqual(['github']);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.id).toBe('github');
    expect(conflicts[0]!.variants.length).toBeGreaterThan(1);
    // The taken variant is one of the ones actually read, not a merge of both.
    expect(conflicts[0]!.variants.map((v) => v.server.transport)).toContainEqual(
      conflicts[0]!.taken.server.transport,
    );
  });
});

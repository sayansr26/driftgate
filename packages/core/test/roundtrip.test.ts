import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/io/memory.js';
import { serializeCanonical } from '../src/model/serialize.js';
import { parse } from '../src/parse/index.js';
import { CANONICAL_SCHEMA_VERSION, DEFAULT_MANIFEST_OPTIONS } from '../src/model/canonical.js';
import { ALL_TOOLS } from '../src/model/selector.js';
import { DEFAULT_RULE_ORDER } from '../src/model/rule.js';
import { MANIFEST_PATH, ruleIdToPath } from '../src/model/paths.js';
import type { Canonical } from '../src/model/canonical.js';

/**
 * T002's validation: model -> serialize -> parse -> deep-equal on a 3-rule fixture.
 *
 * Source refs are compared separately. They record *where a value came from*, so the
 * hand-built model has none and the parsed model necessarily has real positions —
 * demanding they match would be asserting that the parser fabricates the fiction the
 * test author invented, which is backwards.
 */

const threeRuleModel: Canonical = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  manifest: {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    tools: [
      { id: 'claude-code', enabled: true, options: {}, source: { file: MANIFEST_PATH } },
      { id: 'cursor', enabled: true, options: { legacy: true }, source: { file: MANIFEST_PATH } },
      { id: 'copilot', enabled: false, options: {}, source: { file: MANIFEST_PATH } },
    ],
    options: DEFAULT_MANIFEST_OPTIONS,
    canonicalSources: [],
    source: { file: MANIFEST_PATH },
  },
  rules: [
    {
      id: '10-style',
      path: ruleIdToPath('10-style'),
      body: 'Use tabs. Never `any`.\n',
      frontmatter: {
        description: 'Style',
        globs: [],
        tools: ALL_TOOLS,
        order: 10,
        unknown: {},
      },
      source: { file: ruleIdToPath('10-style') },
    },
    {
      id: '20-frontend',
      path: ruleIdToPath('20-frontend'),
      body: 'Prefer server components.\n',
      frontmatter: {
        description: 'Frontend',
        globs: ['src/components/**/*.tsx', 'src/pages/**/*.tsx'],
        tools: { kind: 'include', tools: ['cursor'] },
        order: 20,
        unknown: {},
      },
      source: { file: ruleIdToPath('20-frontend') },
    },
    {
      id: '30-experimental',
      path: ruleIdToPath('30-experimental'),
      body: 'Not yet decided.\n',
      frontmatter: {
        globs: [],
        tools: { kind: 'exclude', tools: ['copilot'] },
        order: DEFAULT_RULE_ORDER,
        // A key Rulegate has never heard of. It must survive the round trip.
        unknown: { experimentalMode: 'agent-requested', weight: 3 },
      },
      source: { file: ruleIdToPath('30-experimental') },
    },
  ],
  mcpServers: [],
  skills: [],
};

function stripSources(model: Canonical): unknown {
  return JSON.parse(
    JSON.stringify(model, (key, value: unknown) => (key === 'source' ? undefined : value)),
  ) as unknown;
}

async function parseFrom(files: ReadonlyMap<string, string>) {
  return parse({ fs: new MemoryFileSystem(files) });
}

describe('canonical round trip', () => {
  it('survives model -> serialize -> parse unchanged', async () => {
    const result = await parseFrom(serializeCanonical(threeRuleModel));

    expect(result.errors).toEqual([]);
    expect(result.mode).toBe('rulegate-dir');
    expect(stripSources(result.canonical)).toEqual(stripSources(threeRuleModel));
  });

  it('preserves frontmatter keys it does not understand', async () => {
    const result = await parseFrom(serializeCanonical(threeRuleModel));
    const experimental = result.canonical.rules.find((r) => r.id === '30-experimental');

    // The losslessness guarantee (T017) depends on this: a key Rulegate drops is a
    // key the user silently loses on their next sync.
    expect(experimental?.frontmatter.unknown).toEqual({
      experimentalMode: 'agent-requested',
      weight: 3,
    });
  });

  it('is stable: parse -> serialize -> parse reaches a fixed point', async () => {
    const once = await parseFrom(serializeCanonical(threeRuleModel));
    const twice = await parseFrom(serializeCanonical(once.canonical));

    expect(twice.canonical).toEqual(once.canonical);
  });

  it('serializes deterministically across repeated runs', () => {
    const first = serializeCanonical(threeRuleModel);
    for (let i = 0; i < 20; i += 1) {
      expect([...serializeCanonical(threeRuleModel)]).toEqual([...first]);
    }
  });

  it('records tool config, options, and disabled tools', async () => {
    const { canonical } = await parseFrom(serializeCanonical(threeRuleModel));
    const tools = canonical.manifest.tools;

    expect(tools.map((t) => t.id)).toEqual(['claude-code', 'cursor', 'copilot']);
    expect(tools.find((t) => t.id === 'copilot')?.enabled).toBe(false);
    expect(tools.find((t) => t.id === 'cursor')?.options).toEqual({ legacy: true });
  });
});

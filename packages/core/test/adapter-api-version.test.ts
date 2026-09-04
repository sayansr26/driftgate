import { describe, expect, it } from 'vitest';
import { computePlan } from '../src/pipeline/plan.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import { NOT_DETECTED, type Adapter } from '../src/adapter/adapter.js';

/**
 * The contract froze at T011, so `apiVersion` has to mean something. A version marker
 * nothing reads is decoration; this is the branch that will decide, when v2 exists,
 * whether a v1 adapter still runs.
 */
function adapterAtVersion(name: string, apiVersion: number): Adapter {
  return {
    name,
    // The cast is the whole point of the test: TypeScript forbids this, and the guard
    // exists for the consumers TypeScript does not police — a plain-JS adapter, or a
    // node_modules holding one built against a different kit.
    apiVersion: apiVersion as 1,
    detect: () => Promise.resolve(NOT_DETECTED),
    read: () => Promise.resolve({}),
    write: () => Promise.resolve([]),
    docs: {
      toolName: name,
      homepage: 'https://example.invalid',
      verifiedAgainst: { version: '0', date: '2026-09-02' },
      files: [],
    },
  };
}

async function planWith(adapters: readonly Adapter[]): ReturnType<typeof computePlan> {
  // The manifest enables exactly the adapters under test, so nothing here trips
  // E_UNKNOWN_TOOL and the assertions are about the version guard alone.
  const tools = adapters.map((a) => `  - ${a.name}`).join('\n');
  const fs = new MemoryFileSystem([
    ['.rulegate/rulegate.yaml', `schemaVersion: 1\ntools:\n${tools}\n`],
    ['.rulegate/rules/10-a.md', 'Body.\n'],
  ]);
  return computePlan({ repoRoot: '/repo', fs, adapters });
}

describe('the adapter API version guard', () => {
  it('refuses an adapter built against a different API version', async () => {
    const plan = await planWith([adapterAtVersion('stale', 2)]);
    const codes = plan.errors.map((e) => e.code);
    expect(codes).toContain('E_ADAPTER_API_VERSION');
    expect(plan.errors[0]?.message).toContain('v2');
  });

  it('keeps running the adapters that do match', async () => {
    // Same rule as the existing failure path: one bad adapter must not take down the run.
    const plan = await planWith([adapterAtVersion('stale', 2), adapterAtVersion('current', 1)]);
    expect(plan.errors.map((e) => e.code)).toEqual(['E_ADAPTER_API_VERSION']);
    expect(plan.enabledAdapters).toContain('current');
  });
});

import { describe, expect, it } from 'vitest';
import {
  ADAPTER_API_VERSION,
  MemoryFileSystem,
  NOT_DETECTED,
  collectImports,
  importedRule,
  type Adapter,
} from '../src/index.js';

const docs = {
  tool: 'x',
  verifiedAgainst: { version: '1', retrieved: '2026-09-02' },
  files: [],
  notes: [],
} as unknown as Adapter['docs'];

function adapter(name: string, read: Adapter['read']): Adapter {
  return {
    name,
    apiVersion: ADAPTER_API_VERSION,
    detect: () => Promise.resolve(NOT_DETECTED),
    read,
    write: () => Promise.resolve([]),
    docs,
  };
}

describe('collectImports', () => {
  const good = adapter('good', () =>
    Promise.resolve({ rules: [importedRule({ id: 'a', body: 'a\n', source: { file: 'a' } })] }),
  );
  const broken = adapter('broken', () => {
    throw new Error('boom');
  });

  it('records a failing adapter and still returns what the others found', async () => {
    // The rule computePlan follows, for the same reason: one broken adapter must not hide
    // what the rest would have imported — least of all during `init`, where the
    // alternative is a new user's first command failing with somebody else's bug.
    const result = await collectImports({
      repoRoot: '/repo',
      fs: new MemoryFileSystem(),
      adapters: [broken, good],
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('E_ADAPTER_FAILED');
    expect(result.sources.find((s) => s.tool === 'good')?.rules).toHaveLength(1);
  });

  it('returns an entry for every adapter, including the ones that found nothing', async () => {
    // `dedupeImported` decides `tools: all` by comparing against the tools that
    // participated. An adapter missing from this list silently narrows every selector.
    const result = await collectImports({
      repoRoot: '/repo',
      fs: new MemoryFileSystem(),
      adapters: [good, adapter('empty', () => Promise.resolve({}))],
    });
    expect(result.sources.map((s) => s.tool)).toEqual(['good', 'empty']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildState,
  hashContents,
  parseState,
  serializeState,
  STATE_SCHEMA_VERSION,
  EMPTY_STATE,
} from '../src/state/state.js';
import { compareToDisk } from '../src/state/compare.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import type { Artifact } from '../src/adapter/artifact.js';

function artifact(path: string, contents: string, adapter = 'claude-code'): Artifact {
  return { path, contents, adapter, kind: 'rules' };
}

describe('hashContents', () => {
  it('is stable and algorithm-prefixed', () => {
    const hash = hashContents('hello\n');
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashContents('hello\n')).toBe(hash);
  });

  it('is blind to line endings', () => {
    // The load-bearing case: on Windows with core.autocrlf=true, hashing raw bytes
    // would report every generated file as hand-edited on every checkout, and `check`
    // would fail CI for every repository on that platform.
    expect(hashContents('a\r\nb\r\n')).toBe(hashContents('a\nb\n'));
  });

  it('is blind to a BOM', () => {
    expect(hashContents('﻿a\n')).toBe(hashContents('a\n'));
  });

  it('still distinguishes genuinely different content', () => {
    expect(hashContents('a\n')).not.toBe(hashContents('b\n'));
  });
});

describe('state serialization', () => {
  const artifacts = [
    artifact('CLAUDE.md', '# One\n'),
    artifact('.cursor/rules/a.mdc', 'a\n', 'cursor'),
  ];

  it('sorts entries by path regardless of input order', () => {
    const forward = buildState(artifacts);
    const reversed = buildState([...artifacts].reverse());

    expect(forward.artifacts.map((a) => a.path)).toEqual(['.cursor/rules/a.mdc', 'CLAUDE.md']);
    expect(serializeState(reversed)).toBe(serializeState(forward));
  });

  it('round-trips through parse unchanged', () => {
    const state = buildState(artifacts);
    expect(parseState(serializeState(state))).toEqual(state);
  });

  it('regenerates byte-identically, which is why it carries no timestamp', () => {
    // T008's stated validation. A `generatedAt` field would make this impossible and
    // put a spurious diff in every repository on every Driftgate upgrade.
    const first = serializeState(buildState(artifacts));
    const second = serializeState(buildState(artifacts));

    expect(second).toBe(first);
    expect(first).not.toMatch(/generatedAt|version["']?\s*:\s*["']\d/);
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('ends with exactly one newline', () => {
    expect(serializeState(buildState(artifacts)).endsWith('}\n')).toBe(true);
  });

  it('records the schema version', () => {
    expect(buildState([]).schemaVersion).toBe(STATE_SCHEMA_VERSION);
  });
});

describe('parseState never throws', () => {
  it.each([
    ['empty string', ''],
    ['whitespace', '   \n'],
    ['a lone brace', '{'],
    ['truncated json', '{"schemaVersion": 1, "artifacts": [{"path": "a"'],
    ['an array', '[]'],
    ['null', 'null'],
    ['wrong shape', '{"schemaVersion": "one", "artifacts": []}'],
    ['missing fields', '{"schemaVersion": 1, "artifacts": [{"path": "a.md"}]}'],
    ['a git merge conflict', '<<<<<<< HEAD\n{"schemaVersion": 1}\n=======\n{}\n>>>>>>> main\n'],
  ])('degrades to undefined on %s', (_label, input) => {
    expect(() => parseState(input)).not.toThrow();
    expect(parseState(input)).toBeUndefined();
  });

  it('treats a missing file as no prior state', () => {
    expect(parseState(undefined)).toBeUndefined();
  });
});

describe('compareToDisk', () => {
  const planned = [artifact('CLAUDE.md', 'generated\n')];

  it('reports content matching state as unchanged', async () => {
    const state = buildState(planned);
    const fs = new MemoryFileSystem([['CLAUDE.md', 'generated\n']]);

    const result = await compareToDisk(state, planned, fs);
    expect(result.unchanged).toEqual(['CLAUDE.md']);
    expect(result.changed).toEqual([]);
  });

  it('reports a hand-edited generated file as changed', async () => {
    const state = buildState(planned);
    const fs = new MemoryFileSystem([['CLAUDE.md', 'someone edited this\n']]);

    const result = await compareToDisk(state, planned, fs);
    expect(result.changed).toEqual(['CLAUDE.md']);
  });

  it('does not call a CRLF checkout a hand-edit', async () => {
    const state = buildState(planned);
    const fs = new MemoryFileSystem([['CLAUDE.md', 'generated\r\n']]);

    const result = await compareToDisk(state, planned, fs);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual(['CLAUDE.md']);
  });

  it('reports a deleted generated file as missing', async () => {
    const result = await compareToDisk(buildState(planned), planned, new MemoryFileSystem());
    expect(result.missing).toEqual(['CLAUDE.md']);
  });

  it('separates a pre-existing unmanaged file from a genuinely new one', async () => {
    // The distinction is the whole guard: `untracked` is safe to write by definition,
    // `unmanaged` is somebody else's file standing where our output goes.
    const fs = new MemoryFileSystem([['CLAUDE.md', 'hand written, predates driftgate\n']]);
    const result = await compareToDisk(EMPTY_STATE, planned, fs);

    expect(result.unmanaged).toEqual(['CLAUDE.md']);
    expect(result.untracked).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it('reports a planned file that is absent from disk as untracked', async () => {
    const result = await compareToDisk(EMPTY_STATE, planned, new MemoryFileSystem());

    expect(result.untracked).toEqual(['CLAUDE.md']);
    expect(result.unmanaged).toEqual([]);
  });

  it('adopts a pre-existing file whose bytes already match, rather than blocking on it', async () => {
    // Refusing here would make idempotency depend on whether state.json survives.
    const fs = new MemoryFileSystem([['CLAUDE.md', 'generated\n']]);
    const result = await compareToDisk(EMPTY_STATE, planned, fs);

    expect(result.unchanged).toEqual(['CLAUDE.md']);
    expect(result.unmanaged).toEqual([]);
  });

  it('offers only recorded files as deletion candidates', async () => {
    // The mechanical form of "never delete a file Driftgate did not generate": a path
    // that was never recorded cannot appear in `orphaned`, and nothing else deletes.
    const state = buildState([
      artifact('CLAUDE.md', 'generated\n'),
      artifact('.cursor/rules/gone.mdc', 'removed rule\n', 'cursor'),
    ]);
    const fs = new MemoryFileSystem([
      ['CLAUDE.md', 'generated\n'],
      ['.cursor/rules/gone.mdc', 'removed rule\n'],
      ['NOTES.md', 'a file driftgate has never seen\n'],
    ]);

    const result = await compareToDisk(state, planned, fs);

    expect(result.orphaned).toEqual(['.cursor/rules/gone.mdc']);
    expect(result.orphaned).not.toContain('NOTES.md');
  });

  it('reports every category sorted', async () => {
    const many = [artifact('z.md', 'z\n'), artifact('a.md', 'a\n'), artifact('m.md', 'm\n')];
    const result = await compareToDisk(EMPTY_STATE, many, new MemoryFileSystem());
    expect(result.untracked).toEqual(['a.md', 'm.md', 'z.md']);
  });
});

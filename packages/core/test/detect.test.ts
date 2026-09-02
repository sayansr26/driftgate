import { describe, expect, it } from 'vitest';
import { CANONICAL_SCHEMA_VERSION, DEFAULT_MANIFEST_OPTIONS } from '../src/model/canonical.js';
import { ADAPTER_API_VERSION } from '../src/adapter/context.js';
import { MANIFEST_PATH } from '../src/model/paths.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import { detectTools } from '../src/detect/engine.js';
import { parseGlobalPattern } from '../src/detect/global.js';
import { detected } from '../src/adapter/adapter.js';
import type { Adapter, DetectResult } from '../src/adapter/adapter.js';
import type { AdapterContext } from '../src/adapter/context.js';
import type { AdapterDocs, PrecedenceEntry } from '../src/adapter/docs.js';
import type { Canonical } from '../src/model/canonical.js';
import type { DirEntry, ReadOnlyFileSystem } from '../src/fs/types.js';
import type { ToolId } from '../src/model/ids.js';

const canonical: Canonical = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  manifest: {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    tools: [],
    options: DEFAULT_MANIFEST_OPTIONS,
    canonicalSources: [],
    source: { file: MANIFEST_PATH },
  },
  rules: [],
  mcpServers: [],
  skills: [],
};

const source = { url: 'https://example.test/docs', title: 'Docs', retrieved: '2026-09-02' };

function entry(pattern: string, over: Partial<PrecedenceEntry> = {}): PrecedenceEntry {
  return {
    pattern,
    scope: 'global',
    role: 'instructions',
    managed: false,
    description: 'test entry',
    source,
    ...over,
  };
}

function docsWith(files: readonly PrecedenceEntry[]): AdapterDocs {
  return {
    toolName: 'Test',
    homepage: 'https://example.test',
    verifiedAgainst: { version: '1.x', date: '2026-09-02' },
    files,
  };
}

interface StubInit {
  readonly name: ToolId;
  readonly detect?: (ctx: AdapterContext) => Promise<DetectResult>;
  readonly files?: readonly PrecedenceEntry[];
  readonly apiVersion?: number;
}

function stub(init: StubInit): Adapter {
  return {
    name: init.name,
    apiVersion: (init.apiVersion ?? ADAPTER_API_VERSION) as typeof ADAPTER_API_VERSION,
    detect: init.detect ?? ((): Promise<DetectResult> => Promise.resolve(detected([]))),
    read: () => Promise.resolve({}),
    write: () => Promise.resolve([]),
    docs: docsWith(init.files ?? []),
  };
}

const base = { repoRoot: '/repo', canonical };

/**
 * Records every call made through a `ReadOnlyFileSystem`, and refuses every write.
 *
 * The refusal is the point. A spy that only *logs* proves nothing about a code path it
 * never exercised, so this one throws on any mutating method: if the engine ever grows a
 * write, the test fails rather than quietly recording it.
 */
class RecordingFileSystem implements ReadOnlyFileSystem {
  readonly calls: { method: string; path: string }[] = [];

  constructor(private readonly inner: ReadOnlyFileSystem) {}

  private note(method: string, path: string): void {
    this.calls.push({ method, path });
  }

  async readFile(p: string): Promise<string> {
    this.note('readFile', p);
    return this.inner.readFile(p);
  }
  async tryReadFile(p: string): Promise<string | undefined> {
    this.note('tryReadFile', p);
    return this.inner.tryReadFile(p);
  }
  async readFileRaw(p: string): Promise<Uint8Array> {
    this.note('readFileRaw', p);
    return this.inner.readFileRaw(p);
  }
  async exists(p: string): Promise<boolean> {
    this.note('exists', p);
    return this.inner.exists(p);
  }
  async listDir(p: string): Promise<readonly DirEntry[]> {
    this.note('listDir', p);
    return this.inner.listDir(p);
  }
  async glob(pattern: string): Promise<readonly string[]> {
    this.note('glob', pattern);
    return this.inner.glob(pattern);
  }
}

describe('parseGlobalPattern', () => {
  it('reads a literal path as a single existence check', () => {
    expect(parseGlobalPattern('~/.claude/CLAUDE.md')).toEqual({
      kind: 'literal',
      literal: '.claude/CLAUDE.md',
    });
  });

  it('reads a trailing star as a one-level listing', () => {
    expect(parseGlobalPattern('~/.copilot/instructions/*.instructions.md')).toEqual({
      kind: 'one-level-glob',
      dir: '.copilot/instructions',
      segment: '*.instructions.md',
    });
  });

  it.each([
    ['~/**/rules.md', 'a recursive walk of the home directory'],
    // Not redundant with the line above: `~/**/rules.md` is *also* caught by the
    // star-outside-the-final-segment rule, so on its own it proves the wrong guard.
    // `~/**` reaches the one-level branch with an empty dir, and would enumerate the
    // top level of the user's home directory. Found by deleting the `**` check and
    // watching every test still pass.
    ['~/**', 'a bare recursive star'],
    ['~/.config/*/rules.md', 'a star outside the final segment'],
    ['~/../.ssh/id_rsa', 'an escape above the home root'],
    ['~/', 'the home directory itself'],
    ['.claude/CLAUDE.md', 'a pattern that is not global at all'],
  ])('refuses %s (%s)', (pattern) => {
    expect(parseGlobalPattern(pattern).kind).toBe('unsupported');
  });
});

describe('detectTools', () => {
  it('reports every tool, including the ones it did not find', async () => {
    const report = await detectTools({
      ...base,
      fs: new MemoryFileSystem([['CLAUDE.md', 'x']]),
      adapters: [
        stub({
          name: 'claude-code',
          detect: (c) => c.fs.exists('CLAUDE.md').then((e) => detected(e ? ['CLAUDE.md'] : [])),
        }),
        stub({ name: 'cursor' }),
      ],
    });

    // An empty `tools` array would be a *different*, wrong answer: `doctor` must be able
    // to say "cursor is not in use here", which it cannot do from an absent row.
    expect(report.tools.map((t) => t.name)).toEqual(['claude-code', 'cursor']);
    expect(report.tools.map((t) => t.detected)).toEqual([true, false]);
  });

  it('sorts by tool id, so registry order cannot reach the output', async () => {
    const names = ['gemini', 'claude-code', 'copilot', 'cursor', 'codex'] as const;
    const report = await detectTools({
      ...base,
      fs: new MemoryFileSystem(),
      adapters: names.map((n) => stub({ name: n })),
    });
    expect(report.tools.map((t) => t.name)).toEqual([
      'claude-code',
      'codex',
      'copilot',
      'cursor',
      'gemini',
    ]);
  });

  it('keeps going when one adapter throws, and says which one failed', async () => {
    const report = await detectTools({
      ...base,
      fs: new MemoryFileSystem(),
      adapters: [
        stub({
          name: 'claude-code',
          detect: () => Promise.reject(new Error('boom')),
        }),
        stub({ name: 'cursor', detect: () => Promise.resolve(detected(['.cursor'])) }),
      ],
    });

    const broken = report.tools.find((t) => t.name === 'claude-code');
    expect(broken?.failed?.code).toBe('E_ADAPTER_FAILED');
    expect(broken?.detected).toBe(false);
    // The negative half: a "skip the whole run" implementation would pass the line above.
    expect(report.tools.find((t) => t.name === 'cursor')?.evidence).toEqual(['.cursor']);
  });

  it('reports an adapter built against a different kit rather than running it', async () => {
    let ran = false;
    const report = await detectTools({
      ...base,
      fs: new MemoryFileSystem(),
      adapters: [
        stub({
          name: 'cursor',
          apiVersion: 2,
          detect: () => {
            ran = true;
            return Promise.resolve(detected(['.cursor']));
          },
        }),
      ],
    });
    expect(report.tools[0]?.failed?.code).toBe('E_ADAPTER_API_VERSION');
    expect(ran).toBe(false);
  });

  describe('global files', () => {
    const withGlobals = stub({
      name: 'claude-code',
      files: [
        entry('CLAUDE.md', { scope: 'project', managed: true }),
        entry('~/.claude/CLAUDE.md'),
        entry('~/.claude/agents/*.md'),
        entry('~/**/anything.md'),
      ],
    });

    it('touches nothing outside the repo when no global filesystem is given', async () => {
      const report = await detectTools({
        ...base,
        fs: new MemoryFileSystem(),
        adapters: [withGlobals],
      });

      expect(report.globalProbed).toBe(false);
      // "We did not look" and "we looked and found nothing" are different facts, and
      // `doctor` reporting the second when the first is true would be unfalsifiable.
      expect(report.tools[0]?.global.map((g) => g.probe)).toEqual([
        'skipped',
        'skipped',
        'skipped',
      ]);
    });

    it('probes literal and one-level-glob patterns, and refuses to walk', async () => {
      const home = new RecordingFileSystem(
        new MemoryFileSystem([
          ['.claude/CLAUDE.md', 'user memory'],
          ['.claude/agents/reviewer.md', 'a'],
          ['.claude/agents/planner.md', 'b'],
          ['deep/nested/anything.md', 'c'],
        ]),
      );

      const report = await detectTools({
        ...base,
        fs: new MemoryFileSystem(),
        adapters: [withGlobals],
        globalFs: home,
      });

      const global = report.tools[0]?.global ?? [];
      expect(global).toEqual([
        {
          pattern: '~/.claude/CLAUDE.md',
          role: 'instructions',
          present: true,
          matches: ['~/.claude/CLAUDE.md'],
          probe: 'literal',
        },
        {
          pattern: '~/.claude/agents/*.md',
          role: 'instructions',
          present: true,
          matches: ['~/.claude/agents/planner.md', '~/.claude/agents/reviewer.md'],
          probe: 'one-level-glob',
        },
        {
          pattern: '~/**/anything.md',
          role: 'instructions',
          present: false,
          matches: [],
          probe: 'unsupported',
        },
      ]);

      // Never `glob()`. Rooted at $HOME that walks everything the user owns — slow, noisy
      // with permission errors, and nondeterministic in a way sorting does not fix.
      expect(home.calls.some((c) => c.method === 'glob')).toBe(false);
      // The unsupported pattern must cost zero filesystem calls, not merely report false.
      expect(home.calls.some((c) => c.path.includes('anything'))).toBe(false);
    });

    it('excludes project-scoped entries from the global probe', async () => {
      const report = await detectTools({
        ...base,
        fs: new MemoryFileSystem(),
        adapters: [withGlobals],
        globalFs: new MemoryFileSystem(),
      });
      expect(report.tools[0]?.global.map((g) => g.pattern)).not.toContain('CLAUDE.md');
    });

    it('reports absent rather than crashing when the home directory cannot be read', async () => {
      const hostile: ReadOnlyFileSystem = {
        readFile: () => Promise.reject(new Error('EACCES')),
        tryReadFile: () => Promise.reject(new Error('EACCES')),
        readFileRaw: () => Promise.reject(new Error('EACCES')),
        exists: () => Promise.reject(new Error('EACCES')),
        listDir: () => Promise.reject(new Error('EACCES')),
        glob: () => Promise.reject(new Error('EACCES')),
      };

      const report = await detectTools({
        ...base,
        fs: new MemoryFileSystem(),
        adapters: [withGlobals],
        globalFs: hostile,
      });
      expect(report.tools[0]?.global.every((g) => !g.present)).toBe(true);
    });

    it('preserves the declared precedence order rather than sorting it', async () => {
      const ordered = stub({
        name: 'codex',
        files: [entry('~/zzz.md'), entry('~/aaa.md')],
      });
      const report = await detectTools({
        ...base,
        fs: new MemoryFileSystem(),
        adapters: [ordered],
        globalFs: new MemoryFileSystem(),
      });
      // `AdapterDocs.files` is documented highest-precedence-first. Sorting this for
      // tidiness would destroy the one fact the feature exists to surface.
      expect(report.tools[0]?.global.map((g) => g.pattern)).toEqual(['~/zzz.md', '~/aaa.md']);
    });
  });

  it('emits no absolute path other than the repo root', async () => {
    const report = await detectTools({
      ...base,
      fs: new MemoryFileSystem([['CLAUDE.md', 'x']]),
      adapters: [
        stub({
          name: 'claude-code',
          files: [entry('~/.claude/CLAUDE.md')],
          detect: () => Promise.resolve(detected(['CLAUDE.md'])),
        }),
      ],
      globalFs: new MemoryFileSystem([['.claude/CLAUDE.md', 'y']]),
    });

    // A report is destined for `doctor` output that people paste into issues. An absolute
    // path here leaks a username and a directory layout.
    const { repoRoot, ...rest } = report;
    expect(repoRoot).toBe('/repo');
    const strings = JSON.stringify(rest).match(/"[^"]*"/g) ?? [];
    expect(strings.filter((s) => /^"(\/|[A-Za-z]:[\\/])/.test(s))).toEqual([]);
  });

  it('performs no writes and reads nothing outside the repository', async () => {
    const repo = new RecordingFileSystem(new MemoryFileSystem([['CLAUDE.md', 'x']]));
    await detectTools({
      ...base,
      fs: repo,
      adapters: [
        stub({
          name: 'claude-code',
          detect: (c) => c.fs.exists('CLAUDE.md').then(() => detected(['CLAUDE.md'])),
        }),
      ],
    });

    expect(repo.calls.length).toBeGreaterThan(0);
    for (const call of repo.calls) {
      expect(['readFile', 'tryReadFile', 'readFileRaw', 'exists', 'listDir', 'glob']).toContain(
        call.method,
      );
      expect(call.path.startsWith('/')).toBe(false);
      expect(call.path.split('/')).not.toContain('..');
    }
  });

  it('is unaffected by the order adapters are supplied in', async () => {
    const names = ['claude-code', 'codex', 'copilot', 'cursor', 'gemini'] as const;
    const adapters = names.map((n) => stub({ name: n, files: [entry(`~/.${n}/rules.md`)] }));

    // A seeded shuffle: Math.random is banned repo-wide, and a nondeterministic test
    // that fails one run in twenty is worse than no test.
    let seed = 20260902;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    const render = async (list: readonly Adapter[]): Promise<string> =>
      JSON.stringify(await detectTools({ ...base, fs: new MemoryFileSystem(), adapters: list }));

    const expected = await render(adapters);
    for (let i = 0; i < 20; i += 1) {
      const shuffled = [...adapters];
      for (let j = shuffled.length - 1; j > 0; j -= 1) {
        const k = Math.floor(next() * (j + 1));
        [shuffled[j], shuffled[k]] = [shuffled[k]!, shuffled[j]!];
      }
      expect(await render(shuffled)).toBe(expected);
    }
  });
});

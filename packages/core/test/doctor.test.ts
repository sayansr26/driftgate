import { describe, expect, it } from 'vitest';
import { ADAPTER_API_VERSION } from '../src/adapter/context.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import { buildDoctorReport } from '../src/doctor/report.js';
import { detected } from '../src/adapter/adapter.js';
import { hashContents } from '../src/state/state.js';
import type { Adapter, DetectResult } from '../src/adapter/adapter.js';
import type { AdapterDocs, DocNote, PrecedenceEntry } from '../src/adapter/docs.js';
import type { DoctorReport } from '../src/doctor/types.js';
import type { ToolId } from '../src/model/ids.js';

const source = { url: 'https://example.test/docs', title: 'Docs', retrieved: '2026-09-02' };

function entry(pattern: string, over: Partial<PrecedenceEntry> = {}): PrecedenceEntry {
  return {
    pattern,
    scope: 'project',
    role: 'instructions',
    managed: false,
    description: 'test entry',
    source,
    ...over,
  };
}

interface StubInit {
  readonly name: ToolId;
  readonly files: readonly PrecedenceEntry[];
  readonly resolution?: AdapterDocs['resolution'];
  readonly limits?: AdapterDocs['limits'];
  readonly notes?: readonly DocNote[];
  readonly detect?: boolean;
  readonly writes?: readonly (readonly [string, string])[];
}

function stub(init: StubInit): Adapter {
  const docs: AdapterDocs = {
    toolName: init.name.toUpperCase(),
    homepage: 'https://example.test',
    verifiedAgainst: { version: '1.x', date: '2026-09-02' },
    files: init.files,
    ...(init.resolution === undefined ? {} : { resolution: init.resolution }),
    ...(init.limits === undefined ? {} : { limits: init.limits }),
    ...(init.notes === undefined ? {} : { notes: init.notes }),
  };
  return {
    name: init.name,
    apiVersion: ADAPTER_API_VERSION,
    detect: (): Promise<DetectResult> =>
      Promise.resolve(init.detect === false ? { detected: false, evidence: [] } : detected(['x'])),
    read: () => Promise.resolve({}),
    write: () =>
      Promise.resolve(
        (init.writes ?? []).map(([path, contents]) => ({
          path,
          contents,
          adapter: init.name,
          kind: 'rules' as const,
        })),
      ),
    docs,
  };
}

/** A repo with a real canonical source, so `adopted` is true and plans are non-empty. */
const MANIFEST = ['.driftgate/driftgate.yaml', 'schemaVersion: 1\ntools: []\n'] as const;

function manifestEnabling(...tools: readonly string[]): readonly [string, string] {
  return [
    '.driftgate/driftgate.yaml',
    `schemaVersion: 1\ntools:\n${tools.map((t) => `  - ${t}\n`).join('')}`,
  ];
}

async function report(
  files: readonly (readonly [string, string])[],
  adapters: readonly Adapter[],
  globalFiles?: readonly (readonly [string, string])[],
): Promise<DoctorReport> {
  return buildDoctorReport({
    repoRoot: '/repo',
    fs: new MemoryFileSystem([MANIFEST, ...files]),
    adapters,
    ...(globalFiles === undefined ? {} : { globalFs: new MemoryFileSystem(globalFiles) }),
  });
}

function codes(r: DoctorReport): string[] {
  return [...new Set(r.warnings.map((w) => w.code))].sort();
}

describe('buildDoctorReport — resolution', () => {
  it('reports every declared entry, in declared order, even when nothing matches', async () => {
    const r = await report(
      [['B.md', 'b']],
      [stub({ name: 'alpha', files: [entry('A.md'), entry('B.md'), entry('C.md')] })],
    );
    const tool = r.tools[0];
    // The count assertion is the vacuity guard: a resolver returning [] would otherwise
    // satisfy every other expectation in this file. `files: []` is this repo's signature bug.
    expect(tool?.files).toHaveLength(3);
    expect(tool?.files.map((f) => f.pattern)).toEqual(['A.md', 'B.md', 'C.md']);
    expect(tool?.files.map((f) => f.status)).toEqual(['absent', 'unmanaged', 'absent']);
  });

  it('marks lower-ranked files shadowed under override, and none under additive', async () => {
    const files = [entry('A.md'), entry('B.md')];
    const disk = [
      ['A.md', 'a'],
      ['B.md', 'b'],
    ] as const;

    const override = await report(disk, [stub({ name: 'o', files, resolution: 'override' })]);
    expect(override.tools[0]?.files.map((f) => f.shadowed)).toEqual([false, true]);

    const additive = await report(disk, [stub({ name: 'a', files, resolution: 'additive' })]);
    expect(additive.tools[0]?.files.map((f) => f.shadowed)).toEqual([false, false]);
  });

  it('shadowing is per (role, scope), so a global file is not shadowed by a project one', async () => {
    const r = await report(
      [['A.md', 'a']],
      [
        stub({
          name: 'o',
          resolution: 'override',
          files: [entry('A.md'), entry('~/g.md', { scope: 'global' })],
        }),
      ],
      [['g.md', 'g']],
    );
    expect(r.tools[0]?.files.map((f) => f.shadowed)).toEqual([false, false]);
    expect(r.tools[0]?.loadedCount).toBe(2);
  });

  it('counts only instruction files toward the token total', async () => {
    const r = await report(
      [
        ['A.md', 'hello world'],
        ['s.json', '{"a":1}'],
      ],
      [
        stub({
          name: 'alpha',
          files: [entry('A.md'), entry('s.json', { role: 'settings' })],
        }),
      ],
    );
    const tool = r.tools[0];
    expect(tool?.loadedCount).toBe(1);
    expect(tool?.files[1]?.loaded).toBe(false);
    expect(tool?.loadedTokens).toBe(tool?.files[0]?.tokens);
    expect(tool?.loadedTokens).toBeGreaterThan(0);
  });

  it('walks nested copies only when nesting authorizes it', async () => {
    const disk = [
      ['A.md', 'a'],
      ['pkg/A.md', 'nested'],
      ['B.md', 'b'],
      ['pkg/B.md', 'nested'],
    ] as const;
    const r = await report(disk, [
      stub({
        name: 'alpha',
        files: [entry('A.md', { nesting: 'nearest-wins' }), entry('B.md')],
      }),
    ]);
    expect(r.tools[0]?.files[0]?.paths).toEqual(['A.md', 'pkg/A.md']);
    expect(r.tools[0]?.files[1]?.paths).toEqual(['B.md']);
  });

  it('separates "did not look" from "found nothing" for global paths', async () => {
    const files = [entry('~/g.md', { scope: 'global' })];
    const unprobed = await report([], [stub({ name: 'alpha', files })]);
    expect(unprobed.globalProbed).toBe(false);
    expect(unprobed.tools[0]?.files[0]?.status).toBe('not-probed');

    const probed = await report([], [stub({ name: 'alpha', files })], []);
    expect(probed.globalProbed).toBe(true);
    expect(probed.tools[0]?.files[0]?.status).toBe('absent');
  });
});

describe('buildDoctorReport — warnings', () => {
  it('W_DUPLICATE_LOAD fires on byte-identical loaded files and names the owner', async () => {
    const r = await report(
      [
        ['own.md', 'same bytes'],
        ['other.md', 'same bytes'],
      ],
      [
        stub({
          name: 'reader',
          resolution: 'additive',
          files: [entry('own.md'), entry('other.md')],
        }),
        stub({ name: 'writer', files: [entry('other.md', { managed: true })], detect: false }),
      ],
    );
    const dup = r.warnings.find((w) => w.code === 'W_DUPLICATE_LOAD');
    expect(dup?.tool).toBe('reader');
    expect(dup?.paths).toEqual(['other.md', 'own.md']);
    expect(dup?.message).toContain('other.md from writer');
  });

  it('W_DUPLICATE_LOAD does not fire when the loaded files differ by one byte', async () => {
    const r = await report(
      [
        ['own.md', 'same bytes'],
        ['other.md', 'same bytes!'],
      ],
      [
        stub({
          name: 'reader',
          resolution: 'additive',
          files: [entry('own.md'), entry('other.md')],
        }),
      ],
    );
    expect(codes(r)).not.toContain('W_DUPLICATE_LOAD');
  });

  it('is derived: a sixth adapter nobody wrote code for gets the same warning', async () => {
    // The point of this test is the mutation it invites. Add `if (tool.name !== 'reader')
    // return []` to duplicateLoadWarnings and this fails while every other case passes —
    // which is precisely what T078 forbids and what "derived, not hardcoded" has to mean.
    const r = await report(
      [
        ['SIXTH.md', 'identical'],
        ['borrowed.md', 'identical'],
      ],
      [
        stub({
          name: 'zeta-newcomer',
          resolution: 'additive',
          files: [entry('SIXTH.md', { managed: true }), entry('borrowed.md')],
        }),
      ],
    );
    expect(r.warnings.filter((w) => w.code === 'W_DUPLICATE_LOAD')).toHaveLength(1);
    expect(r.warnings.find((w) => w.code === 'W_DUPLICATE_LOAD')?.tool).toBe('zeta-newcomer');
  });

  it('W_OVER_LIMIT respects maxTotalBytes strictly, so a file exactly at the cap is fine', async () => {
    const files = [entry('A.md')];
    const atCap = await report(
      [['A.md', 'x'.repeat(10)]],
      [stub({ name: 'alpha', files, limits: { maxTotalBytes: 10 } })],
    );
    expect(codes(atCap)).not.toContain('W_OVER_LIMIT');

    const over = await report(
      [['A.md', 'x'.repeat(11)]],
      [stub({ name: 'alpha', files, limits: { maxTotalBytes: 10 } })],
    );
    expect(over.warnings.find((w) => w.code === 'W_OVER_LIMIT')?.message).toContain('11 bytes');
  });

  it('W_OVER_LIMIT fires per file — the branch no shipped adapter reaches', async () => {
    const r = await report(
      [
        ['A.md', 'x'.repeat(20)],
        ['B.md', 'x'],
      ],
      [
        stub({
          name: 'alpha',
          resolution: 'additive',
          files: [entry('A.md'), entry('B.md')],
          limits: { maxBytesPerFile: 5 },
        }),
      ],
    );
    const w = r.warnings.find((x) => x.code === 'W_OVER_LIMIT');
    expect(w?.paths).toEqual(['A.md']);
    expect(w?.message).toContain('5-byte limit per file');
  });

  it('W_TOOL_NOTE surfaces warn notes of a detected tool and nothing else', async () => {
    const notes: DocNote[] = [
      { level: 'warn', message: 'the warning', source },
      { level: 'info', message: 'the info' },
    ];
    const seen = await report([], [stub({ name: 'alpha', files: [entry('A.md')], notes })]);
    const tool = seen.warnings.filter((w) => w.code === 'W_TOOL_NOTE');
    expect(tool.map((w) => w.message)).toEqual(['the warning']);
    expect(tool[0]?.source).toEqual(source);

    const undetectedTool = await report(
      [],
      [stub({ name: 'alpha', files: [entry('A.md')], notes, detect: false })],
    );
    expect(codes(undetectedTool)).not.toContain('W_TOOL_NOTE');
  });

  it('W_ORPHAN_FILE fires for an instruction-shaped file nothing reads, and not for one that is read', async () => {
    const adapters = [stub({ name: 'alpha', files: [entry('RULES.md')] })];

    const orphaned = await report(
      [
        ['RULES.md', 'root'],
        ['pkg/RULES.md', 'nested and unread'],
      ],
      adapters,
    );
    expect(orphaned.warnings.find((w) => w.code === 'W_ORPHAN_FILE')?.paths).toEqual([
      'pkg/RULES.md',
    ]);

    const read = await report([['RULES.md', 'root']], adapters);
    expect(codes(read)).not.toContain('W_ORPHAN_FILE');
  });

  it('W_ORPHAN_FILE does not fire when nesting makes the nested copy readable', async () => {
    const r = await report(
      [
        ['RULES.md', 'root'],
        ['pkg/RULES.md', 'nested'],
      ],
      [stub({ name: 'alpha', files: [entry('RULES.md', { nesting: 'nearest-wins' })] })],
    );
    expect(codes(r)).not.toContain('W_ORPHAN_FILE');
  });

  it('options.ignore suppresses the shape sense only, and never the record sense', async () => {
    // T081. A golden fixture tree holds instruction files as *data*: nothing loads
    // `fixtures/x/RULES.md`, and nothing is wrong with it being there.
    const adapters = [stub({ name: 'alpha', files: [entry('RULES.md')] })];
    const disk = [
      ['RULES.md', 'root'],
      ['fixtures/x/RULES.md', 'a golden, not a rule'],
    ] as const;

    // Control first: without the option the file is reported, so the assertion below is
    // about `ignore` doing something rather than about the scan finding nothing.
    const noisy = await buildDoctorReport({
      repoRoot: '/repo',
      fs: new MemoryFileSystem([manifestEnabling('alpha'), ...disk]),
      adapters,
    });
    expect(noisy.warnings.find((w) => w.code === 'W_ORPHAN_FILE')?.paths).toEqual([
      'fixtures/x/RULES.md',
    ]);

    const quiet = await buildDoctorReport({
      repoRoot: '/repo',
      fs: new MemoryFileSystem([
        [
          '.driftgate/driftgate.yaml',
          'schemaVersion: 1\ntools:\n  - alpha\noptions:\n  ignore:\n    - fixtures/**\n',
        ],
        ...disk,
      ]),
      adapters,
    });
    expect(codes(quiet)).not.toContain('W_ORPHAN_FILE');

    // The record sense is not narrowed by it. `state.json` says Driftgate wrote this file,
    // and a config key that could make the tool stop mentioning a file it owns is one line
    // away from forgetting it owns it.
    const recorded = await buildDoctorReport({
      repoRoot: '/repo',
      fs: new MemoryFileSystem([
        [
          '.driftgate/driftgate.yaml',
          'schemaVersion: 1\ntools:\n  - alpha\noptions:\n  ignore:\n    - fixtures/**\n',
        ],
        ['fixtures/x/RULES.md', 'ours, and abandoned'],
        [
          '.driftgate/state.json',
          JSON.stringify({
            schemaVersion: 1,
            artifacts: [
              {
                adapter: 'alpha',
                kind: 'rules',
                path: 'fixtures/x/RULES.md',
                hash: hashContents('ours, and abandoned'),
              },
            ],
          }),
        ],
      ]),
      adapters,
    });
    expect(recorded.warnings.find((w) => w.code === 'W_ORPHAN_FILE')?.paths).toEqual([
      'fixtures/x/RULES.md',
    ]);
  });

  it('warnings are sorted deterministically', async () => {
    const r = await report(
      [
        ['A.md', 'x'.repeat(40)],
        ['pkg/A.md', 'x'.repeat(40)],
      ],
      [
        stub({
          name: 'alpha',
          files: [entry('A.md')],
          limits: { maxTotalBytes: 5 },
          notes: [{ level: 'warn', message: 'note' }],
        }),
      ],
    );
    expect(r.warnings.map((w) => w.code)).toEqual([...r.warnings.map((w) => w.code)].sort());
    expect(codes(r)).toEqual(['W_ORPHAN_FILE', 'W_OVER_LIMIT', 'W_TOOL_NOTE']);
  });
});

describe('buildDoctorReport — contract', () => {
  it('works on a repository that has never adopted driftgate', async () => {
    const r = await buildDoctorReport({
      repoRoot: '/repo',
      fs: new MemoryFileSystem([['CLAUDE.md', 'hand written']]),
      adapters: [stub({ name: 'alpha', files: [entry('CLAUDE.md')] })],
    });
    expect(r.adopted).toBe(false);
    // The absence of a canonical source is an ordinary answer, not an error — this is
    // doctor's highest-value run, and it must still report the tool it found.
    expect(r.errors).toEqual([]);
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0]?.files[0]?.status).toBe('unmanaged');
  });

  it('still reports a real parse error', async () => {
    const r = await buildDoctorReport({
      repoRoot: '/repo',
      fs: new MemoryFileSystem([['.driftgate/driftgate.yaml', 'tools: [: broken']]),
      adapters: [stub({ name: 'alpha', files: [entry('A.md')] })],
    });
    expect(r.adopted).toBe(true);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("reads sync status through cross-adapter ownership, not the entry's own managed flag", async () => {
    // The case this exists for is Copilot's `AGENTS.md`: `managed: false` in Copilot's own
    // docs, and nonetheless a file the Codex adapter generates. Classifying from
    // `entry.managed` alone reports somebody's generated, in-sync file as `unmanaged`, and
    // a mutation doing exactly that passed every other test in this file.
    const reader = stub({ name: 'reader', files: [entry('shared.md')] });
    const writer = stub({
      name: 'writer',
      files: [entry('shared.md', { managed: true })],
      writes: [['shared.md', 'generated bytes\n']],
    });

    const inSync = await buildDoctorReport({
      repoRoot: '/repo',
      fs: new MemoryFileSystem([manifestEnabling('writer'), ['shared.md', 'generated bytes\n']]),
      adapters: [reader, writer],
    });
    expect(inSync.tools.find((t) => t.name === 'reader')?.files[0]?.status).toBe('generated');
    expect(inSync.tools.find((t) => t.name === 'reader')?.files[0]?.managedBy).toBe('writer');

    const absent = await buildDoctorReport({
      repoRoot: '/repo',
      fs: new MemoryFileSystem([manifestEnabling('writer')]),
      adapters: [reader, writer],
    });
    expect(absent.tools.find((t) => t.name === 'reader')?.files[0]?.status).toBe('absent');
  });

  it('calls a file stale when the rules moved on, the same word `check` uses', async () => {
    // T079. `compareToDisk` answers disk-vs-record, and an artifact whose rule was edited
    // without a `sync` still matches its record — so classifying from it alone reported a
    // stale file as `generated` while `check` called it `stale`. One repository, two
    // commands, opposite verdicts.
    const writer = stub({
      name: 'writer',
      files: [entry('shared.md', { managed: true })],
      writes: [['shared.md', 'new render\n']],
    });
    const onDisk = 'what sync wrote last time\n';

    const stale = await buildDoctorReport({
      repoRoot: '/repo',
      fs: new MemoryFileSystem([
        manifestEnabling('writer'),
        ['shared.md', onDisk],
        [
          '.driftgate/state.json',
          JSON.stringify({
            schemaVersion: 1,
            artifacts: [
              {
                adapter: 'writer',
                kind: 'rules',
                path: 'shared.md',
                hash: hashContents(onDisk),
              },
            ],
          }),
        ],
      ]),
      adapters: [writer],
    });
    expect(stale.tools[0]?.files[0]?.status).toBe('stale');

    // The control: same repository, same state record, bytes that match the render. A
    // `statusOf` that returned `stale` unconditionally would pass the assertion above.
    const clean = await buildDoctorReport({
      repoRoot: '/repo',
      fs: new MemoryFileSystem([
        manifestEnabling('writer'),
        ['shared.md', 'new render\n'],
        [
          '.driftgate/state.json',
          JSON.stringify({
            schemaVersion: 1,
            artifacts: [
              {
                adapter: 'writer',
                kind: 'rules',
                path: 'shared.md',
                hash: hashContents('new render\n'),
              },
            ],
          }),
        ],
      ]),
      adapters: [writer],
    });
    expect(clean.tools[0]?.files[0]?.status).toBe('generated');
  });

  it('puts no absolute path anywhere but repoRoot', async () => {
    const r = await report(
      [['A.md', 'a']],
      [
        stub({
          name: 'alpha',
          files: [entry('A.md'), entry('~/g.md', { scope: 'global' })],
        }),
      ],
      [['g.md', 'g']],
    );
    const { repoRoot, ...rest } = r;
    expect(repoRoot).toBe('/repo');
    for (const value of JSON.stringify(rest).match(/"[^"]*"/g) ?? []) {
      expect(value.startsWith('"/')).toBe(false);
    }
  });

  it('is byte-identical across repeated runs', async () => {
    const build = (): Promise<DoctorReport> =>
      report(
        [
          ['A.md', 'a'],
          ['pkg/A.md', 'a'],
        ],
        [stub({ name: 'alpha', resolution: 'additive', files: [entry('A.md')] })],
      );
    expect(JSON.stringify(await build())).toBe(JSON.stringify(await build()));
  });
});

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
  /** path -> the canonical rule ids that produced it, for the T084 duplicate scan. */
  readonly provenance?: Readonly<Record<string, readonly string[]>>;
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
          ...(init.provenance?.[path] === undefined
            ? {}
            : { provenance: { ruleIds: init.provenance[path] } }),
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
  it('W_DUPLICATE_LOAD fires when the same rule arrives from differently-shaped files', async () => {
    // T084. This is the case byte comparison could never see, and it is the common one:
    // Cline reads AGENTS.md on top of `.clinerules/*.md`, Roo Code on top of
    // `.roo/rules/*.md` — the same canonical rules, sent twice, in different bytes. The
    // warning stayed silent exactly where the token cost was real, and both adapters
    // shipped a hand-written docs note as a workaround for the detector's blind spot.
    //
    // Set equality is not enough either: the concatenated file carries the *union* of what
    // the split files carry, so no two of them have the same rule set. The question is per
    // rule, which is what `Artifact.provenance.ruleIds` answers.
    // Enabled, not merely detected: provenance exists only for files Driftgate generates,
    // so the rule-level key is available exactly where Driftgate knows what it wrote. A
    // detected-but-disabled tool falls back to the byte comparison, which is all there is.
    const r = await buildDoctorReport({
      repoRoot: '/repo',
      fs: new MemoryFileSystem([
        manifestEnabling('reader', 'writer'),
        ['style.md', 'style rules'],
        ['testing.md', 'testing rules'],
        ['ALL.md', 'style rules and testing rules, concatenated — different bytes entirely'],
      ]),
      adapters: [
        stub({
          name: 'reader',
          resolution: 'additive',
          files: [entry('style.md'), entry('testing.md'), entry('ALL.md')],
          writes: [
            ['style.md', 'style rules'],
            ['testing.md', 'testing rules'],
          ],
          provenance: { 'style.md': ['10-style'], 'testing.md': ['20-testing'] },
        }),
        stub({
          name: 'writer',
          files: [entry('ALL.md', { managed: true })],
          detect: false,
          writes: [
            ['ALL.md', 'style rules and testing rules, concatenated — different bytes entirely'],
          ],
          provenance: { 'ALL.md': ['10-style', '20-testing'] },
        }),
      ],
    });

    const dup = r.warnings.find((w) => w.code === 'W_DUPLICATE_LOAD');
    expect(dup?.tool).toBe('reader');
    // Every file involved, not only the concatenated one: each split file is delivering a
    // rule that also arrives from ALL.md.
    expect(dup?.paths).toEqual(['ALL.md', 'style.md', 'testing.md']);
    expect(dup?.message).toContain('ALL.md from writer');
  });

  it('W_DUPLICATE_LOAD stays silent when the rules genuinely differ', async () => {
    // The control, and it is the assertion that stops the new rule-level key from simply
    // firing on everything: two files, two disjoint rule sets, no duplication.
    const r = await buildDoctorReport({
      repoRoot: '/repo',
      fs: new MemoryFileSystem([
        manifestEnabling('reader', 'writer'),
        ['style.md', 'style rules'],
        ['ONLY-TESTING.md', 'testing rules only'],
      ]),
      adapters: [
        stub({
          name: 'reader',
          resolution: 'additive',
          files: [entry('style.md'), entry('ONLY-TESTING.md')],
          writes: [['style.md', 'style rules']],
          provenance: { 'style.md': ['10-style'] },
        }),
        stub({
          name: 'writer',
          files: [entry('ONLY-TESTING.md', { managed: true })],
          detect: false,
          writes: [['ONLY-TESTING.md', 'testing rules only']],
          provenance: { 'ONLY-TESTING.md': ['20-testing'] },
        }),
      ],
    });
    expect(codes(r)).not.toContain('W_DUPLICATE_LOAD');
  });

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

  it('first-match reports only the first present file as loaded, and bills only that one', async () => {
    // T050a. Zed opens the first file in its nine-file list and stops; the rest are never
    // read. `override` gets the *shadowing* right and the *loading* wrong — under it a
    // shadowed file still counts as loaded, which is correct for Claude Code (a losing
    // file still costs its tokens) and false here.
    const files = [entry('.rules'), entry('.cursorrules'), entry('AGENTS.md')];
    const disk = [
      ['.rules', 'first'],
      ['.cursorrules', 'second, never opened'],
      ['AGENTS.md', 'third, never opened'],
    ] as const;

    const first = await report(disk, [stub({ name: 'alpha', files, resolution: 'first-match' })]);
    const rows = first.tools[0]!.files;
    expect(rows.map((f) => f.loaded)).toEqual([true, false, false]);

    // The header as well as the rows. `loadedCount` and `loadedTokens` are computed from a
    // separate list, and the first version of this fix narrowed only the rows — so every
    // row said "not loaded" while the header still billed all three. Caught by dogfooding,
    // not by the row assertion above, which is why both are pinned.
    expect(first.tools[0]!.loadedCount).toBe(1);
    expect(first.tools[0]!.loadedTokens).toBe(rows[0]!.tokens);

    // The control, and the reason this is not a vacuous assertion: the identical fixture
    // under `override` loads all three, because there a shadowed file is still sent.
    const all = await report(disk, [stub({ name: 'alpha', files, resolution: 'override' })]);
    expect(all.tools[0]!.files.map((f) => f.loaded)).toEqual([true, true, true]);
    expect(all.tools[0]!.loadedCount).toBe(3);

    // Shadowing is unchanged between the two: `first-match` narrows what is *read*, not
    // which entry wins.
    expect(first.tools[0]!.files.map((f) => f.shadowed)).toEqual(
      all.tools[0]!.files.map((f) => f.shadowed),
    );
  });

  it('W_ORPHAN_FILE keys a directory pattern on its directory, not on its extension', async () => {
    // T082. `orphanWarnings` derived the shape from `basenamePosix(entry.pattern)`, so a
    // directory-scoped pattern like `.toolrules/*.md` reduced to `*.md` and claimed every
    // Markdown file in the repository had the shape of a tool instruction file. No shipped
    // adapter had a bare-extension basename, so nothing caught it until an adapter with one
    // was enabled — at which point `doctor` reported the whole repository.
    //
    // The fixture must use a pattern WITH a directory: for a bare name the mutated and
    // unmutated globs are byte-identical (`**/RULES.md` either way), so a bare-name case
    // passes under both and proves nothing.
    const adapters = [stub({ name: 'alpha', files: [entry('.toolrules/*.md')] })];

    const r = await report(
      [
        ['.toolrules/a.md', 'read'],
        ['pkg/.toolrules/b.md', 'a misplaced copy of the directory'],
        ['README.md', 'not an instruction file'],
        ['docs/guide.md', 'also not an instruction file'],
      ],
      adapters,
    );

    // Only the misplaced `.toolrules/` copy. Before the fix this was every `.md` on disk.
    expect(r.warnings.find((w) => w.code === 'W_ORPHAN_FILE')?.paths).toEqual([
      'pkg/.toolrules/b.md',
    ]);
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

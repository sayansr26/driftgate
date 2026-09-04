import { describe, expect, it } from 'vitest';
import { applyPlan, assertDeletable } from '../src/pipeline/apply.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import { hashContents, serializeState, STATE_SCHEMA_VERSION } from '../src/state/state.js';
import { STATE_PATH } from '../src/model/paths.js';
import { DEFAULT_MANIFEST_OPTIONS } from '../src/model/canonical.js';
import { isRulegateError } from '../src/model/errors.js';
import { buildState } from '../src/state/state.js';
import type { Artifact } from '../src/adapter/artifact.js';
import type { Canonical } from '../src/model/canonical.js';
import type { Plan } from '../src/pipeline/plan.js';
import type { StateArtifact, StateFile } from '../src/state/state.js';

/**
 * T020's stated validation: "a property test over random repo states finds no
 * non-generated deletion."
 *
 * Deliberately hand-rolled rather than `fast-check`. This project asserts its runtime
 * dependency list by test and pitches a thin tree, and `determinism.test.ts` already
 * establishes the seeded-LCG idiom — `Math.random` is banned in source, and a shuffle
 * that cannot be replayed cannot be debugged from a CI log. Every failure here is
 * reproducible from the seed printed with it.
 */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 0x100000000;
    return state / 0x100000000;
  };
}

const PATHS = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.cursor/rules/10-style.mdc',
  '.cursor/rules/20-testing.mdc',
  '.github/copilot-instructions.md',
  'docs/notes.md',
  'README.md',
] as const;

interface Repo {
  readonly fs: MemoryFileSystem;
  /** Everything on disk at the start, so "was it ours?" can be answered afterwards. */
  readonly before: ReadonlyMap<string, string>;
  readonly recorded: ReadonlyMap<string, string>;
  readonly plan: Plan;
}

function canonicalFor(): Canonical {
  return {
    schemaVersion: 1,
    manifest: {
      schemaVersion: 1,
      tools: [],
      options: DEFAULT_MANIFEST_OPTIONS,
      canonicalSources: [],
      source: { file: '.rulegate/rulegate.yaml' },
    },
    rules: [],
    mcpServers: [],
    skills: [],
  };
}

/**
 * A repository in a random but *reachable* state: some files Rulegate generated and
 * still generates, some it generated and no longer does (orphans), some it generated and
 * somebody has since edited, and some it never touched at all.
 */
function makeRepo(seed: number): Repo {
  const next = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;

  const fs = new MemoryFileSystem();
  const before = new Map<string, string>();
  const recorded = new Map<string, string>();
  const stateEntries: StateArtifact[] = [];
  const artifacts: Artifact[] = [];

  for (const path of PATHS) {
    // 'ours-current'    generated, still generated
    // 'ours-orphan'     generated, no adapter produces it now  -> a deletion candidate
    // 'ours-edited'     generated, bytes changed since         -> hand-edited, not deletable
    // 'orphan-edited'   an orphan somebody edited after we wrote it -> never deletable
    // 'theirs'          on disk, never ours                    -> never deletable
    // 'absent'          planned but nothing on disk
    // 'ghost'           recorded but gone from disk
    //
    // `orphan-edited` is the role this generator did not have at first, and its absence
    // made the "bytes we removed were the bytes we wrote" assertion vacuous: deleting the
    // refusal branch outright left every seed passing. The recurring failure in this
    // project is not an assertion that checks nothing, it is a guard no input reaches.
    const role = pick([
      'ours-current',
      'ours-orphan',
      'ours-edited',
      'orphan-edited',
      'theirs',
      'absent',
      'ghost',
    ] as const);

    const generated = `# ${path}\n\ngenerated ${String(Math.floor(next() * 1000))}\n`;

    if (role === 'ours-current' || role === 'ours-edited' || role === 'absent') {
      artifacts.push({ path, contents: generated, adapter: 'claude-code', kind: 'instructions' });
    }

    if (
      role === 'ours-current' ||
      role === 'ours-orphan' ||
      role === 'ours-edited' ||
      role === 'orphan-edited'
    ) {
      stateEntries.push({
        path,
        hash: hashContents(generated),
        adapter: 'claude-code',
        kind: 'instructions',
      });
      recorded.set(path, hashContents(generated));
    }
    if (role === 'ghost') {
      stateEntries.push({
        path,
        hash: hashContents(generated),
        adapter: 'claude-code',
        kind: 'instructions',
      });
      recorded.set(path, hashContents(generated));
    }

    const onDisk =
      role === 'ours-current' || role === 'ours-orphan'
        ? generated
        : role === 'ours-edited' || role === 'orphan-edited'
          ? `${generated}edited by a human\n`
          : role === 'theirs'
            ? `somebody else wrote this: ${path}\n`
            : undefined;

    if (onDisk !== undefined) {
      fs.files.set(path, onDisk);
      before.set(path, onDisk);
    }
  }

  stateEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const previous: StateFile = { schemaVersion: STATE_SCHEMA_VERSION, artifacts: stateEntries };
  fs.files.set(STATE_PATH, serializeState(previous));

  const sorted = [...artifacts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const plan: Plan = {
    canonical: canonicalFor(),
    artifacts: sorted,
    state: buildState(sorted),
    enabledAdapters: ['claude-code'],
    errors: [],
    warnings: [],
  };

  return { fs, before, recorded, plan };
}

describe('non-destruction over random repository states (T020)', () => {
  it('never deletes a file that state.json did not record as ours, over 200 seeds', async () => {
    let totalDeleted = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const repo = makeRepo(seed);
      const deleted: string[] = [];
      const fs = repo.fs;
      const realDelete = fs.deleteFile.bind(fs);
      fs.deleteFile = async (p: string): Promise<void> => {
        deleted.push(p);
        await realDelete(p);
      };

      const report = await applyPlan(repo.plan, fs);

      for (const path of deleted) {
        // The whole invariant, stated three ways, because each is a different way to
        // get it wrong: it must have been recorded as ours, the bytes we removed must
        // have been the bytes we wrote, and it must not have been in the plan.
        expect(repo.recorded.has(path), `seed ${String(seed)}: deleted unrecorded ${path}`).toBe(
          true,
        );
        expect(
          hashContents(repo.before.get(path) ?? ''),
          `seed ${String(seed)}: deleted modified ${path}`,
        ).toBe(repo.recorded.get(path));
        expect(
          repo.plan.artifacts.some((a) => a.path === path),
          `seed ${String(seed)}: deleted a planned artifact ${path}`,
        ).toBe(false);
      }

      expect([...deleted].sort()).toEqual([...report.deleted].sort());
      totalDeleted += deleted.length;
    }

    // The control. Every assertion above is vacuously true for a generator that never
    // produces an orphan, and this project has already shipped one fixture that was not
    // the thing it claimed to be (T024's "adversarial" document). If the roles ever stop
    // producing deletions, this test stops testing and says so.
    expect(totalDeleted).toBeGreaterThan(100);
  });

  it('every deleted file is recoverable from .rulegate/backup/, over 200 seeds', async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const repo = makeRepo(seed);
      const report = await applyPlan(repo.plan, repo.fs);

      for (const path of report.deleted) {
        expect(
          repo.fs.files.get(`.rulegate/backup/${path}`),
          `seed ${String(seed)}: no backup for ${path}`,
        ).toBe(repo.before.get(path));
      }
    }
  });

  it('a file nobody recorded is never touched, over 200 seeds', async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const repo = makeRepo(seed);
      await applyPlan(repo.plan, repo.fs);

      for (const [path, contents] of repo.before) {
        const wasOurs = repo.recorded.has(path);
        const wasPlanned = repo.plan.artifacts.some((a) => a.path === path);
        if (wasOurs || wasPlanned) continue;
        expect(repo.fs.files.get(path), `seed ${String(seed)}: touched ${path}`).toBe(contents);
      }
    }
  });
});

describe('E_DELETE_UNRECORDED (T020)', () => {
  const record = {
    path: 'CLAUDE.md',
    hash: hashContents('# generated\n'),
    adapter: 'claude-code',
    kind: 'instructions',
  } as const;

  it('refuses a path state.json does not record, and returns the record for one it does', () => {
    const recorded: StateFile = { schemaVersion: STATE_SCHEMA_VERSION, artifacts: [record] };
    const empty: StateFile = { schemaVersion: STATE_SCHEMA_VERSION, artifacts: [] };

    // The control matters as much as the refusal: an assertion that this throws would
    // pass against a function that throws for everything.
    expect(assertDeletable('CLAUDE.md', recorded)).toEqual(record);

    let thrown: unknown;
    try {
      assertDeletable('CLAUDE.md', empty);
    } catch (e) {
      thrown = e;
    }
    expect(isRulegateError(thrown)).toBe(true);
    expect(isRulegateError(thrown) && thrown.code).toBe('E_DELETE_UNRECORDED');
    // A refusal nobody can act on is a stack trace with better manners.
    expect(isRulegateError(thrown) && thrown.message).toContain('CLAUDE.md');
    expect(isRulegateError(thrown) && thrown.hint).toBeDefined();
  });

  it('is what stands between the delete loop and an unrecorded path', () => {
    // `reclaimOrphans` calls this for every candidate before reading the disk, so a
    // caller that assembled candidates from anywhere but state cannot reach `deleteFile`.
    const other: StateFile = {
      schemaVersion: STATE_SCHEMA_VERSION,
      artifacts: [{ ...record, path: 'AGENTS.md' }],
    };
    expect(() => assertDeletable('CLAUDE.md', other)).toThrow(
      /E_DELETE_UNRECORDED|refusing to delete/,
    );
  });
});

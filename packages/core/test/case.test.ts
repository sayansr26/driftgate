import { describe, expect, it } from 'vitest';
import { foldPath, pathKeyFor, probeCaseInsensitive } from '../src/fs/case.js';
import { compareToDisk } from '../src/state/compare.js';
import { applyPlan, assertDeletable } from '../src/pipeline/apply.js';
import { verifyPlan } from '../src/pipeline/verify.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import { buildState, serializeState, STATE_SCHEMA_VERSION } from '../src/state/state.js';
import { STATE_PATH } from '../src/model/paths.js';
import { DEFAULT_MANIFEST_OPTIONS } from '../src/model/canonical.js';
import type { Artifact } from '../src/adapter/artifact.js';
import type { Canonical } from '../src/model/canonical.js';
import type { Plan } from '../src/pipeline/plan.js';
import type { StateFile } from '../src/state/state.js';

/**
 * Case-insensitive path identity (T085).
 *
 * The defect these guard: `computePlan` has case-folded its conflict key since T069, but
 * `state.json` lookups and `compareToDisk` matched exactly. On APFS and NTFS a recorded
 * `CLAUDE.md` and a planned `claude.md` are **one physical file**, so the same run filed it
 * under `unmanaged` (refusing to write it, on the grounds that it was somebody else's) and
 * under `orphaned` (deleting it, on the grounds that it was ours).
 *
 * Every case here is paired with its control on a case-sensitive filesystem, where
 * `CLAUDE.md` and `claude.md` really are two files and the old answers are the right ones.
 * Without the pair a fold that fired everywhere would pass, and that fold is wrong: it
 * would stop reporting a genuinely stale artifact as an orphan on ext4, leaving it on disk
 * at exit 0 for the tool it was written for to keep loading — which is T073's bug.
 */

const RENDER = '# rules\n\ngenerated\n';
const OLD = '# rules\n\nwhat we wrote last time\n';

function artifact(path: string, contents: string): Artifact {
  return { path, contents, adapter: 'claude-code', kind: 'rules' };
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

function planFor(artifacts: readonly Artifact[]): Plan {
  return {
    canonical: canonicalFor(),
    artifacts,
    state: buildState(artifacts),
    enabledAdapters: ['claude-code'],
    errors: [],
    warnings: [],
  };
}

/**
 * A repository Rulegate generated `CLAUDE.md` into, whose adapter now emits `Claude.md`.
 *
 * `caseInsensitive` decides whether the one file on disk answers to both names. Nothing
 * else differs between the two runs, which is what makes them a controlled pair: any
 * assertion that does not change between them is not testing the fold.
 *
 * **`Claude.md` and not `claude.md`, and that is load-bearing.** The lookup maps are keyed
 * by the *folded* path, so a planned path that is already lower-case matches them whether
 * or not the query is folded — the two branches produce identical behaviour and the case
 * distinguishes nothing. The first draft of this file used `claude.md` and a mutation
 * deleting the fold from `compareToDisk`'s record lookup passed all eleven tests. Same
 * shape as T082's inert control.
 */
function repoWithCaseRename(caseInsensitive: boolean, diskContents = OLD): MemoryFileSystem {
  const recorded: StateFile = {
    schemaVersion: STATE_SCHEMA_VERSION,
    artifacts: buildState([artifact('CLAUDE.md', OLD)]).artifacts,
  };
  return new MemoryFileSystem(
    [
      ['CLAUDE.md', diskContents],
      [STATE_PATH, serializeState(recorded)],
    ],
    { caseInsensitive },
  );
}

describe('probeCaseInsensitive', () => {
  it('says no on a filesystem that distinguishes case', async () => {
    const fs = new MemoryFileSystem([['README.md', 'x\n']]);
    expect(await probeCaseInsensitive(fs)).toBe(false);
  });

  it('says yes on a filesystem that folds it', async () => {
    const fs = new MemoryFileSystem([['README.md', 'x\n']], { caseInsensitive: true });
    expect(await probeCaseInsensitive(fs)).toBe(true);
  });

  it('ignores a root that already lists the flipped name', async () => {
    // Two real files on a case-sensitive filesystem, so `readme.MD` existing proves nothing
    // about folding — believing it reports ext4 as APFS. The pair has to be the *exact*
    // flip to reach this: `README.md` alongside `readme.md` needs no guard, because
    // `readme.MD` still does not exist there and the probe reaches the right answer anyway.
    const fs = new MemoryFileSystem([
      ['README.md', 'x\n'],
      ['readme.MD', 'y\n'],
      ['notes.md', 'z\n'],
    ]);
    expect(await probeCaseInsensitive(fs)).toBe(false);
  });

  it('assumes case-sensitive when nothing at the root can answer', async () => {
    // Not one cased character in the whole name, so the name flips to itself, the
    // directory already lists it, and the probe has no evidence. The old behaviour is the
    // safe default: a probe that cannot tell must not start folding. `123.md` does *not*
    // reach this — an extension is cased too, and writing this case with one was the first
    // draft's mistake.
    const fs = new MemoryFileSystem([['123.456', 'x\n']], { caseInsensitive: true });
    expect(await probeCaseInsensitive(fs)).toBe(false);
  });
});

describe('foldPath and pathKeyFor', () => {
  it('folds only when asked, and never mutates the path it is given', () => {
    expect(foldPath('CLAUDE.md')).toBe('claude.md');
    expect(pathKeyFor(false)('CLAUDE.md')).toBe('CLAUDE.md');
    expect(pathKeyFor(true)('CLAUDE.md')).toBe('claude.md');
  });
});

describe('compareToDisk across a case-only rename', () => {
  it('recognizes its own artifact where the filesystem folds case', async () => {
    const fs = repoWithCaseRename(true);
    const planned = [artifact('Claude.md', RENDER)];

    const comparison = await compareToDisk(
      {
        schemaVersion: STATE_SCHEMA_VERSION,
        artifacts: buildState([artifact('CLAUDE.md', OLD)]).artifacts,
      },
      planned,
      fs,
    );

    expect(comparison.caseInsensitive).toBe(true);
    // Ours and out of date — not somebody else's.
    expect(comparison.unmanaged).toEqual([]);
    expect(comparison.unchanged).toEqual(['Claude.md']);
    // And emphatically not a deletion candidate: `orphaned` is the only source of those
    // anywhere in the codebase, and this is the file the plan is about to write.
    expect(comparison.orphaned).toEqual([]);
  });

  it('still reports two real files as two files where it does not', async () => {
    const fs = repoWithCaseRename(false);
    const planned = [artifact('Claude.md', RENDER)];

    const comparison = await compareToDisk(
      {
        schemaVersion: STATE_SCHEMA_VERSION,
        artifacts: buildState([artifact('CLAUDE.md', OLD)]).artifacts,
      },
      planned,
      fs,
    );

    expect(comparison.caseInsensitive).toBe(false);
    // On ext4 `claude.md` does not exist yet and `CLAUDE.md` is genuinely stale.
    expect(comparison.untracked).toEqual(['Claude.md']);
    expect(comparison.orphaned).toEqual(['CLAUDE.md']);
  });
});

describe('applyPlan across a case-only rename', () => {
  it('does not delete the file it just refused to overwrite', async () => {
    // The destructive shape. Before the fix: the write loop skips `claude.md` as
    // `unmanaged`, then `reclaimOrphans` deletes `CLAUDE.md` — the same physical file,
    // whose bytes still match the record, so nothing refuses it.
    const fs = repoWithCaseRename(true);
    const deleted: string[] = [];
    const realDelete = fs.deleteFile.bind(fs);
    fs.deleteFile = async (p: string): Promise<void> => {
      deleted.push(p);
      await realDelete(p);
    };

    const report = await applyPlan(planFor([artifact('Claude.md', RENDER)]), fs);

    expect(deleted).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.written).toEqual(['Claude.md']);
    expect(await fs.tryReadFile('CLAUDE.md')).toBe(RENDER);
  });

  it('is idempotent afterwards, which is what the delete destroyed', async () => {
    // Before the fix the second run found the file missing and rewrote it, and the third
    // deleted it again: a repository that can never come to rest.
    const fs = repoWithCaseRename(true);
    const plan = planFor([artifact('Claude.md', RENDER)]);

    await applyPlan(plan, fs);
    const second = await applyPlan(plan, fs);

    expect(second.written).toEqual([]);
    expect(second.deleted).toEqual([]);
    expect(second.unchanged).toEqual(['Claude.md']);
  });

  it('still reclaims a genuine orphan where the filesystem distinguishes case', async () => {
    // The control that stops the fix from becoming "orphans are never deleted".
    const fs = repoWithCaseRename(false);
    const report = await applyPlan(planFor([artifact('Claude.md', RENDER)]), fs);

    expect(report.deleted).toEqual(['CLAUDE.md']);
    expect(report.written).toEqual(['Claude.md']);
  });
});

describe('ownership survives a case-only rename', () => {
  it('keeps the record for a hand-edited file rather than forgetting it wrote it', async () => {
    // The case that reaches `reconcileState`'s lookup. The file is ours and somebody has
    // edited it, so `sync` refuses to overwrite and must keep the record — the recorded
    // hash is the only thing that makes the *next* run report the edit rather than adopt
    // it. Matching the record exactly drops it, and a dropped record is T073: Rulegate
    // forgets it owns the file, then calls its own artifact somebody else's.
    const fs = repoWithCaseRename(true, 'somebody edited this by hand\n');
    const report = await applyPlan(planFor([artifact('Claude.md', RENDER)]), fs);

    expect(report.skipped).toEqual([{ path: 'Claude.md', reason: 'hand-edited' }]);
    expect(report.deleted).toEqual([]);

    const after = await fs.tryReadFile(STATE_PATH);
    expect(after).toContain('CLAUDE.md');
  });

  it('refuses to delete a path state does not record, under either casing', () => {
    // `assertDeletable` is the last gate in front of `deleteFile`. Its refusal is
    // unreachable through `applyPlan` by design, so it is tested against the input that
    // reaches it — with a control, since a function that throws for everything passes an
    // assertion that it throws.
    const previous: StateFile = {
      schemaVersion: STATE_SCHEMA_VERSION,
      artifacts: buildState([artifact('CLAUDE.md', OLD)]).artifacts,
    };

    expect(assertDeletable('CLAUDE.md', previous, pathKeyFor(true)).path).toBe('CLAUDE.md');
    expect(assertDeletable('Claude.md', previous, pathKeyFor(true)).path).toBe('CLAUDE.md');
    expect(() => assertDeletable('Claude.md', previous, pathKeyFor(false))).toThrow(
      /does not record it/,
    );
    expect(() => assertDeletable('OTHER.md', previous, pathKeyFor(true))).toThrow(
      /does not record it/,
    );
  });
});

describe('check across a case-only rename', () => {
  it('can be made clean by a sync, rather than reporting one file twice forever', async () => {
    const fs = repoWithCaseRename(true);
    const plan = planFor([artifact('Claude.md', RENDER)]);

    const before = await verifyPlan(plan, fs);
    // One file, one verdict — not `unmanaged` at `claude.md` plus `orphaned` at
    // `CLAUDE.md`, which is a repository no `sync` could bring into sync.
    expect(before.entries.map((e) => e.path)).toEqual(['Claude.md']);
    expect(before.entries[0]?.status).toBe('stale');

    await applyPlan(plan, fs);
    expect((await verifyPlan(plan, fs)).clean).toBe(true);
  });
});

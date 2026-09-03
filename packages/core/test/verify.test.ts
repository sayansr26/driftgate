import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src/pipeline/verify.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import { buildState, serializeState } from '../src/state/state.js';
import { STATE_PATH } from '../src/model/paths.js';
import { DEFAULT_MANIFEST_OPTIONS } from '../src/model/canonical.js';
import type { Artifact } from '../src/adapter/artifact.js';
import type { Canonical } from '../src/model/canonical.js';
import type { Plan } from '../src/pipeline/plan.js';
import type { StateFile } from '../src/state/state.js';

/**
 * One case per `VerifyStatus`, each built from the smallest repository that reaches it.
 * The rule under test is the doc comment on `verifyPlan`: clean means `sync` would write
 * nothing and delete nothing.
 */

const canonical: Canonical = {
  schemaVersion: 1,
  manifest: {
    schemaVersion: 1,
    tools: [],
    options: DEFAULT_MANIFEST_OPTIONS,
    canonicalSources: [],
    source: { file: '.driftgate/driftgate.yaml' },
  },
  rules: [],
  mcpServers: [],
  skills: [],
};

function artifact(path: string, contents: string): Artifact {
  return { path, contents, adapter: 'claude-code', kind: 'rules' };
}

function planOf(...artifacts: Artifact[]): Plan {
  return {
    canonical,
    artifacts,
    state: buildState(artifacts),
    enabledAdapters: [],
    errors: [],
    warnings: [],
  };
}

/** A repo where `state.json` records exactly `recorded`, and `disk` is what is on disk. */
function repo(recorded: readonly Artifact[], disk: Record<string, string>): MemoryFileSystem {
  const state: StateFile = buildState(recorded);
  return new MemoryFileSystem([[STATE_PATH, serializeState(state)], ...Object.entries(disk)]);
}

const RENDER = artifact('CLAUDE.md', '# Rules\n\nNew text.\n');
const OLD = artifact('CLAUDE.md', '# Rules\n\nOld text.\n');

describe('verifyPlan', () => {
  it('is clean when every artifact matches and nothing is orphaned', async () => {
    const report = await verifyPlan(
      planOf(RENDER),
      repo([RENDER], { 'CLAUDE.md': RENDER.contents }),
    );
    expect(report.clean).toBe(true);
    expect(report.entries).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('reports stale when the record matches disk but the render has moved on', async () => {
    // The case `check` exists for: a rule was edited and `sync` was not run. To
    // `compareToDisk` this file is `unchanged`; to `check` it is the whole point.
    const report = await verifyPlan(planOf(RENDER), repo([OLD], { 'CLAUDE.md': OLD.contents }));
    expect(report.clean).toBe(false);
    expect(report.entries).toEqual([
      { path: 'CLAUDE.md', status: 'stale', expected: RENDER.contents, actual: OLD.contents },
    ]);
    expect(report.drifted).toEqual(['CLAUDE.md']);
  });

  it('reports hand-edited when the record no longer matches disk', async () => {
    const mine = 'I edited this.\n';
    const report = await verifyPlan(planOf(RENDER), repo([RENDER], { 'CLAUDE.md': mine }));
    expect(report.entries).toEqual([
      { path: 'CLAUDE.md', status: 'hand-edited', expected: RENDER.contents, actual: mine },
    ]);
  });

  it('reports unmanaged when nothing is recorded and different bytes are on disk', async () => {
    const theirs = 'Somebody else wrote this.\n';
    const report = await verifyPlan(planOf(RENDER), repo([], { 'CLAUDE.md': theirs }));
    expect(report.entries).toEqual([
      { path: 'CLAUDE.md', status: 'unmanaged', expected: RENDER.contents, actual: theirs },
    ]);
  });

  it('is clean for an unrecorded file whose bytes already match — the adoption case', async () => {
    const report = await verifyPlan(planOf(RENDER), repo([], { 'CLAUDE.md': RENDER.contents }));
    expect(report.clean).toBe(true);
  });

  it('is clean for a recorded file that was hand-edited to exactly the new render', async () => {
    // The T021 fix on the `sync` side makes both commands agree here.
    const report = await verifyPlan(planOf(RENDER), repo([OLD], { 'CLAUDE.md': RENDER.contents }));
    expect(report.clean).toBe(true);
  });

  it('reports missing for a planned artifact that is not on disk, recorded or not', async () => {
    const recorded = await verifyPlan(planOf(RENDER), repo([RENDER], {}));
    expect(recorded.entries).toEqual([
      { path: 'CLAUDE.md', status: 'missing', expected: RENDER.contents },
    ]);
    expect(recorded.missing).toEqual(['CLAUDE.md']);
    expect(recorded.drifted).toEqual([]);

    const unrecorded = await verifyPlan(planOf(RENDER), repo([], {}));
    expect(unrecorded.entries.map((e) => e.status)).toEqual(['missing']);
  });

  it('reports an orphan still on disk as drift, because sync would delete it', async () => {
    const mdc = artifact('.cursor/rules/10-style.mdc', 'style\n');
    const report = await verifyPlan(
      planOf(RENDER),
      repo([RENDER, mdc], { 'CLAUDE.md': RENDER.contents, [mdc.path]: mdc.contents }),
    );
    expect(report.clean).toBe(false);
    expect(report.entries).toEqual([{ path: mdc.path, status: 'orphaned', actual: mdc.contents }]);
    // Not a planned path, so it belongs in neither of the legacy arrays.
    expect(report.drifted).toEqual([]);
    expect(report.missing).toEqual([]);
  });

  it('reports an edited orphan separately, because sync would refuse to delete it', async () => {
    const mdc = artifact('.cursor/rules/10-style.mdc', 'style\n');
    const report = await verifyPlan(
      planOf(RENDER),
      repo([RENDER, mdc], { 'CLAUDE.md': RENDER.contents, [mdc.path]: 'mine now\n' }),
    );
    expect(report.entries).toEqual([
      { path: mdc.path, status: 'orphan-hand-edited', actual: 'mine now\n' },
    ]);
  });

  it('is clean for an orphan that is already gone: a stale record is not a change to the repo', async () => {
    const mdc = artifact('.cursor/rules/10-style.mdc', 'style\n');
    const report = await verifyPlan(
      planOf(RENDER),
      repo([RENDER, mdc], { 'CLAUDE.md': RENDER.contents }),
    );
    expect(report.clean).toBe(true);
  });

  it('is clean for a CRLF copy of a clean artifact, as sync would not rewrite it', async () => {
    const crlf = RENDER.contents.replace(/\n/g, '\r\n');
    const report = await verifyPlan(planOf(RENDER), repo([RENDER], { 'CLAUDE.md': crlf }));
    expect(report.clean).toBe(true);
  });

  it('warns about an unreadable state.json and then answers as if there were none', async () => {
    const fs = new MemoryFileSystem([
      [STATE_PATH, '<<<<<<< HEAD\n{ "broken"\n'],
      ['CLAUDE.md', 'theirs\n'],
    ]);
    const report = await verifyPlan(planOf(RENDER), fs);
    expect(report.warnings.map((w) => w.code)).toEqual(['E_STATE_INVALID']);
    expect(report.entries.map((e) => e.status)).toEqual(['unmanaged']);

    // Control: absent state is silent.
    const none = await verifyPlan(
      planOf(RENDER),
      new MemoryFileSystem([['CLAUDE.md', 'theirs\n']]),
    );
    expect(none.warnings).toEqual([]);
  });

  it('sorts planned paths and orphans together, by codepoint', async () => {
    // `AGENTS.md` (orphan) sorts before `CLAUDE.md` (planned) and `Z.md` (planned) after
    // `.cursor/...` (orphan). Emitting orphans after planned paths would pass a test that
    // only used one of each.
    const agents = artifact('AGENTS.md', 'a\n');
    const mdc = artifact('.cursor/rules/10-style.mdc', 'style\n');
    const z = artifact('Z.md', 'z\n');
    const report = await verifyPlan(
      planOf(RENDER, z),
      repo([agents, mdc, RENDER, z], {
        'AGENTS.md': 'a\n',
        '.cursor/rules/10-style.mdc': 'style\n',
        'CLAUDE.md': 'edited\n',
        'Z.md': 'edited\n',
      }),
    );
    expect(report.entries.map((e) => e.path)).toEqual([
      '.cursor/rules/10-style.mdc',
      'AGENTS.md',
      'CLAUDE.md',
      'Z.md',
    ]);
  });
});

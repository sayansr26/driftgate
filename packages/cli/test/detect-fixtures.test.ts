import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFileSystem, detectTools, parse } from '@driftgate/core';
import { detectEngineFixture, fixturePath } from '@driftgate/adapter-kit/testing';
import { ADAPTERS } from '../src/registry.js';
import type { DetectionReport } from '@driftgate/core';

/**
 * T016's stated validation: on fixture repos with 0, 1 and 5 tools present, detection
 * output matches expectation, and a filesystem spy confirms zero writes outside the repo.
 *
 * This lives in the CLI package rather than in core because core must not depend on the
 * adapters — eslint bans `@driftgate/adapter-*` in `packages/core/src`, and the dependency
 * direction is `cli → adapters → kit → core`. Core owns the algorithm; the CLI owns the
 * roster of adapters this build ships. Moving this file into core would invert that.
 */

async function reportFor(kase: 'none' | 'one' | 'all'): Promise<DetectionReport> {
  const repoRoot = fixturePath(detectEngineFixture(kase));
  const fs = new NodeFileSystem(repoRoot);
  const parsed = await parse({ fs });
  return detectTools({ repoRoot, fs, canonical: parsed.canonical, adapters: ADAPTERS });
}

describe('detectTools over the shipped adapter set', () => {
  it('finds nothing in a repository that uses none of the five', async () => {
    const report = await reportFor('none');
    expect(report.tools.map((t) => t.name)).toEqual([
      'claude-code',
      'codex',
      'copilot',
      'cursor',
      'gemini',
    ]);
    // Every tool is still reported, with no evidence. `doctor` must be able to say
    // "cursor is not in use here", and it cannot say that from an absent row.
    expect(report.tools.every((t) => !t.detected)).toBe(true);
    expect(report.tools.flatMap((t) => t.evidence)).toEqual([]);
    expect(report.tools.every((t) => t.failed === undefined)).toBe(true);
  });

  it('finds exactly one tool when only one is configured', async () => {
    const report = await reportFor('one');
    const found = report.tools.filter((t) => t.detected);
    expect(found.map((t) => t.name)).toEqual(['cursor']);
    expect(found[0]?.evidence).toEqual(['.cursor']);
  });

  it('finds all five, with the evidence each adapter documents', async () => {
    const report = await reportFor('all');
    expect(report.tools.filter((t) => t.detected)).toHaveLength(5);
    expect(Object.fromEntries(report.tools.map((t) => [t.name, t.evidence]))).toEqual({
      'claude-code': ['.claude', 'CLAUDE.md'],
      codex: ['AGENTS.md'],
      copilot: ['.github/copilot-instructions.md', '.github/instructions'],
      cursor: ['.cursor', '.cursorrules'],
      gemini: ['.gemini', 'GEMINI.md'],
    });
  });

  it('reports user-level files from the home directory it is given', async () => {
    const repoRoot = fixturePath(detectEngineFixture('all'));
    const fs = new NodeFileSystem(repoRoot);
    const parsed = await parse({ fs });
    // A fixture standing in for $HOME, so this never reads the real one.
    const globalFs = new NodeFileSystem(fixturePath(detectEngineFixture('home')));
    const report = await detectTools({
      repoRoot,
      fs,
      canonical: parsed.canonical,
      adapters: ADAPTERS,
      globalFs,
    });

    expect(report.globalProbed).toBe(true);
    const present = report.tools.flatMap((t) => t.global.filter((g) => g.present));
    // The fixture holds Claude Code's and Gemini's user files and not Cursor's or Codex's,
    // so this covers both answers and cannot pass by returning a constant.
    expect(present.map((g) => g.pattern).sort()).toEqual([
      '~/.claude/CLAUDE.md',
      '~/.gemini/GEMINI.md',
    ]);
    const absent = report.tools.flatMap((t) => t.global.filter((g) => !g.present));
    expect(absent.length).toBeGreaterThan(0);
  });
});

/**
 * A recursive snapshot of every path, its size, and its mtime.
 *
 * Shared by the control and the claim below so that the thing proving the detector works
 * is literally the thing doing the detecting.
 */
async function snapshotTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const child = path.join(d, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child, rel);
        continue;
      }
      const s = await stat(child);
      out.push(`${rel}\t${String(s.size)}\t${String(s.mtimeMs)}`);
    }
  };
  await walk(dir, '');
  return out.sort();
}

describe('the no-write guarantee', () => {
  /**
   * The positive control, and it ships rather than being run once by hand.
   *
   * This repository has produced an inert guard in three consecutive sessions, always in
   * the same way: a test written from the shape of the thing rather than from a failure
   * passes and is believed. So the detector is made to fire, in CI, forever — with the
   * same helper and the same comparison as the real assertion below.
   *
   * The control both adds a file *and* modifies one in place, because a snapshot that
   * compared only filenames would pass a control that merely added one, and would then be
   * weaker than the claim it is vouching for.
   */
  it('detects a write, so the assertion below is known to be capable of failing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'driftgate-detect-'));
    await writeFile(path.join(dir, 'existing.txt'), 'original');
    const before = await snapshotTree(dir);

    await writeFile(path.join(dir, 'added.txt'), 'new');
    await writeFile(path.join(dir, 'existing.txt'), 'modified in place');

    expect(await snapshotTree(dir)).not.toEqual(before);
  });

  it('leaves both the repository and the home directory byte-identical', async () => {
    const repoRoot = fixturePath(detectEngineFixture('all'));
    const home = fixturePath(detectEngineFixture('home'));
    const beforeRepo = await snapshotTree(repoRoot);
    const beforeHome = await snapshotTree(home);

    const fs = new NodeFileSystem(repoRoot);
    const parsed = await parse({ fs });
    await detectTools({
      repoRoot,
      fs,
      canonical: parsed.canonical,
      adapters: ADAPTERS,
      globalFs: new NodeFileSystem(home),
    });

    expect(await snapshotTree(repoRoot)).toEqual(beforeRepo);
    expect(await snapshotTree(home)).toEqual(beforeHome);
  });
});

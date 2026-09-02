import { cp, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFileSystem, buildDoctorReport } from '@driftgate/core';
import { ADAPTERS } from '../src/registry.js';
import { runDoctor } from '../src/commands/doctor.js';
import { ExitCode } from '../src/ui/exit.js';
import type { DoctorReport } from '@driftgate/core';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

/** ANSI CSI introducer, built rather than written literally: eslint bans a control
 *  character inside a regular expression, and a test that matches escape sequences has to
 *  name one somehow. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);

let repo: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'driftgate-doctor-'));
  stdout = [];
  stderr = [];
  // Doctor reports warnings on stderr by design, so an uncaptured run floods the test log
  // with correct output. Capturing also makes the piped-output assertions possible at all.
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const inspect = (): Promise<DoctorReport> =>
  buildDoctorReport({ repoRoot: repo, fs: new NodeFileSystem(repo), adapters: ADAPTERS });

const codes = (r: DoctorReport): string[] => [...new Set(r.warnings.map((w) => w.code))].sort();

/**
 * A repository with all five adapters on, synced, plus the three faults T026 names.
 *
 * The symlink and the 33 KiB file are created here rather than committed under `fixtures/`.
 * Git stores a symlink as a plain text file on a Windows checkout without
 * `core.symlinks=true`, so a committed symlink fixture would quietly become a regular file
 * and the symlink guard would go green while testing nothing — the inert-guard shape this
 * repository has now shipped five times. Creating it at test time makes it real wherever
 * symlinks are real, and lets the assertion be skipped with a stated reason where they are
 * not. Synthesizing the oversized file also keeps 33 KiB of filler out of the repository.
 */
async function seedFaults(): Promise<{ symlinked: boolean }> {
  // The orphan: instruction-shaped, and sitting where no detected tool looks. Cursor's
  // `.cursorrules` entry declares no `nesting`, so a nested copy is read by nobody.
  await mkdir(path.join(repo, 'packages/legacy'), { recursive: true });
  await writeFile(path.join(repo, 'packages/legacy/.cursorrules'), 'stale rules\n');

  // Over Codex's documented 32 KiB total cap, which is the only numeric limit any shipped
  // adapter declares.
  await writeFile(path.join(repo, 'AGENTS.md'), `# Rules\n\n${'filler content. '.repeat(2200)}\n`);

  try {
    await symlink('CLAUDE.md', path.join(repo, 'GEMINI.md'));
    return { symlinked: true };
  } catch {
    return { symlinked: false };
  }
}

describe('driftgate doctor — T026 warnings', () => {
  beforeEach(async () => {
    await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
  });

  it('fires the orphan, over-limit and symlink warnings on one repository', async () => {
    const { symlinked } = await seedFaults();
    const r = await inspect();

    expect(codes(r)).toContain('W_ORPHAN_FILE');
    expect(codes(r)).toContain('W_OVER_LIMIT');
    if (symlinked) expect(codes(r)).toContain('W_SYMLINK');
  });

  it('each warning is read from the repository, not returned as a constant', async () => {
    // Three separate negative controls. Remove one fault at a time and only that warning
    // may disappear — an assertion that passes with the fault removed is reading nothing.
    const { symlinked } = await seedFaults();

    await rm(path.join(repo, 'packages/legacy/.cursorrules'));
    expect(codes(await inspect())).not.toContain('W_ORPHAN_FILE');

    await writeFile(path.join(repo, 'AGENTS.md'), '# Rules\n\nshort\n');
    expect(codes(await inspect())).not.toContain('W_OVER_LIMIT');

    if (symlinked) {
      await rm(path.join(repo, 'GEMINI.md'));
      expect(codes(await inspect())).not.toContain('W_SYMLINK');
    }
  });

  it('every warning names a path the report actually resolved', async () => {
    await seedFaults();
    const r = await inspect();
    const resolved = new Set(r.tools.flatMap((t) => t.files.flatMap((f) => f.paths)));
    const orphans = new Set(
      r.warnings.filter((w) => w.code === 'W_ORPHAN_FILE').flatMap((w) => w.paths),
    );

    for (const w of r.warnings) {
      for (const p of w.paths) expect(resolved.has(p) || orphans.has(p)).toBe(true);
    }
  });
});

describe('driftgate doctor — T078 duplicate loading', () => {
  it('names the tool, the count and the tokens paid twice', async () => {
    await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
    const r = await inspect();

    const dup = r.warnings.find((w) => w.code === 'W_DUPLICATE_LOAD' && w.tool === 'copilot');
    expect(dup).toBeDefined();
    expect(dup?.message).toContain('GitHub Copilot will load');
    expect(dup?.message).toContain("duplicates of another adapter's output");
    // The attribution has to name the adapters that generated the copies, because "you
    // load three identical files" without saying which adapter wrote each is not actionable.
    expect(dup?.message).toContain('from codex');
    expect(dup?.message).toContain('from claude-code');
    expect(dup?.paths).toContain('AGENTS.md');
    expect(dup?.paths).toContain('CLAUDE.md');
  });

  it('is silent for the tools whose loaded files genuinely differ', async () => {
    await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
    const r = await inspect();
    const cursor = r.warnings.find((w) => w.code === 'W_DUPLICATE_LOAD' && w.tool === 'cursor');
    expect(cursor).toBeUndefined();
  });
});

describe('driftgate doctor — contract', () => {
  it('reports a repository that has never adopted driftgate, and exits 0', async () => {
    await cp(path.join(fixtures, 'doctor/unadopted'), repo, { recursive: true });
    const r = await inspect();
    expect(r.adopted).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.tools.some((t) => t.detected)).toBe(true);
    expect(await runDoctor({ cwd: repo, quiet: true, noGlobal: true })).toBe(ExitCode.Ok);
  });

  it('exits 0 even when it has warnings to report', async () => {
    await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
    await seedFaults();
    // `check` owns exit 1 for drift. Doctor reporting a permanent, correct condition as a
    // CI failure is how a gate gets muted.
    expect(await runDoctor({ cwd: repo, quiet: true, noGlobal: true })).toBe(ExitCode.Ok);
  });

  it('writes nothing', async () => {
    await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
    await seedFaults();
    const before = await snapshotTree(repo);
    await runDoctor({ cwd: repo, quiet: true, noGlobal: true });
    expect(await snapshotTree(repo)).toEqual(before);
  });

  it('detects a write, so the assertion above is known to be capable of failing', async () => {
    // The positive control ships and runs in CI forever, through the same helper and the
    // same comparison. A snapshot that cannot fail vouches for nothing.
    await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
    const before = await snapshotTree(repo);
    await writeFile(path.join(repo, 'added.txt'), 'new');
    await writeFile(path.join(repo, 'CLAUDE.md'), 'modified in place');
    expect(await snapshotTree(repo)).not.toEqual(before);
  });

  it('--no-global means nothing outside the repository is probed', async () => {
    await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
    const r = await inspect();
    expect(r.globalProbed).toBe(false);
    for (const tool of r.tools) {
      for (const file of tool.files) {
        if (file.scope === 'global') expect(file.status).toBe('not-probed');
      }
    }
  });
});

describe('driftgate doctor — presentation (T027)', () => {
  beforeEach(async () => {
    await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
  });

  it('emits no ANSI escapes when colour is off', async () => {
    await runDoctor({ cwd: repo, color: false, noGlobal: true });
    expect(stdout.join('')).not.toMatch(ANSI);
    expect(stderr.join('')).not.toMatch(ANSI);
    // Anti-vacuity: an implementation printing nothing would pass the assertion above.
    expect(stdout.join('')).toContain('GitHub Copilot');
  });

  it('emits ANSI escapes on a TTY, so the assertion above is known to be able to fail', async () => {
    // The mandatory positive control, and it earns its place. `--no-color` was genuinely
    // inert before this task: picocolors' `createColors(false)` returns a *new* object
    // rather than reconfiguring the module default, so the old `if (!useColor)
    // pc.createColors(false)` discarded its only effect. It stayed invisible because
    // picocolors auto-disables when stdout is not a TTY — and force-enables under `CI` and
    // on win32, which is precisely where the escapes would first have reached a log.
    //
    // Colour is a property of the terminal, so forcing it means claiming to be one.
    const isTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      await runDoctor({ cwd: repo, color: true, noGlobal: true });
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
    }
    expect(stdout.join('')).toMatch(ANSI);
  });

  it('stays within 80 columns', async () => {
    await runDoctor({ cwd: repo, color: false, noGlobal: true });
    const lines = stdout.join('').split('\n');
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('aligns the status column within each tool block', async () => {
    await runDoctor({ cwd: repo, color: false, noGlobal: true });
    // Per block, not across blocks: each tool is laid out independently, so forcing one
    // global column width would pad every short block to the widest path in the report.
    const blocks = stdout
      .join('')
      .split(/\n(?=\S)/)
      .filter((b) => b.includes('will load'));
    expect(blocks.length).toBeGreaterThan(1);

    let checked = 0;
    for (const block of blocks) {
      const rows = block
        .split('\n')
        .filter(
          (l) =>
            /^ {2}\S/.test(l) &&
            / (absent|generated|unmanaged|drifted|missing|not-probed)\b/.test(l),
        );
      if (rows.length < 2) continue;
      const columns = new Set(
        rows.map((l) => l.search(/ (absent|generated|unmanaged|drifted|missing|not-probed)\b/)),
      );
      expect(columns.size).toBe(1);
      checked += 1;
    }
    // Anti-vacuity: a loop over zero blocks passes without asserting anything.
    expect(checked).toBeGreaterThan(1);
  });

  it('puts the table on stdout and the warnings on stderr', async () => {
    await runDoctor({ cwd: repo, color: false, noGlobal: true });
    expect(stdout.join('')).toContain('will load');
    expect(stdout.join('')).not.toContain('duplicates of another');
    expect(stderr.join('')).toContain("duplicates of another adapter's output");
  });

  it('--json emits a report whose only absolute path is repoRoot', async () => {
    await runDoctor({ cwd: repo, json: true, color: false, noGlobal: true });
    const parsed = JSON.parse(stdout.join('')) as DoctorReport & Record<string, unknown>;
    const { repoRoot, ...rest } = parsed;
    expect(repoRoot).toBe(repo);
    for (const value of JSON.stringify(rest).match(/"[^"]*"/g) ?? []) {
      expect(value.startsWith('"/')).toBe(false);
    }
  });

  it('is byte-identical across repeated runs', async () => {
    await runDoctor({ cwd: repo, color: false, noGlobal: true });
    const first = stdout.join('');
    stdout = [];
    await runDoctor({ cwd: repo, color: false, noGlobal: true });
    expect(stdout.join('')).toBe(first);
  });
});

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
      const s = await stat(child).catch(() => undefined);
      out.push(`${rel}\t${String(s?.size ?? -1)}\t${String(s?.mtimeMs ?? -1)}`);
    }
  };
  await walk(dir, '');
  return out.sort();
}

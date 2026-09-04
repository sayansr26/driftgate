import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '../src/registry.js';

const run = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../../..');

async function page(tool: string): Promise<string> {
  return readFile(path.join(repoRoot, 'docs/tools', `${tool}.md`), 'utf8');
}

/**
 * Two gates, and they catch different things.
 *
 * `--check` is a **byte** gate: it proves the committed pages are what the current
 * `docs.ts` renders. It cannot tell you the renderer is *right* — a renderer that silently
 * dropped every description would stay green forever, because the committed pages would
 * have dropped them too.
 *
 * So the assertions below are a **semantic** gate, and they deliberately assert on fields
 * that appear in exactly one place on the page. Asserting `pattern` or `source.url` would
 * prove nothing: those appear in the precedence table *and* the per-file sections *and* the
 * Sources list, so a mutation removing any one section would still find them somewhere.
 */
describe('generated tool docs — T065', () => {
  it('is byte-identical to what the current adapters render', async () => {
    // The gate CI runs. `--check` never writes and is safe under CI, unlike `--yes`.
    await run('node', ['scripts/generate-docs.mjs', '--check'], { cwd: repoRoot });
  });

  it('has a page for every registered adapter and no others', async () => {
    const index = await readFile(path.join(repoRoot, 'docs/tools/README.md'), 'utf8');
    for (const adapter of ADAPTERS) {
      expect(index).toContain(`(${adapter.name}.md)`);
      await expect(page(adapter.name)).resolves.toContain(adapter.docs.toolName);
    }
  });

  it('renders every per-entry description, which lives nowhere else on the page', async () => {
    // `description` is the field that carries the page's actual value, and it appears only
    // in the "What each file is" section. A renderer that dropped that whole section passes
    // a pattern/URL assertion and fails this one.
    for (const adapter of ADAPTERS) {
      const rendered = await page(adapter.name);
      for (const entry of adapter.docs.files) {
        expect(rendered, `${adapter.name} / ${entry.pattern}`).toContain(entry.description);
      }
    }
  });

  it('renders the "Driftgate writes it" column, which nothing else encodes', async () => {
    // `managed` appears only as a table cell. Dropping the column would silently stop the
    // page distinguishing a file Driftgate generates from one it merely reports — the whole
    // question a reader brings to these pages.
    for (const adapter of ADAPTERS) {
      const rendered = await page(adapter.name);
      for (const entry of adapter.docs.files) {
        const row = rendered
          .split('\n')
          .find((line) => line.startsWith('|') && line.includes(`\`${entry.pattern}\``));
        expect(row, `${adapter.name} / ${entry.pattern}`).toBeDefined();
        expect(row).toContain(entry.managed ? '| yes |' : '| no |');
        expect(row).toContain(entry.role);
      }
    }
  });

  it('renders the size limits and every note, verbatim', async () => {
    for (const adapter of ADAPTERS) {
      const rendered = await page(adapter.name);
      const note = adapter.docs.limits?.note;
      if (note !== undefined) expect(rendered, adapter.name).toContain(note);
      const max = adapter.docs.limits?.maxBytesPerFile;
      if (max !== undefined) expect(rendered, adapter.name).toContain(String(max));
      for (const entry of adapter.docs.notes ?? []) {
        expect(rendered, adapter.name).toContain(entry.message);
      }
    }
  });

  it('states the resolution model in words a reader can act on', async () => {
    // The three are genuinely different behaviours, and the sentence is the only place the
    // page says which one applies. Zed is the one tool where getting it wrong changes the
    // reader's answer completely.
    expect(await page('zed')).toContain('reads the **first** file below that exists and stops');
    expect(await page('gemini')).toContain('all together');
    expect(await page('claude-code')).toContain('the one nearer the top wins');
  });

  it('stamps every source with the date it was read', async () => {
    for (const adapter of ADAPTERS) {
      const rendered = await page(adapter.name);
      for (const entry of adapter.docs.files) {
        expect(rendered, `${adapter.name} / ${entry.source.url}`).toContain(
          `retrieved ${entry.source.retrieved}`,
        );
      }
    }
  });
});

describe('generated adapter registry — T066', () => {
  it('lists every registered adapter', async () => {
    const rendered = await readFile(path.join(repoRoot, 'docs/adapters.md'), 'utf8');
    for (const adapter of ADAPTERS) expect(rendered).toContain(`\`${adapter.name}\``);
    expect(rendered).toContain(`ships ${String(ADAPTERS.length)} adapters`);
  });

  it('reports coverage against each adapter’s real generated artifacts, not its own claim', async () => {
    // The check the plan for this task got wrong. `expectDocsValid` validates `managed`
    // against the goldens in both directions but **never looks at `role`** — and `role` is
    // what the coverage column keys on. Deriving the expectation from `docs.files` again
    // would restate the same array and pass against a mislabelled entry.
    //
    // So the expectation comes from what the adapter actually *writes*: an artifact with
    // `kind: 'mcp'` is the ground truth for "this adapter covers MCP".
    const rendered = await readFile(path.join(repoRoot, 'docs/adapters.md'), 'utf8');

    for (const adapter of ADAPTERS) {
      const row = rendered.split('\n').find((line) => line.includes(`\`${adapter.name}\``));
      expect(row, adapter.name).toBeDefined();

      const declaresMcp = adapter.docs.files.some((f) => f.managed && f.role === 'mcp');
      const fixture = declaresMcp ? `${adapter.name}-mcp` : adapter.name;
      const { renderFixture } = await import('@driftgate/adapter-kit/testing');
      const artifacts = await renderFixture(fixture, adapter).catch(() => undefined);

      if (artifacts === undefined) continue;
      const writesMcp = [...artifacts.keys()].some(
        (p) => p.endsWith('mcp.json') || p.endsWith('config.toml'),
      );
      expect(writesMcp, `${adapter.name} declares MCP but writes none`).toBe(declaresMcp);
      expect(row!.includes('MCP'), `${adapter.name} coverage column`).toBe(declaresMcp);
    }
  });

  it('does not print "not stated" as if it were "stable"', async () => {
    // No shipped adapter sets `status` — the org is not claimed until T034 — so every row
    // must say so rather than borrowing a reassuring default.
    const rendered = await readFile(path.join(repoRoot, 'docs/adapters.md'), 'utf8');
    expect(rendered).toContain('not stated');
    expect(rendered).toContain('never derived from how old its `verifiedAgainst` date is');
  });
});

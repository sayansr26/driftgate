import { describe, expect, it } from 'vitest';
import { expectContentCovered, expectImportMatch } from '@driftgate/adapter-kit/testing';
import { cline } from '../src/index.js';

describe('cline read()', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('cline', cline);
  });

  it('loses no user content, from either documented extension', async () => {
    // `.txt` is not decoration: the vendor says Cline processes both extensions, so an
    // importer that read only `.md` would silently drop half a user's rules.
    await expectContentCovered('cline', cline, [
      '.clinerules/style.md',
      '.clinerules/notes.txt',
    ]);
  });
});

describe('cline docs — the T078 duplicate-load claim (T049b)', () => {
  it('declares the three cross-tool files other adapters generate, unmanaged', async () => {
    const { cline } = await import('../src/index.js');
    const patterns = cline.docs.files.filter((f) => !f.managed).map((f) => f.pattern);

    // These are the whole reason this adapter's docs matter. Cline reads three files that
    // *other* Driftgate adapters write, additively — so enabling cline alongside codex
    // sends Cline the same rules twice. `doctor` derives that warning from this data, with
    // no Cline-specific code anywhere (T078).
    for (const pattern of ['.cursorrules', '.windsurfrules', 'AGENTS.md']) {
      expect(patterns).toContain(pattern);
    }

    // The negative half: the file this adapter *does* write must not be in that set, or
    // the duplicate-load warning would fire on Driftgate's own output.
    expect(patterns).not.toContain('.clinerules/*.md');
  });

  it('emits no MCP artifact, because Cline has no project-level MCP file', async () => {
    const { cline } = await import('../src/index.js');
    expect(cline.docs.files.some((f) => f.role === 'mcp')).toBe(false);
  });
});
